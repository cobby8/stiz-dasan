// 학부모 온라인 «묶음 결제» — 순수 규칙 모듈(DB·네트워크·환경변수 없음).
//
// ■ 무엇을 하나
//   학부모가 미납 청구 여러 건(형제 포함)을 골라 토스 결제 «한 번»으로 낸다.
//   토스 주문 1건(PaymentTransaction) = 청구 N건(PaymentTransactionItem). 청구서(PaymentInvoice)는 그대로 둔다
//   (식당 비유: 메뉴판은 그대로, 계산서만 한 장으로).
//   POS 현장 결제 묶음(src/lib/pos/charge-request.mjs)과 같은 모양 — 정렬 규칙은 그 파일 한 벌을 그대로 쓴다.
//
// ■ 원장 결정(2026-11-09)
//   D2 형제 청구도 묶는다(결제하는 사람 = 대표 보호자 1명) · D3 기본 전부 선택(화면 몫, 서버는 받은 목록만 본다)
//   D4 랠리즈 사본 청구는 사이트 결제(단건·묶음)에서 막는다 · D5 묶음 상한 10건 · 100만 원(토스 단건 한도)
//
// 설계: 학부모 화면 검토 문서 «3-3 묶음 결제 설계안». 테스트: tests/payment-bundle-checkout.test.mjs

import { taxFreeAmountFor } from "./taxFree";
import { sortChargeItems as sortChargeItemsJs } from "@/lib/pos/charge-request.mjs";

// 순수 JS 모듈 함수는 느슨한 시그니처 하나로 받는다(호출부마다 캐스팅하지 않게 — conventions)
const sortChargeItems = sortChargeItemsJs as <T>(payments: T[]) => T[];

/** 한 번에 묶을 수 있는 청구 수(D5) — POS 묶음과 같은 값 */
export const MAX_BUNDLE_ITEMS = 10;
/** 한 번에 결제할 수 있는 합계(D5) — 토스 계약 단건 한도 100만 원 */
export const MAX_BUNDLE_TOTAL = 1_000_000;

/** 결제할 수 있는 청구 상태 — 미납만 */
export const BUNDLE_PAYABLE_PAYMENT_STATUSES: readonly string[] = Object.freeze(["PENDING", "OVERDUE"]);
/** 결제할 수 있는 청구서 상태 */
export const BUNDLE_PAYABLE_INVOICE_STATUSES: readonly string[] = Object.freeze(["ISSUED", "SENT", "OVERDUE"]);

/** 서버가 DB 에서 다시 읽은 청구 1건(학부모가 보낸 값은 쓰지 않는다) */
export type BundleCandidateRow = {
    paymentId: string;
    invoiceId: string | null;
    studentId: string;
    studentName: string;
    type: string | null;
    year: number | null;
    month: number | null;
    title: string;
    paymentStatus: string;
    invoiceStatus: string | null;
    /** 청구(Payment) 금액 — 결제 금액의 기준 */
    amount: number;
    /** 청구서 금액 — 청구 금액과 다르면(수정 직후) 결제하지 않는다 */
    invoiceAmount: number | null;
    /** 결제 담당(대표) 보호자인가 — 학생의 parentId 가 본인 */
    isPayer: boolean;
    /** 랠리즈 청구서의 장부 사본인가(D4) */
    rallyzMirror: boolean;
};

export type BundleBlockCode =
    | "EMPTY"
    | "TOO_MANY"
    | "DUPLICATE"
    | "NOT_FOUND"
    | "NOT_PAYER"
    | "RALLYZ_MIRROR"
    | "NOT_UNPAID"
    | "NO_INVOICE"
    | "AMOUNT_INVALID"
    | "AMOUNT_CHANGED"
    | "TOO_MUCH"
    // 승인 직전 잠금 안 확인(보안 리뷰 M1·M2, 2026-11-09)
    | "CONFIRM_IN_PROGRESS"
    | "OPEN_DEPOSIT_EXISTS";

/** 다른 주문의 «승인 진행 중» 표시가 막는 시간(분). 실패·끊김으로 표시가 남아도 이 시간이 지나면 풀린다. */
export const CONFIRM_LOCK_MINUTES = 10;

/**
 * 결제 시작이 같은 청구·금액의 READY·IN_PROGRESS 주문을 «다시 쓰는» 시간(분) — payment-ledger 의 INTERVAL '30 minutes' 와 같은 값
 * (테스트가 두 곳을 비교한다). 이 시간이 지난 주문은 학부모가 결제창을 닫고 떠난 것으로 보고 «진행 중»으로 치지 않는다.
 */
export const CHECKOUT_REUSE_MINUTES = 30;

/** 학부모에게 보일 이유 문장(개발 용어 없이) */
export const BUNDLE_BLOCK_MESSAGE: Record<BundleBlockCode, string> = {
    EMPTY: "결제할 청구를 선택해 주세요.",
    TOO_MANY: `한 번에 결제할 수 있는 청구는 ${MAX_BUNDLE_ITEMS}건까지예요. 나눠서 결제해 주세요.`,
    DUPLICATE: "같은 청구가 두 번 들어 있어요. 다시 선택해 주세요.",
    NOT_FOUND: "본인 자녀의 청구만 결제할 수 있어요.",
    NOT_PAYER: "결제는 대표 보호자 계정에서만 할 수 있어요.",
    RALLYZ_MIRROR: "랠리즈로 안내된 청구는 랠리즈 앱에서 결제해 주세요.",
    NOT_UNPAID: "이미 납부했거나 결제할 수 없는 청구가 있어요. 화면을 새로 고쳐 주세요.",
    NO_INVOICE: "청구서가 아직 준비되지 않은 청구가 있어요. 잠시 후 다시 시도해 주세요.",
    AMOUNT_INVALID: "결제 금액이 없는 청구가 있어요.",
    AMOUNT_CHANGED: "청구 금액이 바뀌는 중인 청구가 있어요. 화면을 새로 고쳐 주세요.",
    TOO_MUCH: `한 번에 결제할 수 있는 금액은 ${MAX_BUNDLE_TOTAL.toLocaleString("ko-KR")}원까지예요. 나눠서 결제해 주세요.`,
    CONFIRM_IN_PROGRESS: "같은 청구의 다른 결제가 진행 중이에요. 잠시 후 납부 내역을 확인해 주세요.",
    OPEN_DEPOSIT_EXISTS: "같은 청구에 입금을 기다리는 계좌가 이미 있어요. 그 계좌로 입금하거나 계좌를 닫고 다시 결제해 주세요.",
};

/** 결제 시작·승인 직전 «잠금 뒤 다시 읽은» 청구 금액이 처음 읽은 금액과 다를 때 학부모에게 보일 문장 */
export const CHECKOUT_AMOUNT_CHANGED_MESSAGE = "청구 금액이 바뀌었어요. 화면을 새로 고쳐 다시 열어 주세요.";

/**
 * 관리자가 미납 청구 금액을 고치는 동안(같은 잠금 stiz-payment-checkout:{청구 id}) 학부모 결제가 옛 금액으로 주문을 만들지 않게,
 * 잠금을 잡은 «뒤에» 다시 읽은 청구·청구서 금액(fresh)이 기대 금액(expected)과 모두 같은지 본다.
 * 다시 읽은 줄이 없거나 청구·청구서 금액이 서로 다르면 «바뀜»으로 본다(안전한 쪽).
 */
export function checkoutAmountsStale(
    expected: ReadonlyArray<{ paymentId: string; amount: number }>,
    fresh: ReadonlyArray<{ paymentId: string; paymentAmount: number | string | null; invoiceAmount: number | string | null }>,
): boolean {
    return expected.some((want) => {
        const row = fresh.find((candidate) => candidate.paymentId === want.paymentId);
        if (!row || row.paymentAmount == null || row.invoiceAmount == null) return true;
        return Number(row.paymentAmount) !== Number(want.amount) || Number(row.invoiceAmount) !== Number(want.amount);
    });
}

/**
 * 청구 1건을 묶음에 넣을 수 있나. 못 넣으면 이유 코드(화면의 «선택 못 함» 표시와 서버 검사가 같은 함수).
 * 순서가 곧 우선순위: 권한 → 랠리즈 사본 → 미납 → 청구서 → 금액.
 */
export function bundleItemBlock(row: BundleCandidateRow | null | undefined): BundleBlockCode | null {
    if (!row) return "NOT_FOUND";
    if (!row.isPayer) return "NOT_PAYER";
    if (row.rallyzMirror) return "RALLYZ_MIRROR";
    if (!BUNDLE_PAYABLE_PAYMENT_STATUSES.includes(String(row.paymentStatus))) return "NOT_UNPAID";
    if (!row.invoiceId || !row.invoiceStatus) return "NO_INVOICE";
    if (!BUNDLE_PAYABLE_INVOICE_STATUSES.includes(String(row.invoiceStatus))) return "NOT_UNPAID";
    const amount = Number(row.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return "AMOUNT_INVALID";
    if (row.invoiceAmount == null || Number(row.invoiceAmount) !== amount) return "AMOUNT_CHANGED";
    return null;
}

export type BundleEligibility =
    | { ok: true }
    | { ok: false; code: BundleBlockCode; reason: string; paymentId?: string };

function blocked(code: BundleBlockCode, paymentId?: string): BundleEligibility {
    return { ok: false, code, reason: BUNDLE_BLOCK_MESSAGE[code], ...(paymentId ? { paymentId } : {}) };
}

/**
 * 학부모가 고른 청구 목록(requestedIds) ↔ 서버가 다시 읽은 행(rows) 으로 묶음 결제를 시작해도 되나.
 * rows 에는 «본인이 볼 수 있는 자녀»의 청구만 들어 있어야 한다(SQL 이 childAccessSql 로 거른 결과).
 * requestedIds 중 rows 에 없는 id = 남의 청구 또는 없는 청구 → NOT_FOUND(IDOR 차단).
 */
export function bundleCheckoutEligibility(requestedIds: readonly string[], rows: readonly BundleCandidateRow[]): BundleEligibility {
    const ids = Array.isArray(requestedIds) ? requestedIds.map((id) => String(id ?? "").trim()) : [];
    if (ids.length === 0 || ids.some((id) => id === "")) return blocked("EMPTY");
    if (ids.length > MAX_BUNDLE_ITEMS) return blocked("TOO_MANY");
    if (new Set(ids).size !== ids.length) return blocked("DUPLICATE");
    const byId = new Map(rows.map((row) => [String(row.paymentId), row]));
    for (const id of ids) {
        const code = bundleItemBlock(byId.get(id));
        if (code) return blocked(code, id);
    }
    const total = ids.reduce((acc, id) => acc + Number(byId.get(id)!.amount), 0);
    if (total > MAX_BUNDLE_TOTAL) return blocked("TOO_MUCH");
    return { ok: true };
}

/** 토스 주문 항목 1건(PaymentTransactionItem 에 그대로 들어가는 값) */
export type BundleItem = {
    paymentId: string;
    invoiceId: string;
    studentId: string;
    studentName: string;
    title: string;
    amount: number;
    /** 항목 면세 금액 스냅샷 — taxFreeAmountFor(항목 금액). 과세 품목이 생기면 taxFree.ts 한 곳만 바꾼다. */
    taxFreeAmount: number;
    /** 1부터. 1번 = 대표 청구(PaymentTransaction.paymentId·invoiceId) */
    position: number;
};

/**
 * 고른 청구로 주문 항목을 만든다. 정렬 = POS 묶음과 같은 규칙(연·월 → 수강료·셔틀비·기타 → id).
 * 부르기 전에 bundleCheckoutEligibility 가 ok 여야 한다(청구서 id 가 꼭 있어야 함).
 */
export function buildBundleItems(rows: readonly BundleCandidateRow[]): BundleItem[] {
    const sorted = sortChargeItems(rows.map((row) => ({ ...row, id: row.paymentId })));
    return sorted.map((row, index) => {
        const amount = Number(row.amount);
        return {
            paymentId: row.paymentId,
            invoiceId: String(row.invoiceId),
            studentId: row.studentId,
            studentName: row.studentName,
            title: row.title,
            amount,
            taxFreeAmount: taxFreeAmountFor(amount),
            position: index + 1,
        };
    });
}

/** 주문 합계·면세 합계(면세 = 항목 면세의 합) */
export function bundleTotals(items: readonly Pick<BundleItem, "amount" | "taxFreeAmount">[]) {
    return {
        amount: items.reduce((acc, item) => acc + Number(item.amount), 0),
        taxFreeAmount: items.reduce((acc, item) => acc + Number(item.taxFreeAmount), 0),
    };
}

/** 토스 주문 이름 — «김민준 11월 수강료 외 2건» (토스 한도 100자, 여유 있게 80자) */
export function buildBundleOrderName(items: readonly Pick<BundleItem, "studentName" | "title">[]): string {
    const first = items[0];
    if (!first) return "STIZ 수강료";
    const head = `${first.studentName ? `${first.studentName} ` : ""}${first.title || "수강료"}`.trim();
    const name = items.length > 1 ? `${head} 외 ${items.length - 1}건` : head;
    return name.slice(0, 80);
}

/**
 * 토스 주문 번호 — «STIZ-B-{시각}-{대표 청구 앞 8자}». 토스 규칙: 6~64자, 영문·숫자·-·_ 만.
 * 단건(«STIZ-{시각}-{청구서 앞 8자}»)과 머리말이 달라 장부에서 묶음 주문을 바로 알아본다.
 */
export function makeBundleOrderId(nowMs: number, repPaymentId: string): string {
    const tail = String(repPaymentId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "bundle";
    return `STIZ-B-${Math.trunc(nowMs)}-${tail}`;
}

/** 두 묶음이 «같은 청구·같은 금액» 묶음인가(최근 30분 안 READY 주문 재사용 판단 — 순서 무관) */
export function sameBundleItems(
    a: readonly { paymentId: string; amount: number }[],
    b: readonly { paymentId: string; amount: number }[],
): boolean {
    if (a.length !== b.length || a.length === 0) return false;
    const key = (list: readonly { paymentId: string; amount: number }[]) =>
        list.map((item) => `${item.paymentId}:${Number(item.amount)}`).sort().join("|");
    return key(a) === key(b);
}

// ───────────────────────────── 장부 반영 판정 ─────────────────────────────

/** 잠근 뒤 다시 읽은 항목 1건(청구·청구서의 «지금» 상태 + 항목 스냅샷 금액) */
export type BundleLockedItem = {
    paymentId: string;
    invoiceId: string;
    itemAmount: number;
    paymentAmount: number;
    paymentStatus: string;
    invoiceStatus: string;
};

/** 납부 반영할 수 있는 거래 상태(단건 finalizeVerifiedTossPayment 와 같은 목록) */
const FINALIZABLE_TX_STATUSES = new Set(["READY", "IN_PROGRESS", "DONE", "WAITING_FOR_DEPOSIT", "EXPIRED"]);

export type BundleFinalizeDecision =
    | { action: "ALREADY_DONE" }
    | { action: "PAY" }
    | { action: "REJECT"; code: string };

/**
 * 토스가 «결제 완료(DONE)»라고 확인한 묶음 주문을 장부에 반영해도 되나 — 전부 아니면 전무.
 * - 이미 전부 반영됐으면 ALREADY_DONE(웹훅·성공 화면이 두 번 와도 한 번만).
 * - 항목 하나라도 이미 납부·취소·금액 변경이면 REJECT — 하나도 바꾸지 않는다.
 *   무통장입금은 «입금 전에 다른 방법으로 낸 청구가 있다» = VIRTUAL_ACCOUNT_ALREADY_PAID(원장 확인 필요, 기존 단건과 같은 코드).
 *   카드·계좌이체는 승인 전에 미납을 재확인하므로 여기까지 오면 «그 사이 현장 결제됨» = BUNDLE_ITEM_ALREADY_PAID(환불 확인 필요).
 */
export function decideBundleFinalize(input: {
    txStatus: string;
    txAmount: number;
    isVirtualAccount: boolean;
    items: readonly BundleLockedItem[];
}): BundleFinalizeDecision {
    const items = input.items ?? [];
    if (items.length === 0) return { action: "REJECT", code: "BUNDLE_ITEMS_MISSING" };
    const sum = items.reduce((acc, item) => acc + Number(item.itemAmount), 0);
    if (sum !== Number(input.txAmount)) return { action: "REJECT", code: "BUNDLE_AMOUNT_MISMATCH" };

    const allPaid = items.every((item) => item.paymentStatus === "PAID" && item.invoiceStatus === "PAID");
    if (input.txStatus === "DONE" && allPaid) return { action: "ALREADY_DONE" };

    if (!FINALIZABLE_TX_STATUSES.has(String(input.txStatus))) return { action: "REJECT", code: "PAYMENT_ALREADY_CLOSED" };

    const closed = items.some((item) => ["REFUNDED", "CANCELED"].includes(item.paymentStatus) || item.invoiceStatus === "CANCELED");
    if (closed) return { action: "REJECT", code: input.isVirtualAccount ? "VIRTUAL_ACCOUNT_INVOICE_CLOSED" : "BUNDLE_ITEM_CLOSED" };

    const somePaid = items.some((item) => item.paymentStatus === "PAID" || item.invoiceStatus === "PAID");
    if (somePaid) return { action: "REJECT", code: input.isVirtualAccount ? "VIRTUAL_ACCOUNT_ALREADY_PAID" : "BUNDLE_ITEM_ALREADY_PAID" };

    for (const item of items) {
        if (!BUNDLE_PAYABLE_PAYMENT_STATUSES.includes(item.paymentStatus)
            || !BUNDLE_PAYABLE_INVOICE_STATUSES.includes(item.invoiceStatus)) {
            return { action: "REJECT", code: "BUNDLE_ITEM_NOT_PAYABLE" };
        }
        if (Number(item.paymentAmount) !== Number(item.itemAmount)) return { action: "REJECT", code: "BUNDLE_ITEM_AMOUNT_CHANGED" };
    }
    return { action: "PAY" };
}

/**
 * 카드·계좌이체 승인(토스 confirm) «전에» 묶인 청구가 전부 아직 낼 수 있는 상태인지.
 * 하나라도 아니면 승인을 부르지 않는다 — 승인하지 않은 결제창 인증은 토스에서 자동 소멸해 돈이 안 나간다.
 * 막아야 하면 이유 코드, 괜찮으면 null.
 */
export function bundleConfirmBlock(items: readonly (BundleLockedItem & { rallyzMirror?: boolean })[]): BundleBlockCode | null {
    if (!items || items.length === 0) return "EMPTY";
    for (const item of items) {
        if (item.rallyzMirror) return "RALLYZ_MIRROR";
        if (!BUNDLE_PAYABLE_PAYMENT_STATUSES.includes(item.paymentStatus)
            || !BUNDLE_PAYABLE_INVOICE_STATUSES.includes(item.invoiceStatus)) return "NOT_UNPAID";
        if (Number(item.paymentAmount) !== Number(item.itemAmount)) return "AMOUNT_CHANGED";
    }
    return null;
}

export type BundleCancelDecision =
    | { action: "ALREADY_APPLIED" }
    | { action: "APPLY"; refundPaymentIds: string[] }
    | { action: "REJECT"; code: string };

/**
 * 토스에서 «전액 취소»가 확인된 묶음 주문 → 묶인 청구 전부 환불(REFUNDED) 처리.
 * - 납부 완료(PAID)인 항목만 환불로 바꾼다(관리자가 이미 한 건을 환불했으면 그 건은 건너뜀).
 * - 결제 완료 전 거래의 취소는 장부에 반영할 게 없다(PAYMENT_NOT_PAID — 단건과 같은 코드).
 */
export function decideBundleFullCancel(input: {
    txStatus: string;
    items: readonly Pick<BundleLockedItem, "paymentId" | "paymentStatus">[];
}): BundleCancelDecision {
    const items = input.items ?? [];
    if (items.length === 0) return { action: "REJECT", code: "BUNDLE_ITEMS_MISSING" };
    const paid = items.filter((item) => item.paymentStatus === "PAID").map((item) => item.paymentId);
    // 거래 CANCELED 는 이 환불 처리만 남긴다 → 다시 와도 한 번만(다른 방법으로 다시 낸 청구가 PAID 로 남아 있어도)
    if (input.txStatus === "CANCELED") return { action: "ALREADY_APPLIED" };
    if (input.txStatus !== "DONE") return { action: "REJECT", code: "PAYMENT_NOT_PAID" };
    return { action: "APPLY", refundPaymentIds: paid };
}
