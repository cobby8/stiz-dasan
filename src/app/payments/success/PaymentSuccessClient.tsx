"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";

// deposit = 무통장입금 계좌 발급 완료(아직 입금 전 — 납부 완료 아님)
type ConfirmState = "loading" | "pending" | "success" | "deposit" | "error";

type ConfirmResult = {
    state: ConfirmState;
    message: string;
    retryable?: boolean;
    virtualAccount?: PublicVirtualAccountView;
};

const MAX_CONFIRM_RETRIES = 4;

/**
 * @param guestToken 비회원 결제 링크(/pay/<토큰>/success)에서 쓸 때만 — 토큰 승인 API 로 보내고,
 *   «청구서 확인»은 같은 토큰 화면으로, 마이페이지 안내는 숨긴다(로그인 계정이 없을 수 있다).
 */
export default function PaymentSuccessClient({ guestToken = null }: { guestToken?: string | null } = {}) {
    const searchParams = useSearchParams();
    const paymentKey = searchParams.get("paymentKey");
    const orderId = searchParams.get("orderId");
    const amount = searchParams.get("amount");
    // 비회원: 청구서 id 는 주소에서 받지 않는다(서버가 토큰으로 정한다)
    const invoiceId = guestToken ? null : searchParams.get("invoiceId");
    const missingParams = !paymentKey || !orderId || !amount;
    const guestHref = guestToken ? `/pay/${encodeURIComponent(guestToken)}` : null;
    const invoiceHref = guestHref ?? (invoiceId ? `/payments/${encodeURIComponent(invoiceId)}` : "/mypage");

    const [result, setResult] = useState<ConfirmResult>({
        state: "loading",
        message: "결제 승인 상태를 확인하고 있습니다.",
    });

    const confirmPayment = useCallback((attempt = 0) => {
        let canceled = false;
        setResult({
            state: "loading",
            message: attempt > 0 ? "결제 승인 상태를 다시 확인하고 있습니다." : "결제 승인 상태를 확인하고 있습니다.",
        });

        fetch(guestToken ? "/api/pay/confirm" : "/api/payments/toss/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(guestToken
                ? { token: guestToken, paymentKey, orderId, amount: Number(amount) }
                : { paymentKey, orderId, amount: Number(amount), invoiceId }),
        })
            .then(async (response) => {
                const data = await response.json();
                if (data?.retryable && attempt < MAX_CONFIRM_RETRIES) {
                    window.setTimeout(() => {
                        if (!canceled) confirmPayment(attempt + 1);
                    }, 2500);
                    return;
                }
                if (data?.retryable) {
                    if (!canceled) {
                        setResult({
                            state: "pending",
                            retryable: true,
                            message: data.error || "결제는 접수되었고 승인 상태를 확인 중입니다.",
                        });
                    }
                    return;
                }
                if (!response.ok || !data?.ok) {
                    throw new Error(data.error || "결제 승인에 실패했습니다.");
                }
                if (!canceled && data.waitingForDeposit && data.virtualAccount) {
                    // 계좌만 발급됐다. 입금이 확인되면(토스 입금 알림) 그때 자동으로 납부 완료된다.
                    setResult({ state: "deposit", message: "입금 계좌가 발급되었습니다.", virtualAccount: data.virtualAccount });
                    return;
                }
                if (!canceled) {
                    setResult({ state: "success", message: "납부가 완료되었습니다." });
                }
            })
            .catch((error) => {
                if (!canceled) {
                    setResult({
                        state: "error",
                        message: error instanceof Error ? error.message : "결제 승인 중 오류가 발생했습니다.",
                    });
                }
            });

        return () => {
            canceled = true;
        };
    }, [amount, guestToken, invoiceId, orderId, paymentKey]);

    useEffect(() => {
        if (missingParams) return;
        return confirmPayment();
    }, [confirmPayment, missingParams]);

    function retryConfirm() {
        if (missingParams) return;
        confirmPayment();
    }

    const state = missingParams ? "error" : result.state;
    const message = missingParams ? "결제 승인 정보가 부족합니다." : result.message;
    const isDeposit = state === "deposit";
    // 계좌 발급도 «완료된 단계»라 다시 확인 버튼은 숨긴다.
    const isSuccess = state === "success" || isDeposit;
    const isPending = state === "pending";

    return (
        <div className="mx-auto max-w-lg rounded-2xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
            <div
                className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full text-sm font-semibold ${
                    state === "loading"
                        ? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
                        : isSuccess
                            ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                            : isPending
                                ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"
                                : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                }`}
            >
                {state === "loading" ? "확인" : isDeposit ? "입금" : isSuccess ? "완료" : isPending ? "대기" : "오류"}
            </div>
            <h1 className="text-xl font-bold">{message}</h1>
            {isDeposit && result.virtualAccount && (
                <div className="mt-4 text-left">
                    <VirtualAccountNotice account={result.virtualAccount} />
                </div>
            )}
            <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
                {isDeposit
                    ? guestToken
                        ? "입금하면 자동으로 납부 완료됩니다. 계좌는 받은 링크에서 다시 볼 수 있습니다."
                        : "입금하면 자동으로 납부 완료됩니다. 계좌는 청구서와 마이페이지에서 다시 볼 수 있습니다."
                    : isSuccess
                    ? guestToken
                        ? "받은 링크에서 납부 상태를 다시 확인할 수 있습니다."
                        : "청구서와 마이페이지에서 납부 내역을 확인할 수 있습니다."
                    : isPending
                        ? "중복 결제를 막기 위해 새 결제보다 먼저 이 청구서를 다시 확인해 주세요."
                        : "결제가 실제로 완료되었는데 오류가 보이면 학원으로 문의해 주세요."}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
                {!isSuccess && !missingParams && (
                    <button
                        type="button"
                        onClick={retryConfirm}
                        className="academy-button-secondary"
                    >
                        다시 확인
                    </button>
                )}
                <Link
                    href={invoiceHref}
                    className="academy-button-primary"
                >
                    {guestHref || invoiceId ? "청구서 확인" : "마이페이지로 이동"}
                </Link>
                {invoiceId && !guestHref && (
                    <Link
                        href="/mypage"
                        className="academy-button-secondary"
                    >
                        마이페이지
                    </Link>
                )}
            </div>
        </div>
    );
}
