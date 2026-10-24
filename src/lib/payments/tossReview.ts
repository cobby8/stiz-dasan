/**
 * 토스페이먼츠 **가맹 심사용** 테스트 결제 — 순수 계산만 담는다(DB·fetch 없음).
 *
 * ■ 왜 따로 두는가
 *   심사 담당자는 사이트에서 카드 결제창이 실제로 열리는지 본다. 그런데 학부모 청구서 결제
 *   (payment-ledger)에 테스트 키를 넣으면, 테스트 카드로 "결제"한 청구서가 **돈이 안 들어왔는데
 *   납부 완료로** 바뀐다. 그래서 심사용은 이름부터 다른 환경변수(TOSS_REVIEW_*)를 쓰고,
 *   청구서·DB 를 전혀 건드리지 않는다.
 *
 * ■ 실제 키가 들어오면 저절로 꺼진다
 *   두 키가 모두 `test_` 로 시작할 때만 켜진다. 라이브 키(live_)를 실수로 넣어도 버튼이 안 보이고
 *   API 는 404 다 — 심사용 화면으로 진짜 돈이 오가는 일을 막는다.
 */

export type TossReviewConfig = { clientKey: string; secretKey: string };

/** 프로그램 가격 칸 — 공개 프로그램 화면의 가격표와 같은 이름. */
export const REVIEW_PRICE_TIERS = [
    { key: "price", label: "월 수강료" },
    { key: "priceWeek1", label: "주 1회" },
    { key: "priceWeek2", label: "주 2회" },
    { key: "priceWeek3", label: "주 3회" },
    { key: "priceDaily", label: "매일반" },
] as const;

export type ReviewPriceTier = (typeof REVIEW_PRICE_TIERS)[number]["key"];

export type ReviewProgramPrices = {
    name: string;
    price: number | null;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
};

/** 두 키가 모두 테스트 키일 때만 설정을 돌려준다. 하나라도 비었거나 라이브 키면 null(=기능 꺼짐). */
export function readTossReviewConfig(env: Record<string, string | undefined>): TossReviewConfig | null {
    const clientKey = (env.TOSS_REVIEW_CLIENT_KEY ?? "").trim();
    const secretKey = (env.TOSS_REVIEW_SECRET_KEY ?? "").trim();
    if (!clientKey.startsWith("test_") || !secretKey.startsWith("test_")) return null;
    return { clientKey, secretKey };
}

export function isReviewPriceTier(value: unknown): value is ReviewPriceTier {
    return REVIEW_PRICE_TIERS.some((tier) => tier.key === value);
}

/**
 * 결제 금액과 주문명을 **서버의 프로그램 가격**으로 정한다. 화면이 보낸 금액은 믿지 않는다.
 * 가격이 없거나 0 이하면 null — 0원 결제창을 열지 않는다.
 */
export function resolveReviewOrder(program: ReviewProgramPrices, tier: ReviewPriceTier) {
    const amount = program[tier];
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return null;
    const label = REVIEW_PRICE_TIERS.find((item) => item.key === tier)?.label ?? "월 수강료";
    const orderName = tier === "price" ? `${program.name} 월 수강료` : `${program.name} ${label} 월 수강료`;
    // 토스 주문명 최대 100자
    return { amount, orderName: orderName.slice(0, 100) };
}

/**
 * 토스 주문번호 규칙: 영문·숫자·-·_ 6~64자. 실제 청구서 주문과 섞이지 않게 REVIEW- 로 시작한다.
 * randomPart 는 호출하는 쪽이 crypto.randomUUID() 로 넘긴다(여기는 순수 함수로 둔다).
 */
export function makeReviewOrderId(randomPart: string) {
    const safe = randomPart.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
    return `REVIEW-${safe}`;
}

export function isReviewOrderId(orderId: unknown): orderId is string {
    return typeof orderId === "string" && /^REVIEW-[A-Za-z0-9]{6,40}$/.test(orderId);
}

/** 금액으로 쓸 수 있는 값인가 — 양의 정수만(0원·빈 칸·소수는 안 됨). */
function isSellableAmount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 공개 화면에 내놓을 수 있는 프로그램인가 — 가격 칸 5개 중 하나라도 1원 이상이면 true.
 * 토스 심사 기준상 0원 상품은 노출하면 안 되므로, 공개 프로그램 화면이 이걸로 거른다.
 */
export function hasSellablePrice(program: Omit<ReviewProgramPrices, "name">): boolean {
    return REVIEW_PRICE_TIERS.some((tier) => isSellableAmount(program[tier.key]));
}

export type ReviewTierOption = { key: ReviewPriceTier; label: string; amount: number };

/**
 * 고를 수 있는 수업 빈도(가격 칸) 목록 — 프로그램 카드의 [결제하기]와 주문서가 같이 쓴다.
 * 주 1~3회·매일반 중 금액이 있는 칸을 쓰고, 하나도 없으면 "월 수강료"(price) 한 칸으로 대신한다.
 */
export function listReviewTierOptions(program: Omit<ReviewProgramPrices, "name">): ReviewTierOption[] {
    const weekly = REVIEW_PRICE_TIERS.filter((tier) => tier.key !== "price")
        .filter((tier) => isSellableAmount(program[tier.key]))
        .map((tier) => ({ key: tier.key, label: tier.label, amount: program[tier.key] as number }));
    if (weekly.length > 0) return weekly;
    return isSellableAmount(program.price) ? [{ key: "price", label: "월 수강료", amount: program.price }] : [];
}

/**
 * 휴대폰 번호를 숫자만 남겨 검증한다. 010-1234-5678 / 01012345678 / 011-123-4567 모두 허용.
 * 올바르면 숫자 문자열(토스 customerMobilePhone 형식), 아니면 null.
 */
export function normalizeMobilePhone(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const digits = input.replace(/[\s-]/g, "");
    // 010 은 뒤 8자리, 011·016~019(옛 번호)는 7~8자리
    return /^(010\d{8}|01[16789]\d{7,8})$/.test(digits) ? digits : null;
}
