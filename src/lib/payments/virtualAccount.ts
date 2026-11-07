// 무통장입금(가상계좌) — 발급·표시·입금 알림 판정을 모은 한 곳(외부 의존 없는 순수 모듈).
//
// ■ 흐름
//   1) 학부모가 결제창에서 «무통장입금»을 고르면 토스가 입금 전용 계좌를 발급한다.
//      승인 응답 status = WAITING_FOR_DEPOSIT → 청구서는 **미납 그대로**, 거래(PaymentTransaction)만 «입금 대기».
//   2) 학부모가 아무 은행에서 그 계좌로 입금하면 토스가 DEPOSIT_CALLBACK 웹훅을 보낸다.
//      secret 대조 → 토스 결제 조회로 재확인(DONE·금액·면세) → 그때만 납부 완료.
//   3) 기한이 지나거나 취소되면 «입금 대기»만 풀고 청구는 미납 그대로 둔다.
//   근거: https://docs.tosspayments.com/guides/v2/payment-window/integration-virtual-account
//
// ■ 이 파일이 순수해야 하는 이유
//   학부모 화면(클라이언트)도 여기 타입·표시 함수를 쓴다. node:crypto·prisma 를 넣으면 브라우저 번들이 깨진다.
//   secret 해시·대조는 virtualAccountSecret.ts(서버 전용)에 따로 둔다.

import { describeTaxFreeMismatch } from "@/lib/payments/taxFree";
import { formatKstDate, kstHm } from "@/lib/datetime/kst";

/** 계좌 유효 시간 — 토스 최대값 2160시간(90일). 청구 기한과 상관없이 넉넉히 연다. */
export const VIRTUAL_ACCOUNT_VALID_HOURS = 2160;
/** 입금 대기 거래 상태(토스 결제 상태 이름을 그대로 쓴다). 청구서 상태는 새로 만들지 않는다. */
export const VA_WAITING_STATUS = "WAITING_FOR_DEPOSIT";
/** 기한 만료·취소로 «입금 대기»가 풀린 거래 상태. */
export const VA_EXPIRED_STATUS = "EXPIRED";
/** 토스가 돌려주는 결제수단 값. 카드 결제가 "카드"로 저장되는 것과 같은 관례(한국어 그대로 표시된다). */
export const VA_METHOD = "가상계좌";

// 토스 가상계좌 은행 코드(두 자리) → 은행 이름. 모르는 코드는 숫자를 그대로 보여 준다.
const BANK_NAMES: Record<string, string> = {
    "02": "산업은행", "03": "기업은행", "04": "국민은행", "07": "수협은행", "11": "농협은행", "12": "지역농축협",
    "20": "우리은행", "23": "SC제일은행", "27": "씨티은행", "31": "iM뱅크(대구)", "32": "부산은행", "34": "광주은행",
    "35": "제주은행", "37": "전북은행", "39": "경남은행", "45": "새마을금고", "48": "신협", "50": "저축은행",
    "64": "산림조합", "71": "우체국", "81": "하나은행", "88": "신한은행", "89": "케이뱅크", "90": "카카오뱅크",
    "92": "토스뱅크",
};

export function bankNameFor(code: unknown): string {
    const key = typeof code === "string" ? code.trim() : typeof code === "number" ? String(code).padStart(2, "0") : "";
    if (!key) return "은행";
    return BANK_NAMES[key] ?? `은행(${key})`;
}

/** DB(rawResponse.virtualAccountIssue)에 저장하는 발급 정보 — secret 은 여기 절대 넣지 않는다. */
export type VirtualAccountIssue = {
    bankCode: string | null;
    bankName: string;
    accountNumber: string;
    customerName: string | null;
    dueDate: string; // 토스 원문 ISO(+09:00 포함). 시각 비교는 Date 로, 표시는 KST 모듈로.
    amount: number;
};

/** 학부모 화면에 내보내는 모양. 고른 칸만 담는다(secret·해시·paymentKey 없음). */
export type PublicVirtualAccountView = {
    bankName: string;
    accountNumber: string;
    customerName: string | null;
    amount: number;
    dueDate: string;
    dueLabel: string; // "2027년 2월 6일 14:30" (KST)
    expired: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseInstant(value: unknown): Date | null {
    if (typeof value !== "string" || !value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 토스 승인(또는 조회) 응답에서 발급 정보를 뽑는다. 계좌번호·기한이 없으면 null(발급으로 보지 않는다). */
export function extractVirtualAccountIssue(payment: unknown, amount: number): VirtualAccountIssue | null {
    const va = asRecord(asRecord(payment).virtualAccount);
    const accountNumber = readText(va.accountNumber);
    const dueDate = readText(va.dueDate);
    if (!accountNumber || !dueDate || !parseInstant(dueDate)) return null;
    const bankCode = readText(va.bankCode) ?? (typeof va.bankCode === "number" ? String(va.bankCode) : null);
    return {
        bankCode,
        bankName: bankNameFor(va.bankCode),
        accountNumber,
        customerName: readText(va.customerName),
        dueDate,
        amount,
    };
}

/** 저장된 발급 정보를 다시 읽는다(JSON 이 깨졌으면 null). */
export function readStoredIssue(value: unknown): VirtualAccountIssue | null {
    const raw = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
    const r = asRecord(raw);
    const accountNumber = readText(r.accountNumber);
    const dueDate = readText(r.dueDate);
    const amount = Number(r.amount);
    if (!accountNumber || !dueDate || !parseInstant(dueDate) || !Number.isFinite(amount)) return null;
    return {
        bankCode: readText(r.bankCode),
        bankName: readText(r.bankName) ?? bankNameFor(r.bankCode),
        accountNumber,
        customerName: readText(r.customerName),
        dueDate,
        amount,
    };
}

/** 입금 기한이 지났는가. 시각(순간) 비교라 시간대가 끼지 않는다. */
export function isVirtualAccountExpired(issue: Pick<VirtualAccountIssue, "dueDate">, nowMs: number): boolean {
    const due = parseInstant(issue.dueDate);
    return !due || due.getTime() <= nowMs;
}

/** "2027년 2월 6일 14:30" — KST 기준 날짜 + 24시간제 시각. */
export function formatVirtualAccountDue(dueDate: string): string {
    const due = parseInstant(dueDate);
    if (!due) return "";
    return `${formatKstDate(due, { year: "numeric", month: "long", day: "numeric" }, "")} ${kstHm(due)}`.trim();
}

/**
 * 학부모 화면용 모양을 만든다. 거래 상태가 EXPIRED 거나 기한이 지났으면 expired=true.
 * ⚠️ 칸을 하나씩 골라 담는다 — 원문 객체를 펼치면(...) secret 이 섞여 나갈 수 있다.
 */
export function toPublicVirtualAccountView(
    issue: VirtualAccountIssue,
    txStatus: string | null | undefined,
    nowMs: number,
): PublicVirtualAccountView {
    return {
        bankName: issue.bankName,
        accountNumber: issue.accountNumber,
        customerName: issue.customerName,
        amount: issue.amount,
        dueDate: issue.dueDate,
        dueLabel: formatVirtualAccountDue(issue.dueDate),
        expired: txStatus === VA_EXPIRED_STATUS || isVirtualAccountExpired(issue, nowMs),
    };
}

/**
 * 마이페이지 목록용 — 청구가 아직 미납일 때만 최근 가상계좌를 보여 준다(납부·환불·취소면 null).
 * vaStatus·vaIssue 는 SQL 이 가장 최근 가상계좌 거래에서 고른 상태·발급 정보다.
 */
export function parentVirtualAccountView(
    paymentStatus: string | null | undefined,
    vaStatus: string | null | undefined,
    vaIssue: unknown,
    nowMs: number,
): PublicVirtualAccountView | null {
    if (paymentStatus !== "PENDING" && paymentStatus !== "OVERDUE") return null;
    if (vaStatus !== VA_WAITING_STATUS && vaStatus !== VA_EXPIRED_STATUS) return null;
    const issue = readStoredIssue(vaIssue);
    return issue ? toPublicVirtualAccountView(issue, vaStatus, nowMs) : null;
}

/** 응답 객체에서 secret 칸을 지운 얕은 복사본(학부모에게 돌려주는 승인 결과용). */
export function stripPaymentSecret<T>(payment: T): T {
    if (!payment || typeof payment !== "object") return payment;
    const copy = { ...(payment as Record<string, unknown>) };
    delete copy.secret;
    if (copy.virtualAccount && typeof copy.virtualAccount === "object") {
        const va = { ...(copy.virtualAccount as Record<string, unknown>) };
        delete va.secret;
        copy.virtualAccount = va;
    }
    return copy as T;
}

/**
 * 웹훅 본문이 DEPOSIT_CALLBACK(가상계좌 입금 알림)인가.
 * 토스 DEPOSIT_CALLBACK 본문 = { createdAt, secret, status, transactionKey, orderId } — eventType 칸이 없다.
 */
export function isDepositCallbackPayload(payload: unknown): boolean {
    const r = asRecord(payload);
    if (r.eventType === "DEPOSIT_CALLBACK") return true;
    return !r.eventType && typeof r.secret === "string" && typeof r.status === "string" && typeof r.orderId === "string";
}

/** 이 거래가 가상계좌 거래인가(입금 대기·만료 상태이거나 수단이 가상계좌). */
export function isVirtualAccountTransaction(tx: { status?: string | null; method?: string | null }): boolean {
    return tx.status === VA_WAITING_STATUS || tx.status === VA_EXPIRED_STATUS || tx.method === VA_METHOD;
}

/** secret 대조 결과(대조 자체는 서버 전용 virtualAccountSecret.ts 가 한다). */
export type DepositSecretCheck = "MATCH" | "MISMATCH" | "NOT_PROVIDED" | "NOT_STORED";

export type VirtualAccountWebhookDecision =
    | { action: "PAY" }
    | { action: "ALREADY_DONE" }
    | { action: "RELEASE"; reason: string }
    | { action: "REJECT"; code: string; alert: boolean }
    | { action: "IGNORE"; code: string }
    | { action: "DELEGATE" }; // 입금 뒤 환불(전액 취소) — 기존 카드 취소 경로에 맡긴다

const RELEASE_STATUSES = new Set(["EXPIRED", "ABORTED", "CANCELED", "PARTIAL_CANCELED"]);
const PAYABLE_TX_STATUSES = new Set(["READY", "IN_PROGRESS", VA_WAITING_STATUS, VA_EXPIRED_STATUS]);

/**
 * 가상계좌 거래에 온 웹훅을 어떻게 처리할지 정한다. 장부를 바꾸는 쪽은 이 결과대로만 움직인다.
 * verified = 토스 결제 조회 API 로 다시 읽은 결과(웹훅 본문은 믿지 않는다).
 */
export function decideVirtualAccountWebhook(input: {
    isDepositCallback: boolean;
    secretCheck: DepositSecretCheck;
    tx: { orderId: string; amount: number; status: string; paymentKey?: string | null };
    paymentStatus: string | null | undefined; // 청구(Payment) 상태
    verified: Record<string, unknown> | null;
}): VirtualAccountWebhookDecision {
    const { tx, verified } = input;

    // 1) secret — 저장된 값과 다르면 위조로 본다. 입금 알림인데 secret 이 없어도 거부한다.
    //    (저장값이 없을 때는 = 승인 응답을 못 받고 조회로 복구한 경우. 그때는 아래 토스 재조회만 믿는다.)
    if (input.secretCheck === "MISMATCH") return { action: "REJECT", code: "DEPOSIT_SECRET_MISMATCH", alert: false };
    if (input.isDepositCallback && input.secretCheck === "NOT_PROVIDED") {
        return { action: "REJECT", code: "DEPOSIT_SECRET_MISSING", alert: false };
    }

    // 2) 토스 재조회 결과가 이 주문과 같은 결제인가
    if (!verified) return { action: "IGNORE", code: "TOSS_PAYMENT_NOT_VERIFIED" };
    if (verified.orderId !== tx.orderId || (tx.paymentKey && verified.paymentKey && verified.paymentKey !== tx.paymentKey)) {
        return { action: "REJECT", code: "TOSS_PAYMENT_MISMATCH", alert: false };
    }
    const status = typeof verified.status === "string" ? verified.status : "";

    if (status === "DONE") {
        if (tx.status === "DONE") return { action: "ALREADY_DONE" };
        if (Number(verified.totalAmount) !== Number(tx.amount)) {
            return { action: "REJECT", code: "VIRTUAL_ACCOUNT_AMOUNT_MISMATCH", alert: true };
        }
        if (describeTaxFreeMismatch(verified)) {
            return { action: "REJECT", code: "VIRTUAL_ACCOUNT_TAX_FREE_MISMATCH", alert: true };
        }
        // 입금 전에 다른 수단(현장·관리자)으로 이미 납부됐다 → 이중 납부. 자동 처리하지 않고 원장에게 알린다.
        if (input.paymentStatus === "PAID") return { action: "REJECT", code: "VIRTUAL_ACCOUNT_ALREADY_PAID", alert: true };
        if (input.paymentStatus === "REFUNDED" || input.paymentStatus === "CANCELED") {
            return { action: "REJECT", code: "VIRTUAL_ACCOUNT_INVOICE_CLOSED", alert: true };
        }
        if (!PAYABLE_TX_STATUSES.has(tx.status)) return { action: "REJECT", code: "VIRTUAL_ACCOUNT_TX_CLOSED", alert: true };
        return { action: "PAY" };
    }

    if (status === VA_WAITING_STATUS) {
        // 납부 완료였는데 다시 입금 대기 = 은행이 입금을 취소한 경우. 자동으로 되돌리지 않고 알린다.
        if (tx.status === "DONE") return { action: "REJECT", code: "VIRTUAL_ACCOUNT_DEPOSIT_REVERSED", alert: true };
        return { action: "IGNORE", code: "VIRTUAL_ACCOUNT_STILL_WAITING" };
    }

    if (RELEASE_STATUSES.has(status)) {
        if (tx.status === "DONE") return status === "CANCELED" ? { action: "DELEGATE" } : { action: "IGNORE", code: "TOSS_PARTIAL_CANCEL_REVIEW" };
        return { action: "RELEASE", reason: status };
    }

    return { action: "IGNORE", code: "TOSS_PAYMENT_NOT_VERIFIED" };
}

/**
 * 토스 시각 문자열 → Date. 결제 객체 날짜는 "+09:00" 이 붙어 오지만,
 * DEPOSIT_CALLBACK 본문 createdAt 은 "2022-01-01T00:00:00.000000" 처럼 **시간대 없이 한국 시각**으로 온다.
 * 그대로 new Date() 하면 서버(UTC)가 9시간 어긋나게 읽으므로, 시간대가 없으면 KST(+09:00)로 붙여 읽는다.
 */
export function parseTossTimestamp(value: unknown): Date | null {
    if (typeof value !== "string") return null;
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
    if (!m) return null;
    const fraction = m[2] ? m[2].slice(0, 4) : ""; // 소수 초는 밀리초(3자리)까지만
    const d = new Date(`${m[1]}${fraction}${m[3] ?? "+09:00"}`);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 결제창에 넘길 휴대폰 번호. 토스는 숫자만 받고 형식이 틀리면 결제창이 오류를 낸다 → 확실할 때만 넘긴다.
 */
export function toTossMobilePhone(phone: string | null | undefined): string | undefined {
    const digits = String(phone ?? "").replace(/\D/g, "");
    return /^01\d{8,9}$/.test(digits) ? digits : undefined;
}
