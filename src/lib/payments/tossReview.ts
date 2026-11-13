/**
 * 공개 화면에 내놓을 수 있는 프로그램인지 판정한다 — 순수 계산만 담는다(DB·fetch 없음).
 *
 * ■ 이 파일의 내력
 *   2026-10-02 토스페이먼츠 가맹 심사용 테스트 결제(TOSS_REVIEW_* 키·주문서·결제창)가 여기 있었다.
 *   심사가 끝나(2026-11-07 승인) 2026-11-14 에 심사용 결제 코드는 전부 지웠고,
 *   홈·프로그램 안내가 쓰는 «0원 프로그램 숨김» 판정만 남겼다.
 *   (파일 이름은 그대로 둔다 — 부르는 곳과 테스트가 이 경로를 쓴다)
 */

/** 프로그램 가격 칸 — 공개 프로그램 화면의 가격표와 같은 이름. */
const PRICE_TIER_KEYS = ["price", "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily"] as const;

export type ProgramPriceColumns = {
    price: number | null;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
};

/** 금액으로 쓸 수 있는 값인가 — 양의 정수만(0원·빈 칸·소수는 안 됨). */
function isSellableAmount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 공개 화면에 내놓을 수 있는 프로그램인가 — 가격 칸 5개 중 하나라도 1원 이상이면 true.
 * 0원 상품(가격을 아직 안 정한 특강 등)은 공개 프로그램 화면에 내놓지 않는다.
 */
export function hasSellablePrice(program: ProgramPriceColumns): boolean {
    return PRICE_TIER_KEYS.some((key) => isSellableAmount(program[key]));
}
