// 학부모 온라인 «묶음 결제» — 장부 연결부(DB 를 인자로 받는다. prisma 를 import 하지 않음 → 가짜 DB 로 실행 테스트).
//
// payment-ledger.ts 의 finalizeVerifiedTossPayment · applyVerifiedTossFullCancel 이 «항목 있는 거래»일 때
// 자기 트랜잭션(db) 안에서 이 함수들을 부른다. 판정은 순수 checkoutBundle.ts, 여기서는 그 결과대로 SQL 만 돈다.
//
// ■ 전부 아니면 전무(markPaymentsPaidTogether 와 같은 패턴)
//   거래 1줄 + 묶인 청구·청구서 전부를 FOR UPDATE 로 잠그고, 건마다 «미납 + 금액 그대로» 조건부 UPDATE.
//   하나라도 0행이면 오류를 던져 호출한 쪽 트랜잭션 전체가 되돌아간다(일부만 납부 금지).
//
// 테스트: tests/payment-bundle-checkout.test.mjs (가짜 db 로 «한 건 이미 납부 → 전부 되돌림» 등을 실행)

import {
    decideBundleFinalize,
    decideBundleFullCancel,
    type BundleLockedItem,
} from "./checkoutBundle";

/** raw SQL 두 개만 쓴다(prisma 본체 또는 $transaction 의 db) */
export type BundleSqlClient = {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** 조건부 UPDATE 가 0행일 때 던지는 오류 — 호출한 쪽이 이 머리말로 «묶음 충돌»을 알아본다 */
export const BUNDLE_LEDGER_CONFLICT = "BUNDLE_LEDGER_CONFLICT";

/**
 * 거래(별칭 txAlias)가 그 청구서(invoiceExpr)를 «대표 청구로든 항목으로든» 품고 있나 — SQL 조각.
 * 단건 경로(열린 가상계좌 조회·닫기)가 묶음 주문의 계좌도 보게 하는 연결점. 식별자는 코드에 적힌 값만 받는다.
 */
export function txCoversInvoiceSql(txAlias: string, invoiceExpr: string): string {
    assertSqlIdent(txAlias, invoiceExpr);
    return `(${txAlias}."invoiceId" = ${invoiceExpr} OR EXISTS (
        SELECT 1 FROM "PaymentTransactionItem" tx_item
         WHERE tx_item."transactionId" = ${txAlias}.id AND tx_item."invoiceId" = ${invoiceExpr}))`;
}

/** 거래(txAlias)가 그 청구(paymentExpr)를 대표 청구로든 항목으로든 품고 있나 — SQL 조각 */
export function txCoversPaymentSql(txAlias: string, paymentExpr: string): string {
    assertSqlIdent(txAlias, paymentExpr);
    return `(${txAlias}."paymentId" = ${paymentExpr} OR EXISTS (
        SELECT 1 FROM "PaymentTransactionItem" tx_item
         WHERE tx_item."transactionId" = ${txAlias}.id AND tx_item."paymentId" = ${paymentExpr}))`;
}

function assertSqlIdent(alias: string, expr: string) {
    // 별칭은 영문 소문자·숫자, 값은 $n 또는 별칭.칼럼 — 사용자 입력이 SQL 조각에 섞이지 않게
    if (!/^[a-z][a-z0-9_]*$/.test(alias) || !/^(\$[1-9]\d*|[a-z][a-z0-9_]*\.(?:id|"[A-Za-z]+"))$/.test(expr)) {
        throw new Error("INVALID_BUNDLE_SQL_EXPRESSION");
    }
}

/**
 * 거래에 묶인 청구의 «지금» 상태로 단건 판정(decideVirtualAccountWebhook)에 넘길 청구 상태를 고른다 — SQL.
 * 항목 하나라도 PAID 면 PAID(입금 전에 다른 방법으로 낸 청구가 있다 = 원장 확인), 하나라도 환불·취소면 그 상태,
 * 아니면 대표 청구 상태. 항목이 없는 옛 거래는 대표 청구 상태 그대로($1 = 대표 청구 id, $2 = 거래 id).
 */
export const TX_PAYMENT_STATUS_SQL = `SELECT CASE
        WHEN EXISTS (SELECT 1 FROM "PaymentTransactionItem" it JOIN "Payment" ip ON ip.id = it."paymentId"
                      WHERE it."transactionId" = $2 AND ip.status = 'PAID') THEN 'PAID'
        WHEN EXISTS (SELECT 1 FROM "PaymentTransactionItem" it JOIN "Payment" ip ON ip.id = it."paymentId"
                      WHERE it."transactionId" = $2 AND ip.status = 'REFUNDED') THEN 'REFUNDED'
        WHEN EXISTS (SELECT 1 FROM "PaymentTransactionItem" it JOIN "Payment" ip ON ip.id = it."paymentId"
                      WHERE it."transactionId" = $2 AND ip.status = 'CANCELED') THEN 'CANCELED'
        ELSE p.status END AS status
     FROM "Payment" p WHERE p.id = $1`;

/** 거래에 항목이 있나(= 묶음 주문인가). 항목은 주문을 만들 때 한 번 쓰고 바꾸지 않는다. */
export async function hasBundleItems(db: BundleSqlClient, transactionId: string): Promise<boolean> {
    const rows = await db.$queryRawUnsafe<Array<{ found: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM "PaymentTransactionItem" WHERE "transactionId" = $1) AS found`,
        transactionId,
    );
    return rows[0]?.found === true;
}

type ItemRow = BundleLockedItem & { position: number; taxFreeAmount: number };

/**
 * 묶인 청구·청구서를 읽는다. lock=true 면 FOR UPDATE — 청구 id 순서로 잠가 겹치는 두 묶음이 서로 기다리다 막히지 않게.
 */
export async function listBundleItems(db: BundleSqlClient, transactionId: string, lock: boolean): Promise<ItemRow[]> {
    const rows = await db.$queryRawUnsafe<ItemRow[]>(
        `SELECT it."paymentId", it."invoiceId", it.amount AS "itemAmount", it."taxFreeAmount", it.position,
                p.amount AS "paymentAmount", p.status AS "paymentStatus", i.status AS "invoiceStatus"
           FROM "PaymentTransactionItem" it
           JOIN "Payment" p ON p.id = it."paymentId"
           JOIN "PaymentInvoice" i ON i.id = it."invoiceId"
          WHERE it."transactionId" = $1
          ORDER BY it."paymentId"
          ${lock ? "FOR UPDATE OF p, i" : ""}`,
        transactionId,
    );
    return rows
        .map((row) => ({
            ...row,
            itemAmount: Number(row.itemAmount),
            paymentAmount: Number(row.paymentAmount),
            taxFreeAmount: Number(row.taxFreeAmount),
            position: Number(row.position),
        }))
        .sort((a, b) => a.position - b.position);
}

export type BundleFinalizeInput = {
    transactionId: string;
    orderId: string;
    paymentKey: string;
    method: string | null;
    receiptUrl: string | null;
    /** 납부 시각 ISO(UTC). 없으면 지금 */
    paidAtIso: string | null;
    /** 토스 응답(비밀값 지운 것) */
    rawResponse: unknown;
    /** 토스 응답의 결제 수단이 «가상계좌»인가(거래 상태와 함께 무통장 판정에 쓴다) */
    methodIsVirtualAccount: boolean;
    actorType: "PARENT" | "WEBHOOK";
    actorId?: string | null;
};

export type BundleFinalizeResult =
    | { ok: true; alreadyConfirmed: boolean; size: number }
    | { ok: false; error: string };

/**
 * 묶음 주문 납부 반영 — 반드시 호출한 쪽의 트랜잭션(db) 안에서 부른다.
 * 거래 → 청구·청구서 순으로 잠그고 판정, PAY 면 건마다 조건부 UPDATE(하나라도 0행이면 던져서 전부 되돌림).
 */
export async function finalizeBundleInTx(db: BundleSqlClient, input: BundleFinalizeInput): Promise<BundleFinalizeResult> {
    const locked = await db.$queryRawUnsafe<Array<{ id: string; status: string; amount: number }>>(
        `SELECT id, status, amount FROM "PaymentTransaction" WHERE id = $1 FOR UPDATE`,
        input.transactionId,
    );
    const tx = locked[0];
    if (!tx) return { ok: false, error: "TRANSACTION_NOT_FOUND" };
    const items = await listBundleItems(db, tx.id, true);
    const isVirtualAccount = tx.status === "WAITING_FOR_DEPOSIT" || tx.status === "EXPIRED" || input.methodIsVirtualAccount;
    const decision = decideBundleFinalize({ txStatus: tx.status, txAmount: Number(tx.amount), isVirtualAccount, items });
    if (decision.action === "ALREADY_DONE") return { ok: true, alreadyConfirmed: true, size: items.length };
    if (decision.action === "REJECT") return { ok: false, error: decision.code };

    for (const item of items) {
        // "paidDate" 는 시간대 없는(timestamp) 칸 → UTC 벽시계로(단건 finalize 와 같은 식)
        const paid = await db.$queryRawUnsafe<Array<{ id: string }>>(
            `UPDATE "Payment" SET status = 'PAID', "paidDate" = COALESCE("paidDate", ($6::timestamptz AT TIME ZONE 'UTC'), NOW()),
                    method = COALESCE($2, method), "paidProvider" = 'TOSS', "providerOrderId" = $3,
                    "providerPaymentKey" = $4, "receiptUrl" = COALESCE($5, "receiptUrl"), "updatedAt" = NOW()
              WHERE id = $1 AND status IN ('PENDING', 'OVERDUE') AND amount = $7::int
              RETURNING id`,
            item.paymentId, input.method, input.orderId, input.paymentKey, input.receiptUrl, input.paidAtIso, item.itemAmount,
        );
        // 하나라도 못 바꾸면(잠금 사이 바뀜) 던진다 → 호출한 쪽 트랜잭션 전체가 되돌아간다
        if (paid.length === 0) throw new Error(`${BUNDLE_LEDGER_CONFLICT}: payment ${item.paymentId}`);
        const invoice = await db.$queryRawUnsafe<Array<{ id: string }>>(
            `UPDATE "PaymentInvoice" SET status = 'PAID', "paidAt" = COALESCE("paidAt", $2::timestamptz, NOW()), "updatedAt" = NOW()
              WHERE id = $1 AND status IN ('ISSUED', 'SENT', 'OVERDUE')
              RETURNING id`,
            item.invoiceId, input.paidAtIso,
        );
        if (invoice.length === 0) throw new Error(`${BUNDLE_LEDGER_CONFLICT}: invoice ${item.invoiceId}`);
    }

    const txUpdated = await db.$executeRawUnsafe(
        `UPDATE "PaymentTransaction" SET status = 'DONE', "paymentKey" = $2,
                method = COALESCE($3, method), "receiptUrl" = COALESCE($4, "receiptUrl"),
                "approvedAt" = COALESCE("approvedAt", $6::timestamptz, NOW()), "rawResponse" = $5::jsonb, "updatedAt" = NOW()
          WHERE id = $1 AND status IN ('READY', 'IN_PROGRESS', 'DONE', 'WAITING_FOR_DEPOSIT', 'EXPIRED')`,
        tx.id, input.paymentKey, input.method, input.receiptUrl, JSON.stringify(input.rawResponse ?? null), input.paidAtIso,
    );
    if (Number(txUpdated) !== 1) throw new Error(`${BUNDLE_LEDGER_CONFLICT}: transaction ${tx.id}`);

    // 감사 기록은 청구마다(action PAYMENT_MARK_PAID — 취소 확정의 «출처 확인»이 이 값을 본다)
    for (const item of items) {
        await db.$executeRawUnsafe(
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'PAYMENT_MARK_PAID', 'Verified Toss bundle payment marked as paid', $6::jsonb, NOW())`,
            item.paymentId, item.invoiceId, tx.id, input.actorType, input.actorId ?? null,
            JSON.stringify({
                provider: "TOSS",
                orderId: input.orderId,
                paymentKey: "[verified]",
                method: input.method,
                paidAt: input.paidAtIso,
                bundle: { orderId: input.orderId, size: items.length, position: item.position, amount: item.itemAmount },
            }),
        );
    }
    return { ok: true, alreadyConfirmed: false, size: items.length };
}

export type BundleCancelResult =
    | { ok: true; alreadyApplied: boolean; refunded: number }
    | { ok: false; error: string };

/**
 * 토스 전액 취소가 확인된 묶음 주문 → 묶인 청구(PAID) 전부 환불, 청구서 취소, 거래 취소 — 호출한 쪽 트랜잭션 안에서.
 * 납부일은 비운다(관리자 «환불»·단건 전액 취소와 같은 관례 — POS 대조가 paidDate 로 납부 건을 고른다).
 */
export async function refundBundleInTx(
    db: BundleSqlClient,
    input: { transactionId: string; rawResponse: unknown },
): Promise<BundleCancelResult> {
    const locked = await db.$queryRawUnsafe<Array<{ id: string; status: string; orderId: string }>>(
        `SELECT id, status, "orderId" FROM "PaymentTransaction" WHERE id = $1 FOR UPDATE`,
        input.transactionId,
    );
    const tx = locked[0];
    if (!tx) return { ok: false, error: "TRANSACTION_NOT_FOUND" };
    const items = await listBundleItems(db, tx.id, true);
    const decision = decideBundleFullCancel({ txStatus: tx.status, items });
    if (decision.action === "ALREADY_APPLIED") return { ok: true, alreadyApplied: true, refunded: 0 };
    if (decision.action === "REJECT") return { ok: false, error: decision.code };

    const refundSet = new Set(decision.refundPaymentIds);
    let refunded = 0;
    for (const item of items) {
        if (!refundSet.has(item.paymentId)) continue;
        const changed = await db.$executeRawUnsafe(
            `UPDATE "Payment" SET status = 'REFUNDED', "paidDate" = NULL, "updatedAt" = NOW() WHERE id = $1 AND status = 'PAID'`,
            item.paymentId,
        );
        if (Number(changed) !== 1) continue; // 잠근 뒤라 일어나지 않지만, 바뀌지 않은 건은 기록도 남기지 않는다
        refunded += 1;
        await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = COALESCE("canceledAt", NOW()), "updatedAt" = NOW()
              WHERE id = $1 AND status <> 'CANCELED'`,
            item.invoiceId,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, 'WEBHOOK', NULL, 'PAYMENT_REFUNDED', 'Verified Toss bundle full cancel marked as refunded', $4::jsonb, NOW())`,
            item.paymentId, item.invoiceId, tx.id,
            JSON.stringify({
                provider: "TOSS",
                orderId: tx.orderId,
                paymentKey: "[verified]",
                bundle: { orderId: tx.orderId, size: items.length, position: item.position, amount: item.itemAmount },
            }),
        );
    }
    await db.$executeRawUnsafe(
        `UPDATE "PaymentTransaction" SET status = 'CANCELED', "rawResponse" = $2::jsonb, "updatedAt" = NOW()
          WHERE id = $1 AND status = 'DONE'`,
        tx.id, JSON.stringify(input.rawResponse ?? null),
    );
    return { ok: true, alreadyApplied: false, refunded };
}
