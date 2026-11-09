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
    BUNDLE_PAYABLE_PAYMENT_STATUSES,
    CONFIRM_LOCK_MINUTES,
    bundleConfirmBlock,
    checkoutAmountsStale,
    CHECKOUT_REUSE_MINUTES,
    decideBundleFinalize,
    decideBundleFullCancel,
    type BundleBlockCode,
    type BundleLockedItem,
} from "./checkoutBundle";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { readStoredIssue, toPublicVirtualAccountView } from "./virtualAccount";

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

/** 거래(t)가 청구 목록($n::text[]) 중 하나라도 대표로든 항목으로든 품나 — SQL 조각 */
function txCoversAnyPaymentSql(param: string): string {
    if (!/^\$[1-9]\d*$/.test(param)) throw new Error("INVALID_BUNDLE_SQL_EXPRESSION");
    return `(t."paymentId" = ANY(${param}::text[]) OR EXISTS (
        SELECT 1 FROM "PaymentTransactionItem" tx_item
         WHERE tx_item."transactionId" = t.id AND tx_item."paymentId" = ANY(${param}::text[])))`;
}

/**
 * 청구 id 정렬순으로 advisory 잠금(트랜잭션이 끝나면 풀림). 결제 시작·토스 승인 직전이 같은 키를 쓴다 —
 * 겹치는 청구를 가진 두 주문(묶음↔묶음, 묶음↔단건)이 동시에 지나가지 못하게(보안 리뷰 M1·M2).
 * 정렬순이라 서로 다른 순서로 잠그다 교착되지 않는다.
 */
export async function lockPaymentsForCheckout(db: BundleSqlClient, paymentIds: readonly string[]): Promise<void> {
    for (const id of [...new Set(paymentIds)].sort()) {
        await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `stiz-payment-checkout:${id}`);
    }
}

/**
 * 잠금(lockPaymentsForCheckout)을 잡은 «뒤에» 청구·청구서 금액을 다시 읽는다 — 결제 시작·승인 직전이 같이 쓴다.
 * 관리자 «청구서 수정»(updateUnpaidPayment)도 같은 잠금을 잡고 금액을 바꾸므로, 이 값과 처음 읽은 금액을
 * checkoutAmountsStale 로 비교하면 «옛 금액 주문»이 생기지 않는다.
 */
export async function readCheckoutAmounts(
    db: BundleSqlClient,
    paymentIds: readonly string[],
): Promise<Array<{ paymentId: string; paymentAmount: number; invoiceAmount: number | null }>> {
    if (paymentIds.length === 0) return [];
    return db.$queryRawUnsafe(
        `SELECT p.id AS "paymentId", p.amount AS "paymentAmount", i.amount AS "invoiceAmount"
           FROM "Payment" p
           LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
          WHERE p.id = ANY($1::text[])`,
        [...paymentIds],
    );
}

/**
 * 이 청구들을 품은 «기한 안의 입금 대기 계좌» 거래 id(excludeTxId 는 뺀다). 발급 정보를 못 읽는 입금 대기 거래도
 * 열린 것으로 본다(안전한 쪽 — 매일 점검이 정리한다).
 */
export async function findOpenDepositTxIds(
    db: BundleSqlClient,
    paymentIds: readonly string[],
    excludeTxId: string | null,
    nowMs: number,
): Promise<string[]> {
    if (paymentIds.length === 0) return [];
    const rows = await db.$queryRawUnsafe<Array<{ id: string; status: string; issue: unknown }>>(
        `SELECT t.id, t.status, t."rawResponse"->'virtualAccountIssue' AS issue
           FROM "PaymentTransaction" t
          WHERE t.status = 'WAITING_FOR_DEPOSIT'
            AND ($2::text IS NULL OR t.id <> $2)
            AND ${txCoversAnyPaymentSql("$1")}`,
        [...paymentIds],
        excludeTxId,
    );
    return rows
        .filter((row) => isOpenDepositRow(row, nowMs))
        .map((row) => row.id);
}

/** 입금 대기 거래가 «기한 안»인가 — 발급 정보를 못 읽으면 열린 것으로 본다(안전한 쪽). findOpenDepositTxIds 와 공용 */
function isOpenDepositRow(row: { status: string; issue: unknown }, nowMs: number): boolean {
    const issue = readStoredIssue(row.issue);
    return !issue || !toPublicVirtualAccountView(issue, row.status, nowMs).expired;
}

/**
 * 학부모 결제가 «지금» 진행 중인 거래인가(관리자 «청구서 수정» 차단·학생 상세 안내용, 2026-11-09).
 * - READY·IN_PROGRESS: 최근 CHECKOUT_REUSE_MINUTES(30분) 안에 움직인 것만. 결제창을 열고 닫은 오래된 주문은 막지 않는다
 *   (만료 코드가 없어 남아 있다 — 30분이 지나면 결제 시작도 새 주문을 만든다).
 * - WAITING_FOR_DEPOSIT: 기한이 남은 입금 계좌만(findOpenDepositTxIds 와 같은 기준).
 */
export function isParentCheckoutActive(
    row: { status: string; updatedAt: Date | string | null; issue?: unknown },
    nowMs: number,
): boolean {
    if (row.status === "READY" || row.status === "IN_PROGRESS") {
        const updatedMs = row.updatedAt ? new Date(row.updatedAt).getTime() : NaN;
        return Number.isFinite(updatedMs) && nowMs - updatedMs < CHECKOUT_REUSE_MINUTES * 60_000;
    }
    if (row.status === "WAITING_FOR_DEPOSIT") return isOpenDepositRow({ status: row.status, issue: row.issue }, nowMs);
    return false;
}

/**
 * 청구들 중 «학부모 결제 진행 중»인 청구 id — 대표 청구로든 묶음 항목으로든 거래에 든 것. 판정은 isParentCheckoutActive 한 곳.
 * 관리자 수정 서버(updateUnpaidPayment)와 학생 상세 조회(getStudentActivity)가 같이 쓴다.
 */
export async function findParentCheckoutActivePaymentIds(
    db: BundleSqlClient,
    paymentIds: readonly string[],
    nowMs: number,
): Promise<Set<string>> {
    const active = new Set<string>();
    if (paymentIds.length === 0) return active;
    const rows = await db.$queryRawUnsafe<Array<{ paymentId: string; status: string; updatedAt: Date | string | null; issue: unknown }>>(
        `SELECT cover.payment_id AS "paymentId", t.status, t."updatedAt", t."rawResponse"->'virtualAccountIssue' AS issue
           FROM "PaymentTransaction" t
           JOIN LATERAL (
                SELECT t."paymentId" AS payment_id
                UNION
                SELECT it."paymentId" FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id
           ) cover ON true
          WHERE cover.payment_id = ANY($1::text[])
            AND t.status IN ('READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT')`,
        [...paymentIds],
    );
    for (const row of rows) {
        if (isParentCheckoutActive(row, nowMs)) active.add(String(row.paymentId));
    }
    return active;
}

/**
 * 토스 승인(confirm) 직전 — 반드시 호출한 쪽의 짧은 트랜잭션(db) 안에서. 토스 호출은 트랜잭션 «밖»에서 한다.
 *  1) 이 주문이 덮는 청구를 id 정렬순으로 잠근다.
 *  2) 잠근 뒤 다시 읽어 확인: 전부 미납·금액 그대로·랠리즈 사본 아님 / 다른 주문이 «승인 진행 중»(10분 안) 아님 /
 *     다른 입금 대기 계좌 없음(두 탭 무통장 → 계좌 2개 방지).
 *  3) 통과하면 이 주문을 «승인 진행 중»(IN_PROGRESS + updatedAt 지금)으로 표시 — 기존 칸·상태값만 쓴다.
 *     승인이 실패·끊겨 표시가 남아도 CONFIRM_LOCK_MINUTES 뒤엔 다른 주문을 막지 않는다.
 * 막아야 하면 이유 코드, 통과면 null.
 */
export async function claimTossConfirmInTx(
    db: BundleSqlClient,
    input: { transactionId: string; repPaymentId: string; nowMs: number },
): Promise<BundleBlockCode | null> {
    const before = await listBundleItems(db, input.transactionId, false);
    const paymentIds = before.length > 0 ? before.map((item) => item.paymentId) : [input.repPaymentId];
    await lockPaymentsForCheckout(db, paymentIds);

    const mirrorRows = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT p.id FROM "Payment" p WHERE p.id = ANY($1::text[]) AND NOT (${rallyzMirrorExclusionSql("p")})`,
        paymentIds,
    );
    const mirrors = new Set(mirrorRows.map((row) => row.id));
    if (before.length > 0) {
        // 잠근 뒤 다시 읽은 «지금» 상태로 판정
        const fresh = await listBundleItems(db, input.transactionId, false);
        const block = bundleConfirmBlock(fresh.map((item) => ({ ...item, rallyzMirror: mirrors.has(item.paymentId) })));
        if (block) return block;
    } else {
        if (mirrors.size > 0) return "RALLYZ_MIRROR";
        const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status FROM "Payment" WHERE id = $1`, input.repPaymentId);
        if (!BUNDLE_PAYABLE_PAYMENT_STATUSES.includes(String(rows[0]?.status ?? ""))) return "NOT_UNPAID";
        // 단건 주문 금액 = 주문을 만들 때의 청구 금액. 그 뒤 관리자가 금액을 고쳤으면 옛 금액으로 승인하지 않는다
        // (묶음은 위 bundleConfirmBlock 이 항목 금액으로 같은 확인을 한다)
        const txRows = await db.$queryRawUnsafe<Array<{ amount: number }>>(
            `SELECT amount FROM "PaymentTransaction" WHERE id = $1`,
            input.transactionId,
        );
        const fresh = await readCheckoutAmounts(db, [input.repPaymentId]);
        if (!txRows[0] || checkoutAmountsStale([{ paymentId: input.repPaymentId, amount: Number(txRows[0].amount) }], fresh)) {
            return "AMOUNT_CHANGED";
        }
    }

    const busy = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT t.id FROM "PaymentTransaction" t
          WHERE t.id <> $1 AND t.provider = 'TOSS' AND t.status = 'IN_PROGRESS'
            AND t."updatedAt" > NOW() - ($3::int * INTERVAL '1 minute')
            AND ${txCoversAnyPaymentSql("$2")}
          LIMIT 1`,
        input.transactionId,
        paymentIds,
        CONFIRM_LOCK_MINUTES,
    );
    if (busy.length > 0) return "CONFIRM_IN_PROGRESS";

    const open = await findOpenDepositTxIds(db, paymentIds, input.transactionId, input.nowMs);
    if (open.length > 0) return "OPEN_DEPOSIT_EXISTS";

    await db.$executeRawUnsafe(
        `UPDATE "PaymentTransaction" SET status = 'IN_PROGRESS', "updatedAt" = NOW()
          WHERE id = $1 AND status IN ('READY', 'IN_PROGRESS', 'FAILED')`,
        input.transactionId,
    );
    return null;
}

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
    /** skipped = PAID 지만 이 주문으로 낸 게 아닌(다른 방법으로 다시 낸) 청구 — 환불하지 않고 원장 확인 */
    | { ok: true; alreadyApplied: boolean; refunded: number; skipped: string[] }
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
    if (decision.action === "ALREADY_APPLIED") return { ok: true, alreadyApplied: true, refunded: 0, skipped: [] };
    if (decision.action === "REJECT") return { ok: false, error: decision.code };

    const refundSet = new Set(decision.refundPaymentIds);
    let refunded = 0;
    const skipped: string[] = [];
    for (const item of items) {
        if (!refundSet.has(item.paymentId)) continue;
        // 이 주문(providerOrderId)으로 낸 청구만 환불한다 — 관리자 환불 뒤 현장·계좌이체로 다시 낸 청구는 건드리지 않는다(보안 리뷰 L1)
        const changed = await db.$executeRawUnsafe(
            `UPDATE "Payment" SET status = 'REFUNDED', "paidDate" = NULL, "updatedAt" = NOW()
              WHERE id = $1 AND status = 'PAID' AND "paidProvider" = 'TOSS' AND "providerOrderId" = $2`,
            item.paymentId, tx.orderId,
        );
        if (Number(changed) !== 1) {
            skipped.push(item.paymentId);
            continue;
        }
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
    return { ok: true, alreadyApplied: false, refunded, skipped };
}
