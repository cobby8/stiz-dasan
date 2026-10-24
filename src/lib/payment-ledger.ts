import { revalidatePath, revalidateTag } from "next/cache";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PUBLIC_SITE_URL } from "@/lib/publicMetadata";
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
    invoiceStatus?: string;
    paymentStatus?: string;
};

type TerminalPaymentTargetRow = {
    paymentId: string;
    invoiceId: string;
    studentId: string;
    parentId: string | null;
    amount: number;
    status: string;
    invoiceStatus: string;
    type: string | null;
    description: string | null;
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

function makeUuidFromSeed(seed: string) {
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
}) {
    if (input.explicitEventId) return input.explicitEventId;

    const fingerprintSource = input.paymentKey || input.orderId || input.eventType || input.status || input.totalAmount
        ? {
            eventType: input.eventType,
            paymentKey: input.paymentKey,
            orderId: input.orderId,
            status: input.status,
            totalAmount: input.totalAmount,
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

function toTerminalDate(value: string | Date | null | undefined) {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    const trimmed = value.trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? new Date(`${trimmed}T00:00:00+09:00`)
        : new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
        throw new Error("결제일이 올바르지 않습니다.");
    }
    return date;
}

function buildTerminalOrderId(paymentId: string, approvalNo: string, paidAt: Date) {
    const datePart = paidAt.toISOString().slice(0, 10).replace(/-/g, "");
    const approvalPart = approvalNo.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 24) || "APPROVAL";
    return `TERMINAL-${datePart}-${approvalPart}-${paymentId.replace(/-/g, "").slice(0, 8)}`.slice(0, 64);
}

export async function recordTerminalPayment(input: {
    paymentId: string;
    approvalNo: string;
    receivedAt?: string | Date | null;
    memo?: string | null;
    receiptUrl?: string | null;
    method?: string | null;
    actorType: LedgerActorType;
    actorId?: string | null;
}) {
    await ensurePaymentInfrastructure();

    const paymentId = input.paymentId.trim();
    const approvalNo = input.approvalNo.trim();
    if (!paymentId) throw new Error("수납 기록 ID가 필요합니다.");
    if (!approvalNo) throw new Error("단말기 승인번호를 입력해 주세요.");

    const paidAt = toTerminalDate(input.receivedAt);
    const method = input.method?.trim() || "CARD";
    const receiptUrl = input.receiptUrl?.trim() || null;
    const memo = input.memo?.trim() || null;
    const invoice = await ensureInvoiceForPayment(paymentId);
    if (!invoice?.id) {
        throw new Error("청구서를 찾을 수 없습니다.");
    }

    const orderId = buildTerminalOrderId(paymentId, approvalNo, paidAt);
    const rawResponse = {
        provider: "TOSS_TERMINAL",
        approvalNo,
        memo,
        receivedAt: paidAt.toISOString(),
    };

    return prisma.$transaction(async (db) => {
        const targets = await db.$queryRawUnsafe<TerminalPaymentTargetRow[]>(
            `SELECT
                p.id AS "paymentId",
                i.id AS "invoiceId",
                p."studentId",
                i."parentId",
                p.amount,
                p.status,
                i.status AS "invoiceStatus",
                p.type,
                p.description
             FROM "Payment" p
             JOIN "PaymentInvoice" i ON i."paymentId" = p.id
             WHERE p.id = $1
             FOR UPDATE OF p, i`,
            paymentId,
        );
        const target = targets[0];
        if (!target) throw new Error("수납 기록을 찾을 수 없습니다.");
        if (target.status === "PAID" || target.invoiceStatus === "PAID") {
            throw new Error("이미 납부완료 처리된 청구입니다.");
        }

        const transactionRows = await db.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "PaymentTransaction" (
                id, "paymentId", "invoiceId", "studentId", "parentId", provider,
                "orderId", "orderName", amount, status, method, "receiptUrl",
                "requestedAt", "approvedAt", "rawResponse", "createdAt", "updatedAt"
            )
            VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4, 'TOSS_TERMINAL',
                $5, $6, $7, 'DONE', $8, $9,
                $10::timestamp, $10::timestamp, $11::jsonb, NOW(), NOW()
            )
            RETURNING id`,
            target.paymentId,
            target.invoiceId,
            target.studentId,
            target.parentId,
            orderId,
            target.description || target.type || "현장 단말기 수납",
            Number(target.amount),
            method,
            receiptUrl,
            paidAt,
            JSON.stringify(rawResponse),
        );
        const transactionId = transactionRows[0]?.id;

        await db.$executeRawUnsafe(
            `UPDATE "Payment"
             SET status = 'PAID',
                 "paidDate" = $2::timestamp,
                 method = $3,
                 "paidProvider" = 'TOSS_TERMINAL',
                 "providerOrderId" = $4,
                 "receiptUrl" = COALESCE($5, "receiptUrl"),
                 "updatedAt" = NOW()
             WHERE id = $1`,
            target.paymentId,
            paidAt,
            method,
            approvalNo,
            receiptUrl,
        );

        await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoice"
             SET status = 'PAID',
                 "paidAt" = $2::timestamp,
                 "updatedAt" = NOW()
             WHERE id = $1`,
            target.invoiceId,
            paidAt,
        );

        await db.$executeRawUnsafe(
            `INSERT INTO "PaymentAuditLog" (
                id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId",
                action, message, metadata, "createdAt"
            )
            VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4, $5,
                'TERMINAL_PAYMENT_MARK_PAID', 'Toss terminal payment marked as paid', $6::jsonb, NOW()
            )`,
            target.paymentId,
            target.invoiceId,
            transactionId ?? null,
            input.actorType,
            input.actorId ?? null,
            JSON.stringify(rawResponse),
        );

        return {
            ok: true as const,
            paymentId: target.paymentId,
            invoiceId: target.invoiceId,
            transactionId,
            approvalNo,
            message: "현장 단말기 결제를 납부완료로 반영했습니다.",
        };
    }).finally(() => {
        revalidatePaymentCaches();
    });
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
            tx."receiptUrl" AS "transactionReceiptUrl"
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

    const config = getPaymentProviderConfig();
    if (!config.providerReady) {
        return {
            ok: false as const,
            error: "온라인 결제 설정이 아직 완료되지 않았습니다.",
            providerReady: false,
            configurationMissing: true,
        };
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

    const recentRows = await prisma.$queryRawUnsafe<CheckoutTransactionRow[]>(
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

    const orderName = String(invoice.title || "STIZ 수강료").slice(0, 80);
    const existing = recentRows[0];
    const orderId = existing?.orderId ?? `${provider === CAFE24_PAYMENT_PROVIDER ? "STIZ-C24" : "STIZ"}-${Date.now()}-${String(input.invoiceId).slice(0, 8)}`;
    let transactionId = existing?.id ?? null;

    if (!existing) {
        const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
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
            orderId,
            orderName,
            Number(invoice.amount),
        );
        transactionId = inserted[0]?.id ?? null;
    }

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
        successUrl,
        failUrl,
    };
}

function encodeTossSecret(secretKey: string) {
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

async function getVerifiedTossPayment(paymentKey: string | null, orderId: string | null) {
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

    const receiptUrl = readString(asRecord(input.payment.receipt).url)
        ?? readString(asRecord(input.payment.card).receiptUrl);

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
        if (!["READY", "IN_PROGRESS", "DONE"].includes(current.status)
            || ["REFUNDED", "CANCELED"].includes(current.paymentStatus ?? "")
            || ["REFUNDED", "CANCELED"].includes(current.invoiceStatus ?? "")
            || current.status === "CANCELED") {
            return { ok: false as const, error: "PAYMENT_ALREADY_CLOSED" };
        }

        const paymentUpdated = await db.$executeRawUnsafe(
            `UPDATE "Payment" SET status = 'PAID', "paidDate" = COALESCE("paidDate", NOW()),
             method = COALESCE($2, method), "paidProvider" = 'TOSS', "providerOrderId" = $3,
             "providerPaymentKey" = $4, "receiptUrl" = COALESCE($5, "receiptUrl"), "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('PENDING', 'OVERDUE', 'PAID')`,
            current.paymentId, readString(input.payment.method), orderId, paymentKey, receiptUrl,
        );
        const invoiceUpdated = await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoice" SET status = 'PAID', "paidAt" = COALESCE("paidAt", NOW()), "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('ISSUED', 'SENT', 'OVERDUE', 'PAID')`,
            current.invoiceId,
        );
        const transactionUpdated = await db.$executeRawUnsafe(
            `UPDATE "PaymentTransaction" SET status = 'DONE', "paymentKey" = $2,
             method = COALESCE($3, method), "receiptUrl" = COALESCE($4, "receiptUrl"),
             "approvedAt" = COALESCE("approvedAt", NOW()), "rawResponse" = $5::jsonb, "updatedAt" = NOW()
             WHERE id = $1 AND status IN ('READY', 'IN_PROGRESS', 'DONE')`,
            current.id, paymentKey, readString(input.payment.method), receiptUrl, JSON.stringify(input.payment),
        );
        if (paymentUpdated !== 1 || invoiceUpdated !== 1 || transactionUpdated !== 1) {
            throw new Error("PAYMENT_LEDGER_STATE_CONFLICT");
        }
        await db.$executeRawUnsafe(
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'PAYMENT_MARK_PAID', 'Verified Toss payment marked as paid', $6::jsonb, NOW())`,
            current.paymentId, current.invoiceId, current.id, input.actorType, input.actorId ?? null,
            JSON.stringify({ provider: "TOSS", orderId, paymentKey: "[verified]" }),
        );
        return { ok: true as const, alreadyConfirmed: false };
    });
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

    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey) {
        return { ok: false as const, error: "Toss Payments 서버 키가 설정되어 있지 않습니다." };
    }

    await prisma.$executeRawUnsafe(
        `UPDATE "PaymentTransaction"
         SET status = 'IN_PROGRESS', "updatedAt" = NOW()
         WHERE id = $1 AND status = 'READY'`,
        tx.id,
    );

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
        if (lookup.kind === "verified") {
            const recovered = await finalizeVerifiedTossPayment({
                tx,
                payment: lookup.payment,
                actorType: "PARENT",
                actorId: tx.parentId,
            });
            if (recovered.ok) return { ok: true as const, payment: lookup.payment, recovered: true as const };
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
            JSON.stringify(result),
        );
        return { ok: false as const, error: "Toss 결제 검증에 실패했습니다." };
    }

    const finalized = await finalizeVerifiedTossPayment({ tx, payment: result, actorType: "PARENT", actorId: tx.parentId });
    if (!finalized.ok) return { ok: false as const, error: "결제 완료 처리에 실패했습니다." };

    return { ok: true as const, payment: result };
}

export async function recordTossWebhook(payload: unknown) {
    await ensurePaymentInfrastructure();

    const payloadRecord = asRecord(payload);
    const data = asRecord(payloadRecord.data ?? payload);
    const eventType = readString(payloadRecord.eventType) ?? readString(payloadRecord.type) ?? readString(data.status);
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
        JSON.stringify(payload),
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

    const lookup = await getVerifiedTossPayment(paymentKey, orderId);
    if (lookup.kind === "retryable") {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET error = $2 WHERE id = $1`,
            eventRecordId, lookup.reason,
        );
        return { ok: false as const, processed: false, retryable: true, eventId: eventRecordId };
    }

    const verified = lookup.kind === "verified" ? lookup.payment : null;
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

    await prisma.$executeRawUnsafe(
        `UPDATE "PaymentWebhookEvent" SET error = 'TOSS_PAYMENT_NOT_VERIFIED', "processedAt" = NOW() WHERE id = $1`,
        eventRecordId,
    );
    return { ok: true as const, processed: false, eventId: eventRecordId };
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
