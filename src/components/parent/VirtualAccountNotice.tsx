"use client";

// 무통장입금(가상계좌) 안내 한 칸 — 결제 화면·결제 완료 화면·마이페이지가 같이 쓴다.
// 서버가 고른 칸(PublicVirtualAccountView)만 받는다. 웹훅 비밀값·결제키는 애초에 이 부품까지 오지 않는다.

import { useState } from "react";
import type { PublicVirtualAccountView } from "@/lib/payments/virtualAccount";

export default function VirtualAccountNotice({
    account,
    compact = false,
    onReissue,
    reissuing = false,
}: {
    account: PublicVirtualAccountView;
    /** 마이페이지 목록처럼 좁은 자리에서는 한 줄로 줄인다. */
    compact?: boolean;
    /** 기한 만료 시 «다시 발급» 버튼(결제 화면에서만 넘긴다). 없으면 청구서 링크 안내만. */
    onReissue?: () => void;
    reissuing?: boolean;
}) {
    const [copied, setCopied] = useState(false);

    async function copyAccount() {
        try {
            // 계좌번호만 복사한다(은행 앱 붙여넣기용 — 하이픈은 은행 앱이 알아서 받는다).
            await navigator.clipboard.writeText(account.accountNumber);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    }

    if (account.expired) {
        return (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                <p className="font-extrabold">기한 만료 — 다시 발급</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    입금 기한({account.dueLabel})이 지나 이 계좌로는 입금할 수 없습니다. 청구서에서 새 계좌를 받아 주세요.
                </p>
                {onReissue && (
                    <button
                        type="button"
                        onClick={onReissue}
                        disabled={reissuing}
                        className="mt-2 min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-bold text-gray-800 disabled:opacity-60 dark:border-gray-600 dark:text-white"
                    >
                        {reissuing ? "결제창 여는 중..." : "새 입금 계좌 받기"}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className={`rounded-xl border border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime ${compact ? "p-3 text-xs" : "p-4 text-sm"}`}>
            <p className="font-extrabold">입금 대기</p>
            {/* 한 줄 요약: 은행 계좌번호 (예금주) 금액 · 기한까지 */}
            <p className="mt-1 break-all font-bold text-gray-900 dark:text-white">
                {account.bankName} {account.accountNumber}
                {account.customerName ? ` (${account.customerName})` : ""}
            </p>
            <p className="mt-0.5">
                {account.amount.toLocaleString("ko-KR")}원 · {account.dueLabel}까지
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={copyAccount}
                    className="min-h-11 rounded-lg bg-brand-orange-500 px-4 text-sm font-bold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                    {copied ? "복사했어요" : "계좌번호 복사"}
                </button>
                {!compact && (
                    <span className="text-xs text-yellow-800 dark:text-brand-neon-lime/80">
                        아무 은행 앱에서 이 계좌로 입금하면 자동으로 납부 완료됩니다.
                    </span>
                )}
            </div>
        </div>
    );
}
