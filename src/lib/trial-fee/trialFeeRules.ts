/**
 * 체험비 온라인 결제 — 순수 규칙(외부 import 없음: 테스트가 그대로 실행한다).
 *
 * ■ 왜 청구(Payment)·토스 거래(PaymentTransaction)를 쓰지 않나
 *   체험 신청자는 아직 원생(Student)이 아니고 로그인도 없다. 기존 거래 표는 청구·청구서·학생 id 가
 *   모두 필수라 체험비를 담을 수 없다. 그래서 체험비는 별도 표(TrialFeePayment)에 같은 모양으로 담고,
 *   토스 호출(승인·조회·취소)·면세 규칙·가상계좌 판정은 기존 함수를 그대로 빌려 쓴다.
 *
 * ■ 권한 = 신청 건에 묶인 결제 링크 토큰
 *   신청 직후 서버가 무작위 토큰(32바이트)을 만들어 해시만 저장하고, 원문은 신청 완료 화면에만 준다.
 *   토큰을 가진 사람만 그 신청의 결제 화면을 연다 — 신청 id 를 주소에 넣지 않는다(남의 신청 결제 방지).
 */

/** 토스 주문번호 머리말 — 청구 결제(STIZ-·STIZ-B-)·심사용(REVIEW-)과 섞이지 않게 */
export const TRIAL_FEE_ORDER_PREFIX = "TRIAL-";

/** 체험비 기본값(원) — 설정(AcademySettings.trialFeeAmount)이 비었거나 이상할 때만 쓴다 */
export const DEFAULT_TRIAL_FEE_AMOUNT = 10_000;
/** 설정으로 받을 수 있는 범위(오타로 100만 원이 결제되는 일을 막는다) */
export const MIN_TRIAL_FEE_AMOUNT = 1_000;
export const MAX_TRIAL_FEE_AMOUNT = 100_000;

/** 체험비 무통장입금 계좌 유효 시간 — 청구(90일)와 달리 체험일 전에 확정돼야 해서 짧게(3일) */
export const TRIAL_VA_VALID_HOURS = 72;

/** 같은 신청에서 «결제창만 열고 닫은» 주문을 다시 쓰는 시간(청구 결제와 같은 30분) */
export const TRIAL_ORDER_REUSE_MINUTES = 30;

/** 결제 링크를 열 수 있는 신청 상태 — 문의·연락·체험 예정까지(참석·등록·취소 뒤에는 결제 안 받음) */
export const TRIAL_PAYABLE_STATUSES = ["NEW", "CONTACTED", "SCHEDULED"] as const;

export type TrialFeePaymentStatus =
    | "READY" // 주문만 만들고 결제창을 연 상태
    | "WAITING_FOR_DEPOSIT" // 무통장입금 계좌 발급 — 입금 전
    | "DONE" // 결제 완료(체험 확정)
    | "CANCELED" // 전액 취소(환불)
    | "EXPIRED" // 무통장입금 기한 지남
    | "FAILED" // 승인 실패
    | "NEEDS_REFUND"; // 같은 신청에 결제가 두 번 들어옴 — 원장 환불 확인

/** 신청(TrialLead) 쪽 요약 칸 — 관리자 목록이 표를 따로 읽지 않게 신청 행에 같이 적는다 */
export type TrialLeadFeeSummary = "WAITING_FOR_DEPOSIT" | "PAID" | "REFUNDED" | "NEEDS_REFUND" | null;

/** 설정값 → 실제 결제 금액. 숫자가 아니거나 범위를 벗어나면 기본값(1만 원). */
export function normalizeTrialFeeAmount(value: unknown): number {
    const amount = typeof value === "string" ? Number(value.replace(/[^0-9]/g, "")) : Number(value);
    if (!Number.isInteger(amount) || amount < MIN_TRIAL_FEE_AMOUNT || amount > MAX_TRIAL_FEE_AMOUNT) {
        return DEFAULT_TRIAL_FEE_AMOUNT;
    }
    return amount;
}

/** 화면 표시용 «10,000원» — 언어 설정과 무관하게 같은 모양 */
export function formatTrialFeeAmount(amount: number): string {
    return `${String(Math.trunc(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
}

/** 결제 링크 토큰 모양 — 32바이트 base64url(43자). 다른 모양은 DB 조회 전에 거른다. */
export function isTrialPaymentTokenShape(token: unknown): token is string {
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** 토스 주문번호(영문·숫자·-·_ 6~64자). randomPart 는 부르는 쪽이 crypto.randomUUID() 로 넘긴다. */
export function makeTrialFeeOrderId(randomPart: string): string {
    const safe = randomPart.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    return `${TRIAL_FEE_ORDER_PREFIX}${safe}`;
}

export function isTrialFeeOrderId(orderId: unknown): orderId is string {
    return typeof orderId === "string" && /^TRIAL-[A-Za-z0-9]{6,32}$/.test(orderId);
}

/** 웹훅 본문에서 주문번호를 꺼낸다(결제 알림은 data.orderId, 입금 알림은 최상위 orderId). */
export function extractWebhookOrderId(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : record;
    const orderId = data.orderId ?? record.orderId;
    return typeof orderId === "string" && orderId ? orderId : null;
}

/** 주문명 — 토스 결제창·영수증에 보인다(최대 100자). 아이 이름은 넣지 않는다(영수증 공유 시 노출 방지). */
export function trialFeeOrderName(): string {
    return "STIZ 농구교실 체험수업비";
}

export type TrialCheckoutBlock =
    | "NOT_FOUND" // 토큰에 맞는 신청이 없음
    | "CLOSED" // 참석·등록·취소 등 결제를 받지 않는 상태
    | "ALREADY_PAID" // 이미 결제(또는 학원이 입금 확인) 완료
    | "PAYMENT_OFF"; // 온라인 결제가 꺼져 있거나 결제 키가 준비되지 않음

export const TRIAL_CHECKOUT_BLOCK_MESSAGE: Record<TrialCheckoutBlock, string> = {
    NOT_FOUND: "결제 링크를 찾을 수 없어요. 체험수업 신청을 다시 해 주시거나 학원에 문의해 주세요.",
    CLOSED: "이 체험수업 신청은 지금 결제할 수 없어요. 학원에 문의해 주세요.",
    ALREADY_PAID: "체험수업비 결제가 이미 완료됐어요.",
    PAYMENT_OFF: "지금은 온라인 결제를 쓸 수 없어요. 학원에 문의해 주세요.",
};

/**
 * 결제창을 열어도 되는가 — 서버가 DB 값으로 다시 판단한다(화면 값은 믿지 않는다).
 * 학원이 «입금 확인» 버튼으로 이미 확인한 신청(trialFeeConfirmed)도 이미 낸 것으로 본다.
 */
export function trialCheckoutBlock(input: {
    found: boolean;
    status: string | null | undefined;
    feeConfirmed: boolean | null | undefined;
    feeSummary: string | null | undefined;
    paymentEnabled: boolean;
}): TrialCheckoutBlock | null {
    if (!input.found) return "NOT_FOUND";
    if (input.feeConfirmed || input.feeSummary === "PAID") return "ALREADY_PAID";
    if (!(TRIAL_PAYABLE_STATUSES as readonly string[]).includes(String(input.status ?? ""))) return "CLOSED";
    if (!input.paymentEnabled) return "PAYMENT_OFF";
    return null;
}

export type TrialConfirmDecision =
    | { kind: "PROCEED" }
    | { kind: "ALREADY_DONE" } // 같은 결제키로 이미 확정(새로고침) — 토스를 다시 부르지 않는다
    | { kind: "WAITING_DEPOSIT" } // 같은 결제키로 계좌 발급됨(새로고침)
    | { kind: "REJECT"; reason: "AMOUNT_MISMATCH" | "ORDER_CLOSED" | "LEAD_ALREADY_PAID" | "IN_PROGRESS" };

/**
 * 토스 결제창에서 돌아온 값(paymentKey·orderId·amount)을 저장된 주문과 비교한다 — 승인(돈이 나가는 순간) 전에.
 * - 금액은 저장된 주문 금액과 같아야 한다(주소창에서 바꾼 금액 차단)
 * - 신청이 이미 다른 결제로 확정됐으면 승인하지 않는다(이중 확정 방지 — 승인 안 한 결제창 인증은 토스에서 자동 소멸)
 */
export function decideTrialFeeConfirm(input: {
    stored: { amount: number; status: string; paymentKey: string | null; confirmStartedAtMs: number | null };
    request: { paymentKey: string; amount: number };
    leadAlreadyPaid: boolean;
    nowMs: number;
}): TrialConfirmDecision {
    const { stored, request } = input;
    if (Number(stored.amount) !== Number(request.amount)) return { kind: "REJECT", reason: "AMOUNT_MISMATCH" };
    if (stored.status === "DONE" && stored.paymentKey === request.paymentKey) return { kind: "ALREADY_DONE" };
    if (stored.status === "WAITING_FOR_DEPOSIT" && stored.paymentKey === request.paymentKey) return { kind: "WAITING_DEPOSIT" };
    if (input.leadAlreadyPaid) return { kind: "REJECT", reason: "LEAD_ALREADY_PAID" };
    if (stored.status !== "READY") return { kind: "REJECT", reason: "ORDER_CLOSED" };
    // 다른 탭이 10분 안에 승인을 시작했다 — 두 번 승인하지 않는다
    if (stored.confirmStartedAtMs != null && input.nowMs - stored.confirmStartedAtMs < 10 * 60_000) {
        return { kind: "REJECT", reason: "IN_PROGRESS" };
    }
    return { kind: "PROCEED" };
}

export const TRIAL_CONFIRM_REJECT_MESSAGE: Record<Extract<TrialConfirmDecision, { kind: "REJECT" }>["reason"], string> = {
    AMOUNT_MISMATCH: "결제 금액이 체험수업비와 달라 결제하지 않았어요. 다시 시도해 주세요.",
    ORDER_CLOSED: "결제 주문이 이미 끝났어요. 결제 화면에서 다시 시도해 주세요.",
    LEAD_ALREADY_PAID: "체험수업비 결제가 이미 완료됐어요. 이번 결제는 진행되지 않았어요.",
    IN_PROGRESS: "결제를 확인하는 중이에요. 잠시 후 다시 확인해 주세요.",
};

/**
 * 토스 승인·조회 결과가 이 주문과 맞는가.
 * DONE = 결제 완료, WAITING = 무통장입금 계좌 발급, MISMATCH = 다른 주문·다른 금액(장부 반영 금지).
 */
export function classifyTrialTossResult(
    result: { status?: unknown; orderId?: unknown; paymentKey?: unknown; totalAmount?: unknown } | null,
    stored: { orderId: string; amount: number },
    expectedPaymentKey: string | null,
): "DONE" | "WAITING" | "MISMATCH" {
    if (!result) return "MISMATCH";
    if (result.orderId !== stored.orderId) return "MISMATCH";
    if (typeof result.paymentKey !== "string" || !result.paymentKey) return "MISMATCH";
    if (expectedPaymentKey && result.paymentKey !== expectedPaymentKey) return "MISMATCH";
    if (Number(result.totalAmount) !== Number(stored.amount)) return "MISMATCH";
    if (result.status === "DONE") return "DONE";
    if (result.status === "WAITING_FOR_DEPOSIT") return "WAITING";
    return "MISMATCH";
}

/**
 * 관리자 화면 «체험비» 칸 문구 — 온라인 결제 요약(feeSummary)이 있으면 그것을 먼저 쓴다.
 * 없으면 null(부르는 쪽이 예전 입금 확인 문구를 쓴다).
 */
export function trialOnlineFeeLabel(feeSummary: string | null | undefined): "결제 완료(온라인)" | "입금 대기(무통장 계좌 발급)" | "환불 완료" | "이중 결제(환불 필요)" | null {
    if (feeSummary === "PAID") return "결제 완료(온라인)";
    if (feeSummary === "NEEDS_REFUND") return "이중 결제(환불 필요)";
    if (feeSummary === "WAITING_FOR_DEPOSIT") return "입금 대기(무통장 계좌 발급)";
    if (feeSummary === "REFUNDED") return "환불 완료";
    return null;
}

/**
 * 관리자 체험 목록 한 줄 행의 «체험비» 짧은 표시(이름 옆). 표시할 것이 없으면 null.
 * 온라인 결제 요약이 먼저, 없으면 학원 입금 확인(trialFeeConfirmed).
 */
export function trialFeeListChip(lead: { trialFeeConfirmed?: boolean | null; trialFeePaymentStatus?: string | null }): { label: string; needsAction: boolean } | null {
    if (lead.trialFeePaymentStatus === "NEEDS_REFUND") return { label: "환불 필요", needsAction: true };
    if (lead.trialFeePaymentStatus === "PAID" && lead.trialFeeConfirmed) return { label: "결제", needsAction: false };
    if (lead.trialFeePaymentStatus === "WAITING_FOR_DEPOSIT" && !lead.trialFeeConfirmed) return { label: "입금 대기", needsAction: false };
    if (lead.trialFeePaymentStatus === "REFUNDED" && !lead.trialFeeConfirmed) return { label: "환불", needsAction: false };
    if (lead.trialFeeConfirmed) return { label: "입금", needsAction: false };
    return null;
}

/** 관리자 «체험비 환불» 버튼을 보일 신청인가 — 온라인 결제 완료 또는 이중 결제 */
export function canRefundTrialFeeOnline(feeSummary: string | null | undefined): boolean {
    return feeSummary === "PAID" || feeSummary === "NEEDS_REFUND";
}
