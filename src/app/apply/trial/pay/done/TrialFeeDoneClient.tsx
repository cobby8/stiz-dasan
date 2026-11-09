"use client";

// 체험비 결제 완료 복귀 — 주소의 paymentKey·orderId·amount 와 결제 링크 토큰(t)을 서버에 넘겨 승인한다.
// 금액·주문 대조와 이중 확정 방지는 서버가 한다(여기서는 결과만 보여 준다).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ACADEMY_GUIDE_FACTS } from "@/lib/trial-fee/guideMessages";
import { TrialVirtualAccountBox, type TrialVirtualAccount } from "../TrialFeeCheckoutClient";

type View =
    | { kind: "loading" }
    | { kind: "paid"; amountLabel: string }
    | { kind: "waiting"; account: TrialVirtualAccount }
    | { kind: "error"; message: string; retryable: boolean };

export default function TrialFeeDoneClient() {
    const params = useSearchParams();
    const token = params.get("t") ?? "";
    const [view, setView] = useState<View>({ kind: "loading" });
    const started = useRef(false);

    async function confirm() {
        setView({ kind: "loading" });
        try {
            const response = await fetch("/api/apply/trial-fee/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token,
                    paymentKey: params.get("paymentKey") ?? "",
                    orderId: params.get("orderId") ?? "",
                    amount: Number(params.get("amount") ?? NaN),
                }),
            });
            const data = await response.json();
            if (data.ok && data.paid) setView({ kind: "paid", amountLabel: data.amountLabel });
            else if (data.ok && data.waitingForDeposit) setView({ kind: "waiting", account: data.virtualAccount });
            else setView({ kind: "error", message: data.error || "결제를 확인하지 못했어요.", retryable: Boolean(data.retryable) });
        } catch {
            setView({ kind: "error", message: "결제를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.", retryable: true });
        }
    }

    useEffect(() => {
        // 개발 모드 이중 실행에도 승인 요청은 한 번만(서버도 같은 결제키를 멱등 처리한다)
        if (started.current) return;
        started.current = true;
        void confirm();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const backHref = token ? `/apply/trial/pay/${encodeURIComponent(token)}` : "/apply/trial";

    return (
        <div className="space-y-3 rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-5 text-[var(--color-public-ink)]">
            {view.kind === "loading" && <p className="text-sm font-bold">결제를 확인하고 있어요...</p>}
            {view.kind === "paid" && (
                <>
                    <h1 className="text-xl font-black">체험수업이 확정됐어요</h1>
                    <p className="text-sm text-[var(--color-public-muted)]">체험수업비 {view.amountLabel} 결제가 확인됐어요. 수업 시간과 반은 담당자가 한 번 더 안내드려요.</p>
                    <p className="text-sm">준비물: {ACADEMY_GUIDE_FACTS.trialSupplies}</p>
                    <p className="text-sm">위치: {ACADEMY_GUIDE_FACTS.address}</p>
                </>
            )}
            {view.kind === "waiting" && (
                <>
                    <h1 className="text-xl font-black">입금 계좌를 받았어요</h1>
                    <TrialVirtualAccountBox account={view.account} />
                </>
            )}
            {view.kind === "error" && (
                <>
                    <p role="alert" className="text-sm font-bold">{view.message}</p>
                    {view.retryable && (
                        <button type="button" onClick={() => void confirm()} className="min-h-11 w-full rounded-xl border border-[var(--color-public-line)] text-sm font-bold">
                            다시 확인
                        </button>
                    )}
                    <Link href={backHref} className="inline-flex min-h-11 items-center text-sm font-bold underline">결제 화면으로 돌아가기</Link>
                </>
            )}
            <Link href="/" className="inline-flex min-h-11 items-center text-sm font-bold underline">홈으로</Link>
        </div>
    );
}
