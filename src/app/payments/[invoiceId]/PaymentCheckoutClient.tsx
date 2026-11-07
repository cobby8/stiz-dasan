"use client";

import { useState } from "react";
import { taxFreeAmountFor } from "@/lib/payments/taxFree";
import { VIRTUAL_ACCOUNT_VALID_HOURS, type PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";

type TossPaymentMethod = "CARD" | "TRANSFER" | "VIRTUAL_ACCOUNT";
type PaymentProvider = "TOSS" | "CAFE24_BRIDGE";

declare global {
    interface Window {
        TossPayments?: (clientKey: string) => {
            payment: (options: { customerKey: string }) => {
                requestPayment: (options: {
                    method: TossPaymentMethod;
                    amount: { currency: "KRW"; value: number };
                    taxFreeAmount?: number;
                    orderId: string;
                    orderName: string;
                    successUrl: string;
                    failUrl: string;
                    customerEmail?: string;
                    customerName?: string;
                    customerMobilePhone?: string;
                    // 무통장입금(가상계좌) 전용 옵션 — 토스 결제창 SDK v2 requestPayment 의 virtualAccount
                    virtualAccount?: {
                        validHours?: number;
                        cashReceipt?: { type: "소득공제" | "지출증빙" | "미발행" };
                        useEscrow?: boolean;
                    };
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
    customerMobilePhone?: string;
    successUrl?: string;
    failUrl?: string;
    error?: string;
    /** 서버가 «이미 열린 입금 계좌가 있다»고 판정하면 새 결제 대신 이 칸이 온다. */
    openVirtualAccount?: PublicVirtualAccountView;
};

const PAYMENT_METHODS: {
    value: TossPaymentMethod;
    label: string;
    description: string;
    icon: string;
}[] = [
        { value: "CARD", label: "카드/간편결제", description: "카드, 토스페이 등", icon: "credit_card" },
        { value: "TRANSFER", label: "계좌이체", description: "실시간 계좌이체", icon: "account_balance" },
        { value: "VIRTUAL_ACCOUNT", label: "무통장입금(가상계좌)", description: "입금 전용 계좌를 받아 아무 은행에서 입금", icon: "savings" },
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
    virtualAccount = null,
}: {
    invoiceId: string;
    providerReady: boolean;
    provider: PaymentProvider;
    providerLabel: string;
    amount: number;
    /** 이 청구서의 최근 가상계좌(입금 대기 또는 만료). 서버가 소유권 확인 후 넘긴다. */
    virtualAccount?: PublicVirtualAccountView | null;
}) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [method, setMethod] = useState<TossPaymentMethod>("CARD");
    // 서버 판정으로 받은 열린 계좌(다른 탭에서 방금 발급한 경우 등) — 화면에 바로 보여 준다.
    const [openAccount, setOpenAccount] = useState<PublicVirtualAccountView | null>(
        virtualAccount && !virtualAccount.expired ? virtualAccount : null,
    );
    const expiredAccount = virtualAccount && virtualAccount.expired ? virtualAccount : null;

    // «다른 방법으로 결제» 확인 단계를 펼쳤는가(열린 입금 계좌가 있을 때만 쓴다)
    const [switching, setSwitching] = useState(false);

    // closeAccount=true: 열린 입금 계좌를 서버가 토스에서 닫은 뒤 새 결제를 연다(확인 단계를 거친 경우만).
    async function startPayment(selected: TossPaymentMethod = method, closeAccount = false) {
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
                body: JSON.stringify({ invoiceId, method: selected, closeOpenVirtualAccount: closeAccount }),
            });
            const data = (await response.json()) as CheckoutResponse;

            if (!response.ok || !data.ok) {
                throw new Error(data.error || "결제 준비에 실패했습니다.");
            }
            const responseProvider = data.provider || provider;
            // 이미 입금 대기 중인 계좌가 있다 → 새로 발급하지 않고 그 계좌를 보여 준다(이중 납부 방지).
            if (data.openVirtualAccount) {
                setOpenAccount(data.openVirtualAccount);
                setLoading(false);
                return;
            }
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
                method: selected,
                amount: { currency: "KRW", value: data.amount },
                // 면세사업자(교육서비스)라 결제 금액 전부를 면세로 보낸다. 빠지면 토스 기본값(복합과세)으로 부가세가 잡힌다.
                taxFreeAmount: taxFreeAmountFor(data.amount),
                orderId: data.orderId,
                orderName: data.orderName,
                successUrl: data.successUrl,
                failUrl: data.failUrl,
                customerEmail: data.customerEmail,
                customerName: data.customerName,
                customerMobilePhone: data.customerMobilePhone,
                // 무통장입금: 90일(최대) 동안 입금 가능한 전용 계좌. 현금영수증은 «소득공제»로 기본 선택해 두고
                // 학부모가 결제창에서 번호를 넣거나 용도를 바꾼다. 교육비라 에스크로는 쓰지 않는다.
                ...(selected === "VIRTUAL_ACCOUNT"
                    ? {
                        virtualAccount: {
                            validHours: VIRTUAL_ACCOUNT_VALID_HOURS,
                            cashReceipt: { type: "소득공제" as const },
                            useEscrow: false,
                        },
                    }
                    : {}),
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "결제 요청 중 오류가 발생했습니다.");
            setLoading(false);
        }
    }

    // 입금 대기 중 — 새 결제 버튼 대신 받은 계좌만 보여 준다(같은 청구에 계좌 두 개를 만들지 않는다).
    if (openAccount) {
        return (
            <div className="mt-6">
                <VirtualAccountNotice account={openAccount} />
                {error && (
                    <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                        {error}
                    </div>
                )}
                {providerReady && provider === "TOSS" && !switching && (
                    <button
                        type="button"
                        onClick={() => setSwitching(true)}
                        className="mt-3 min-h-11 w-full rounded-xl border border-gray-300 px-4 text-sm font-bold text-gray-700 dark:border-gray-600 dark:text-gray-200"
                    >
                        다른 방법으로 결제(계좌가 닫혀요)
                    </button>
                )}
                {switching && (
                    // 위험 확인: 계좌를 닫으면 되돌릴 수 없으니 무엇이 일어나는지 먼저 알리고 수단을 고르게 한다.
                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                        <p className="font-extrabold">지금 받은 입금 계좌를 닫을까요?</p>
                        <p className="mt-1 text-xs">닫으면 그 계좌로는 입금할 수 없어요. 이미 입금했다면 닫지 말고 잠시 기다려 주세요.</p>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                            {PAYMENT_METHODS.filter((option) => option.value !== "VIRTUAL_ACCOUNT").map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    disabled={loading}
                                    onClick={() => void startPayment(option.value, true)}
                                    className="min-h-11 rounded-lg bg-red-600 px-3 text-sm font-bold text-white disabled:opacity-60"
                                >
                                    {loading ? "계좌 닫는 중..." : `계좌 닫고 ${option.label}`}
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            disabled={loading}
                            onClick={() => setSwitching(false)}
                            className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm font-bold text-gray-700 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                        >
                            그대로 두기
                        </button>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mt-6">
            {expiredAccount && (
                <div className="mb-4">
                    <VirtualAccountNotice
                        account={expiredAccount}
                        onReissue={() => {
                            setMethod("VIRTUAL_ACCOUNT");
                            void startPayment("VIRTUAL_ACCOUNT");
                        }}
                        reissuing={loading}
                    />
                </div>
            )}

            {!providerReady && (
                <div className="mb-4 rounded-xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                    지금은 {providerLabel} 온라인 납부 준비 중입니다. 학원에서 계좌이체, 현장 결제, 수동 납부 확인으로 처리할 수 있습니다.
                </div>
            )}

            {providerReady && provider === "TOSS" && (
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {PAYMENT_METHODS.map((option) => {
                        const active = method === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => setMethod(option.value)}
                                disabled={loading}
                                // 무통장입금은 설명이 길어 모바일(2칸)에서는 한 줄을 다 쓴다
                                className={`flex min-h-16 items-center gap-3 rounded-xl border px-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${option.value === "VIRTUAL_ACCOUNT" ? "col-span-2 sm:col-span-1" : ""} ${
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
                onClick={() => void startPayment()}
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
