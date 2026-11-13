// 토스 결제창 실패·취소로 돌아왔을 때(failUrl ?code=…&message=…) 학부모에게 보일 문장.
// 왜 주소의 message 를 그대로 쓰지 않나: 주소 글은 누구나 바꿔 보낼 수 있어(가짜 안내문을 심을 수 있다) 화면에 그대로 비추지 않는다.
// 코드별로 정해 둔 문장만 쓰고, 모르는 코드는 기본 문장으로.

const TOSS_FAIL_MESSAGE: Record<string, string> = {
    PAY_PROCESS_CANCELED: "결제를 취소했어요.",
    USER_CANCEL: "결제를 취소했어요.",
    PAY_PROCESS_ABORTED: "결제가 중간에 멈췄어요. 잠시 후 다시 시도해 주세요.",
    REJECT_CARD_COMPANY: "카드사에서 결제를 거절했어요. 다른 카드나 결제 방식으로 시도해 주세요.",
    REJECT_CARD_PAYMENT: "카드사에서 결제를 거절했어요. 다른 카드나 결제 방식으로 시도해 주세요.",
    EXCEED_MAX_DAILY_PAYMENT_COUNT: "하루 결제 횟수를 넘었어요. 다른 결제 방식으로 시도해 주세요.",
    EXCEED_MAX_PAYMENT_AMOUNT: "결제 한도를 넘었어요. 체크를 줄여 나눠서 결제해 주세요.",
    INVALID_CARD_NUMBER: "카드 번호를 다시 확인해 주세요.",
    INVALID_STOPPED_CARD: "정지된 카드예요. 다른 카드로 시도해 주세요.",
    NOT_ENOUGH_BALANCE: "잔액이 부족해요. 다른 결제 방식으로 시도해 주세요.",
};

/**
 * 간편결제 바로가기를 쓸 수 없을 때(미계약·미지원 결제수단) 토스가 주는 코드(2026-11-13).
 * 결제창 SDK v2(js.tosspayments.com/v2/standard)에 있는 코드 + 결제 API 의 미지원 코드.
 * ⚠️ src/lib/payments/preferredMethod.ts 의 EASY_PAY_UNAVAILABLE_CODES 와 같은 목록(테스트가 비교) —
 *    거기는 테스트 로더 때문에 이 파일을 import 하지 않고 같은 값을 따로 둔다.
 */
export const EASY_PAY_UNAVAILABLE_CODES = [
    "NOT_SUPPORTED_METHOD",
    "NOT_SUPPORTED",
    "NOT_SUPPORTED_EASY_PAY",
    "INVALID_EASY_PAY",
    "INVALID_FLOW_MODE_PARAMETERS",
    "UNSUPPORTED_TEST_PHASE_PAYMENT_METHOD",
    "NOT_AVAILABLE_PAYMENT",
] as const;

export const EASY_PAY_UNAVAILABLE_MESSAGE = "이 결제 방법은 지금 쓸 수 없어요. 다른 결제 방법(카드)으로 다시 시도해 주세요.";

for (const code of EASY_PAY_UNAVAILABLE_CODES) TOSS_FAIL_MESSAGE[code] = EASY_PAY_UNAVAILABLE_MESSAGE;

/** 간편결제 바로가기 실패로 돌아왔는가(failUrl ?code=) — «카드로 다시» 안내를 붙일지 */
export function isEasyPayUnavailableCode(code: unknown): boolean {
    const key = typeof code === "string" ? code.trim().toUpperCase() : "";
    return (EASY_PAY_UNAVAILABLE_CODES as readonly string[]).includes(key);
}

export const TOSS_FAIL_DEFAULT_MESSAGE = "결제가 완료되지 않았어요. 다시 시도해 주세요.";

/** 토스 실패 코드 → 정해진 안내 문장(모르는 코드·빈 값은 기본 문장) */
export function tossFailMessage(code: unknown): string {
    const key = typeof code === "string" ? code.trim().toUpperCase() : "";
    return Object.prototype.hasOwnProperty.call(TOSS_FAIL_MESSAGE, key) ? TOSS_FAIL_MESSAGE[key] : TOSS_FAIL_DEFAULT_MESSAGE;
}
