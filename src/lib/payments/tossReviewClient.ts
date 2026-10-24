"use client";

/**
 * 토스페이먼츠 가맹 심사용 결제창 열기 — 브라우저 전용 공용 모듈.
 *
 * ■ 왜 따로 빼는가
 *   예전엔 프로그램 카드의 [결제하기]가 이 코드를 직접 들고 있었다. 이제 결제창은 주문서에서 연다.
 *   한 벌만 두어 "한쪽만 고쳐지는" 사고를 막는다.
 *
 * ■ 아무것도 저장하지 않는다
 *   서버 checkout API 는 DB 를 읽기만 한다. 주문자 이름·휴대폰은 토스 결제창에만 넘긴다.
 */

type CheckoutResponse = {
    clientKey?: string;
    customerKey?: string;
    orderId?: string;
    amount?: number;
    orderName?: string;
    successUrl?: string;
    failUrl?: string;
    error?: string;
};

type TossPaymentsFactory = (clientKey: string) => {
    payment: (options: { customerKey: string }) => {
        requestPayment: (options: {
            method: "CARD";
            amount: { currency: "KRW"; value: number };
            orderId: string;
            orderName: string;
            successUrl: string;
            failUrl: string;
            customerName?: string;
            customerMobilePhone?: string;
        }) => Promise<void>;
    };
};

function loadTossScript() {
    return new Promise<TossPaymentsFactory>((resolve, reject) => {
        const ready = () => {
            const factory = (window as unknown as { TossPayments?: TossPaymentsFactory }).TossPayments;
            if (factory) resolve(factory);
            else reject(new Error("결제창을 불러오지 못했습니다."));
        };
        if ((window as unknown as { TossPayments?: unknown }).TossPayments) return ready();

        // 청구서 결제 화면과 같은 스크립트 표식을 써서 두 번 싣지 않는다.
        const existing = document.querySelector<HTMLScriptElement>("script[data-toss-payments]");
        if (existing) {
            existing.addEventListener("load", ready, { once: true });
            existing.addEventListener("error", () => reject(new Error("결제창을 불러오지 못했습니다.")), { once: true });
            return;
        }
        const script = document.createElement("script");
        script.src = "https://js.tosspayments.com/v2/standard";
        script.async = true;
        script.dataset.tossPayments = "true";
        script.onload = ready;
        script.onerror = () => reject(new Error("결제창을 불러오지 못했습니다."));
        document.head.appendChild(script);
    });
}

/**
 * 서버에서 주문 정보(금액은 DB 가격)를 받아 토스 카드 결제창을 연다.
 * 결제창을 닫거나 실패하면 Error 를 던진다 — 부르는 쪽이 메시지를 보여준다.
 */
export async function openReviewCardPayment(input: {
    programId: string;
    tier: string;
    customerName?: string;
    customerMobilePhone?: string; // 숫자만(예: 01012345678)
}) {
    const response = await fetch("/api/payments/toss-review/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ programId: input.programId, tier: input.tier }),
    });
    const data = (await response.json().catch(() => ({}))) as CheckoutResponse;
    if (!response.ok || !data.clientKey || !data.customerKey || !data.orderId || !data.amount || !data.orderName || !data.successUrl || !data.failUrl) {
        throw new Error(data.error || "결제 준비에 실패했습니다.");
    }
    const TossPayments = await loadTossScript();
    await TossPayments(data.clientKey).payment({ customerKey: data.customerKey }).requestPayment({
        method: "CARD",
        amount: { currency: "KRW", value: data.amount },
        orderId: data.orderId,
        orderName: data.orderName,
        successUrl: data.successUrl,
        failUrl: data.failUrl,
        // 값이 있을 때만 넘긴다(빈 문자열은 토스가 거절할 수 있음)
        ...(input.customerName ? { customerName: input.customerName } : {}),
        ...(input.customerMobilePhone ? { customerMobilePhone: input.customerMobilePhone } : {}),
    });
}
