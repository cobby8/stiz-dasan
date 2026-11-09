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

export const TOSS_FAIL_DEFAULT_MESSAGE = "결제가 완료되지 않았어요. 다시 시도해 주세요.";

/** 토스 실패 코드 → 정해진 안내 문장(모르는 코드·빈 값은 기본 문장) */
export function tossFailMessage(code: unknown): string {
    const key = typeof code === "string" ? code.trim().toUpperCase() : "";
    return Object.prototype.hasOwnProperty.call(TOSS_FAIL_MESSAGE, key) ? TOSS_FAIL_MESSAGE[key] : TOSS_FAIL_DEFAULT_MESSAGE;
}
