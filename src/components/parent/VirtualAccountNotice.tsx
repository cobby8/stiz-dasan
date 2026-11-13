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
            <div className="rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                <p className="font-semibold">기한 만료 — 다시 발급</p>
                {/* 다시 받기 버튼이 있으면 «어디서 받나» 설명은 버튼이 대신한다 */}
                <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">
                    {account.dueLabel}에 기한이 지났어요.{onReissue ? "" : " 청구서에서 새 계좌를 받아 주세요."}
                </p>
                {onReissue && (
                    <button
                        type="button"
                        onClick={onReissue}
                        disabled={reissuing}
                        className="academy-button-secondary mt-2 w-full"
                    >
                        {reissuing ? "결제창 여는 중..." : "새 입금 계좌 받기"}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className={`rounded-lg bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-ink)] ${compact ? "p-2.5 text-xs" : "p-3 text-sm"}`}>
            {/* 계좌번호 옆에 복사 버튼을 붙인다 — 버튼 글자를 «복사»로 줄여 계좌번호가 덜 접히게(읽기 프로그램에는 «계좌번호 복사») */}
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[var(--color-academy-warning)]">입금 대기</p>
                    <p className="break-all font-semibold tabular-nums">
                        {account.bankName} {account.accountNumber}
                        {account.customerName ? ` (${account.customerName})` : ""}
                    </p>
                    <p className="tabular-nums">
                        {account.amount.toLocaleString("ko-KR")}원 · {account.dueLabel}까지
                    </p>
                </div>
                <button
                    type="button"
                    onClick={copyAccount}
                    aria-label="계좌번호 복사"
                    className={`${compact ? "academy-button-tonal" : "academy-button-primary"} min-h-11 shrink-0 whitespace-nowrap`}
                >
                    {copied ? "복사됨" : "복사"}
                </button>
            </div>
            {!compact && (
                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">아무 은행 앱에서 입금하면 자동으로 납부 완료돼요.</p>
            )}
        </div>
    );
}
