"use client";

// 체험비 결제 버튼 — 로그인 없는 신청자용(결제 링크 토큰으로만 동작).
// 결제창 여는 방식은 학부모 청구 결제(PaymentCheckoutClient)와 같다: 토스 결제창 v2 · 카드/계좌이체/무통장입금 · 면세 금액 전달.
// 다른 점: 금액·면세·주문번호를 서버(/api/apply/trial-fee/checkout)가 정해 주고, 화면은 그대로 넘기기만 한다.

import { useState } from "react";

type Method = "CARD" | "TRANSFER" | "VIRTUAL_ACCOUNT";

type TossFactory = (clientKey: string) => {
    payment: (options: { customerKey: string }) => {
        requestPayment: (options: Record<string, unknown>) => Promise<void>;
    };
};

export type TrialVirtualAccount = {
    bankName: string;
    accountNumber: string;
    customerName: string | null;
    amount: number;
    dueLabel: string;
    expired: boolean;
};

const METHODS: Array<{ value: Method; label: string }> = [
    { value: "CARD", label: "카드·간편결제" },
    { value: "TRANSFER", label: "계좌이체" },
    { value: "VIRTUAL_ACCOUNT", label: "무통장입금" },
];

function loadTossScript(): Promise<TossFactory> {
    return new Promise((resolve, reject) => {
        const ready = () => {
            const factory = (window as unknown as { TossPayments?: TossFactory }).TossPayments;
            if (factory) resolve(factory);
            else reject(new Error("결제창을 불러오지 못했어요."));
        };
        if ((window as unknown as { TossPayments?: unknown }).TossPayments) return ready();
        // 청구서 결제 화면과 같은 스크립트 표식 — 두 번 싣지 않는다
        const existing = document.querySelector<HTMLScriptElement>("script[data-toss-payments]");
        if (existing) {
            existing.addEventListener("load", ready, { once: true });
            existing.addEventListener("error", () => reject(new Error("결제창을 불러오지 못했어요.")), { once: true });
            return;
        }
        const script = document.createElement("script");
        script.src = "https://js.tosspayments.com/v2/standard";
        script.async = true;
        script.dataset.tossPayments = "true";
        script.onload = ready;
        script.onerror = () => reject(new Error("결제창을 불러오지 못했어요."));
        document.head.appendChild(script);
    });
}

/** 무통장입금 계좌 안내(공개 화면 토큰으로) */
export function TrialVirtualAccountBox({ account }: { account: TrialVirtualAccount }) {
    const [copied, setCopied] = useState(false);
    if (account.expired) {
        return (
            <p className="rounded-lg border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-3 text-sm text-[var(--color-public-ink)]">
                입금 기한({account.dueLabel})이 지났어요. 아래에서 다시 결제해 주세요.
            </p>
        );
    }
    return (
        <div className="rounded-lg border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-3 text-sm text-[var(--color-public-ink)]">
            <p className="font-extrabold">아래 계좌로 {account.amount.toLocaleString("ko-KR")}원을 입금해 주세요</p>
            <div className="mt-2 flex items-center justify-between gap-2">
                <span className="min-w-0 break-all font-bold">{account.bankName} {account.accountNumber}</span>
                <button
                    type="button"
                    onClick={async () => {
                        try {
                            await navigator.clipboard.writeText(account.accountNumber);
                            setCopied(true);
                        } catch {
                            setCopied(false);
                        }
                    }}
                    aria-label="계좌번호 복사"
                    className="min-h-11 shrink-0 rounded-lg border border-[var(--color-public-line)] bg-[var(--color-public-paper)] px-3 text-xs font-bold"
                >
                    {copied ? "복사됨" : "복사"}
                </button>
            </div>
            <p className="mt-1 text-xs text-[var(--color-public-muted)]">입금 기한: {account.dueLabel} · 입금이 확인되면 체험수업이 확정돼요.</p>
        </div>
    );
}

export default function TrialFeeCheckoutClient({ token, amountLabel }: { token: string; amountLabel: string }) {
    const [method, setMethod] = useState<Method>("CARD");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [openAccount, setOpenAccount] = useState<TrialVirtualAccount | null>(null);

    async function start() {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch("/api/apply/trial-fee/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || "결제를 준비하지 못했어요.");
            // 이미 받은 입금 계좌가 있으면 새 결제 대신 그 계좌(계좌 두 개 = 이중 입금 방지)
            if (data.openVirtualAccount) {
                setOpenAccount(data.openVirtualAccount);
                setLoading(false);
                return;
            }
            const factory = await loadTossScript();
            const payment = factory(data.clientKey).payment({ customerKey: data.customerKey });
            await payment.requestPayment({
                method,
                amount: { currency: "KRW", value: data.amount },
                // 면세 금액 — 서버가 주문에 저장한 값 그대로(교육서비스 전액 면세, 청구 결제와 같은 규칙)
                taxFreeAmount: data.taxFreeAmount,
                orderId: data.orderId,
                orderName: data.orderName,
                successUrl: data.successUrl,
                failUrl: data.failUrl,
                customerName: data.customerName,
                customerMobilePhone: data.customerMobilePhone,
                ...(method === "VIRTUAL_ACCOUNT"
                    ? { virtualAccount: { validHours: data.virtualAccountValidHours, cashReceipt: { type: "소득공제" }, useEscrow: false } }
                    : {}),
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "결제를 요청하지 못했어요.");
            setLoading(false);
        }
    }

    if (openAccount) return <TrialVirtualAccountBox account={openAccount} />;

    return (
        <div className="space-y-3">
            <div role="radiogroup" aria-label="결제 방식" className="grid grid-cols-3 gap-1.5">
                {METHODS.map((option) => {
                    const active = method === option.value;
                    return (
                        <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={loading}
                            onClick={() => setMethod(option.value)}
                            className={`min-h-12 whitespace-nowrap rounded-lg border px-1 text-xs font-bold disabled:opacity-60 ${active
                                ? "border-[var(--color-public-trial)] text-[var(--color-public-trial)]"
                                : "border-[var(--color-public-line)] text-[var(--color-public-muted)]"}`}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>
            {method === "VIRTUAL_ACCOUNT" && <p className="text-xs text-[var(--color-public-muted)]">무통장입금은 받은 계좌로 3일 안에 입금하면 확정돼요.</p>}
            {error && <p role="alert" className="rounded-lg border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-2 text-sm font-bold text-[var(--color-public-ink)]">{error}</p>}
            {/* 체험 신청 흐름이라 주 버튼은 체험 주황(--color-public-trial) */}
            <button
                type="button"
                onClick={() => void start()}
                disabled={loading}
                className="min-h-12 w-full rounded-xl bg-[var(--color-public-trial)] text-base font-black text-[var(--color-public-white)] hover:bg-[var(--color-public-trial-hover)] disabled:opacity-60"
            >
                {loading ? "결제창 여는 중..." : `체험수업비 ${amountLabel} 결제하기`}
            </button>
        </div>
    );
}
