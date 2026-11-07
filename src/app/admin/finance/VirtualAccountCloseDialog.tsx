"use client";

// 관리자 «가상계좌 닫기» 확인창 — 수납 목록의 «입금 대기 · 가상계좌» 건에서 연다.
// FinanceClient 는 여는 상태 한 줄과 이 부품만 둔다(다른 작업과 겹치지 않게 로직은 여기에).

import { useState } from "react";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { closeVirtualAccountAction } from "@/app/actions/virtual-account";

export default function VirtualAccountCloseDialog({
    target,
    onClose,
    onClosed,
}: {
    target: { id: string; studentName: string; amount: number };
    onClose: () => void;
    /** 닫기 성공 또는 «이미 입금»처럼 목록이 바뀌었을 때 다시 불러오기 */
    onClosed: () => void;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    async function handleConfirm() {
        setPending(true);
        setError(undefined);
        const result = await closeVirtualAccountAction(target.id);
        setPending(false);
        if (result.ok) {
            onClosed();
            onClose();
            return;
        }
        // 실패해도 «이미 입금돼 납부 완료로 반영»일 수 있으니 목록은 새로 읽는다. 창은 열어 둬 이유를 보여 준다.
        setError(result.message);
        onClosed();
    }

    return (
        <AdminConfirmDialog
            titleId="virtual-account-close-title"
            title={`"${target.studentName}" 가상계좌 닫기`}
            description={`${target.amount.toLocaleString("ko-KR")}원 입금 대기 계좌를 토스에서 닫습니다.\n닫으면 학부모가 그 계좌로 입금할 수 없고, 청구는 미납 그대로 남습니다.\n이미 입금됐다면 닫지 않고 납부 완료로 반영합니다.`}
            confirmLabel="계좌 닫기"
            tone="danger"
            pending={pending}
            pendingLabel="닫는 중..."
            error={error}
            onConfirm={() => void handleConfirm()}
            onCancel={onClose}
        />
    );
}
