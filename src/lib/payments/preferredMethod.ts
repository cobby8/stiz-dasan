// 학부모 결제 «자주 쓰는 결제 방법» 규칙(2026-11-13 원장 결정 방식 ①).
//
// 왜 이렇게 하나: 카드 정보를 우리가 저장하지 않는다(브랜드페이·자동결제는 별도 계약이라 이번엔 안 함).
// 대신 ① 간편결제 앱으로 바로 가는 버튼(토스 결제창 SDK v2 의 flowMode "DIRECT" + easyPay 코드)과
//      ② 지난번에 쓴 방법을 기억해 결제 화면 맨 위에 큰 버튼으로 보여 준다.
//
// 이 파일은 순수 규칙만 둔다(DB·화면 의존 없음 → 테스트에서 실제로 실행해 확인한다).
// 화면 = src/components/parent/PaymentMethodPicker.tsx, 저장 = src/lib/payments/preferredMethodStore.ts.

/**
 * 우리 쪽 결제 방법 코드 — User."preferredPaymentMethod" 에 이 값만 저장한다(화이트리스트).
 * 계좌이체(TRANSFER)는 원래 있던 결제 방식이라 그대로 둔다(기존 기능 보존).
 */
export const PREFERRED_PAYMENT_METHODS = ["TOSSPAY", "KAKAOPAY", "NAVERPAY", "CARD", "TRANSFER", "VIRTUAL_ACCOUNT"] as const;
export type PreferredPaymentMethod = (typeof PREFERRED_PAYMENT_METHODS)[number];

/** 간편결제 바로가기 3종 — 토스 «간편결제사 코드»(영문) 그대로.
 *  출처: https://docs.tosspayments.com/codes/org-codes (간편결제사 코드 표: 토스페이 TOSSPAY · 네이버페이 NAVERPAY · 카카오페이 KAKAOPAY) — 2026-11-13 확인 */
export const EASY_PAY_CODES = {
    TOSSPAY: "TOSSPAY",
    KAKAOPAY: "KAKAOPAY",
    NAVERPAY: "NAVERPAY",
} as const;
export type EasyPayMethod = keyof typeof EASY_PAY_CODES;

/** 결제 화면 버튼 순서·이름·아이콘(Material Symbols). 브랜드 로고 이미지는 쓰지 않고 글자로만 보인다. */
export const PAYMENT_METHOD_OPTIONS: { value: PreferredPaymentMethod; label: string; icon: string }[] = [
    { value: "TOSSPAY", label: "토스페이", icon: "account_balance_wallet" },
    { value: "KAKAOPAY", label: "카카오페이", icon: "account_balance_wallet" },
    { value: "NAVERPAY", label: "네이버페이", icon: "account_balance_wallet" },
    { value: "CARD", label: "카드", icon: "credit_card" },
    { value: "TRANSFER", label: "계좌이체", icon: "account_balance" },
    { value: "VIRTUAL_ACCOUNT", label: "무통장입금", icon: "savings" },
];

/** 값 → 화면 이름(모르는 값은 null) */
export function paymentMethodLabel(value: unknown): string | null {
    return PAYMENT_METHOD_OPTIONS.find((option) => option.value === value)?.label ?? null;
}

/** 맨 위 큰 버튼 글 — «토스페이로 결제»·«카드로 결제»(받침에 따라 «으로») */
export function quickPayLabel(value: PreferredPaymentMethod): string {
    const label = paymentMethodLabel(value) ?? "카드";
    const last = label.charCodeAt(label.length - 1);
    // 한글 받침 판정: (글자-0xAC00) % 28 이 0 이면 받침 없음. 받침 «ㄹ»(8)도 «로»를 쓴다.
    const jong = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 : 0;
    return `${label}${jong === 0 || jong === 8 ? "로" : "으로"} 결제`;
}

/** 화면·서버 동작이 보낸 값을 화이트리스트로 거른다. 모르는 값·빈 값은 null(= 정하지 않음). */
export function normalizePreferredPaymentMethod(value: unknown): PreferredPaymentMethod | null {
    if (typeof value !== "string") return null;
    const key = value.trim().toUpperCase();
    return (PREFERRED_PAYMENT_METHODS as readonly string[]).includes(key) ? (key as PreferredPaymentMethod) : null;
}

export function isEasyPayMethod(value: PreferredPaymentMethod): value is EasyPayMethod {
    return Object.prototype.hasOwnProperty.call(EASY_PAY_CODES, value);
}

/** 서버 결제 준비 API(/api/payments/checkout · /api/mypage/payments/checkout)에 보낼 방식.
 *  간편결제는 토스에서 «카드» 결제라 서버에는 CARD 로 보낸다(서버 계약 그대로 — 금액·주문은 서버가 정한다). */
export function serverMethodFor(value: PreferredPaymentMethod): "CARD" | "TRANSFER" | "VIRTUAL_ACCOUNT" {
    if (value === "TRANSFER" || value === "VIRTUAL_ACCOUNT") return value;
    return "CARD";
}

/**
 * requestPayment 에 넣을 «방식 부분»만 만든다(금액·주문번호·면세·돌아올 주소는 화면이 서버 값으로 붙인다).
 *  - 간편결제: method CARD + card.flowMode "DIRECT" + card.easyPay 코드 → 그 간편결제 앱으로 바로 간다
 *  - forceDefault=true(바로가기 실패 후 다시 열기) 또는 카드: 통합 결제창(flowMode "DEFAULT") — 카드·간편결제 전체 화면
 *  - 계좌이체·무통장입금: 방식만(무통장입금 계좌 옵션은 화면이 기존 그대로 붙인다)
 */
export function tossRequestFor(value: PreferredPaymentMethod, forceDefault = false):
    | { method: "CARD"; card: { flowMode: "DIRECT"; easyPay: string } | { flowMode: "DEFAULT" } }
    | { method: "TRANSFER" | "VIRTUAL_ACCOUNT" } {
    if (value === "TRANSFER" || value === "VIRTUAL_ACCOUNT") return { method: value };
    if (!forceDefault && isEasyPayMethod(value)) {
        return { method: "CARD", card: { flowMode: "DIRECT", easyPay: EASY_PAY_CODES[value] } };
    }
    return { method: "CARD", card: { flowMode: "DEFAULT" } };
}

/** 학부모가 결제창을 스스로 닫은 경우의 코드(SDK 오류 USER_CANCEL · failUrl 의 PAY_PROCESS_CANCELED) */
const CANCEL_CODES = new Set(["USER_CANCEL", "PAY_PROCESS_CANCELED"]);

/** SDK 오류에서 code 를 꺼낸다(없으면 빈 글자) */
export function tossErrorCode(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") return code.trim().toUpperCase();
    }
    return "";
}

/**
 * 간편결제 바로가기가 실패했을 때 통합 결제창으로 다시 열지 판정.
 *  - 간편결제 바로가기였고 · 사용자가 닫은 것(취소)이 아니면 → true(미계약·미지원 코드 등)
 *  - 카드·계좌이체·무통장입금이었거나 · 이미 통합창으로 다시 연 뒤거나 · 취소면 → false(재시도하지 않는다)
 */
export function shouldFallbackToDefault(value: PreferredPaymentMethod, error: unknown, alreadyFellBack = false): boolean {
    if (alreadyFellBack || !isEasyPayMethod(value)) return false;
    return !CANCEL_CODES.has(tossErrorCode(error));
}

export const EASY_PAY_FALLBACK_MESSAGE = "이 결제 방법은 지금 쓸 수 없어요. 카드·간편결제 전체 화면으로 열게요.";

/**
 * 결제창 열기 + 바로가기 실패 시 통합창으로 한 번만 다시 열기(단건·묶음 화면 공통).
 *  open   : «방식 부분»을 받아 requestPayment 를 부르는 함수(금액·주문은 화면이 서버 값으로 채운다)
 *  notify : 다시 열기 전에 학부모에게 보일 안내
 * 취소·두 번째 실패·바로가기가 아닌 방법의 오류는 그대로 던진다(화면이 기존처럼 오류 문구를 보인다).
 */
export async function requestTossWithFallback(
    value: PreferredPaymentMethod,
    open: (part: ReturnType<typeof tossRequestFor>) => Promise<void>,
    notify: (message: string) => void,
): Promise<void> {
    try {
        await open(tossRequestFor(value));
    } catch (error) {
        if (!shouldFallbackToDefault(value, error)) throw error;
        notify(EASY_PAY_FALLBACK_MESSAGE);
        await open(tossRequestFor(value, true));
    }
}

/** 토스 응답 easyPay.provider(한글 이름 또는 영문 코드) → 우리 코드 */
const EASY_PAY_PROVIDER_TO_METHOD: Record<string, EasyPayMethod> = {
    "토스페이": "TOSSPAY",
    TOSSPAY: "TOSSPAY",
    "카카오페이": "KAKAOPAY",
    KAKAOPAY: "KAKAOPAY",
    "네이버페이": "NAVERPAY",
    NAVERPAY: "NAVERPAY",
};

/** 토스 응답 method(한글이 기본, 옛 형식 영문도 받는다) → 우리 코드 */
const TOSS_METHOD_TO_METHOD: Record<string, PreferredPaymentMethod> = {
    "카드": "CARD",
    CARD: "CARD",
    // 바로가기가 없는 간편결제(삼성페이·페이코 등)는 다음에도 통합 결제창으로 열면 된다
    "간편결제": "CARD",
    EASY_PAY: "CARD",
    "계좌이체": "TRANSFER",
    TRANSFER: "TRANSFER",
    "가상계좌": "VIRTUAL_ACCOUNT",
    VIRTUAL_ACCOUNT: "VIRTUAL_ACCOUNT",
};

/**
 * 토스 승인 응답 → 저장할 «지난번 결제 방법». 알 수 없으면 null(저장하지 않는다).
 * easyPay.provider 가 바로가기 3종이면 그것이 우선(토스페이로 낸 카드 결제도 «토스페이»로 기억).
 */
export function preferredMethodFromTossPayment(payment: unknown): PreferredPaymentMethod | null {
    if (!payment || typeof payment !== "object") return null;
    const record = payment as { method?: unknown; easyPay?: unknown };
    const easyPay = record.easyPay && typeof record.easyPay === "object" ? (record.easyPay as { provider?: unknown }) : null;
    const provider = typeof easyPay?.provider === "string" ? easyPay.provider.trim() : "";
    if (provider) {
        const hit = EASY_PAY_PROVIDER_TO_METHOD[provider] ?? EASY_PAY_PROVIDER_TO_METHOD[provider.toUpperCase()];
        if (hit) return hit;
    }
    const method = typeof record.method === "string" ? record.method.trim() : "";
    if (!method) return null;
    return TOSS_METHOD_TO_METHOD[method] ?? TOSS_METHOD_TO_METHOD[method.toUpperCase()] ?? null;
}
