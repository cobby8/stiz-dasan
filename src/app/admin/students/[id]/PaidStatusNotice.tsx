"use client";

import Link from "next/link";
import InlineConfirm from "@/components/parent/InlineConfirm";
import type { PaidStatusLock } from "@/lib/payments/paidStatusGuard";

/**
 * 학생 상세 «청구/수납» — 납부완료 청구의 상태 버튼 아래 한 줄(2026-11-10 원장 지시).
 *
 * 왜: 상태 묶음 버튼으로 납부완료를 대기·취소로 바꾸면, 실제 받은 돈은 그대로인데 장부만 «안 받음»이 된다.
 *  - REAL_LOCKED(토스 온라인·현장 POS·카페24 등 실제 결제): 버튼은 잠그고, 돈을 돌려주는 길(수납 관리 ⚡)만 알려 준다.
 *  - MANUAL_REVERT(현금·계좌이체 등 직접 기록): 잘못 적은 기록만 «대기로 되돌리기» — 그 자리에서 한 번 더 묻는다.
 * 최종 판단은 서버 updatePaymentStatus 가 DB 로 다시 한다(이 화면은 안내).
 */
export default function PaidStatusNotice({
    lock,
    updating,
    onRevert,
}: {
    lock: PaidStatusLock;
    /** 이 청구가 처리 중인지(버튼 잠금) */
    updating: boolean;
    /** «대기로 되돌리기» 확정 — 부르는 쪽이 서버 액션을 부른다 */
    onRevert: () => unknown;
}) {
    if (lock === "REAL_LOCKED") {
        return (
            <p className="mt-1.5 text-xs text-[var(--color-academy-muted)]">
                결제 취소·환불은 <Link href="/admin/finance" prefetch={false} className="font-bold text-[var(--color-academy-ink)] underline">수납 관리</Link> ⚡ 메뉴에서 해요.
            </p>
        );
    }
    if (lock === "MANUAL_REVERT") {
        return (
            <div className="mt-1.5 space-y-1.5">
                <InlineConfirm
                    label="대기로 되돌리기"
                    question="실제로 돈을 받지 않았을 때만 쓰세요. 납부 기록을 지우고 대기로 되돌릴까요?"
                    confirmLabel="대기로 되돌리기"
                    keepLabel="그만두기"
                    pending={updating}
                    pendingLabel="되돌리는 중…"
                    triggerClassName="min-h-11 px-3 text-xs"
                    onConfirm={onRevert}
                />
                <p className="text-xs text-[var(--color-academy-muted)]">
                    돈을 돌려줬다면 <Link href="/admin/finance" prefetch={false} className="font-bold text-[var(--color-academy-ink)] underline">수납 관리</Link> ⚡ 메뉴 «환불»을 쓰세요.
                </p>
            </div>
        );
    }
    return null;
}
