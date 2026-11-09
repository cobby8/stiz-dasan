import { revalidatePath, revalidateTag } from "next/cache";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PUBLIC_SITE_URL } from "@/lib/publicMetadata";
import { classifyTossCancel } from "@/lib/payments/tossCancel";
import { describeTaxFreeMismatch } from "@/lib/payments/taxFree";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
// 학부모 «묶음 결제»(2026-11-09) — 순수 규칙 + DB 인자 연결부
import {
    BUNDLE_BLOCK_MESSAGE,
    MAX_BUNDLE_ITEMS,
    MAX_BUNDLE_TOTAL,
    bundleCheckoutEligibility,
    bundleItemBlock,
    bundleTotals,
    buildBundleItems,
    buildBundleOrderName,
    makeBundleOrderId,
    sameBundleItems,
    CHECKOUT_AMOUNT_CHANGED_MESSAGE,
    checkoutAmountsStale,
    type BundleBlockCode,
    type BundleCandidateRow,
} from "@/lib/payments/checkoutBundle";
import {
    BUNDLE_LEDGER_CONFLICT,
    TX_PAYMENT_STATUS_SQL,
    claimTossConfirmInTx,
    finalizeBundleInTx,
    findOpenDepositTxIds,
    lockPaymentsForCheckout,
    readCheckoutAmounts,
    hasBundleItems,
    listBundleItems,
    refundBundleInTx,
    txCoversInvoiceSql,
} from "@/lib/payments/bundleLedger";
import {
    VA_EXPIRED_STATUS,
    VA_METHOD,
    VA_WAITING_STATUS,
    decideVirtualAccountClose,
    decideVirtualAccountWebhook,
    extractVirtualAccountIssue,
    isDepositCallbackPayload,
    isVirtualAccountTransaction,
    shouldRetryDepositCallback,
    parseTossTimestamp,
    readStoredIssue,
    stripPaymentSecret,
    stripWebhookSecrets,
    toPublicVirtualAccountView,
    toTossMobilePhone,
    virtualAccountCancelIdempotencySeed,
    virtualAccountCancelReason,
    virtualAccountCloseReviewCode,
    type PublicVirtualAccountView,
} from "@/lib/payments/virtualAccount";
import { buildIssuedRawResponse, checkDepositSecret } from "@/lib/payments/virtualAccountSecret";
import { postMessage } from "@/lib/slack/client";
import {
    CAFE24_PAYMENT_PROVIDER,
    Cafe24PaymentBridgeError,
    buildCafe24PaymentBridgePayload,
    getCafe24PaymentBridgeConfig,
    getCafe24PaymentCheckoutUrl,
    postCafe24PaymentCheckout,
    verifyCafe24PaymentSignature,
} from "@/lib/cafe24-payment";

export type LedgerPaymentStatus = "PENDING" | "OVERDUE" | "PAID" | "REFUNDED" | "CANCELED";
export type LedgerInvoiceStatus = "ISSUED" | "SENT" | "OVERDUE" | "PAID" | "CANCELED";
export type LedgerActorType = "ADMIN" | "PARENT" | "SYSTEM" | "WEBHOOK";

type PaymentInvoiceRow = {
    id: string;
    [key: string]: unknown;
};

type ParentInvoiceRow = {
    invoiceId: string;
    paymentId: string;
    studentId: string;
    parentId: string | null;
    invoiceNo: string;
    invoiceStatus: string;
    amount: number;
    title: string;
    description: string | null;
    dueDate: Date;
    issuedAt: Date;
    sentAt: Date | null;
    paidAt: Date | null;
    checkoutUrl: string | null;
    paymentStatus: string;
    paidDate: Date | null;
    method: string | null;
    receiptUrl: string | null;
    studentName: string;
    parentName: string | null;
    parentEmail: string;
    parentPhone: string | null;
    transactionId: string | null;
    orderId: string | null;
    transactionStatus: string | null;
    transactionReceiptUrl: string | null;
    /** 랠리즈 청구서의 장부 사본인가 — 사이트 결제(단건·묶음) 막음(원장 결정 D4, 2026-11-09) */
    rallyzMirror: boolean;
};

export type PaymentOwnerIdentity = {
    authUserId: string;
    email: string | null;
};

type CheckoutTransactionRow = {
    id: string;
    orderId: string;
    orderName: string;
    amount: number;
    rawResponse?: unknown;
};

type PaymentTransactionRow = {
    id: string;
    paymentId: string;
    invoiceId: string;
    studentId: string;
    parentId: string | null;
    orderId: string;
    paymentKey?: string | null;
    amount: number;
    status: string;
    method?: string | null;
    rawResponse?: unknown;
    invoiceStatus?: string;
    paymentStatus?: string;
};

type TossKeyMode = "test" | "live" | "unknown";
type TossProviderKeyMode = TossKeyMode | "mixed";
type OnlinePaymentProvider = "TOSS" | typeof CAFE24_PAYMENT_PROVIDER;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function makeTossCustomerKey(invoice: Pick<ParentInvoiceRow, "parentId" | "parentEmail">) {
    const digest = createHash("sha256")
        .update(`stiz-parent:v2:${invoice.parentId || invoice.parentEmail}`)
        .digest("base64url")
        .slice(0, 36);
    return `stiz_${digest}`;
}

function isUuidLike(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** 토스 조회·가상계좌 취소 요청의 응답 대기 한도(10초). 승인(confirm)은 «승인됐는데 끊김» 위험이 있어 따로 둔다. */
const TOSS_FETCH_TIMEOUT_MS = 10_000;
/** 매일 점검의 시간 예산 — cron maxDuration 60초 안에서 마무리(남은 건은 다음 날) */
const SWEEP_TIME_BUDGET_MS = 45_000;

export function makeUuidFromSeed(seed: string) {
    const hex = createHash("sha256").update(seed).digest("hex");
    const variant = ((parseInt(hex[16] || "8", 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function makeTossIdempotencyKey(transactionId: string, orderId: string) {
    return isUuidLike(transactionId)
        ? transactionId
        : makeUuidFromSeed(`stiz-toss-confirm:${transactionId}:${orderId}`);
}

function makeTossWebhookEventId(input: {
    payload: unknown;
    explicitEventId: string | null;
    eventType: string | null;
    paymentKey: string | null;
    orderId: string | null;
    status: string | null;
    totalAmount: number | null;
    /** 가상계좌 입금 알림의 transactionKey(없으면 createdAt). 입금·입금취소가 반복돼도 서로 다른 알림으로 본다. */
    depositKey?: string | null;
}) {
    if (input.explicitEventId) return input.explicitEventId;

    const fingerprintSource = input.paymentKey || input.orderId || input.eventType || input.status || input.totalAmount
        ? {
            eventType: input.eventType,
            paymentKey: input.paymentKey,
            orderId: input.orderId,
            status: input.status,
            totalAmount: input.totalAmount,
            // 카드 등 기존 알림의 지문이 바뀌지 않게 값이 있을 때만 칸을 넣는다
            ...(input.depositKey ? { depositKey: input.depositKey } : {}),
        }
        : input.payload;
    const digest = createHash("sha256")
        .update(JSON.stringify(fingerprintSource ?? null))
        .digest("hex")
        .slice(0, 48);
    return `generated:${digest}`;
}

function inferTossKeyMode(key: string): TossKeyMode {
    if (key.startsWith("test_")) return "test";
    if (key.startsWith("live_")) return "live";
    return "unknown";
}

function makePaymentReturnUrl(origin: string, path: string, invoiceId: string) {
    const url = new URL(path, origin);
    url.searchParams.set("invoiceId", invoiceId);
    return url.toString();
}

let _paymentInfrastructureEnsured = false;

export function revalidatePaymentCaches() {
    revalidatePath("/admin/finance");
    revalidatePath("/admin/stats");
    revalidatePath("/mypage");
    revalidateTag("admin-finance", { expire: 0 });
    revalidateTag("admin-stats", { expire: 0 });
}

export async function ensurePaymentInfrastructure() {
    if (_paymentInfrastructureEnsured) return;

    const paymentColumns: [string, string][] = [
        ["classId", "TEXT"],
        ["type", "TEXT DEFAULT 'MONTHLY'"],
        ["method", "TEXT"],
        ["description", "TEXT"],
        ["month", "INTEGER"],
        ["year", "INTEGER"],
        ["autoGenerated", "BOOLEAN DEFAULT false"],
        ["notifiedAt", "TIMESTAMPTZ"],
        ["invoiceNo", "TEXT"],
        ["issuedAt", "TIMESTAMPTZ"],
        ["payableUntil", "TIMESTAMPTZ"],
        ["paidProvider", "TEXT"],
        ["providerOrderId", "TEXT"],
        ["providerPaymentKey", "TEXT"],
        ["receiptUrl", "TEXT"],
        ["paymentRequestedAt", "TIMESTAMPTZ"],
        ["lastReminderAt", "TIMESTAMPTZ"],
        ["reminderCount", "INTEGER DEFAULT 0"],
    ];

    for (const [column, type] of paymentColumns) {
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "${column}" ${type}`
        );
    }

    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "PaymentInvoice" (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            "paymentId" TEXT NOT NULL UNIQUE,
            "studentId" TEXT NOT NULL,
            "classId" TEXT,
            "parentId" TEXT,
            "invoiceNo" TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'ISSUED',
            amount INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            "dueDate" TIMESTAMPTZ NOT NULL,
            "issuedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "sentAt" TIMESTAMPTZ,
            "paidAt" TIMESTAMPTZ,
            "canceledAt" TIMESTAMPTZ,
            "lastReminderAt" TIMESTAMPTZ,
            "reminderCount" INTEGER NOT NULL DEFAULT 0,
            "checkoutUrl" TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await prisma.$executeRawUnsafe(
        `ALTER TABLE "PaymentInvoice" ADD COLUMN IF NOT EXISTS "classId" TEXT`
    );

    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "PaymentTransaction" (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            "paymentId" TEXT NOT NULL,
            "invoiceId" TEXT NOT NULL,
            "studentId" TEXT NOT NULL,
            "parentId" TEXT,
            provider TEXT NOT NULL DEFAULT 'TOSS',
            "orderId" TEXT NOT NULL UNIQUE,
            "paymentKey" TEXT UNIQUE,
            "orderName" TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'READY',
            method TEXT,
            "receiptUrl" TEXT,
            "failureCode" TEXT,
            "failureMessage" TEXT,
            "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "approvedAt" TIMESTAMPTZ,
            "rawResponse" JSONB,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "PaymentWebhookEvent" (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            provider TEXT NOT NULL DEFAULT 'TOSS',
            "eventId" TEXT,
            "eventType" TEXT,
            "paymentKey" TEXT,
            "orderId" TEXT,
            processed BOOLEAN NOT NULL DEFAULT false,
            "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "processedAt" TIMESTAMPTZ,
            payload JSONB NOT NULL,
            error TEXT
        )
    `);

    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "PaymentAuditLog" (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            "paymentId" TEXT,
            "invoiceId" TEXT,
            "transactionId" TEXT,
            "actorType" TEXT NOT NULL,
            "actorId" TEXT,
            action TEXT NOT NULL,
            message TEXT,
            metadata JSONB,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    const indexes = [
        `CREATE INDEX IF NOT EXISTS "Payment_year_month_idx" ON "Payment" (year, month)`,
        `CREATE INDEX IF NOT EXISTS "Payment_status_idx" ON "Payment" (status)`,
        `CREATE INDEX IF NOT EXISTS "Payment_status_dueDate_idx" ON "Payment" (status, "dueDate")`,
        `CREATE INDEX IF NOT EXISTS "Payment_classId_status_dueDate_idx" ON "Payment" ("classId", status, "dueDate")`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "Payment_id_classId_key" ON "Payment" (id, "classId")`,
        `CREATE INDEX IF NOT EXISTS "Payment_providerOrderId_idx" ON "Payment" ("providerOrderId")`,
        `CREATE INDEX IF NOT EXISTS "Payment_providerPaymentKey_idx" ON "Payment" ("providerPaymentKey")`,
        `CREATE INDEX IF NOT EXISTS "PaymentInvoice_parent_status_idx" ON "PaymentInvoice" ("parentId", status)`,
        `CREATE INDEX IF NOT EXISTS "PaymentInvoice_student_due_idx" ON "PaymentInvoice" ("studentId", "dueDate")`,
        `CREATE INDEX IF NOT EXISTS "PaymentInvoice_classId_status_dueDate_idx" ON "PaymentInvoice" ("classId", status, "dueDate")`,
        `CREATE INDEX IF NOT EXISTS "PaymentTransaction_invoice_status_idx" ON "PaymentTransaction" ("invoiceId", status)`,
        `CREATE INDEX IF NOT EXISTS "PaymentTransaction_payment_status_idx" ON "PaymentTransaction" ("paymentId", status)`,
        `CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_order_idx" ON "PaymentWebhookEvent" ("orderId")`,
        `CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_paymentKey_idx" ON "PaymentWebhookEvent" ("paymentKey")`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentWebhookEvent_provider_eventId_key"
         ON "PaymentWebhookEvent" (provider, "eventId")`,
        `CREATE INDEX IF NOT EXISTS "PaymentAuditLog_payment_idx" ON "PaymentAuditLog" ("paymentId", "createdAt" DESC)`,
    ];

    for (const sql of indexes) {
        await prisma.$executeRawUnsafe(sql);
    }

    _paymentInfrastructureEnsured = true;
}

export async function recordPaymentAudit(input: {
    paymentId?: string | null;
    invoiceId?: string | null;
    transactionId?: string | null;
    actorType: LedgerActorType;
    actorId?: string | null;
    action: string;
    message?: string | null;
    metadata?: unknown;
}) {
    await ensurePaymentInfrastructure();
    await prisma.$executeRawUnsafe(
        `INSERT INTO "PaymentAuditLog" (
            id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId",
            action, message, metadata, "createdAt"
        )
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())`,
        input.paymentId ?? null,
        input.invoiceId ?? null,
        input.transactionId ?? null,
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.message ?? null,
        JSON.stringify(input.metadata ?? null),
    );
}

export async function ensureInvoicesForMonth(
    year: number,
    month: number,
    paymentIds?: string[],
    transaction?: Pick<typeof prisma, "$executeRawUnsafe" | "$queryRawUnsafe">,
) {
    // 선택 발행은 새로 생성된 정확한 Payment ID만 대상으로 한다. 빈 선택을 월 전체로 확대하지 않는다.
    if (paymentIds && paymentIds.length === 0) return { invoiceCount: 0 };
    // 거래 호출자는 시작 전에 인프라를 준비한다. 거래 안에서 전역 연결/DDL을 호출하지 않는다.
    if (!transaction) await ensurePaymentInfrastructure();
    const db = transaction ?? prisma;

    const dueStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dueEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

    await db.$executeRawUnsafe(
        `
        INSERT INTO "PaymentInvoice" (
            id, "paymentId", "studentId", "classId", "parentId", "invoiceNo", status,
            amount, title, description, "dueDate", "issuedAt", "paidAt",
            "createdAt", "updatedAt"
        )
        SELECT
            gen_random_uuid()::text,
            p.id,
            p."studentId",
            p."classId",
            s."parentId",
            CONCAT(
                'STIZ-',
                COALESCE(p.year, EXTRACT(YEAR FROM p."dueDate")::int)::text,
                LPAD(COALESCE(p.month, EXTRACT(MONTH FROM p."dueDate")::int)::text, 2, '0'),
                '-',
                SUBSTRING(REPLACE(p.id, '-', '') FROM 1 FOR 8)
            ),
            CASE
                WHEN p.status = 'PAID' THEN 'PAID'
                WHEN p.status IN ('REFUNDED', 'CANCELED') THEN 'CANCELED'
                WHEN p.status = 'OVERDUE' THEN 'OVERDUE'
                ELSE 'ISSUED'
            END,
            p.amount,
            COALESCE(p.description, p.type, '수강료'),
            p.description,
            p."dueDate",
            COALESCE(p."issuedAt", NOW()),
            p."paidDate",
            NOW(),
            NOW()
        FROM "Payment" p
        JOIN "Student" s ON s.id = p."studentId"
        WHERE (
            (p.year = $1 AND p.month = $2)
            OR (p."dueDate" >= $3::timestamp AND p."dueDate" < $4::timestamp)
        )
        AND ($5::text[] IS NULL OR p.id = ANY($5::text[]))
        ON CONFLICT ("paymentId") DO UPDATE SET
            "studentId" = EXCLUDED."studentId",
            "classId" = EXCLUDED."classId",
            "parentId" = EXCLUDED."parentId",
            amount = EXCLUDED.amount,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            "dueDate" = EXCLUDED."dueDate",
            status = CASE
                WHEN "PaymentInvoice".status = 'PAID' THEN 'PAID'
                ELSE EXCLUDED.status
            END,
            "paidAt" = COALESCE("PaymentInvoice"."paidAt", EXCLUDED."paidAt"),
            "updatedAt" = NOW()
        `,
        year,
        month,
        dueStart,
        dueEnd,
        paymentIds ?? null,
    );

    await db.$executeRawUnsafe(
        `
        UPDATE "Payment" p
        SET
            "invoiceNo" = i."invoiceNo",
            "issuedAt" = COALESCE(p."issuedAt", i."issuedAt"),
            "payableUntil" = COALESCE(p."payableUntil", i."dueDate"),
            "updatedAt" = NOW()
        FROM "PaymentInvoice" i
        WHERE i."paymentId" = p.id
          AND (
            (p.year = $1 AND p.month = $2)
            OR (p."dueDate" >= $3::timestamp AND p."dueDate" < $4::timestamp)
          )
          AND ($5::text[] IS NULL OR p.id = ANY($5::text[]))
        `,
        year,
        month,
        dueStart,
        dueEnd,
        paymentIds ?? null,
    );

    const rows = await db.$queryRawUnsafe<{ count: number }[]>(
        `
        SELECT COUNT(*)::int AS count
        FROM "PaymentInvoice" i
        JOIN "Payment" p ON p.id = i."paymentId"
        WHERE (
            (p.year = $1 AND p.month = $2)
            OR (p."dueDate" >= $3::timestamp AND p."dueDate" < $4::timestamp)
        )
        AND ($5::text[] IS NULL OR p.id = ANY($5::text[]))
        `,
        year,
        month,
        dueStart,
        dueEnd,
        paymentIds ?? null,
    );

    return { invoiceCount: Number(rows[0]?.count ?? 0) };
}

export async function ensureInvoiceForPayment(paymentId: string) {
    await ensurePaymentInfrastructure();

    const rows = await prisma.$queryRawUnsafe<{ year: number | null; month: number | null; dueDate: Date }[]>(
        `SELECT year, month, "dueDate" FROM "Payment" WHERE id = $1 LIMIT 1`,
        paymentId,
    );
    const payment = rows[0];
    if (!payment) return null;

    const dueDate = new Date(payment.dueDate);
    await ensureInvoicesForMonth(payment.year ?? dueDate.getFullYear(), payment.month ?? dueDate.getMonth() + 1);

    const invoiceRows = await prisma.$queryRawUnsafe<PaymentInvoiceRow[]>(
        `SELECT * FROM "PaymentInvoice" WHERE "paymentId" = $1 LIMIT 1`,
        paymentId,
    );

    return invoiceRows[0] ?? null;
}

export async function markOverduePayments() {
    await ensurePaymentInfrastructure();

    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "Payment" WHERE status = 'PENDING' AND "dueDate"::date < CURRENT_DATE`
    );

    if (rows.length === 0) return { updated: 0 };

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");

    await prisma.$executeRawUnsafe(
        `UPDATE "Payment" SET status = 'OVERDUE', "updatedAt" = NOW() WHERE id IN (${placeholders})`,
        ...ids,
    );

    await prisma.$executeRawUnsafe(
        `UPDATE "PaymentInvoice" SET status = 'OVERDUE', "updatedAt" = NOW()
         WHERE "paymentId" IN (${placeholders}) AND status IN ('ISSUED', 'SENT')`,
        ...ids,
    );

    await recordPaymentAudit({
        actorType: "SYSTEM",
        action: "PAYMENT_MARK_OVERDUE",
        message: `${ids.length} overdue payments marked`,
        metadata: { paymentIds: ids },
    });

    revalidatePaymentCaches();
    return { updated: ids.length };
}

export async function syncInvoiceStatusesForMonth(year: number, month: number) {
    await ensurePaymentInfrastructure();

    const updated = await prisma.$executeRawUnsafe(
        `
        UPDATE "PaymentInvoice" i
        SET
            status = CASE
                WHEN p.status = 'PAID' THEN 'PAID'
                WHEN p.status IN ('REFUNDED', 'CANCELED') THEN 'CANCELED'
                WHEN p.status = 'OVERDUE' THEN 'OVERDUE'
                WHEN p.status = 'PENDING' THEN CASE WHEN i."sentAt" IS NOT NULL THEN 'SENT' ELSE 'ISSUED' END
                ELSE i.status
            END,
            amount = p.amount,
            "paidAt" = CASE
                WHEN p.status = 'PAID' THEN COALESCE(i."paidAt", p."paidDate", NOW())
                WHEN i.status = 'PAID' THEN NULL
                ELSE i."paidAt"
            END,
            "canceledAt" = CASE
                WHEN p.status IN ('REFUNDED', 'CANCELED') THEN COALESCE(i."canceledAt", NOW())
                WHEN i.status = 'CANCELED' THEN NULL
                ELSE i."canceledAt"
            END,
            "updatedAt" = NOW()
        FROM "Payment" p
        WHERE i."paymentId" = p.id
          AND p.year = $1
          AND p.month = $2
          AND p.type = 'MONTHLY'
          AND (
            i.status IS DISTINCT FROM CASE
                WHEN p.status = 'PAID' THEN 'PAID'
                WHEN p.status IN ('REFUNDED', 'CANCELED') THEN 'CANCELED'
                WHEN p.status = 'OVERDUE' THEN 'OVERDUE'
                WHEN p.status = 'PENDING' THEN CASE WHEN i."sentAt" IS NOT NULL THEN 'SENT' ELSE 'ISSUED' END
                ELSE i.status
            END
            OR i.amount IS DISTINCT FROM p.amount
            OR (p.status = 'PAID' AND i."paidAt" IS NULL)
            OR (p.status IN ('REFUNDED', 'CANCELED') AND i."canceledAt" IS NULL)
            OR (p.status <> 'PAID' AND i.status = 'PAID')
            OR (p.status NOT IN ('REFUNDED', 'CANCELED') AND i.status = 'CANCELED')
          )
        `,
        year,
        month,
    );

    revalidatePaymentCaches();
    return { updated: Number(updated ?? 0) };
}

export async function markPaymentPaid(input: {
    paymentId: string;
    invoiceId?: string | null;
    transactionId?: string | null;
    actorType: LedgerActorType;
    actorId?: string | null;
    method?: string | null;
    provider?: string | null;
    orderId?: string | null;
    providerOrderId?: string | null;
    paymentKey?: string | null;
    receiptUrl?: string | null;
    paidAt?: Date | string | null;
    rawResponse?: unknown;
}) {
    await ensurePaymentInfrastructure();

    const paidAt = input.paidAt ? new Date(input.paidAt) : null;
    if (paidAt && Number.isNaN(paidAt.getTime())) {
        throw new Error("Invalid paidAt date");
    }
    const providerOrderId = input.providerOrderId ?? input.orderId ?? null;
    const invoice = input.invoiceId
        ? { id: input.invoiceId }
        : await ensureInvoiceForPayment(input.paymentId);

    await prisma.$executeRawUnsafe(
        `UPDATE "Payment"
         SET status = 'PAID',
             "paidDate" = COALESCE("paidDate", $7::timestamp, NOW()),
             method = COALESCE($2, method),
             "paidProvider" = COALESCE($3, "paidProvider"),
             "providerOrderId" = COALESCE($4, "providerOrderId"),
             "providerPaymentKey" = COALESCE($5, "providerPaymentKey"),
             "receiptUrl" = COALESCE($6, "receiptUrl"),
             "updatedAt" = NOW()
         WHERE id = $1`,
        input.paymentId,
        input.method ?? null,
        input.provider ?? null,
        providerOrderId,
        input.paymentKey ?? null,
        input.receiptUrl ?? null,
        paidAt,
    );

    if (invoice?.id) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentInvoice"
             SET status = 'PAID', "paidAt" = COALESCE("paidAt", $2::timestamp, NOW()), "updatedAt" = NOW()
             WHERE id = $1`,
            invoice.id,
            paidAt,
        );
    }

    if (input.transactionId) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentTransaction"
             SET status = 'DONE',
                 "paymentKey" = COALESCE($2, "paymentKey"),
                 method = COALESCE($3, method),
                 "receiptUrl" = COALESCE($4, "receiptUrl"),
                 "approvedAt" = COALESCE("approvedAt", $5::timestamp, NOW()),
                 "rawResponse" = COALESCE($6::jsonb, "rawResponse"),
                 "updatedAt" = NOW()
              WHERE id = $1`,
            input.transactionId,
            input.paymentKey ?? null,
            input.method ?? null,
            input.receiptUrl ?? null,
            paidAt,
            input.rawResponse ? JSON.stringify(input.rawResponse) : null,
        );
    }

    await recordPaymentAudit({
        paymentId: input.paymentId,
        invoiceId: invoice?.id ?? null,
        transactionId: input.transactionId ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: "PAYMENT_MARK_PAID",
        message: "Payment marked as paid",
        metadata: {
            method: input.method,
            provider: input.provider,
            orderId: input.orderId,
            providerOrderId,
            paymentKey: input.paymentKey ? "[saved]" : null,
            paidAt: paidAt?.toISOString() ?? null,
        },
    });

    revalidatePaymentCaches();
}

/**
 * 청구 여러 건을 «한 트랜잭션으로» 납부완료 — 토스 POS 현장 결제 «묶음»(같은 학생 여러 건을 POS 결제 한 번, 2026-11-08 원장 결정)에서만 쓴다.
 * 왜 따로 두나: markPaymentPaid 를 건마다 부르면 중간에 멈췄을 때 «일부만 납부»가 남는다. 묶음은 전부 아니면 전무여야 한다.
 * - 건마다 «아직 미납 + 금액 그대로 + 수강료·셔틀비»일 때만 바꾼다(조건부 UPDATE). 하나라도 0행이면 오류 → 전부 되돌린다.
 * - 청구·청구서·감사 기록 모양은 markPaymentPaid 와 같다(action PAYMENT_MARK_PAID — 취소 확정의 «출처 확인»이 이 값을 본다).
 * - 청구서(PaymentInvoice)는 트랜잭션 «밖»에서 먼저 만들어 둔다(월 단위로 한꺼번에 만드는 함수라 트랜잭션을 길게 잡지 않게).
 */
export async function markPaymentsPaidTogether(input: {
    items: { paymentId: string; amount: number }[];
    actorType: LedgerActorType;
    actorId?: string | null;
    method?: string | null;
    provider?: string | null;
    providerOrderId?: string | null;
    paymentKey?: string | null;
    paidAt?: Date | string | null;
    /** 감사 기록에 같이 남길 묶음 정보(번호·청구 id 목록 등) */
    bundle?: Record<string, unknown>;
}) {
    await ensurePaymentInfrastructure();
    if (input.items.length === 0) throw new Error("묶음 납부: 청구가 없습니다.");
    const paidAt = input.paidAt ? new Date(input.paidAt) : null;
    if (paidAt && Number.isNaN(paidAt.getTime())) {
        throw new Error("Invalid paidAt date");
    }
    // 청구서 먼저(이미 있으면 그대로 돌려준다)
    const invoiceIds: (string | null)[] = [];
    for (const item of input.items) {
        invoiceIds.push((await ensureInvoiceForPayment(item.paymentId))?.id ?? null);
    }

    await prisma.$transaction(async (db) => {
        for (let i = 0; i < input.items.length; i += 1) {
            const item = input.items[i];
            const changed = await db.$queryRawUnsafe<{ id: string }[]>(
                `UPDATE "Payment"
                 SET status = 'PAID',
                     "paidDate" = COALESCE("paidDate", $7::timestamp, NOW()),
                     method = COALESCE($2, method),
                     "paidProvider" = COALESCE($3, "paidProvider"),
                     "providerOrderId" = COALESCE($4, "providerOrderId"),
                     "providerPaymentKey" = COALESCE($5, "providerPaymentKey"),
                     "receiptUrl" = COALESCE($6, "receiptUrl"),
                     "updatedAt" = NOW()
                 WHERE id = $1 AND status IN ('PENDING', 'OVERDUE') AND amount = $8::int AND type IN ('MONTHLY', 'SHUTTLE', 'OTHER')
                 RETURNING id`,
                item.paymentId,
                input.method ?? null,
                input.provider ?? null,
                input.providerOrderId ?? null,
                input.paymentKey ?? null,
                null,
                paidAt,
                item.amount,
            );
            // 하나라도 못 바꾸면(이미 납부·금액 변경) 전부 되돌린다 — 일부만 납부 금지
            if (changed.length === 0) {
                throw new Error(`묶음 납부 중단: 청구 ${item.paymentId} 가 미납이 아니거나 금액이 바뀌었습니다(전부 되돌림).`);
            }
            const invoiceId = invoiceIds[i];
            if (invoiceId) {
                await db.$executeRawUnsafe(
                    `UPDATE "PaymentInvoice"
                     SET status = 'PAID', "paidAt" = COALESCE("paidAt", $2::timestamp, NOW()), "updatedAt" = NOW()
                     WHERE id = $1`,
                    invoiceId,
                    paidAt,
                );
            }
            await db.$executeRawUnsafe(
                `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
                 VALUES (gen_random_uuid()::text, $1, $2, NULL, $3, $4, 'PAYMENT_MARK_PAID', 'Payment marked as paid', $5::jsonb, NOW())`,
                item.paymentId,
                invoiceId,
                input.actorType,
                input.actorId ?? null,
                JSON.stringify({
                    method: input.method,
                    provider: input.provider,
                    providerOrderId: input.providerOrderId ?? null,
                    paymentKey: input.paymentKey ? "[saved]" : null,
                    paidAt: paidAt?.toISOString() ?? null,
                    bundle: { ...(input.bundle ?? {}), size: input.items.length, position: i + 1 },
                }),
            );
        }
    });

    revalidatePaymentCaches();
}

/** 트랜잭션 안에서 쓰는 raw SQL 두 개만 받는다(prisma 본체 또는 $transaction 의 db) */
export type LedgerSqlClient = Pick<typeof prisma, "$executeRawUnsafe" | "$queryRawUnsafe">;

/**
 * 납부완료 청구 → 환불(REFUNDED) 로 바꾼다. 청구서는 취소(CANCELED), 감사 기록 1줄.
 * 토스 POS 현장 결제가 «토스 웹훅 재조회로» 전액 취소 확인됐을 때만 부른다(chargeRequestService).
 * 호출한 쪽의 트랜잭션(db) 안에서 돈다 — 요청 표시(취소 완료)와 함께 한 번에 확정되게.
 * 조건부 UPDATE(status = 'PAID')라 여러 번 불려도 한 번만 바뀐다. 바뀌었으면 true.
 * 납부일은 비운다(관리자 화면 «환불»·토스 전액 취소 반영과 같은 관례 — POS 대조가 paidDate 로 납부 건을 고른다).
 */
export async function refundPaidPaymentInTx(
    db: LedgerSqlClient,
    input: { paymentId: string; actorType: LedgerActorType; actorId?: string | null; message: string; metadata?: unknown },
): Promise<boolean> {
    const changed = await db.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "Payment" SET status = 'REFUNDED', "paidDate" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND status = 'PAID'
          RETURNING id`,
        input.paymentId,
    );
    if (changed.length === 0) return false;
    await db.$executeRawUnsafe(
        `UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = COALESCE("canceledAt", NOW()), "updatedAt" = NOW()
          WHERE "paymentId" = $1 AND status <> 'CANCELED'`,
        input.paymentId,
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
         VALUES (gen_random_uuid()::text, $1, NULL, NULL, $2, $3, 'PAYMENT_REFUNDED', $4, $5::jsonb, NOW())`,
        input.paymentId,
        input.actorType,
        input.actorId ?? null,
        input.message.slice(0, 500),
        JSON.stringify(input.metadata ?? {}),
    );
    return true;
}

function getSelectedPaymentProvider(): OnlinePaymentProvider {
    const raw = (process.env.PAYMENT_PROVIDER || process.env.NEXT_PUBLIC_PAYMENT_PROVIDER || "")
        .trim()
        .toUpperCase();
    if (["CAFE24", "CAFE24_BRIDGE", "CAFE24_PAYMENT", "STIZ_CAFE24"].includes(raw)) {
        return CAFE24_PAYMENT_PROVIDER;
    }
    return "TOSS";
}

function getPaymentProviderLabel(provider: OnlinePaymentProvider) {
    return provider === CAFE24_PAYMENT_PROVIDER ? "본사 카페24" : "토스페이먼츠";
}

export function getPaymentProviderConfig() {
    const clientKey = process.env.NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY
        || process.env.TOSS_PAYMENTS_CLIENT_KEY
        || "";
    const secretKey = process.env.TOSS_PAYMENTS_SECRET_KEY || "";
    const clientKeyMode = inferTossKeyMode(clientKey);
    const secretKeyMode = inferTossKeyMode(secretKey);
    const provider = getSelectedPaymentProvider();
    const cafe24Bridge = getCafe24PaymentBridgeConfig();
    const keyPairReady = Boolean(
        clientKey
        && secretKey
        && clientKeyMode !== "unknown"
        && secretKeyMode !== "unknown"
        && clientKeyMode === secretKeyMode,
    );

    return {
        provider,
        providerLabel: getPaymentProviderLabel(provider),
        clientKey,
        secretKey,
        clientKeyMode,
        secretKeyMode,
        keyPairReady,
        cafe24Bridge,
        providerReady: provider === CAFE24_PAYMENT_PROVIDER ? cafe24Bridge.ready : keyPairReady,
    };
}

export function getPaymentProviderPublicStatus() {
    const config = getPaymentProviderConfig();
    const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "";
    const siteUrl = configuredSiteUrl || PUBLIC_SITE_URL;
    const siteOrigin = (() => {
        if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) return null;
        try {
            return new URL(siteUrl).origin;
        } catch {
            return null;
        }
    })();
    const keyMode: TossProviderKeyMode = config.keyPairReady
        ? config.clientKeyMode
        : config.clientKey || config.secretKey
            ? "mixed"
            : "unknown";
    const successPath = config.provider === CAFE24_PAYMENT_PROVIDER ? "/payments/cafe24/success" : "/payments/success";
    const webhookPath = config.provider === CAFE24_PAYMENT_PROVIDER ? "/api/payments/cafe24/webhook" : "/api/payments/toss/webhook";

    return {
        provider: config.provider,
        providerLabel: config.providerLabel,
        providerReady: config.providerReady,
        clientKeyConfigured: Boolean(config.clientKey),
        secretKeyConfigured: Boolean(config.secretKey),
        clientKeyMode: config.clientKeyMode,
        secretKeyMode: config.secretKeyMode,
        keyMode,
        keyPairReady: config.keyPairReady,
        cafe24BridgeUrlConfigured: config.cafe24Bridge.apiUrlConfigured,
        cafe24BridgeUrlValid: config.cafe24Bridge.apiUrlValid,
        cafe24BridgeSecretConfigured: config.cafe24Bridge.secretConfigured,
        cafe24BridgeSecretValid: config.cafe24Bridge.secretFormatValid,
        cafe24BridgeReady: config.cafe24Bridge.ready,
        siteUrlConfigured: Boolean(siteOrigin),
        siteUrlValid: Boolean(siteOrigin),
        successUrlPreview: siteOrigin ? makePaymentReturnUrl(siteOrigin, successPath, "invoice-id") : null,
        failUrlPreview: siteOrigin ? makePaymentReturnUrl(siteOrigin, "/payments/fail", "invoice-id") : null,
        webhookUrl: siteOrigin ? new URL(webhookPath, siteOrigin).toString() : null,
    };
}

export async function getInvoiceForParent(invoiceId: string, owner: PaymentOwnerIdentity) {
    await ensurePaymentInfrastructure();

    const rows = await prisma.$queryRawUnsafe<ParentInvoiceRow[]>(
        `
        SELECT
            i.id AS "invoiceId",
            i."paymentId",
            i."studentId",
            i."parentId",
            i."invoiceNo",
            i.status AS "invoiceStatus",
            i.amount,
            i.title,
            i.description,
            i."dueDate",
            i."issuedAt",
            i."sentAt",
            i."paidAt",
            i."checkoutUrl",
            p.status AS "paymentStatus",
            p."paidDate",
            p.method,
            p."receiptUrl",
            s.name AS "studentName",
            u.name AS "parentName",
            u.email AS "parentEmail",
            u.phone AS "parentPhone",
            tx.id AS "transactionId",
            tx."orderId",
            tx.status AS "transactionStatus",
            tx."receiptUrl" AS "transactionReceiptUrl",
            (NOT (${rallyzMirrorExclusionSql("p")})) AS "rallyzMirror"
        FROM "PaymentInvoice" i
        JOIN "Payment" p ON p.id = i."paymentId"
        JOIN "Student" s ON s.id = i."studentId"
        JOIN "User" u ON u.id = i."parentId"
        LEFT JOIN LATERAL (
            SELECT id, "orderId", status, "receiptUrl"
            FROM "PaymentTransaction"
            WHERE "invoiceId" = i.id
            ORDER BY "createdAt" DESC
            LIMIT 1
        ) tx ON true
        WHERE i.id = $1
          AND (
            u."authUserId" = $2
            OR (u."authUserId" IS NULL AND u.id = $2)
          )
        LIMIT 1
        `,
        invoiceId,
        owner.authUserId,
    );

    return rows[0] ?? null;
}

export async function createCheckoutSession(input: {
    invoiceId: string;
    owner: PaymentOwnerIdentity;
    origin: string;
    /** 학부모가 고른 결제 수단(CARD·TRANSFER·VIRTUAL_ACCOUNT). 없으면 예전처럼 동작. */
    method?: string | null;
    /** 열린 입금 계좌를 닫고 다른 수단으로 결제하겠다는 학부모 확인(화면 확인 단계를 거친 경우만 true). */
    closeOpenVirtualAccount?: boolean;
}) {
    await ensurePaymentInfrastructure();

    const invoice = await getInvoiceForParent(input.invoiceId, input.owner);
    if (!invoice) {
        return { ok: false as const, error: "청구서를 찾을 수 없습니다." };
    }

    if (invoice.paymentStatus === "PAID" || invoice.invoiceStatus === "PAID") {
        return { ok: false as const, error: "이미 납부가 완료된 청구서입니다.", alreadyPaid: true };
    }

    if (["REFUNDED", "CANCELED"].includes(invoice.paymentStatus) || invoice.invoiceStatus === "CANCELED") {
        return { ok: false as const, error: "취소되었거나 결제할 수 없는 청구서입니다.", closed: true };
    }

    if (Number(invoice.amount) <= 0) {
        return { ok: false as const, error: "결제 금액이 없어 온라인 결제를 시작할 수 없습니다.", closed: true };
    }

    // 랠리즈 사본 청구는 랠리즈에서 결제한다 — 사이트에서도 받으면 이중 납부(원장 결정 D4, 2026-11-09)
    if (invoice.rallyzMirror === true) {
        return { ok: false as const, error: BUNDLE_BLOCK_MESSAGE.RALLYZ_MIRROR, closed: true, rallyzMirror: true as const };
    }

    const config = getPaymentProviderConfig();
    if (!config.providerReady) {
        return {
            ok: false as const,
            error: "온라인 결제 설정이 아직 완료되지 않았습니다.",
            providerReady: false,
            configurationMissing: true,
        };
    }

    // 기한 안의 입금 대기 계좌가 이미 있으면 새 결제를 시작하지 않고 그 계좌를 돌려준다.
    // (두 계좌에 각각 입금되는 이중 납부를 서버에서 막는다 — 화면 버튼만 숨기는 걸로는 부족하다)
    if (config.provider === "TOSS") {
        const vaState = await getVirtualAccountState(invoice.invoiceId);
        if (vaState && !vaState.expired) {
            // 원장 결정(11-08): 다른 수단(카드·계좌이체)을 확인하고 고르면 열린 계좌를 토스에서 닫고 새 결제를 연다.
            // 무통장입금을 다시 고르거나 확인 없이 부르면 예전처럼 그 계좌를 다시 보여 준다.
            const wantsOtherMethod = input.closeOpenVirtualAccount === true
                && (input.method === "CARD" || input.method === "TRANSFER");
            if (!wantsOtherMethod) {
                return {
                    ok: true as const,
                    provider: config.provider,
                    providerLabel: config.providerLabel,
                    providerReady: config.providerReady,
                    openVirtualAccount: vaState,
                };
            }
            const closed = await closeOpenVirtualAccount(invoice.invoiceId);
            if (closed === "PAID") {
                // 닫는 사이 입금이 들어왔다 — 입금이 이긴다. 새 결제를 열지 않는다.
                return { ok: false as const, error: "이미 납부가 완료된 청구서입니다.", alreadyPaid: true };
            }
            if (closed === "FAIL") {
                // 닫았는지 확신할 수 없으면 결제창을 열지 않는다(이중 납부 방지 우선).
                return {
                    ok: false as const,
                    error: "입금 계좌를 닫지 못했습니다. 잠시 후 다시 시도해 주세요.",
                    providerReady: config.providerReady,
                    providerError: true as const,
                    retryable: true,
                };
            }
        }
    }

    const cleanOrigin = input.origin.replace(/\/$/, "");
    const successUrl = makePaymentReturnUrl(
        cleanOrigin,
        config.provider === CAFE24_PAYMENT_PROVIDER ? "/payments/cafe24/success" : "/payments/success",
        invoice.invoiceId,
    );
    const failUrl = makePaymentReturnUrl(cleanOrigin, "/payments/fail", invoice.invoiceId);
    const cafe24WebhookUrl = new URL("/api/payments/cafe24/webhook", cleanOrigin).toString();
    const provider = config.provider;

    const orderName = String(invoice.title || "STIZ 수강료").slice(0, 80);
    // 청구 잠금 안에서 «열린 입금 계좌 재확인 → 주문 재사용/생성»을 한 번에(두 탭 동시 시작 — 보안 리뷰 M2).
    // 묶음 결제 시작·토스 승인 직전과 같은 잠금 키(청구 id)를 쓴다.
    const reserved = await prisma.$transaction(async (db) => {
        await lockPaymentsForCheckout(db, [invoice.paymentId]);
        if (provider === "TOSS" && (await findOpenDepositTxIds(db, [invoice.paymentId], null, Date.now())).length > 0) {
            return { openDeposit: true as const };
        }
        // 금액은 잠금 «밖»에서 읽었다. 그 사이 관리자가 «청구서 수정»(같은 잠금)으로 금액을 바꿨으면
        // 옛 금액으로 주문을 만들지 않고 멈춘다(금액이 같으면 예전 흐름 그대로)
        const freshAmounts = await readCheckoutAmounts(db, [invoice.paymentId]);
        if (checkoutAmountsStale([{ paymentId: invoice.paymentId, amount: Number(invoice.amount) }], freshAmounts)) {
            return { amountChanged: true as const };
        }
        const recentRows = await db.$queryRawUnsafe<CheckoutTransactionRow[]>(
            `SELECT id, "orderId", "orderName", amount, "rawResponse"
             FROM "PaymentTransaction"
             WHERE "invoiceId" = $1
               AND amount = $2
               AND provider = $3
               AND status IN ('READY', 'IN_PROGRESS')
               AND "requestedAt" > NOW() - INTERVAL '30 minutes'
             ORDER BY "createdAt" DESC
             LIMIT 1`,
            input.invoiceId,
            Number(invoice.amount),
            provider,
        );
        const found = recentRows[0];
        if (found) return { openDeposit: false as const, existing: found, transactionId: found.id, orderId: found.orderId };
        const newOrderId = `${provider === CAFE24_PAYMENT_PROVIDER ? "STIZ-C24" : "STIZ"}-${Date.now()}-${String(input.invoiceId).slice(0, 8)}`;
        const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO "PaymentTransaction" (
                id, "paymentId", "invoiceId", "studentId", "parentId", provider,
                "orderId", "orderName", amount, status, "requestedAt", "createdAt", "updatedAt"
            )
            VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4, $5,
                $6, $7, $8, 'READY', NOW(), NOW(), NOW()
            )
            RETURNING id`,
            invoice.paymentId,
            invoice.invoiceId,
            invoice.studentId,
            invoice.parentId,
            provider,
            newOrderId,
            orderName,
            Number(invoice.amount),
        );
        return { openDeposit: false as const, existing: undefined, transactionId: inserted[0]?.id ?? null, orderId: newOrderId };
    });
    if ("amountChanged" in reserved) {
        return { ok: false as const, error: CHECKOUT_AMOUNT_CHANGED_MESSAGE, amountChanged: true as const };
    }
    if (reserved.openDeposit) {
        // 잠금 사이 다른 탭이 입금 계좌를 받았다 — 새 주문 없이 그 계좌를 보여 준다
        const vaState = await getVirtualAccountState(invoice.invoiceId);
        if (vaState && !vaState.expired) {
            return {
                ok: true as const,
                provider: config.provider,
                providerLabel: config.providerLabel,
                providerReady: config.providerReady,
                openVirtualAccount: vaState,
            };
        }
        return { ok: false as const, error: BUNDLE_BLOCK_MESSAGE.OPEN_DEPOSIT_EXISTS, blocked: "OPEN_DEPOSIT_EXISTS" as const };
    }
    const existing = reserved.existing;
    const orderId = reserved.orderId;
    const transactionId = reserved.transactionId;

    await prisma.$executeRawUnsafe(
        `UPDATE "Payment"
         SET "paymentRequestedAt" = NOW(), "updatedAt" = NOW()
         WHERE id = $1`,
        invoice.paymentId,
    );

    if (provider === CAFE24_PAYMENT_PROVIDER) {
        const existingCheckoutUrl = getCafe24PaymentCheckoutUrl(asRecord(existing?.rawResponse));
        if (existingCheckoutUrl) {
            return {
                ok: true as const,
                provider,
                providerLabel: config.providerLabel,
                providerReady: config.providerReady,
                checkoutUrl: existingCheckoutUrl,
                orderId,
                amount: Number(invoice.amount),
                orderName,
                customerName: invoice.parentName || invoice.studentName || "STIZ 학부모",
                customerEmail: invoice.parentEmail,
                successUrl,
                failUrl,
            };
        }

        const payload = buildCafe24PaymentBridgePayload({
            partnerRequestId: orderId,
            invoiceId: invoice.invoiceId,
            invoiceNo: invoice.invoiceNo,
            paymentId: invoice.paymentId,
            amount: Number(invoice.amount),
            orderName,
            customerName: invoice.parentName || invoice.studentName || "STIZ 학부모",
            customerPhone: invoice.parentPhone,
            customerEmail: invoice.parentEmail,
            studentName: invoice.studentName,
            successUrl,
            failUrl,
            webhookUrl: cafe24WebhookUrl,
        });

        try {
            const bridgeResult = await postCafe24PaymentCheckout(payload);
            const checkoutUrl = getCafe24PaymentCheckoutUrl(bridgeResult);
            await prisma.$executeRawUnsafe(
                `UPDATE "PaymentTransaction"
                 SET status = 'IN_PROGRESS',
                     "paymentKey" = COALESCE($2, "paymentKey"),
                     "rawResponse" = $3::jsonb,
                     "updatedAt" = NOW()
                 WHERE id = $1`,
                transactionId,
                bridgeResult.paymentKey ?? bridgeResult.providerOrderId ?? bridgeResult.cafe24OrderId ?? null,
                JSON.stringify({ ...bridgeResult, checkoutUrl }),
            );
            await prisma.$executeRawUnsafe(
                `UPDATE "PaymentInvoice" SET "checkoutUrl" = $2, "updatedAt" = NOW() WHERE id = $1`,
                invoice.invoiceId,
                checkoutUrl,
            );

            return {
                ok: true as const,
                provider,
                providerLabel: config.providerLabel,
                providerReady: config.providerReady,
                checkoutUrl,
                orderId,
                amount: Number(invoice.amount),
                orderName,
                customerName: invoice.parentName || invoice.studentName || "STIZ 학부모",
                customerEmail: invoice.parentEmail,
                successUrl,
                failUrl,
            };
        } catch (error) {
            const bridgeError = error instanceof Cafe24PaymentBridgeError ? error : null;
            await prisma.$executeRawUnsafe(
                `UPDATE "PaymentTransaction"
                 SET status = CASE WHEN $4::boolean THEN status ELSE 'FAILED' END,
                     "failureCode" = $2,
                     "failureMessage" = $3,
                     "updatedAt" = NOW()
                 WHERE id = $1`,
                transactionId,
                bridgeError ? `CAFE24_BRIDGE_${bridgeError.statusCode ?? "CONFIG"}` : "CAFE24_BRIDGE_FAILED",
                error instanceof Error ? error.message : "본사 카페24 결제 요청에 실패했습니다.",
                Boolean(bridgeError?.retryable),
            );
            return {
                ok: false as const,
                error: error instanceof Error ? error.message : "본사 카페24 결제 요청에 실패했습니다.",
                providerReady: config.providerReady,
                providerError: true as const,
                retryable: Boolean(bridgeError?.retryable),
            };
        }
    }

    return {
        ok: true as const,
        provider,
        providerLabel: config.providerLabel,
        providerReady: config.providerReady,
        clientKey: config.clientKey,
        customerKey: makeTossCustomerKey(invoice),
        orderId,
        amount: Number(invoice.amount),
        orderName,
        customerName: invoice.parentName || invoice.studentName || "STIZ 학부모",
        customerEmail: invoice.parentEmail,
        // 가상계좌 발급·입금 안내 문자를 토스가 보낼 번호. 형식이 확실할 때만 넘긴다(틀리면 결제창 오류).
        customerMobilePhone: toTossMobilePhone(invoice.parentPhone),
        successUrl,
        failUrl,
    };
}

/**
 * 청구서의 가장 최근 가상계좌(입금 대기·만료)를 학부모 화면 모양으로 돌려준다. 없으면 null.
 * 저장된 칸 중 발급 정보(virtualAccountIssue)만 읽는다 — secret 해시는 SELECT 하지 않는다.
 * 소유권 확인은 부르는 쪽(getInvoiceForParent 통과 후)이 한다.
 */
export async function getVirtualAccountState(invoiceId: string, nowMs: number = Date.now()): Promise<PublicVirtualAccountView | null> {
    await ensurePaymentInfrastructure();
    // 묶음 주문(PaymentTransactionItem)의 계좌도 본다 — 묶음 계좌 입금 대기 중에 같은 청구를 단건으로 또 결제하지 않게(이중 납부 방지)
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string; issue: unknown }>>(
        `SELECT t.status, t."rawResponse"->'virtualAccountIssue' AS issue
         FROM "PaymentTransaction" t
         WHERE ${txCoversInvoiceSql("t", "$1")}
           AND t.status IN ('${VA_WAITING_STATUS}', '${VA_EXPIRED_STATUS}')
           AND t."rawResponse"->'virtualAccountIssue' IS NOT NULL
         ORDER BY t."createdAt" DESC
         LIMIT 1`,
        invoiceId,
    );
    const row = rows[0];
    const issue = row ? readStoredIssue(row.issue) : null;
    return issue ? toPublicVirtualAccountView(issue, row!.status, nowMs) : null;
}

/**
 * 입금 대기 계좌를 «입금 대기 해제(EXPIRED)»로 정리한다. 청구·청구서는 미납 그대로.
 * 웹훅(만료·취소)과 «다른 수단으로 결제»가 같이 쓴다. 이미 다른 상태면 0 을 돌려준다(멱등).
 */
type VirtualAccountActor = { actorType: "PARENT" | "ADMIN" | "WEBHOOK" | "SYSTEM"; actorId?: string | null };

async function releaseVirtualAccountTx(tx: PaymentTransactionRow, reason: string, actor: VirtualAccountActor) {
    const released = await prisma.$executeRawUnsafe(
        `UPDATE "PaymentTransaction"
         SET status = '${VA_EXPIRED_STATUS}', "failureCode" = $2, "updatedAt" = NOW()
         WHERE id = $1 AND status = '${VA_WAITING_STATUS}'`,
        tx.id, `VIRTUAL_ACCOUNT_${reason}`,
    );
    if (released === 1) {
        await recordPaymentAudit({
            paymentId: tx.paymentId,
            invoiceId: tx.invoiceId,
            transactionId: tx.id,
            actorType: actor.actorType,
            actorId: actor.actorId ?? (actor.actorType === "PARENT" ? tx.parentId : null),
            action: "VIRTUAL_ACCOUNT_RELEASED",
            message: actor.actorType === "PARENT"
                ? "Virtual account closed because the parent chose another payment method"
                : actor.actorType === "ADMIN"
                    ? "Virtual account closed by admin"
                    : "Toss virtual account expired or canceled before deposit",
            metadata: { provider: "TOSS", orderId: tx.orderId, tossStatus: reason },
        });
        revalidatePaymentCaches();
    }
    return released;
}

/**
 * 토스 재조회로 «입금 완료(DONE)»가 확인된 가상계좌를 납부 완료로 반영한다.
 * 금액·면세·이중 납부 검사는 웹훅과 같은 규칙(decideVirtualAccountWebhook). 반영 못 하면 감사 기록 + 원장 알림.
 */
async function payVerifiedVirtualAccount(tx: PaymentTransactionRow, verified: TossPaymentResult, depositedAt: string | null) {
    // 묶음 주문이면 묶인 청구 중 하나라도 납부·환불된 상태를 본다(입금 전에 다른 방법으로 낸 청구 = 원장 확인)
    const statusRows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        TX_PAYMENT_STATUS_SQL,
        tx.paymentId,
        tx.id,
    );
    const decision = decideVirtualAccountWebhook({
        isDepositCallback: false,
        // 우리가 토스 API 를 직접 불러 받은 결과라 secret 대조 대상이 아니다(웹훅 쪽은 부르기 전에 이미 대조했다)
        secretCheck: "NOT_STORED",
        tx: { orderId: tx.orderId, amount: Number(tx.amount), status: tx.status, paymentKey: tx.paymentKey ?? null },
        paymentStatus: statusRows[0]?.status ?? null,
        verified,
    });
    if (decision.action === "ALREADY_DONE") return { ok: true as const };
    if (decision.action !== "PAY") {
        const code = decision.action === "REJECT" || decision.action === "IGNORE" ? decision.code : `VIRTUAL_ACCOUNT_${decision.action}`;
        await recordVirtualAccountReview(tx, code, decision.action === "REJECT" && decision.alert);
        return { ok: false as const, error: code };
    }
    // 입금 시각: 토스 조회의 approvedAt(입금 완료 시각) → 없으면 알림 본문 createdAt(시간대 없는 KST) → 없으면 지금.
    const paidAt = parseTossTimestamp(verified.approvedAt) ?? parseTossTimestamp(depositedAt);
    const finalized = await finalizeVerifiedTossPayment({ tx, payment: verified, actorType: "WEBHOOK", paidAt });
    if (finalized.ok) {
        revalidatePaymentCaches();
        return { ok: true as const };
    }
    // 잠금 안에서 다시 보니 이미 납부됐다 등 — 납부 처리하지 않고 알린다.
    await recordVirtualAccountReview(tx, finalized.error, true);
    return { ok: false as const, error: finalized.error };
}

/**
 * 토스 결제 취소 API(POST /v1/payments/{paymentKey}/cancel) — 입금 전 가상계좌를 닫는다.
 * 입금 전(WAITING_FOR_DEPOSIT) 취소라 환불 계좌(refundReceiveAccount)를 보내지 않는다.
 * 성공 여부는 응답이 아니라 부르는 쪽의 재조회로 판정한다.
 *
 * ⚠️ refundReceiveAccount·cancelAmount 절대 넣지 말 것 — 입금 완료 건 환불을 토스가 거절하게 하는 안전장치.
 *    닫는 사이 입금이 먼저 들어오면 토스가 이 요청을 거절하고, 재조회가 DONE 을 보고 납부로 반영한다.
 *    두 키를 넣으면 그 입금이 조용히 환불돼 버린다. (tests/toss-virtual-account.test.mjs 가 본문을 검사한다)
 */
async function requestTossVirtualAccountCancel(tx: PaymentTransactionRow, actorType: VirtualAccountActor["actorType"]): Promise<boolean> {
    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey || !tx.paymentKey) return false;
    try {
        const response = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(tx.paymentKey)}/cancel`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${encodeTossSecret(secretKey)}`,
                "Content-Type": "application/json",
                // 같은 10분 안의 연타는 토스에서 한 번만, 10분 뒤 재시도는 새 시도로(실패 응답에 갇히지 않게)
                "Idempotency-Key": makeUuidFromSeed(virtualAccountCancelIdempotencySeed(tx.id, tx.paymentKey, Date.now())),
            },
            // 누가 닫았는지 토스 쪽 기록에도 남긴다(학부모·원장·시스템)
            // ⚠️ refundReceiveAccount·cancelAmount 절대 넣지 말 것 — 입금 완료 건 환불을 토스가 거절하게 하는 안전장치
            body: JSON.stringify({ cancelReason: virtualAccountCancelReason(actorType) }),
            cache: "no-store",
            // 토스가 응답하지 않으면 10초 뒤 포기 — 재조회가 결과를 판정한다
            signal: AbortSignal.timeout(TOSS_FETCH_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * 학부모가 다른 수단을 고를 때 청구서의 열린 입금 계좌를 닫는다.
 *  - CLOSED: 닫힘 확인(재조회 CANCELED/EXPIRED) → 새 결제 진행
 *  - PAID:   닫는 사이 입금이 먼저 들어옴(입금이 이긴다) → 납부 반영, 새 결제 막음
 *  - FAIL:   닫혔는지 확신 못 함 → 새 결제 막음(«잠시 후 다시»)
 */
async function closeOpenVirtualAccount(
    invoiceId: string,
    actor: VirtualAccountActor = { actorType: "PARENT" },
): Promise<"CLOSED" | "PAID" | "FAIL"> {
    // 묶음 주문의 계좌도 닫는다(이 청구서가 항목으로 든 거래) — 열린 계좌 조회(getVirtualAccountState)와 같은 범위
    const rows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT t.* FROM "PaymentTransaction" t
         WHERE ${txCoversInvoiceSql("t", "$1")} AND t.status = '${VA_WAITING_STATUS}'
         ORDER BY t."createdAt" DESC
         LIMIT 1`,
        invoiceId,
    );
    const tx = rows[0];

    // 그사이 웹훅이 먼저 처리했으면(입금 또는 만료) 거래가 없다 → 아래 청구 상태 재확인이 판정한다.
    const outcome: "CLOSED" | "PAID" | "FAIL" = tx ? await closeVirtualAccountTransaction(tx, actor) : "CLOSED";

    // 마지막으로 청구 상태를 다시 본다 — 닫는 사이 다른 경로(웹훅·현장)로 납부됐으면 새 결제를 막는다.
    const statusRows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT p.status FROM "PaymentInvoice" i JOIN "Payment" p ON p.id = i."paymentId" WHERE i.id = $1`,
        invoiceId,
    );
    if (statusRows[0]?.status === "PAID") return "PAID";
    return outcome;
}

/**
 * 입금 대기 거래 1건을 토스에서 닫는다(취소 → 재조회로 닫힘 확인). 청구서 단위 닫기와 묶음 결제 시작이 같이 쓴다.
 *  - CLOSED: 닫힘 확인 · PAID: 닫는 사이 입금이 먼저 들어와 납부 반영 · FAIL: 닫혔는지 확신 못 함
 */
async function closeVirtualAccountTransaction(
    tx: PaymentTransactionRow,
    actor: VirtualAccountActor,
): Promise<"CLOSED" | "PAID" | "FAIL"> {
    let outcome: "CLOSED" | "PAID" | "FAIL" = "FAIL";
    if (tx.paymentKey) {
        const first = await getVerifiedTossPayment(tx.paymentKey, tx.orderId);
        let verified = first.kind === "verified" ? first.payment : null;
        let step = first.kind === "retryable" ? "FAIL" : decideVirtualAccountClose(verified, tx);
        if (step === "CANCEL") {
            await requestTossVirtualAccountCancel(tx, actor.actorType);
            // 취소 응답만 믿지 않고 다시 조회해 «닫힘»을 확인한다(그사이 입금됐을 수도 있다).
            const after = await getVerifiedTossPayment(tx.paymentKey, tx.orderId);
            verified = after.kind === "verified" ? after.payment : null;
            step = after.kind === "retryable" ? "FAIL" : decideVirtualAccountClose(verified, tx);
            if (step === "CANCEL") step = "FAIL"; // 여전히 입금 대기 = 닫기 실패
        }
        if (step === "RELEASED" && verified) {
            await releaseVirtualAccountTx(tx, String(verified.status), actor);
            outcome = "CLOSED";
        } else if (step === "PAID" && verified) {
            await payVerifiedVirtualAccount(tx, verified, null);
            outcome = "PAID";
        } else if (step === "FAIL") {
            // 부분 취소처럼 자동으로 못 푸는 상태면 원장 확인으로 넘긴다(닫기 실패 = 새 결제 막음)
            await reviewUnclosableVirtualAccount(tx, verified);
        }
    }
    return outcome;
}

/**
 * 원장이 수납 목록에서 «가상계좌 닫기». 학부모의 «다른 방법으로 결제»와 같은 닫기 함수를 쓴다.
 * 권한 확인은 부르는 쪽(서버 액션 — 원장만)이 한다.
 */
export async function closeVirtualAccountByAdmin(input: { paymentId: string; adminUserId: string }) {
    await ensurePaymentInfrastructure();
    const rows = await prisma.$queryRawUnsafe<Array<{ invoiceId: string }>>(
        `SELECT i.id AS "invoiceId" FROM "PaymentInvoice" i WHERE i."paymentId" = $1 LIMIT 1`,
        input.paymentId,
    );
    const invoiceId = rows[0]?.invoiceId;
    if (!invoiceId) return { ok: false as const, message: "청구서를 찾을 수 없습니다." };
    const open = await getVirtualAccountState(invoiceId);
    if (!open || open.expired) return { ok: false as const, message: "닫을 입금 대기 계좌가 없습니다." };
    const closed = await closeOpenVirtualAccount(invoiceId, { actorType: "ADMIN", actorId: input.adminUserId });
    // 실패가 아니라 «입금이 이겼다» — 화면은 성공 톤으로 보인다(paid: true)
    if (closed === "PAID") return { ok: false as const, paid: true as const, message: "이미 입금돼 납부 완료로 반영했습니다. 계좌는 닫지 않았습니다." };
    if (closed === "FAIL") return { ok: false as const, message: "토스에서 계좌를 닫지 못했습니다. 잠시 후 다시 시도해 주세요." };
    return { ok: true as const };
}

/**
 * 매일 점검(cron) — 입금 대기 거래를 토스에 다시 물어 놓친 입금·만료를 줍는다.
 * 웹훅이 끝내 안 왔거나 재조회가 늦었던 건이 영구 미납으로 남지 않게 하는 안전망.
 * 같은 판정 함수(decideVirtualAccountClose)와 같은 반영 함수를 써서 여러 번 돌아도 결과가 같다.
 */
export async function sweepWaitingVirtualAccounts(limit = 100, budgetMs = SWEEP_TIME_BUDGET_MS) {
    await ensurePaymentInfrastructure();
    const rows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT * FROM "PaymentTransaction"
         WHERE status = '${VA_WAITING_STATUS}' AND "paymentKey" IS NOT NULL
         ORDER BY "createdAt" ASC
         LIMIT $1`,
        limit,
    );
    const startedAt = Date.now();
    const result = { checked: 0, paid: 0, released: 0, waiting: 0, failed: 0, deferred: 0 };
    for (const tx of rows) {
        // cron 제한 시간(maxDuration 60초) 안에 끝내려고, 시간 예산을 넘기면 남은 건은 다음 점검으로 미룬다
        if (Date.now() - startedAt > budgetMs) {
            result.deferred = rows.length - result.checked;
            break;
        }
        result.checked += 1;
        // 한 건이 터져도(DB·네트워크) 실패로 세고 나머지는 계속 본다
        try {
            const lookup = await getVerifiedTossPayment(tx.paymentKey ?? null, tx.orderId);
            const verified = lookup.kind === "verified" ? lookup.payment : null;
            const step = lookup.kind === "retryable" ? "FAIL" : decideVirtualAccountClose(verified, tx);
            if (step === "PAID" && verified) {
                const paid = await payVerifiedVirtualAccount(tx, verified, null);
                if (paid.ok) result.paid += 1; else result.failed += 1;
            } else if (step === "RELEASED" && verified) {
                await releaseVirtualAccountTx(tx, String(verified.status), { actorType: "SYSTEM" });
                result.released += 1;
            } else if (step === "CANCEL") {
                result.waiting += 1; // 아직 입금 전 — 그대로 둔다
            } else {
                result.failed += 1;
                // 부분 취소 등은 원장 확인 기록(같은 사유는 한 번만 — 매일 돌아도 알림이 쌓이지 않는다)
                if (step === "FAIL") await reviewUnclosableVirtualAccount(tx, verified);
            }
        } catch (error) {
            result.failed += 1;
            console.error(
                "[virtual-account-sweep] tx failed:",
                tx.id,
                error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
            );
        }
    }
    return result;
}

/** 닫기·매일 점검이 FAIL 일 때, 원장 확인이 필요한 상태(부분 취소)면 확인 기록 + 알림을 남긴다. */
async function reviewUnclosableVirtualAccount(tx: PaymentTransactionRow, verified: TossPaymentResult | null) {
    const code = virtualAccountCloseReviewCode(verified);
    if (code) await recordVirtualAccountReview(tx, code, true);
}

/**
 * 가상계좌 발급(승인 응답 WAITING_FOR_DEPOSIT)을 거래에 기록한다. 청구서·청구는 미납 그대로 둔다.
 * secret 원문은 저장하지 않고 해시만 남긴다(buildIssuedRawResponse).
 */
async function recordVirtualAccountIssued(input: {
    tx: PaymentTransactionRow;
    payment: TossPaymentResult;
    actorType: "PARENT" | "WEBHOOK";
}): Promise<PublicVirtualAccountView | "PAID" | null> {
    const issue = extractVirtualAccountIssue(input.payment, Number(input.tx.amount));
    const paymentKey = readString(input.payment.paymentKey);
    if (!issue || !paymentKey) return null;

    const updated = await prisma.$executeRawUnsafe(
        `UPDATE "PaymentTransaction"
         SET status = '${VA_WAITING_STATUS}', "paymentKey" = $2, method = COALESCE($3, method),
             "rawResponse" = $4::jsonb, "failureCode" = NULL, "failureMessage" = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND status IN ('READY', 'IN_PROGRESS', '${VA_WAITING_STATUS}')`,
        input.tx.id,
        paymentKey,
        readString(input.payment.method),
        JSON.stringify(buildIssuedRawResponse(input.payment, issue)),
    );
    if (updated === 1) {
        await recordPaymentAudit({
            paymentId: input.tx.paymentId,
            invoiceId: input.tx.invoiceId,
            transactionId: input.tx.id,
            actorType: input.actorType,
            actorId: input.actorType === "PARENT" ? input.tx.parentId : null,
            action: "VIRTUAL_ACCOUNT_ISSUED",
            message: "Toss virtual account issued; waiting for deposit",
            metadata: { provider: "TOSS", orderId: input.tx.orderId, bankName: issue.bankName, dueDate: issue.dueDate },
        });
        revalidatePaymentCaches();
    } else {
        // 0건 = 그사이 다른 경로가 거래를 바꿨다. 입금 알림이 먼저 와 DONE 이면 «납부 완료»로 답한다.
        const current = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
            `SELECT status FROM "PaymentTransaction" WHERE id = $1`,
            input.tx.id,
        );
        if (current[0]?.status === "DONE") return "PAID";
    }
    return toPublicVirtualAccountView(issue, VA_WAITING_STATUS, Date.now());
}

/** 가상계좌 이상 상황(금액 불일치·이중 납부 등)을 원장 슬랙 DM 으로 알린다. 실패해도 웹훅 처리는 계속한다. */
async function alertVirtualAccountIssue(text: string) {
    const owner = (process.env.SLACK_OWNER_USER_ID || "").trim();
    if (!owner) {
        console.warn(`[virtual-account] 원장 슬랙 ID 없음 — 알림 생략: ${text}`);
        return;
    }
    try {
        await postMessage({ channel: owner, text });
    } catch (error) {
        console.error("[virtual-account] 슬랙 알림 실패:", error instanceof Error ? error.message : error);
    }
}

export function encodeTossSecret(secretKey: string) {
    return Buffer.from(`${secretKey}:`).toString("base64");
}

type TossPaymentResult = Record<string, unknown> & {
    paymentKey?: string;
    orderId?: string;
    status?: string;
    totalAmount?: number;
    method?: string;
};

type TossLookupResult =
    | { kind: "verified"; payment: TossPaymentResult }
    | { kind: "rejected"; status: number }
    | { kind: "retryable"; reason: string };

async function requestTossPayment(path: string): Promise<TossLookupResult> {
    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey) return { kind: "retryable", reason: "TOSS_SECRET_NOT_CONFIGURED" };

    try {
        const response = await fetch(`https://api.tosspayments.com${path}`, {
            method: "GET",
            headers: { Authorization: `Basic ${encodeTossSecret(secretKey)}` },
            cache: "no-store",
            // 응답 없는 토스 조회에 cron·화면이 매달리지 않게 10초 뒤 포기(→ retryable)
            signal: AbortSignal.timeout(TOSS_FETCH_TIMEOUT_MS),
        });
        if (response.status === 429 || response.status >= 500) {
            return { kind: "retryable", reason: `TOSS_LOOKUP_${response.status}` };
        }
        if (!response.ok) return { kind: "rejected", status: response.status };
        return { kind: "verified", payment: await response.json() as TossPaymentResult };
    } catch {
        return { kind: "retryable", reason: "TOSS_LOOKUP_NETWORK_ERROR" };
    }
}

export async function getVerifiedTossPayment(paymentKey: string | null, orderId: string | null) {
    if (!paymentKey && !orderId) return { kind: "rejected", status: 400 } as const;
    const path = paymentKey
        ? `/v1/payments/${encodeURIComponent(paymentKey)}`
        : `/v1/payments/orders/${encodeURIComponent(orderId!)}`;
    return requestTossPayment(path);
}

async function finalizeVerifiedTossPayment(input: {
    tx: PaymentTransactionRow;
    payment: TossPaymentResult;
    actorType: "PARENT" | "WEBHOOK";
    actorId?: string | null;
    /** 실제 납부 시각(가상계좌 = 입금 시각). 없으면 지금. */
    paidAt?: Date | null;
}) {
    const paymentKey = readString(input.payment.paymentKey);
    const orderId = readString(input.payment.orderId);
    const amount = readNumber(input.payment.totalAmount);
    if (
        input.payment.status !== "DONE"
        || !paymentKey
        || orderId !== input.tx.orderId
        || amount !== Number(input.tx.amount)
    ) {
        return { ok: false as const, error: "TOSS_PAYMENT_NOT_VERIFIED" };
    }

    // 면세 처리 확인 — 승인·복구·웹훅이 모두 이 함수를 거친다. 면세가 아니어도 결제는 그대로 반영하고
    // 경고만 남긴다(응답 원문은 아래 rawResponse 에 taxFreeAmount·suppliedAmount·vat 째로 저장된다).
    const taxFreeWarning = describeTaxFreeMismatch(input.payment);
    if (taxFreeWarning) console.warn(`[toss-tax-free] orderId=${orderId} ${taxFreeWarning}`);

    const receiptUrl = readString(asRecord(input.payment.receipt).url)
        ?? readString(asRecord(input.payment.card).receiptUrl);

    // 묶음 주문(항목 있음) — 묶인 청구 전부를 한 트랜잭션에서 잠그고 전부 아니면 전무로 반영한다.
    if (await hasBundleItems(prisma, input.tx.id)) {
        return finalizeVerifiedBundlePayment({ ...input, paymentKey, orderId: orderId!, receiptUrl });
    }

    return prisma.$transaction(async (db) => {
        const locked = await db.$queryRawUnsafe<PaymentTransactionRow[]>(
            `SELECT tx.*, i.status AS "invoiceStatus", p.status AS "paymentStatus"
             FROM "PaymentTransaction" tx
             JOIN "PaymentInvoice" i ON i.id = tx."invoiceId"
             JOIN "Payment" p ON p.id = tx."paymentId"
             WHERE tx.id = $1
             FOR UPDATE OF tx, i, p`,
            input.tx.id,
        );
        const current = locked[0];
        if (!current) return { ok: false as const, error: "TRANSACTION_NOT_FOUND" };
        if (current.status === "DONE" && current.paymentStatus === "PAID" && current.invoiceStatus === "PAID") {
            return { ok: true as const, alreadyConfirmed: true };
        }
        // 가상계좌: 입금 전에 다른 수단으로 이미 납부된 청구면 덮어쓰지 않는다(이중 납부 — 원장 확인 필요).
        const isVirtualAccount = current.status === VA_WAITING_STATUS || current.status === VA_EXPIRED_STATUS
            || input.payment.method === VA_METHOD;
        if (isVirtualAccount && (current.paymentStatus === "PAID" || current.invoiceStatus === "PAID")) {
            return { ok: false as const, error: "VIRTUAL_ACCOUNT_ALREADY_PAID" };
        }
        if (!["READY", "IN_PROGRESS", "DONE", VA_WAITING_STATUS, VA_EXPIRED_STATUS].includes(current.status)
            || ["REFUNDED", "CANCELED"].includes(current.paymentStatus ?? "")
            || ["REFUNDED", "CANCELED"].includes(current.invoiceStatus ?? "")
            || current.status === "CANCELED") {
            return { ok: false as const, error: "PAYMENT_ALREADY_CLOSED" };
        }

        // 납부 시각: ISO(UTC) 문자열로 넘긴다. "paidDate" 는 시간대 없는(timestamp) 칸이라
        // UTC 벽시계로 바꿔 넣고(AT TIME ZONE 'UTC'), 나머지 timestamptz 칸은 그대로 넣는다.
        const paidAtIso = input.paidAt && !Number.isNaN(input.paidAt.getTime()) ? input.paidAt.toISOString() : null;
        const paymentUpdated = await db.$executeRawUnsafe(
            `UPDATE "Payment" SET status = 'PAID', "paidDate" = COALESCE("paidDate", ($6::timestamptz AT TIME ZONE 'UTC'), NOW()),
             method = COALESCE($2, method), "paidProvider" = 'TOSS', "providerOrderId" = $3,
             "providerPaymentKey" = $4, "receiptUrl" = COALESCE($5, "receiptUrl"), "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('PENDING', 'OVERDUE', 'PAID')`,
            current.paymentId, readString(input.payment.method), orderId, paymentKey, receiptUrl, paidAtIso,
        );
        const invoiceUpdated = await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoice" SET status = 'PAID', "paidAt" = COALESCE("paidAt", $2::timestamptz, NOW()), "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('ISSUED', 'SENT', 'OVERDUE', 'PAID')`,
            current.invoiceId, paidAtIso,
        );
        const transactionUpdated = await db.$executeRawUnsafe(
            `UPDATE "PaymentTransaction" SET status = 'DONE', "paymentKey" = $2,
             method = COALESCE($3, method), "receiptUrl" = COALESCE($4, "receiptUrl"),
             "approvedAt" = COALESCE("approvedAt", $6::timestamptz, NOW()), "rawResponse" = $5::jsonb, "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('READY', 'IN_PROGRESS', 'DONE', '${VA_WAITING_STATUS}', '${VA_EXPIRED_STATUS}')`,
            current.id, paymentKey, readString(input.payment.method), receiptUrl,
            JSON.stringify(stripPaymentSecret(input.payment)), paidAtIso,
        );
        if (paymentUpdated !== 1 || invoiceUpdated !== 1 || transactionUpdated !== 1) {
            throw new Error("PAYMENT_LEDGER_STATE_CONFLICT");
        }
        await db.$executeRawUnsafe(
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'PAYMENT_MARK_PAID', 'Verified Toss payment marked as paid', $6::jsonb, NOW())`,
            current.paymentId, current.invoiceId, current.id, input.actorType, input.actorId ?? null,
            JSON.stringify({ provider: "TOSS", orderId, paymentKey: "[verified]", method: readString(input.payment.method), paidAt: paidAtIso }),
        );
        return { ok: true as const, alreadyConfirmed: false };
    });
}

/**
 * 묶음 주문의 납부 반영(finalizeVerifiedTossPayment 의 «항목 있음» 갈래). 검증(DONE·주문·금액)은 부른 쪽이 이미 했다.
 * - 한 트랜잭션: 거래 + 묶인 청구·청구서 전부 FOR UPDATE → 판정 → 건마다 조건부 UPDATE(하나라도 0행이면 전부 되돌림).
 * - 반영 못 한 경우:
 *     무통장입금 → 오류 코드만 돌려준다. 부른 쪽(payVerifiedVirtualAccount)이 «확인 필요» 기록 + 원장 알림을 남긴다.
 *     카드·계좌이체 → 토스에서는 이미 돈이 나갔다. 여기서 «묶음 결제 확인 필요» 기록 + 원장 알림(환불 판단).
 */
async function finalizeVerifiedBundlePayment(input: {
    tx: PaymentTransactionRow;
    payment: TossPaymentResult;
    actorType: "PARENT" | "WEBHOOK";
    actorId?: string | null;
    paidAt?: Date | null;
    paymentKey: string;
    orderId: string;
    receiptUrl: string | null;
}): Promise<{ ok: true; alreadyConfirmed: boolean } | { ok: false; error: string }> {
    const isVirtualAccount = input.tx.status === VA_WAITING_STATUS || input.tx.status === VA_EXPIRED_STATUS
        || input.payment.method === VA_METHOD;
    const paidAtIso = input.paidAt && !Number.isNaN(input.paidAt.getTime()) ? input.paidAt.toISOString() : null;
    let result: { ok: true; alreadyConfirmed: boolean } | { ok: false; error: string };
    try {
        const done = await prisma.$transaction((db) => finalizeBundleInTx(db, {
            transactionId: input.tx.id,
            orderId: input.orderId,
            paymentKey: input.paymentKey,
            method: readString(input.payment.method),
            receiptUrl: input.receiptUrl,
            paidAtIso,
            rawResponse: stripPaymentSecret(input.payment),
            methodIsVirtualAccount: input.payment.method === VA_METHOD,
            actorType: input.actorType,
            actorId: input.actorId ?? null,
        }));
        result = done.ok ? { ok: true, alreadyConfirmed: done.alreadyConfirmed } : { ok: false, error: done.error };
    } catch (error) {
        // 조건부 UPDATE 0행 = 잠금 사이 청구가 바뀜 → 트랜잭션 전체가 이미 되돌아갔다
        if (!(error instanceof Error) || !error.message.startsWith(BUNDLE_LEDGER_CONFLICT)) throw error;
        result = { ok: false, error: isVirtualAccount ? "VIRTUAL_ACCOUNT_ALREADY_PAID" : "BUNDLE_ITEM_ALREADY_PAID" };
    }
    if (result.ok) {
        revalidatePaymentCaches();
    } else if (!isVirtualAccount) {
        await recordBundlePaymentReview(input.tx, result.error);
    }
    return result;
}

/**
 * 카드·계좌이체 묶음 결제가 토스에서는 완료됐는데 장부에 반영하지 못한 경우 — 감사 기록 + 원장 슬랙 DM.
 * 같은 거래·같은 사유는 한 번만(성공 화면 새로고침·웹훅 재전송 대비).
 */
async function recordBundlePaymentReview(tx: PaymentTransactionRow, code: string, headline?: string) {
    const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
         SELECT gen_random_uuid()::text, $1, $2, $3, 'SYSTEM', NULL, 'PAYMENT_BUNDLE_REVIEW', $4, $5::jsonb, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM "PaymentAuditLog"
           WHERE "transactionId" = $3 AND action = 'PAYMENT_BUNDLE_REVIEW' AND message = $4
         )
         RETURNING id`,
        tx.paymentId, tx.invoiceId, tx.id, code,
        JSON.stringify({ provider: "TOSS", orderId: tx.orderId, amount: Number(tx.amount) }),
    );
    if (inserted.length > 0) {
        const text = headline
            ?? `[묶음 결제 확인 필요] 토스 결제는 완료됐지만 묶은 청구 중 이미 납부·취소·금액 변경된 건이 있어 장부에 반영하지 않았습니다(${code}). 환불 여부를 확인해 주세요.`;
        await alertVirtualAccountIssue(
            `${text}\n주문 ${tx.orderId} · ${Number(tx.amount).toLocaleString("ko-KR")}원 · /admin/finance`,
        );
    }
}

/**
 * 토스에서 전액 취소된 결제를 장부에 반영한다(청구 → 환불, 청구서 → 취소, 거래 → 취소).
 * 토스 재조회로 전액 취소가 확인된 뒤에만 부른다. 이미 반영됐으면 아무것도 하지 않는다(멱등).
 * 묶음 주문이면 묶인 청구 전부를 한 트랜잭션에서 환불 처리한다(refundBundleInTx).
 */
async function applyVerifiedTossFullCancel(input: { tx: PaymentTransactionRow; payment: TossPaymentResult }) {
    if (await hasBundleItems(prisma, input.tx.id)) {
        const applied = await prisma.$transaction((db) => refundBundleInTx(db, {
            transactionId: input.tx.id,
            rawResponse: stripPaymentSecret(input.payment),
        }));
        if (applied.ok && !applied.alreadyApplied) revalidatePaymentCaches();
        if (applied.ok && applied.skipped.length > 0) {
            // 이 주문으로 낸 게 아닌(다른 방법으로 다시 낸) 청구는 환불하지 않았다 — 원장 확인(보안 리뷰 L1)
            await recordBundlePaymentReview(input.tx, "BUNDLE_REFUND_SKIPPED",
                `[묶음 결제 확인 필요] 토스 전액 취소를 반영하면서 다른 방법으로 다시 낸 청구 ${applied.skipped.length}건은 환불 처리하지 않았습니다. 장부를 확인해 주세요.`);
        }
        return applied.ok
            ? { ok: true as const, alreadyApplied: applied.alreadyApplied }
            : { ok: false as const, error: applied.error };
    }
    return prisma.$transaction(async (db) => {
        const locked = await db.$queryRawUnsafe<PaymentTransactionRow[]>(
            `SELECT tx.*, i.status AS "invoiceStatus", p.status AS "paymentStatus"
             FROM "PaymentTransaction" tx
             JOIN "PaymentInvoice" i ON i.id = tx."invoiceId"
             JOIN "Payment" p ON p.id = tx."paymentId"
             WHERE tx.id = $1
             FOR UPDATE OF tx, i, p`,
            input.tx.id,
        );
        const current = locked[0];
        if (!current) return { ok: false as const, error: "TRANSACTION_NOT_FOUND" };
        if (current.status === "CANCELED" && current.paymentStatus === "REFUNDED") {
            return { ok: true as const, alreadyApplied: true };
        }
        // 납부 완료된 거래만 환불로 바꾼다. 결제 전 거래의 취소는 장부에 반영할 게 없다.
        if (current.status !== "DONE" || current.paymentStatus !== "PAID") {
            return { ok: false as const, error: "PAYMENT_NOT_PAID" };
        }

        await db.$executeRawUnsafe(
            // 관리자 화면의 환불 처리와 같이 납부일을 비운다(POS 대조가 paidDate 로 납부 건을 고른다).
            `UPDATE "Payment" SET status = 'REFUNDED', "paidDate" = NULL, "updatedAt" = NOW() WHERE id = $1 AND status = 'PAID'`,
            current.paymentId,
        );
        await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = COALESCE("canceledAt", NOW()), "updatedAt" = NOW()
             WHERE id = $1 AND status <> 'CANCELED'`,
            current.invoiceId,
        );
        await db.$executeRawUnsafe(
            `UPDATE "PaymentTransaction" SET status = 'CANCELED', "rawResponse" = $2::jsonb, "updatedAt" = NOW()
             WHERE id = $1 AND status = 'DONE'`,
            current.id, JSON.stringify(stripPaymentSecret(input.payment)),
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, 'WEBHOOK', NULL, 'PAYMENT_REFUNDED', 'Verified Toss full cancel marked as refunded', $4::jsonb, NOW())`,
            current.paymentId, current.invoiceId, current.id,
            JSON.stringify({ provider: "TOSS", orderId: current.orderId, paymentKey: "[verified]" }),
        );
        return { ok: true as const, alreadyApplied: false };
    });
}

/** 관리자 환불 취소 요청의 Idempotency-Key 시드 — 같은 10분 안 연타는 토스에서 한 번만, 10분 뒤 재시도는 새 시도 */
function adminRefundIdempotencySeed(txId: string, paymentKey: string, nowMs: number): string {
    // 날짜 함수 없이 10분 칸 번호만 쓴다(시간대가 끼어들 일이 없게)
    return `stiz-admin-refund:${txId}:${paymentKey}:${Math.floor(nowMs / 600_000)}`;
}

/** 토스 오류 응답에서 원장이 읽을 문장만 뽑는다(없으면 null) */
export async function readTossErrorMessage(response: Response): Promise<string | null> {
    try {
        const body = asRecord(await response.json());
        return readString(body.message)?.slice(0, 200) ?? null;
    } catch {
        return null;
    }
}

export type AdminTossRefundResult =
    | { ok: true; paymentIds: string[]; alreadyApplied: boolean }
    | { ok: false; message: string };

/**
 * 관리자 수납 목록 «선택 항목 환불» — 토스 온라인 결제 1건(묶음이면 주문 1건 = 청구 N건)을 전액 취소한다.
 * 흐름: 토스 재조회(완료·금액·부분취소 없음 확인) → 감사 기록 → 토스 결제 취소 API(전액, cancelAmount 없음)
 *      → 다시 조회해 «전액 취소»가 확인될 때만 applyVerifiedTossFullCancel(웹훅과 같은 반영 함수, 묶음이면 묶인 청구 전부).
 * 응답만 믿지 않는다 — 장부는 재조회 결과로만 바뀐다. 웹훅이 뒤에 와도 같은 함수라 두 번 바뀌지 않는다(멱등).
 * 권한 확인은 부르는 쪽(서버 액션 — 원장만)이 한다. paymentIds = 화면이 고른 청구(묶음 전부를 골랐는지 서버가 다시 본다).
 */
export async function refundTossPaymentByAdmin(input: {
    transactionId: string;
    paymentIds: string[];
    adminUserId: string;
}): Promise<AdminTossRefundResult> {
    await ensurePaymentInfrastructure();
    const rows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT * FROM "PaymentTransaction" WHERE id = $1 AND provider = 'TOSS' LIMIT 1`,
        input.transactionId,
    );
    const tx = rows[0];
    if (!tx || !tx.paymentKey) return { ok: false, message: "토스 결제 기록을 찾지 못했어요." };

    // 이 주문에 묶인 청구 전부(항목 없는 단건 = 대표 청구 하나) — 화면이 고른 것과 정확히 같아야 한다
    const bundle = await hasBundleItems(prisma, tx.id);
    const coveredIds = bundle
        ? (await prisma.$queryRawUnsafe<Array<{ paymentId: string }>>(
            `SELECT "paymentId" FROM "PaymentTransactionItem" WHERE "transactionId" = $1 ORDER BY position`,
            tx.id,
        )).map((row) => row.paymentId)
        : [tx.paymentId];
    const picked = new Set(input.paymentIds);
    if (coveredIds.length !== picked.size || !coveredIds.every((id) => picked.has(id))) {
        return { ok: false, message: `묶음으로 낸 결제는 함께 환불해야 해요(${coveredIds.length}건).` };
    }

    // ① 지금 토스 상태 확인 — 이미 전액 취소돼 있으면(상점관리자에서 먼저 취소 등) 장부만 맞춘다
    const before = await getVerifiedTossPayment(tx.paymentKey, tx.orderId);
    if (before.kind !== "verified") return { ok: false, message: "토스에서 결제를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
    const beforeCancel = classifyTossCancel(before.payment, tx, tx.paymentKey);
    if (beforeCancel.kind === "FULL_CANCEL") {
        const applied = await applyVerifiedTossFullCancel({ tx, payment: before.payment });
        return applied.ok
            ? { ok: true, paymentIds: coveredIds, alreadyApplied: applied.alreadyApplied }
            : { ok: false, message: "토스에서는 취소됐지만 장부 반영이 막혔어요. 수납 기록을 확인해 주세요." };
    }
    if (beforeCancel.kind === "PARTIAL_CANCEL") {
        return { ok: false, message: "토스에서 일부만 취소된 결제예요. 토스 상점관리자에서 확인해 주세요." };
    }
    const verified = before.payment;
    if (tx.status !== "DONE" || verified.status !== "DONE" || verified.orderId !== tx.orderId
        || Number(verified.totalAmount) !== Number(tx.amount)
        || (verified.balanceAmount != null && Number(verified.balanceAmount) !== Number(tx.amount))) {
        return { ok: false, message: "토스 결제 상태가 장부와 달라 취소하지 않았어요. 토스 상점관리자에서 확인해 주세요." };
    }
    // 입금이 끝난 무통장입금(가상계좌)은 환불받을 계좌가 있어야 토스가 돌려준다 — 여기서는 받지 않는다
    if (verified.method === VA_METHOD || tx.method === VA_METHOD) {
        return { ok: false, message: "무통장입금으로 낸 결제는 환불 계좌가 필요해요. 토스 상점관리자에서 환불해 주세요." };
    }

    // ② 감사 기록 먼저(취소 요청이 나간 뒤 서버가 멈춰도 누가 눌렀는지 남게) — 묶인 청구마다
    for (const paymentId of coveredIds) {
        await recordPaymentAudit({
            paymentId,
            transactionId: tx.id,
            actorType: "ADMIN",
            actorId: input.adminUserId,
            action: "PAYMENT_TOSS_CANCEL_REQUESTED",
            message: coveredIds.length > 1
                ? `관리자 토스 결제 전액 취소 요청 (묶음 ${coveredIds.length}건)`
                : "관리자 토스 결제 전액 취소 요청",
            metadata: { provider: "TOSS", orderId: tx.orderId, amount: Number(tx.amount), bundleSize: coveredIds.length },
        });
    }

    // ③ 토스 결제 취소 API — 전액(cancelAmount 를 넣지 않는다 = 남은 금액 전부)
    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey) return { ok: false, message: "토스 결제 키가 설정되어 있지 않아요." };
    let tossError: string | null = null;
    try {
        const response = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(tx.paymentKey)}/cancel`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${encodeTossSecret(secretKey)}`,
                "Content-Type": "application/json",
                "Idempotency-Key": makeUuidFromSeed(adminRefundIdempotencySeed(tx.id, tx.paymentKey, Date.now())),
            },
            body: JSON.stringify({ cancelReason: "학원 관리자 환불" }),
            cache: "no-store",
            signal: AbortSignal.timeout(TOSS_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) tossError = await readTossErrorMessage(response) ?? `토스 응답 ${response.status}`;
    } catch {
        tossError = "토스 응답이 없어요";
    }

    // ④ 응답과 상관없이 다시 조회해 판정한다(성공 응답이 끊겨도, 실패 응답인데 실제로 취소됐어도 맞게)
    const after = await getVerifiedTossPayment(tx.paymentKey, tx.orderId);
    if (after.kind === "verified") {
        const cancel = classifyTossCancel(after.payment, tx, tx.paymentKey);
        if (cancel.kind === "FULL_CANCEL") {
            const applied = await applyVerifiedTossFullCancel({ tx, payment: after.payment });
            if (applied.ok) {
                revalidatePaymentCaches();
                return { ok: true, paymentIds: coveredIds, alreadyApplied: applied.alreadyApplied };
            }
            return { ok: false, message: "토스에서는 취소됐지만 장부 반영이 막혔어요. 수납 기록을 확인해 주세요." };
        }
        if (cancel.kind === "PARTIAL_CANCEL") {
            return { ok: false, message: "토스에서 일부만 취소됐어요. 토스 상점관리자에서 확인해 주세요." };
        }
    }
    return { ok: false, message: tossError ? `토스가 취소하지 않았어요(${tossError}).` : "취소가 확인되지 않았어요. 잠시 후 수납 화면에서 다시 확인해 주세요." };
}

export async function confirmTossPayment(input: {
    paymentKey: string;
    orderId: string;
    amount: number;
    invoiceId?: string | null;
    owner: PaymentOwnerIdentity;
}) {
    await ensurePaymentInfrastructure();

    const txRows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT tx.*, i.status AS "invoiceStatus", p.status AS "paymentStatus"
         FROM "PaymentTransaction" tx
         JOIN "PaymentInvoice" i ON i.id = tx."invoiceId"
         JOIN "Payment" p ON p.id = tx."paymentId"
         JOIN "User" u ON u.id = tx."parentId"
         WHERE tx."orderId" = $1
           AND ($3::text IS NULL OR tx."invoiceId" = $3)
           AND (
             u."authUserId" = $2
             OR (u."authUserId" IS NULL AND u.id = $2)
           )
         LIMIT 1`,
        input.orderId,
        input.owner.authUserId,
        input.invoiceId ?? null,
    );
    const tx = txRows[0];
    if (!tx) return { ok: false as const, error: "결제 주문을 찾을 수 없습니다." };

    if (Number(tx.amount) !== Number(input.amount)) {
        return { ok: false as const, error: "결제 금액이 청구 금액과 다릅니다." };
    }

    if ((tx.status === "DONE" || tx.paymentStatus === "PAID" || tx.invoiceStatus === "PAID")
        && tx.paymentKey === input.paymentKey) {
        return { ok: true as const, alreadyConfirmed: true };
    }

    // 이미 다른 결제(현장·관리자·다른 결제키)로 납부된 청구서 — 토스 승인을 부르지 않는다(카드·가상계좌 공통 이중 납부 방지).
    // 승인하지 않은 결제창 인증은 토스에서 자동으로 소멸해 돈이 빠져나가지 않는다.
    if ((tx.paymentStatus === "PAID" || tx.invoiceStatus === "PAID") && tx.paymentKey !== input.paymentKey) {
        return { ok: false as const, error: "이미 납부가 완료된 청구서입니다.", alreadyPaid: true as const };
    }

    // 이미 발급된 가상계좌(성공 화면 새로고침·재시도) — 토스를 다시 부르지 않고 저장된 계좌를 보여 준다.
    if (tx.status === VA_WAITING_STATUS && tx.paymentKey === input.paymentKey) {
        const issue = readStoredIssue(asRecord(tx.rawResponse).virtualAccountIssue);
        if (issue) {
            return {
                ok: true as const,
                waitingForDeposit: true as const,
                virtualAccount: toPublicVirtualAccountView(issue, tx.status, Date.now()),
            };
        }
    }

    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey) {
        return { ok: false as const, error: "Toss Payments 서버 키가 설정되어 있지 않습니다." };
    }

    // 승인(돈이 나가는 순간) «전에» 짧은 트랜잭션에서 묶인 청구를 id 순으로 잠그고 다시 확인한 뒤 «승인 진행 중»으로 표시한다
    // (보안 리뷰 M1·M2 — 두 탭 동시 카드 승인·무통장 계좌 2개 방지). 단건·묶음 같은 함수.
    // 확인: 전부 미납·금액 그대로 · 랠리즈 사본 아님(D4) · 겹치는 다른 주문이 승인 중(10분 안) 아님 · 다른 입금 대기 계좌 없음.
    // 막으면 토스 승인을 부르지 않는다(결제창 인증은 자동 소멸 — 돈 안 나감). 토스 호출은 트랜잭션 밖이다.
    const confirmBlock = await prisma.$transaction((db) => claimTossConfirmInTx(db, {
        transactionId: tx.id,
        repPaymentId: tx.paymentId,
        nowMs: Date.now(),
    }));
    if (confirmBlock) {
        return {
            ok: false as const,
            error: BUNDLE_BLOCK_MESSAGE[confirmBlock],
            ...(confirmBlock === "NOT_UNPAID" ? { alreadyPaid: true as const } : {}),
            blocked: confirmBlock,
        };
    }

    const response = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
        method: "POST",
        headers: {
            Authorization: `Basic ${encodeTossSecret(secretKey)}`,
            "Content-Type": "application/json",
            "Idempotency-Key": makeTossIdempotencyKey(tx.id, input.orderId),
        },
        body: JSON.stringify({
            paymentKey: input.paymentKey,
            orderId: input.orderId,
            amount: Number(tx.amount),
        }),
    });

    const result = await response.json().catch(() => ({
        code: `TOSS_HTTP_${response.status}`,
        message: "Toss 결제 승인 응답을 확인할 수 없습니다.",
    }));

    if (!response.ok) {
        const lookup = await getVerifiedTossPayment(input.paymentKey, input.orderId);
        // 승인 응답을 못 받았는데 실제로는 가상계좌가 발급된 경우(조회 응답에는 secret 이 없다 → 해시 없이 저장,
        // 입금 알림 때는 토스 재조회 결과만으로 판정한다).
        if (lookup.kind === "verified" && lookup.payment.status === VA_WAITING_STATUS
            && lookup.payment.orderId === tx.orderId && Number(lookup.payment.totalAmount) === Number(tx.amount)) {
            const view = await recordVirtualAccountIssued({ tx, payment: lookup.payment, actorType: "PARENT" });
            if (view === "PAID") return { ok: true as const, alreadyConfirmed: true };
            if (view) return { ok: true as const, waitingForDeposit: true as const, virtualAccount: view, recovered: true as const };
        }
        if (lookup.kind === "verified") {
            const recovered = await finalizeVerifiedTossPayment({
                tx,
                payment: lookup.payment,
                actorType: "PARENT",
                actorId: tx.parentId,
            });
            if (recovered.ok) return { ok: true as const, payment: stripPaymentSecret(lookup.payment), recovered: true as const };
        }

        const retryable = response.status === 429 || response.status >= 500 || lookup.kind === "retryable";
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentTransaction"
             SET "paymentKey" = $2,
                 status = CASE WHEN $6::boolean THEN status ELSE 'FAILED' END,
                 "failureCode" = $3,
                 "failureMessage" = $4,
                 "rawResponse" = $5::jsonb,
                 "updatedAt" = NOW()
             WHERE id = $1`,
            tx.id,
            input.paymentKey,
            result.code ?? "TOSS_CONFIRM_FAILED",
            result.message ?? "Toss payment confirm failed",
            JSON.stringify(result),
            retryable,
        );
        return {
            ok: false as const,
            retryable,
            error: retryable
                ? "결제 승인 상태를 확인 중입니다. 잠시 후 다시 확인해 주세요."
                : result.message ?? "결제 승인에 실패했습니다.",
        };
    }

    // 무통장입금(가상계좌): 승인 = 계좌 발급. 돈은 아직 안 들어왔으니 납부 완료로 바꾸지 않는다.
    if (result.status === VA_WAITING_STATUS && result.paymentKey === input.paymentKey
        && result.orderId === input.orderId && Number(result.totalAmount) === Number(tx.amount)) {
        const view = await recordVirtualAccountIssued({ tx, payment: result, actorType: "PARENT" });
        if (view === "PAID") return { ok: true as const, alreadyConfirmed: true };
        if (view) return { ok: true as const, waitingForDeposit: true as const, virtualAccount: view };
    }

    if (result.status !== "DONE" || result.paymentKey !== input.paymentKey
        || result.orderId !== input.orderId || Number(result.totalAmount) !== Number(tx.amount)) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentTransaction"
             SET "paymentKey" = $2,
                 status = CASE WHEN status = 'DONE' THEN status ELSE 'FAILED' END,
                 "failureCode" = 'TOSS_CONFIRM_VERIFICATION_FAILED',
                 "failureMessage" = 'Toss confirm response did not match the stored invoice transaction',
                 "rawResponse" = $3::jsonb,
                 "updatedAt" = NOW()
             WHERE id = $1`,
            tx.id,
            input.paymentKey,
            JSON.stringify(stripPaymentSecret(result)),
        );
        return { ok: false as const, error: "Toss 결제 검증에 실패했습니다." };
    }

    const finalized = await finalizeVerifiedTossPayment({ tx, payment: result, actorType: "PARENT", actorId: tx.parentId });
    if (!finalized.ok) return { ok: false as const, error: "결제 완료 처리에 실패했습니다." };

    // 학부모에게 돌려주는 응답 — secret 칸은 지운다(가상계좌가 아니어도 같은 규칙).
    return { ok: true as const, payment: stripPaymentSecret(result) };
}

// ───────────────────────────── 학부모 «묶음 결제»(2026-11-09) ─────────────────────────────
//
// 토스 주문 1건(PaymentTransaction: 대표 청구 = 1번 항목, amount = 합계) + 청구 N건(PaymentTransactionItem).
// 규칙은 src/lib/payments/checkoutBundle.ts, 장부 반영은 src/lib/payments/bundleLedger.ts.
// 승인·웹훅·가상계좌 입금·매일 점검·전액 취소는 단건과 같은 함수(finalizeVerifiedTossPayment 등)를 지나며 «항목 있음» 갈래로 간다.

/**
 * 학부모가 볼 수 있는 자녀(childAccessSql)의 청구를 «서버 DB 값»으로 읽는다.
 * paymentIds 가 있으면 그 id 만(남의 청구 id 는 결과에 안 나온다 → 규칙이 NOT_FOUND 로 막음),
 * 없으면 미납 청구 전부(묶음 결제 후보 목록).
 */
async function loadBundleCandidateRows(parentUserId: string, paymentIds: string[] | null): Promise<BundleCandidateRow[]> {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT p.id AS "paymentId", i.id AS "invoiceId", s.id AS "studentId", s.name AS "studentName",
                p.type, p.year, p.month,
                COALESCE(i.title, p.description, p.type, '수강료') AS title,
                p.status AS "paymentStatus", i.status AS "invoiceStatus",
                p.amount, i.amount AS "invoiceAmount",
                (s."parentId" = $1) AS "isPayer",
                (NOT (${rallyzMirrorExclusionSql("p")})) AS "rallyzMirror"
           FROM "Payment" p
           JOIN "Student" s ON s.id = p."studentId"
           LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
          WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
            AND ($2::text[] IS NULL OR p.id = ANY($2::text[]))
            AND ($2::text[] IS NOT NULL OR p.status IN ('PENDING', 'OVERDUE'))
          ORDER BY p."dueDate" ASC NULLS LAST, p.id
          LIMIT 60`,
        parentUserId,
        paymentIds,
    );
    return rows.map((row) => ({
        paymentId: String(row.paymentId),
        invoiceId: row.invoiceId ? String(row.invoiceId) : null,
        studentId: String(row.studentId),
        studentName: String(row.studentName ?? ""),
        type: row.type ? String(row.type) : null,
        year: row.year == null ? null : Number(row.year),
        month: row.month == null ? null : Number(row.month),
        title: String(row.title ?? "수강료"),
        paymentStatus: String(row.paymentStatus),
        invoiceStatus: row.invoiceStatus ? String(row.invoiceStatus) : null,
        amount: Number(row.amount ?? 0),
        invoiceAmount: row.invoiceAmount == null ? null : Number(row.invoiceAmount),
        isPayer: row.isPayer === true,
        rallyzMirror: row.rallyzMirror === true,
    }));
}

/** 청구서가 아직 없는(그 외엔 결제 가능한) 청구는 청구서를 먼저 만든다 — 트랜잭션 밖(월 단위 함수라 길다) */
async function ensureInvoicesForBundleRows(rows: BundleCandidateRow[]): Promise<boolean> {
    const missing = rows.filter((row) => bundleItemBlock(row) === "NO_INVOICE");
    for (const row of missing) await ensureInvoiceForPayment(row.paymentId);
    return missing.length > 0;
}

type OpenBundleVirtualAccount = {
    tx: PaymentTransactionRow;
    view: PublicVirtualAccountView;
    items: { paymentId: string; amount: number }[];
};

/** 이 청구들 중 하나라도 품은 «기한 안의 입금 대기 계좌»(단건·묶음 모두) */
async function findOpenVirtualAccountsForPayments(paymentIds: string[], nowMs: number): Promise<OpenBundleVirtualAccount[]> {
    const rows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT t.* FROM "PaymentTransaction" t
          WHERE t.status = '${VA_WAITING_STATUS}'
            AND t."rawResponse"->'virtualAccountIssue' IS NOT NULL
            AND (t."paymentId" = ANY($1::text[]) OR EXISTS (
                  SELECT 1 FROM "PaymentTransactionItem" it
                   WHERE it."transactionId" = t.id AND it."paymentId" = ANY($1::text[])))
          ORDER BY t."createdAt" DESC`,
        paymentIds,
    );
    const open: OpenBundleVirtualAccount[] = [];
    for (const tx of rows) {
        const issue = readStoredIssue(asRecord(tx.rawResponse).virtualAccountIssue);
        if (!issue) continue;
        const view = toPublicVirtualAccountView(issue, tx.status, nowMs);
        if (view.expired) continue;
        const items = await listBundleItems(prisma, tx.id, false);
        open.push({
            tx,
            view,
            items: items.length > 0
                ? items.map((item) => ({ paymentId: item.paymentId, amount: item.itemAmount }))
                : [{ paymentId: tx.paymentId, amount: Number(tx.amount) }],
        });
    }
    return open;
}

/** 묶음 결제 후보 1건(화면 갈래가 쓰는 모양) */
export type BundleCheckoutCandidate = {
    paymentId: string;
    invoiceId: string | null;
    studentId: string;
    studentName: string;
    title: string;
    amount: number;
    paymentStatus: string;
    /** 묶음에 넣을 수 있나(D3: 화면은 selectable 인 것을 기본 전부 선택) */
    selectable: boolean;
    /** 못 넣는 이유(코드·문장). 넣을 수 있으면 null */
    blockCode: BundleBlockCode | null;
    blockReason: string | null;
    /** 이 청구를 품은 입금 대기 계좌가 있나(있으면 새 결제 전에 «계좌 닫기» 확인이 필요) */
    pendingDeposit: boolean;
};

/**
 * 학부모 «묶음 결제» 후보 — 내 자녀(가족 연결 포함)의 미납 청구 전부와 선택 가능 여부.
 * 결제는 대표 보호자만(NOT_PAYER), 랠리즈 사본은 막음(RALLYZ_MIRROR). 화면 표시용이고 결제 시작 때 서버가 다시 검사한다.
 */
export async function getBundleCheckoutCandidates(parentUserId: string) {
    await ensurePaymentInfrastructure();
    // 읽기 전용 — 청구서가 아직 없는 청구도 고를 수 있게 둔다(결제 시작 때 서버가 청구서를 만든 뒤 다시 검사한다)
    const rows = await loadBundleCandidateRows(parentUserId, null);
    const open = rows.length > 0 ? await findOpenVirtualAccountsForPayments(rows.map((row) => row.paymentId), Date.now()) : [];
    const pending = new Set(open.flatMap((entry) => entry.items.map((item) => item.paymentId)));
    const items: BundleCheckoutCandidate[] = rows.map((row) => {
        const raw = bundleItemBlock(row);
        const code = raw === "NO_INVOICE" ? null : raw;
        return {
            paymentId: row.paymentId,
            invoiceId: row.invoiceId,
            studentId: row.studentId,
            studentName: row.studentName,
            title: row.title,
            amount: row.amount,
            paymentStatus: row.paymentStatus,
            selectable: code === null,
            blockCode: code,
            blockReason: code ? BUNDLE_BLOCK_MESSAGE[code] : null,
            pendingDeposit: pending.has(row.paymentId),
        };
    });
    return { items, maxItems: MAX_BUNDLE_ITEMS, maxTotal: MAX_BUNDLE_TOTAL };
}

/**
 * 학부모 «묶음 결제» 시작 — 고른 청구 N건으로 토스 주문 1건을 만든다(결제창은 화면이 연다).
 * 서버가 청구를 다시 읽어 확인: 내 자녀 + 대표 보호자 · 미납 · 금액 > 0 · 청구서 있음 · 랠리즈 사본 아님 · 10건/100만 원 이하.
 * 이중 납부 방지: 고른 청구 중 하나라도 «입금 대기 계좌»(단건·묶음)에 들어 있으면
 *   - 그 계좌가 «같은 청구 묶음»이고 무통장입금을 다시 고르면(또는 확인 없이 부르면) → 그 계좌를 돌려준다(단건과 같은 규칙).
 *   - 아니면 closeOpenVirtualAccount=true(화면 확인)일 때만 그 계좌들을 토스에서 닫고 진행, 아니면 openVirtualAccountConflict.
 * 같은 청구 묶음·같은 금액의 30분 안 READY 주문은 다시 쓴다(결제창을 닫았다 다시 연 경우).
 */
export async function createBundleCheckoutSession(input: {
    /** requireVerifiedParent().appUserId (User.id) */
    parentUserId: string;
    /** 학부모가 고른 청구 id 목록(그대로 믿지 않고 서버가 다시 읽는다) */
    paymentIds: unknown;
    origin: string;
    /** CARD · TRANSFER · VIRTUAL_ACCOUNT */
    method?: string | null;
    /** 열린 입금 계좌를 닫고 진행하겠다는 학부모 확인(화면 확인 단계를 거친 경우만 true) */
    closeOpenVirtualAccount?: boolean;
}) {
    await ensurePaymentInfrastructure();
    const ids = Array.isArray(input.paymentIds)
        ? input.paymentIds.map((value) => (typeof value === "string" ? value.trim() : ""))
        : [];
    // 빈 목록·너무 많음·중복은 DB 를 읽기 전에 막는다(rows 가 비어도 이 세 가지가 먼저 걸린다)
    const pre = bundleCheckoutEligibility(ids, []);
    if (!pre.ok && ["EMPTY", "TOO_MANY", "DUPLICATE"].includes(pre.code)) {
        return { ok: false as const, error: pre.reason, blocked: pre.code };
    }

    let rows = await loadBundleCandidateRows(input.parentUserId, ids);
    if (await ensureInvoicesForBundleRows(rows)) rows = await loadBundleCandidateRows(input.parentUserId, ids);
    const eligibility = bundleCheckoutEligibility(ids, rows);
    if (!eligibility.ok) {
        return {
            ok: false as const,
            error: eligibility.reason,
            blocked: eligibility.code,
            paymentId: eligibility.paymentId ?? null,
            ...(eligibility.code === "NOT_UNPAID" ? { alreadyPaid: true as const } : {}),
        };
    }

    const config = getPaymentProviderConfig();
    if (config.provider !== "TOSS") {
        // 본사 카페24 결제 방식에는 «여러 건 한 주문»이 없다 — 단건 결제로 안내
        return { ok: false as const, error: "지금 결제 방식에서는 한 번에 결제할 수 없어요. 청구서마다 결제해 주세요.", providerReady: config.providerReady };
    }
    if (!config.providerReady) {
        return {
            ok: false as const,
            error: "온라인 결제 설정이 아직 완료되지 않았습니다.",
            providerReady: false,
            configurationMissing: true,
        };
    }

    let items = buildBundleItems(rows.filter((row) => ids.includes(row.paymentId)));

    // ── 이중 납부 방지: 열린 입금 계좌(단건·묶음)
    const open = await findOpenVirtualAccountsForPayments(items.map((item) => item.paymentId), Date.now());
    if (open.length > 0) {
        const wantsOtherMethod = input.method === "CARD" || input.method === "TRANSFER";
        const sameSet = open.length === 1 && sameBundleItems(open[0].items, items);
        if (sameSet && !(input.closeOpenVirtualAccount === true && wantsOtherMethod)) {
            return {
                ok: true as const,
                provider: config.provider,
                providerLabel: config.providerLabel,
                providerReady: config.providerReady,
                openVirtualAccount: open[0].view,
                orderId: open[0].tx.orderId,
            };
        }
        if (input.closeOpenVirtualAccount !== true) {
            return {
                ok: false as const,
                error: "입금 대기 중인 계좌가 있는 청구가 들어 있어요. 그 계좌를 닫고 새로 결제할까요?",
                openVirtualAccountConflict: true as const,
                openVirtualAccounts: open.map((entry) => ({ ...entry.view, paymentIds: entry.items.map((item) => item.paymentId) })),
            };
        }
        for (const entry of open) {
            const closed = await closeVirtualAccountTransaction(entry.tx, { actorType: "PARENT", actorId: input.parentUserId });
            if (closed === "PAID") {
                // 닫는 사이 입금이 먼저 들어왔다 — 입금이 이긴다. 새 결제를 열지 않는다.
                return { ok: false as const, error: "이미 납부가 완료된 청구가 있어요. 화면을 새로 고쳐 주세요.", alreadyPaid: true as const };
            }
            if (closed === "FAIL") {
                return {
                    ok: false as const,
                    error: "입금 계좌를 닫지 못했습니다. 잠시 후 다시 시도해 주세요.",
                    providerReady: config.providerReady,
                    providerError: true as const,
                    retryable: true,
                };
            }
        }
        // 닫는 사이 다른 경로로 납부됐을 수 있다 — 다시 읽어 확인
        rows = await loadBundleCandidateRows(input.parentUserId, ids);
        const again = bundleCheckoutEligibility(ids, rows);
        if (!again.ok) {
            return { ok: false as const, error: again.reason, blocked: again.code, ...(again.code === "NOT_UNPAID" ? { alreadyPaid: true as const } : {}) };
        }
        items = buildBundleItems(rows.filter((row) => ids.includes(row.paymentId)));
    }

    const totals = bundleTotals(items);
    const rep = items[0];
    const orderName = buildBundleOrderName(items);

    // 청구 잠금 안에서 «열린 입금 계좌 재확인 → 같은 묶음 READY 주문 재사용 → 없으면 거래+항목 생성»(보안 리뷰 M2)
    // 거래 1줄 + 항목 N줄이 같은 트랜잭션이라 항목 없는 묶음 거래가 남지 않는다.
    const paymentIds = items.map((item) => item.paymentId);
    const reserved = await prisma.$transaction(async (db) => {
        await lockPaymentsForCheckout(db, paymentIds);
        if ((await findOpenDepositTxIds(db, paymentIds, null, Date.now())).length > 0) {
            return { openDeposit: true as const, orderId: null };
        }
        // 항목 금액은 잠금 «밖»에서 읽었다 — 관리자가 그 사이 금액을 고쳤으면 옛 금액 묶음을 만들지 않는다
        const freshAmounts = await readCheckoutAmounts(db, paymentIds);
        if (checkoutAmountsStale(items.map((item) => ({ paymentId: item.paymentId, amount: item.amount })), freshAmounts)) {
            return { amountChanged: true as const };
        }
        // 같은 청구 묶음·같은 금액의 30분 안 READY 주문 재사용(단건과 같은 규칙)
        const recent = await db.$queryRawUnsafe<CheckoutTransactionRow[]>(
            `SELECT id, "orderId", "orderName", amount
               FROM "PaymentTransaction"
              WHERE "parentId" = $1 AND provider = 'TOSS' AND amount = $2
                AND status IN ('READY', 'IN_PROGRESS')
                AND "requestedAt" > NOW() - INTERVAL '30 minutes'
                AND EXISTS (SELECT 1 FROM "PaymentTransactionItem" it WHERE it."transactionId" = "PaymentTransaction".id)
              ORDER BY "createdAt" DESC
              LIMIT 5`,
            input.parentUserId,
            totals.amount,
        );
        for (const row of recent) {
            const rowItems = await listBundleItems(db, row.id, false);
            if (sameBundleItems(rowItems.map((item) => ({ paymentId: item.paymentId, amount: item.itemAmount })), items)) {
                return { openDeposit: false as const, orderId: row.orderId };
            }
        }

        const newOrderId = makeBundleOrderId(Date.now(), rep.paymentId);
        const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO "PaymentTransaction" (
                id, "paymentId", "invoiceId", "studentId", "parentId", provider,
                "orderId", "orderName", amount, status, "requestedAt", "createdAt", "updatedAt"
             )
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'TOSS', $5, $6, $7, 'READY', NOW(), NOW(), NOW())
             RETURNING id`,
            rep.paymentId, rep.invoiceId, rep.studentId, input.parentUserId, newOrderId, orderName, totals.amount,
        );
        const transactionId = inserted[0]?.id;
        if (!transactionId) throw new Error("묶음 결제 주문을 만들지 못했습니다.");
        for (const item of items) {
            await db.$executeRawUnsafe(
                `INSERT INTO "PaymentTransactionItem" (id, "transactionId", "paymentId", "invoiceId", amount, "taxFreeAmount", position, "createdAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW())`,
                transactionId, item.paymentId, item.invoiceId, item.amount, item.taxFreeAmount, item.position,
            );
        }
        return { openDeposit: false as const, orderId: newOrderId };
    });
    if ("amountChanged" in reserved) {
        return { ok: false as const, error: CHECKOUT_AMOUNT_CHANGED_MESSAGE, blocked: "AMOUNT_CHANGED" as const, amountChanged: true as const };
    }
    if (reserved.openDeposit) {
        // 잠금 사이 다른 탭이 입금 계좌를 받았다 — 새 주문을 만들지 않는다(화면은 «계좌 닫기» 확인으로)
        return {
            ok: false as const,
            error: BUNDLE_BLOCK_MESSAGE.OPEN_DEPOSIT_EXISTS,
            blocked: "OPEN_DEPOSIT_EXISTS" as const,
            openVirtualAccountConflict: true as const,
            openVirtualAccounts: [] as Array<PublicVirtualAccountView & { paymentIds: string[] }>,
        };
    }
    const orderId = reserved.orderId;

    await prisma.$executeRawUnsafe(
        `UPDATE "Payment" SET "paymentRequestedAt" = NOW(), "updatedAt" = NOW() WHERE id = ANY($1::text[])`,
        items.map((item) => item.paymentId),
    );

    const users = await prisma.$queryRawUnsafe<Array<{ name: string | null; email: string; phone: string | null }>>(
        `SELECT name, email, phone FROM "User" WHERE id = $1 LIMIT 1`,
        input.parentUserId,
    );
    const user = users[0];
    const cleanOrigin = input.origin.replace(/\/$/, "");

    return {
        ok: true as const,
        provider: config.provider,
        providerLabel: config.providerLabel,
        providerReady: config.providerReady,
        clientKey: config.clientKey,
        customerKey: makeTossCustomerKey({ parentId: input.parentUserId, parentEmail: user?.email ?? "" }),
        orderId,
        amount: totals.amount,
        /** 토스 requestPayment 의 taxFreeAmount — 항목 면세의 합(꼭 같이 넘긴다: 복합과세 상점) */
        taxFreeAmount: totals.taxFreeAmount,
        orderName,
        customerName: user?.name || rep.studentName || "STIZ 학부모",
        customerEmail: user?.email ?? null,
        customerMobilePhone: toTossMobilePhone(user?.phone ?? null),
        // 설치 앱 범위(/mypage) 안에서 돌아온다 — 화면은 다음 갈래(/mypage/payments/done · checkout)
        successUrl: new URL("/mypage/payments/done", cleanOrigin).toString(),
        failUrl: new URL("/mypage/payments/checkout?result=fail", cleanOrigin).toString(),
        items: items.map((item) => ({
            paymentId: item.paymentId,
            invoiceId: item.invoiceId,
            studentName: item.studentName,
            title: item.title,
            amount: item.amount,
            taxFreeAmount: item.taxFreeAmount,
            position: item.position,
        })),
    };
}

/**
 * 묶음 주문 1건(완료 화면용) — 주문 상태·합계·영수증·묶인 청구·무통장 계좌.
 * 소유권: 주문을 만든 학부모(PaymentTransaction.parentId = 앱 계정)만. 남의 주문 번호면 null(IDOR 차단).
 */
export async function getBundleOrderForParent(orderId: string, parentUserId: string) {
    await ensurePaymentInfrastructure();
    const rows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT t.* FROM "PaymentTransaction" t
          WHERE t."orderId" = $1 AND t."parentId" = $2
            AND EXISTS (SELECT 1 FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id)
          LIMIT 1`,
        orderId,
        parentUserId,
    );
    const tx = rows[0];
    if (!tx) return null;
    const items = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT it."paymentId", it."invoiceId", it.amount, it.position, p.status AS "paymentStatus",
                s.name AS "studentName", COALESCE(i.title, p.description, p.type, '수강료') AS title
           FROM "PaymentTransactionItem" it
           JOIN "Payment" p ON p.id = it."paymentId"
           JOIN "Student" s ON s.id = p."studentId"
           LEFT JOIN "PaymentInvoice" i ON i.id = it."invoiceId"
          WHERE it."transactionId" = $1
          ORDER BY it.position`,
        tx.id,
    );
    const issue = tx.status === VA_WAITING_STATUS || tx.status === VA_EXPIRED_STATUS
        ? readStoredIssue(asRecord(tx.rawResponse).virtualAccountIssue)
        : null;
    return {
        orderId: tx.orderId,
        /** READY · IN_PROGRESS · WAITING_FOR_DEPOSIT · EXPIRED · DONE · CANCELED · FAILED */
        status: tx.status,
        amount: Number(tx.amount),
        receiptUrl: readString((tx as PaymentTransactionRow & { receiptUrl?: unknown }).receiptUrl),
        virtualAccount: issue ? toPublicVirtualAccountView(issue, tx.status, Date.now()) : null,
        items: items.map((item) => ({
            paymentId: String(item.paymentId),
            invoiceId: String(item.invoiceId),
            studentName: String(item.studentName ?? ""),
            title: String(item.title ?? ""),
            amount: Number(item.amount ?? 0),
            position: Number(item.position ?? 0),
            paymentStatus: String(item.paymentStatus),
        })),
    };
}

export async function recordTossWebhook(payload: unknown) {
    await ensurePaymentInfrastructure();

    const payloadRecord = asRecord(payload);
    const data = asRecord(payloadRecord.data ?? payload);
    // 가상계좌 입금 알림(DEPOSIT_CALLBACK)은 eventType 칸이 없다 → 이름을 붙여 기록·중복 판정에 쓴다.
    const depositCallback = isDepositCallbackPayload(payloadRecord);
    const eventType = depositCallback
        ? "DEPOSIT_CALLBACK"
        : readString(payloadRecord.eventType) ?? readString(payloadRecord.type) ?? readString(data.status);
    const paymentKey = readString(data.paymentKey);
    const orderId = readString(data.orderId);
    const eventId = makeTossWebhookEventId({
        payload,
        explicitEventId: readString(payloadRecord.eventId) ?? readString(payloadRecord.id),
        eventType,
        paymentKey,
        orderId,
        status: readString(data.status),
        totalAmount: readNumber(data.totalAmount),
        depositKey: depositCallback ? readString(payloadRecord.transactionKey) ?? readString(payloadRecord.createdAt) : null,
    });

    const eventRows = await prisma.$queryRawUnsafe<Array<{ id: string; processed: boolean }>>(
        `INSERT INTO "PaymentWebhookEvent" (
            id, provider, "eventId", "eventType", "paymentKey", "orderId",
            payload, "receivedAt"
        )
        VALUES (gen_random_uuid()::text, 'TOSS', $1, $2, $3, $4, $5::jsonb, NOW())
        ON CONFLICT (provider, "eventId")
        DO UPDATE SET
          "eventType" = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent"."eventType" ELSE EXCLUDED."eventType" END,
          "paymentKey" = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent"."paymentKey" ELSE EXCLUDED."paymentKey" END,
          "orderId" = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent"."orderId" ELSE EXCLUDED."orderId" END,
          payload = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent".payload ELSE EXCLUDED.payload END,
          "receivedAt" = NOW()
        RETURNING id, processed`,
        eventId,
        eventType,
        paymentKey,
        orderId,
        // 지문(eventId)은 위에서 원문으로 만들었다. 저장할 때만 secret(가상계좌 입금 알림 비밀값)을 가린다.
        JSON.stringify(stripWebhookSecrets(payload)),
    );

    const eventRecordId = eventRows[0]?.id ?? null;
    if (eventRows[0]?.processed) {
        return { ok: true as const, processed: true, duplicate: true, eventId: eventRecordId };
    }
    if (!orderId && !paymentKey) {
        return { ok: true as const, processed: false, eventId: eventRecordId };
    }

    const txRows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT * FROM "PaymentTransaction"
         WHERE "orderId" = $1 OR "paymentKey" = $2
         ORDER BY "createdAt" DESC
         LIMIT 1`,
        orderId,
        paymentKey,
    );
    const tx = txRows[0];
    if (!tx) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET error = 'TRANSACTION_NOT_FOUND', "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: false, eventId: eventRecordId };
    }

    // 가상계좌 거래: secret 대조를 토스 조회보다 먼저 한다(위조 알림이면 토스 API 를 부르지 않는다).
    const virtualAccountTx = depositCallback || isVirtualAccountTransaction(tx);
    const secretCheck = virtualAccountTx
        ? checkDepositSecret(readString(payloadRecord.secret) ?? readString(data.secret), asRecord(tx.rawResponse).depositSecretHash)
        : null;
    if (secretCheck === "MISMATCH" || (depositCallback && secretCheck === "NOT_PROVIDED")) {
        const code = secretCheck === "MISMATCH" ? "DEPOSIT_SECRET_MISMATCH" : "DEPOSIT_SECRET_MISSING";
        console.warn(`[virtual-account] ${code} orderId=${tx.orderId}`);
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET error = $2, "processedAt" = NOW() WHERE id = $1`,
            eventRecordId, code,
        );
        // processed=false 로 남겨 같은 지문의 진짜 알림이 오면 다시 처리되게 한다.
        return { ok: true as const, processed: false, eventId: eventRecordId };
    }

    const lookup = await getVerifiedTossPayment(paymentKey, orderId);
    if (lookup.kind === "retryable") {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET error = $2 WHERE id = $1`,
            eventRecordId, lookup.reason,
        );
        return { ok: false as const, processed: false, retryable: true, eventId: eventRecordId };
    }

    const verified = lookup.kind === "verified" ? lookup.payment : null;

    if (virtualAccountTx && secretCheck) {
        const handled = await applyVirtualAccountWebhook({
            tx,
            verified,
            depositCallback,
            secretCheck,
            eventRecordId,
            depositedAt: readString(payloadRecord.createdAt),
            callbackStatus: depositCallback ? readString(payloadRecord.status) : null,
        });
        // null = 입금 뒤 전액 취소(환불) → 아래 기존 취소 경로가 처리한다.
        if (handled) return handled;
    }
    const matches = verified
        && verified.status === "DONE"
        && verified.orderId === tx.orderId
        && verified.paymentKey
        && (!paymentKey || verified.paymentKey === paymentKey)
        && Number(verified.totalAmount) === Number(tx.amount);

    if (matches) {
        const finalized = await finalizeVerifiedTossPayment({ tx, payment: verified, actorType: "WEBHOOK" });
        if (!finalized.ok) {
            await prisma.$executeRawUnsafe(
                `UPDATE "PaymentWebhookEvent" SET error = $2, "processedAt" = NOW() WHERE id = $1`,
                eventRecordId, finalized.error,
            );
            return { ok: true as const, processed: false, eventId: eventRecordId };
        }

        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET processed = true, "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: true, eventId: eventRecordId };
    }

    // 상점관리자에서 결제를 취소한 경우 — 토스 재조회 결과로만 판단한다.
    const cancel = classifyTossCancel(verified, tx, paymentKey);
    if (cancel.kind === "FULL_CANCEL" && verified) {
        const applied = await applyVerifiedTossFullCancel({ tx, payment: verified });
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET processed = $2, error = $3, "processedAt" = NOW() WHERE id = $1`,
            eventRecordId, applied.ok, applied.ok ? null : applied.error,
        );
        return { ok: true as const, processed: applied.ok, eventId: eventRecordId };
    }
    if (cancel.kind === "PARTIAL_CANCEL") {
        // 부분 환불은 어느 항목을 돌려줬는지 장부가 알 수 없어 자동 반영하지 않는다. 기록만 남겨 원장이 처리한다.
        await prisma.$executeRawUnsafe(
            // 같은 거래·같은 취소 금액 기록이 이미 있으면 다시 쌓지 않는다(알림 재전송·반복 호출 대비).
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             SELECT gen_random_uuid()::text, $1, $2, $3, 'WEBHOOK', NULL, 'PAYMENT_PARTIAL_CANCEL_REVIEW', 'Toss partial cancel needs manual review', $4::jsonb, NOW()
             WHERE NOT EXISTS (
               SELECT 1 FROM "PaymentAuditLog"
               WHERE "transactionId" = $3 AND action = 'PAYMENT_PARTIAL_CANCEL_REVIEW'
                 AND metadata->>'canceledAmount' = $5
             )`,
            tx.paymentId, tx.invoiceId, tx.id,
            JSON.stringify({ provider: "TOSS", orderId: tx.orderId, canceledAmount: cancel.canceledAmount }),
            String(cancel.canceledAmount),
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET error = 'TOSS_PARTIAL_CANCEL_REVIEW', "processedAt" = NOW() WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: false, eventId: eventRecordId };
    }

    await prisma.$executeRawUnsafe(
        `UPDATE "PaymentWebhookEvent" SET error = 'TOSS_PAYMENT_NOT_VERIFIED', "processedAt" = NOW() WHERE id = $1`,
        eventRecordId,
    );
    return { ok: true as const, processed: false, eventId: eventRecordId };
}

/**
 * 가상계좌 거래에 온 웹훅(입금·만료·취소)을 장부에 반영한다. 판정은 decideVirtualAccountWebhook(순수)이 하고
 * 여기서는 그 결과대로만 움직인다. 같은 알림이 여러 번 와도 결과가 같다(멱등).
 */
async function applyVirtualAccountWebhook(input: {
    tx: PaymentTransactionRow;
    verified: TossPaymentResult | null;
    depositCallback: boolean;
    secretCheck: ReturnType<typeof checkDepositSecret>;
    eventRecordId: string | null;
    depositedAt: string | null;
    /** DEPOSIT_CALLBACK 본문의 status(입금 알림일 때만) */
    callbackStatus?: string | null;
}): Promise<{ ok: true; processed: boolean; eventId: string | null; retryable?: boolean } | null> {
    const { tx, verified, eventRecordId } = input;
    // 묶음 주문이면 묶인 청구 중 하나라도 납부·환불된 상태를 본다(입금 전에 다른 방법으로 낸 청구 = 원장 확인)
    const statusRows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        TX_PAYMENT_STATUS_SQL,
        tx.paymentId,
        tx.id,
    );
    const decision = decideVirtualAccountWebhook({
        isDepositCallback: input.depositCallback,
        secretCheck: input.secretCheck,
        tx: { orderId: tx.orderId, amount: Number(tx.amount), status: tx.status, paymentKey: tx.paymentKey ?? null },
        paymentStatus: statusRows[0]?.status ?? null,
        verified,
    });

    const finishEvent = async (processed: boolean, error: string | null) => {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET processed = $2, error = $3, "processedAt" = NOW() WHERE id = $1`,
            eventRecordId, processed, error,
        );
        return { ok: true as const, processed, eventId: eventRecordId };
    };

    if (decision.action === "DELEGATE") return null;

    if (decision.action === "ALREADY_DONE") return finishEvent(true, null);

    if (decision.action === "PAY") {
        // decide 는 토스 재조회 결과가 있을 때만 PAY 를 준다. 혹시 없으면 반영하지 않는다.
        if (!verified) return finishEvent(false, "TOSS_PAYMENT_NOT_VERIFIED");
        const paid = await payVerifiedVirtualAccount(tx, verified, input.depositedAt);
        return paid.ok ? finishEvent(true, null) : finishEvent(false, paid.error);
    }

    if (decision.action === "RELEASE") {
        // «입금 대기»만 푼다. 청구·청구서는 미납 그대로(학부모가 다시 발급하거나 다른 수단으로 낸다).
        await releaseVirtualAccountTx(tx, decision.reason, { actorType: "WEBHOOK" });
        return finishEvent(true, null);
    }

    if (decision.action === "REJECT") {
        await recordVirtualAccountReview(tx, decision.code, decision.alert);
        return finishEvent(false, decision.code);
    }

    // 입금 알림은 «입금됐다(DONE)»고 하는데 토스 조회가 아직 따라오지 못했다(입금 대기·4xx).
    // 200 으로 끝내면 토스가 다시 보내지 않아 영구 미납이 된다 → 503 으로 재전송을 받는다(매일 점검 cron 이 한 번 더 줍는다).
    if (shouldRetryDepositCallback(input.depositCallback, input.callbackStatus ?? null, decision)) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET error = $2 WHERE id = $1`,
            eventRecordId, `RETRY_${decision.code}`,
        );
        return { ok: true as const, processed: false, eventId: eventRecordId, retryable: true };
    }

    // IGNORE — 아직 입금 대기 등 장부에 반영할 게 없다.
    return finishEvent(false, decision.code);
}

const VIRTUAL_ACCOUNT_ALERT_TEXT: Record<string, string> = {
    VIRTUAL_ACCOUNT_AMOUNT_MISMATCH: "입금 금액이 청구 금액과 달라 납부 처리하지 않았습니다.",
    VIRTUAL_ACCOUNT_TAX_FREE_MISMATCH: "입금 건이 면세로 처리되지 않아 납부 처리하지 않았습니다.",
    VIRTUAL_ACCOUNT_ALREADY_PAID: "이미 다른 방법으로 납부된 청구서에 가상계좌 입금이 들어왔습니다(이중 납부 — 환불 확인 필요).",
    VIRTUAL_ACCOUNT_INVOICE_CLOSED: "취소·환불된 청구서에 가상계좌 입금이 들어왔습니다(환불 확인 필요).",
    VIRTUAL_ACCOUNT_TX_CLOSED: "닫힌 거래에 가상계좌 입금이 들어왔습니다(확인 필요).",
    VIRTUAL_ACCOUNT_DEPOSIT_REVERSED: "납부 완료된 가상계좌 입금이 은행에서 취소됐습니다(장부 확인 필요).",
    VIRTUAL_ACCOUNT_PARTIAL_CANCELED: "가상계좌 입금 건이 토스에서 부분 취소돼 자동 처리하지 않았습니다(장부 확인 필요).",
    // 묶음 결제(2026-11-09) — 묶인 청구 중 하나라도 반영할 수 없으면 전부 반영하지 않는다
    BUNDLE_ITEM_NOT_PAYABLE: "묶음 입금 건 중 결제할 수 없는 상태의 청구가 있어 전부 납부 처리하지 않았습니다(확인 필요).",
    BUNDLE_ITEM_AMOUNT_CHANGED: "묶음 입금 건 중 금액이 바뀐 청구가 있어 전부 납부 처리하지 않았습니다(확인 필요).",
    BUNDLE_AMOUNT_MISMATCH: "묶음 입금 금액이 묶인 청구 합계와 달라 납부 처리하지 않았습니다(확인 필요).",
    BUNDLE_ITEMS_MISSING: "묶음 주문의 청구 목록을 찾지 못해 납부 처리하지 않았습니다(확인 필요).",
};

/**
 * 자동 처리하지 않은 가상계좌 건을 감사 기록으로 남기고, 필요하면 원장에게 알린다.
 * 같은 거래·같은 사유는 한 번만 기록·알림한다(토스 알림 재전송 대비).
 */
async function recordVirtualAccountReview(tx: PaymentTransactionRow, code: string, alert: boolean) {
    const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
         SELECT gen_random_uuid()::text, $1, $2, $3, 'WEBHOOK', NULL, 'VIRTUAL_ACCOUNT_REVIEW', $4, $5::jsonb, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM "PaymentAuditLog"
           WHERE "transactionId" = $3 AND action = 'VIRTUAL_ACCOUNT_REVIEW' AND message = $4
         )
         RETURNING id`,
        tx.paymentId, tx.invoiceId, tx.id, code,
        JSON.stringify({ provider: "TOSS", orderId: tx.orderId, amount: Number(tx.amount) }),
    );
    if (inserted.length > 0 && alert) {
        const reason = VIRTUAL_ACCOUNT_ALERT_TEXT[code] ?? `가상계좌 입금 확인 필요(${code}).`;
        await alertVirtualAccountIssue(
            `[가상계좌 확인 필요] ${reason}\n주문 ${tx.orderId} · ${Number(tx.amount).toLocaleString("ko-KR")}원 · /admin/finance 에서 확인해 주세요.`,
        );
    }
}

function makeCafe24WebhookEventId(input: {
    payload: unknown;
    explicitEventId: string | null;
    eventType: string | null;
    orderId: string | null;
    providerOrderId: string | null;
    status: string | null;
    amount: number | null;
}) {
    if (input.explicitEventId) return input.explicitEventId;

    const digest = createHash("sha256")
        .update(JSON.stringify({
            eventType: input.eventType,
            orderId: input.orderId,
            providerOrderId: input.providerOrderId,
            status: input.status,
            amount: input.amount,
            payload: input.orderId || input.providerOrderId ? undefined : input.payload,
        }))
        .digest("hex")
        .slice(0, 48);
    return `generated:${digest}`;
}

function isCafe24PaidStatus(status: string | null) {
    return ["PAID", "DONE", "COMPLETED", "PAYMENT_COMPLETED", "PAYMENT_DONE"].includes(String(status || "").toUpperCase());
}

function isCafe24FailedStatus(status: string | null) {
    return ["FAILED", "CANCELED", "CANCELLED", "REFUNDED", "PAYMENT_FAILED"].includes(String(status || "").toUpperCase());
}

export function verifyCafe24PaymentWebhook(payload: unknown, headers: Headers) {
    return verifyCafe24PaymentSignature({
        payload,
        timestamp: headers.get("x-stiz-timestamp"),
        signature: headers.get("x-stiz-signature"),
    });
}

export async function recordCafe24PaymentWebhook(payload: unknown) {
    await ensurePaymentInfrastructure();

    const payloadRecord = asRecord(payload);
    const data = asRecord(payloadRecord.data ?? payload);
    const status = readString(data.status) ?? readString(data.paymentStatus);
    const eventType = readString(payloadRecord.eventType) ?? readString(payloadRecord.type) ?? status;
    const orderId = readString(data.partnerRequestId) ?? readString(data.orderId) ?? readString(payloadRecord.orderId);
    const providerOrderId = readString(data.cafe24OrderId)
        ?? readString(data.providerOrderId)
        ?? readString(data.orderNo)
        ?? readString(data.orderNumber);
    const paymentKey = readString(data.paymentKey) ?? providerOrderId;
    const amount = readNumber(data.amount) ?? readNumber(data.totalAmount) ?? readNumber(data.paidAmount);
    const receiptUrl = readString(data.receiptUrl) ?? readString(data.orderUrl);
    const eventId = makeCafe24WebhookEventId({
        payload,
        explicitEventId: readString(payloadRecord.eventId) ?? readString(payloadRecord.id),
        eventType,
        orderId,
        providerOrderId,
        status,
        amount,
    });

    const eventRows = await prisma.$queryRawUnsafe<Array<{ id: string; processed: boolean }>>(
        `INSERT INTO "PaymentWebhookEvent" (
            id, provider, "eventId", "eventType", "paymentKey", "orderId",
            payload, "receivedAt"
        )
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::jsonb, NOW())
        ON CONFLICT (provider, "eventId")
        DO UPDATE SET
          "eventType" = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent"."eventType" ELSE EXCLUDED."eventType" END,
          "paymentKey" = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent"."paymentKey" ELSE EXCLUDED."paymentKey" END,
          "orderId" = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent"."orderId" ELSE EXCLUDED."orderId" END,
          payload = CASE WHEN "PaymentWebhookEvent".processed THEN "PaymentWebhookEvent".payload ELSE EXCLUDED.payload END,
          "receivedAt" = NOW()
        RETURNING id, processed`,
        CAFE24_PAYMENT_PROVIDER,
        eventId,
        eventType,
        paymentKey,
        orderId,
        JSON.stringify(payload),
    );

    const eventRecordId = eventRows[0]?.id ?? null;
    if (eventRows[0]?.processed) {
        return { ok: true as const, processed: true, duplicate: true, eventId: eventRecordId };
    }
    if (!orderId) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET error = 'CAFE24_ORDER_ID_MISSING', "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: false, eventId: eventRecordId };
    }

    const txRows = await prisma.$queryRawUnsafe<PaymentTransactionRow[]>(
        `SELECT * FROM "PaymentTransaction"
         WHERE provider = $1 AND "orderId" = $2
         ORDER BY "createdAt" DESC
         LIMIT 1`,
        CAFE24_PAYMENT_PROVIDER,
        orderId,
    );
    const tx = txRows[0];
    if (!tx) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET error = 'TRANSACTION_NOT_FOUND', "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: false, eventId: eventRecordId };
    }

    if (amount !== null && Number(amount) !== Number(tx.amount)) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET error = 'CAFE24_AMOUNT_MISMATCH', "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: false as const, processed: false, eventId: eventRecordId };
    }

    if (isCafe24PaidStatus(status)) {
        await markPaymentPaid({
            paymentId: tx.paymentId,
            invoiceId: tx.invoiceId,
            transactionId: tx.id,
            actorType: "WEBHOOK",
            provider: CAFE24_PAYMENT_PROVIDER,
            method: "CAFE24",
            orderId: tx.orderId,
            providerOrderId,
            paymentKey,
            receiptUrl,
            rawResponse: payload,
        });
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET processed = true, "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: true, eventId: eventRecordId };
    }

    if (isCafe24FailedStatus(status)) {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentTransaction"
             SET status = 'FAILED',
                 "failureCode" = COALESCE($2, 'CAFE24_PAYMENT_FAILED'),
                 "failureMessage" = COALESCE($3, '본사 카페24 결제가 완료되지 않았습니다.'),
                 "rawResponse" = $4::jsonb,
                 "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('READY', 'IN_PROGRESS')`,
            tx.id,
            status,
            readString(data.message) ?? readString(data.error),
            JSON.stringify(payload),
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent"
             SET processed = true, "processedAt" = NOW()
             WHERE id = $1`,
            eventRecordId,
        );
        return { ok: true as const, processed: true, eventId: eventRecordId };
    }

    await prisma.$executeRawUnsafe(
        `UPDATE "PaymentWebhookEvent"
         SET error = 'CAFE24_STATUS_NOT_PAID'
         WHERE id = $1`,
        eventRecordId,
    );
    return { ok: true as const, processed: false, eventId: eventRecordId };
}
