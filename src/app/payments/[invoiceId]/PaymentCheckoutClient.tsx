"use client";

import { useState } from "react";

type TossPaymentMethod = "CARD" | "TRANSFER";
type PaymentProvider = "TOSS" | "CAFE24_BRIDGE";

declare global {
    interface Window {
        TossPayments?: (clientKey: string) => {
            payment: (options: { customerKey: string }) => {
                requestPayment: (options: {
                    method: TossPaymentMethod;
                    amount: { currency: "KRW"; value: number };
                    orderId: string;
                    orderName: string;
                    successUrl: string;
                    failUrl: string;
                    customerEmail?: string;
                    customerName?: string;
                }) => Promise<void>;
            };
        };
    }
}

type CheckoutResponse = {
    ok: boolean;
    provider?: PaymentProvider;
    providerLabel?: string;
    providerReady?: boolean;
    checkoutUrl?: string;
    clientKey?: string;
    customerKey?: string;
    orderId?: string;
    amount?: number;
    orderName?: string;
    customerName?: string;
    customerEmail?: string;
    successUrl?: string;
    failUrl?: string;
    error?: string;
};

const PAYMENT_METHODS: {
    value: TossPaymentMethod;
    label: string;
    description: string;
    icon: string;
}[] = [
        { value: "CARD", label: "카드/간편결제", description: "카드, 토스페이 등", icon: "credit_card" },
        { value: "TRANSFER", label: "계좌이체", description: "실시간 계좌이체", icon: "account_balance" },
    ];

function loadTossScript() {
    return new Promise<void>((resolve, reject) => {
        if (window.TossPayments) {
            resolve();
            return;
        }

        const existing = document.querySelector<HTMLScriptElement>("script[data-toss-payments]");
        if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("토스페이먼츠 결제창을 불러오지 못했습니다.")), { once: true });
            return;
        }

        const script = document.createElement("script");
        script.src = "https://js.tosspayments.com/v2/standard";
        script.async = true;
        script.dataset.tossPayments = "true";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("토스페이먼츠 결제창을 불러오지 못했습니다."));
        document.head.appendChild(script);
    });
}

export default function PaymentCheckoutClient({
    invoiceId,
    providerReady,
    provider,
    providerLabel,
    amount,
}: {
    invoiceId: string;
    providerReady: boolean;
    provider: PaymentProvider;
    providerLabel: string;
    amount: number;
}) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [method, setMethod] = useState<TossPaymentMethod>("CARD");

    async function startPayment() {
        if (!providerReady) {
            setError("온라인 결제 설정이 아직 완료되지 않았습니다. 학원으로 문의해 주세요.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch("/api/payments/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invoiceId }),
            });
            const data = (await response.json()) as CheckoutResponse;

            if (!response.ok || !data.ok) {
                throw new Error(data.error || "결제 준비에 실패했습니다.");
            }
            const responseProvider = data.provider || provider;
            if (!data.providerReady || !data.orderId || !data.amount || !data.orderName || !data.successUrl || !data.failUrl) {
                throw new Error("결제 정보가 부족합니다. 학원으로 문의해 주세요.");
            }

            if (responseProvider === "CAFE24_BRIDGE") {
                if (!data.checkoutUrl) {
                    throw new Error("본사 카페24 결제 링크를 받지 못했습니다. 학원으로 문의해 주세요.");
                }
                window.location.assign(data.checkoutUrl);
                return;
            }

            if (!data.clientKey || !data.customerKey) {
                throw new Error("토스 결제 정보가 부족합니다. 학원으로 문의해 주세요.");
            }

            await loadTossScript();
            if (!window.TossPayments) {
                throw new Error("결제창을 불러오지 못했습니다.");
            }

            const tossPayments = window.TossPayments(data.clientKey);
            const payment = tossPayments.payment({ customerKey: data.customerKey });
            await payment.requestPayment({
                method,
                amount: { currency: "KRW", value: data.amount },
                orderId: data.orderId,
                orderName: data.orderName,
                successUrl: data.successUrl,
                failUrl: data.failUrl,
                customerEmail: data.customerEmail,
                customerName: data.customerName,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "결제 요청 중 오류가 발생했습니다.");
            setLoading(false);
        }
    }

    return (
        <div className="mt-6">
            {!providerReady && (
                <div className="mb-4 rounded-xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                    지금은 {providerLabel} 온라인 납부 준비 중입니다. 학원에서 계좌이체, 현장 결제, 수동 납부 확인으로 처리할 수 있습니다.
                </div>
            )}

            {providerReady && provider === "TOSS" && (
                <div className="mb-4 grid grid-cols-2 gap-2">
                    {PAYMENT_METHODS.map((option) => {
                        const active = method === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => setMethod(option.value)}
                                disabled={loading}
                                className={`flex min-h-16 items-center gap-3 rounded-xl border px-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                    active
                                        ? "border-brand-orange-500 bg-orange-50 text-brand-navy-900 dark:border-brand-neon-lime dark:bg-brand-neon-lime/15 dark:text-white"
                                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                                }`}
                            >
                                <span className="material-symbols-outlined text-xl" aria-hidden="true">{option.icon}</span>
                                <span>
                                    <span className="block text-sm font-extrabold">{option.label}</span>
                                    <span className="block text-xs font-bold text-gray-500 dark:text-gray-400">{option.description}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            {providerReady && provider === "CAFE24_BRIDGE" && (
                <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                    <p className="font-extrabold">본사 카페24 결제창으로 이동합니다.</p>
                    <p className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                        결제 완료 후 본사 확인 신호가 도착하면 납부 완료로 자동 반영됩니다.
                    </p>
                </div>
            )}

            {error && (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                    {error}
                </div>
            )}

            <button
                type="button"
                onClick={startPayment}
                disabled={loading || amount <= 0 || !providerReady}
                className="flex w-full items-center justify-center rounded-xl bg-brand-orange-500 px-5 py-4 text-base font-extrabold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                {loading
                    ? "결제창 여는 중..."
                    : providerReady
                        ? `${amount.toLocaleString("ko-KR")}원 ${providerLabel}로 납부하기`
                        : "온라인 납부 준비 중"}
            </button>

            <p className="mt-3 text-center text-xs text-gray-500 dark:text-gray-400">
                결제 완료 후 자동으로 납부 완료 처리됩니다.
            </p>
        </div>
    );
}
