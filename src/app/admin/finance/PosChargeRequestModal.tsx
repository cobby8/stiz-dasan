"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { cancelPosChargeRequest, createPosChargeRequest, loadPosChargeRequest } from "@/app/actions/pos-charge";
import type { AdminChargeRequestView } from "@/lib/pos/chargeRequestService";

/**
 * «현장 결제» 창 — 청구서 1건을 토스 POS 로 받을 때 쓰는 결제 번호(S-482193)를 만들고 크게 보여 준다.
 *
 * 흐름: [결제 번호 만들기] → 번호·금액 크게 표시 → 선생님이 POS 주문 메모에 «STIZ:S-482193» 입력 후 카드 결제
 *       → 토스가 결제를 알려 주면 서버가 확인해 납부완료로 바꾼다([결제 확인]으로 다시 볼 수 있다).
 * 이 창은 돈을 직접 바꾸지 않는다. 납부완료는 토스 결제 확인으로만 된다.
 */

type Target = { id: string; studentName: string; amount: number; title: string };

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

const STATUS_TEXT: Record<string, string> = {
    PENDING: "결제 기다리는 중",
    SENT: "POS 에서 결제 진행 중",
    PAID: "납부완료로 반영됨",
    CANCELLED: "취소된 요청",
    EXPIRED: "시간이 지난 요청",
    HELD: "원장 확인 필요",
};

export default function PosChargeRequestModal({
    target,
    onClose,
    onPaid,
}: {
    target: Target;
    onClose: () => void;
    /** 납부완료가 확인되면 목록을 다시 읽게 한다 */
    onPaid: () => void;
}) {
    const { confirm, confirmDialog } = useAdminConfirm();
    const [request, setRequest] = useState<AdminChargeRequestView | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    // 부모가 매번 새 함수를 넘겨도 다시 불러오기가 반복되지 않게 ref 로 들고 있는다
    const onPaidRef = useRef(onPaid);
    useEffect(() => {
        onPaidRef.current = onPaid;
    }, [onPaid]);

    const refresh = useCallback(async () => {
        setLoading(true);
        const result = await loadPosChargeRequest(target.id);
        setLoading(false);
        if (!result.ok) {
            setMessage(result.message);
            return;
        }
        setRequest(result.request);
        setMessage("");
        if (result.request?.status === "PAID") onPaidRef.current();
    }, [target.id]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const isOpen = !!request && (request.status === "PENDING" || request.status === "SENT") && !request.isExpired;

    async function handleCreate() {
        const ok = await confirm({
            title: `${target.studentName} · ${won(target.amount)} 현장 결제 번호 만들기`,
            description: "30분 동안 쓸 수 있는 결제 번호를 만듭니다. 토스 POS 에서 카드 결제를 받으면 납부완료로 바뀝니다.",
            confirmLabel: "번호 만들기",
            tone: "primary",
        });
        if (!ok) return;
        setBusy(true);
        const result = await createPosChargeRequest(target.id);
        setBusy(false);
        if (!result.ok) {
            setMessage(result.message);
            return;
        }
        setRequest(result.request);
        setMessage(result.existing ? "이미 만들어 둔 번호가 있어 그 번호를 보여 드립니다." : "");
    }

    async function handleCancel() {
        if (!request) return;
        const ok = await confirm({
            title: `결제 번호 ${request.shortCode} 취소`,
            description:
                request.status === "SENT"
                    ? "POS 에서 이미 결제를 진행 중일 수 있습니다. 취소한 뒤 결제가 들어오면 슬랙 확인 알림으로 넘어갑니다."
                    : "이 번호로는 더 이상 자동 납부 반영이 되지 않습니다.",
            confirmLabel: "번호 취소",
            tone: "danger",
        });
        if (!ok) return;
        setBusy(true);
        const result = await cancelPosChargeRequest(request.id);
        setBusy(false);
        if (!result.ok) setMessage(result.message);
        await refresh();
    }

    return (
        <>
        <AdminModal titleId="pos-charge-title" onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={false} panelClassName="max-w-md">
            <div className="w-full p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-[var(--color-academy-primary)]">현장 결제 · 토스 POS</p>
                        <h2 id="pos-charge-title" className="mt-0.5 truncate text-lg font-extrabold text-[var(--color-academy-ink)]">
                            {target.studentName} · {won(target.amount)}
                        </h2>
                        <p className="text-sm text-[var(--color-academy-muted)]">{target.title}</p>
                    </div>
                    <button type="button" onClick={onClose} disabled={busy} className="academy-button-text">
                        닫기
                    </button>
                </div>

                {loading && !request ? (
                    <p className="mt-6 text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>
                ) : isOpen && request ? (
                    <div className="mt-4">
                        {/* 주인공 하나: 결제 번호 — 선생님이 POS 앞에서 멀리서도 읽을 수 있게 크게 */}
                        <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-4 py-5 text-center">
                            <p className="text-sm font-bold text-[var(--color-academy-muted)]">결제 번호</p>
                            <p className="mt-1 font-mono text-5xl font-black tracking-wider text-[var(--color-academy-ink)]" aria-live="polite">
                                {request.shortCode}
                            </p>
                            <p className="mt-2 text-xl font-extrabold text-[var(--color-academy-ink)]">{won(request.amount)}</p>
                            <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                                {STATUS_TEXT[request.status]} · {request.expiresKstHm}까지
                            </p>
                        </div>
                        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-[var(--color-academy-ink)]">
                            <li>
                                토스 POS 주문 메모에 <b className="font-mono">{request.memo}</b> 를 넣어 주세요.
                            </li>
                            <li>금액 {won(request.amount)}을 그대로 카드 결제하면 납부완료로 바뀝니다.</li>
                        </ol>
                        <p className="mt-2 text-xs text-[var(--color-academy-muted)]">
                            금액을 바꾸거나 메모를 빼면 자동 반영되지 않고 슬랙 확인 알림으로 넘어갑니다.
                        </p>
                        <div className="mt-4 flex items-center gap-2">
                            <button type="button" onClick={() => void handleCancel()} disabled={busy} className="academy-button-danger">
                                번호 취소
                            </button>
                            <button type="button" onClick={() => void refresh()} disabled={busy || loading} className="academy-button-primary ml-auto">
                                {loading ? "확인 중…" : "결제 확인"}
                            </button>
                        </div>
                    </div>
                ) : request?.status === "PAID" ? (
                    <div className="mt-4 rounded-lg border border-[var(--color-academy-line)] px-4 py-4">
                        <p className="text-base font-extrabold text-[var(--color-academy-success)]">납부완료로 반영됐습니다</p>
                        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                            결제 번호 {request.shortCode} · {won(request.amount)}
                            {request.paidKst ? ` · ${request.paidKst} 결제` : ""}
                        </p>
                        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">랠리즈에도 납부 처리해 주세요.</p>
                    </div>
                ) : (
                    <div className="mt-4">
                        {request?.status === "HELD" ? (
                            <div className="rounded-lg border border-[var(--color-academy-danger)] px-4 py-3 text-sm">
                                <p className="font-bold text-[var(--color-academy-danger)]">자동 반영 보류 · {request.shortCode}</p>
                                <p className="mt-1 text-[var(--color-academy-ink)]">{request.note ?? "확인이 필요합니다."}</p>
                                <p className="mt-1 text-[var(--color-academy-muted)]">슬랙 결제 확인 알림에서 처리해 주세요.</p>
                            </div>
                        ) : request ? (
                            <p className="text-sm text-[var(--color-academy-muted)]">
                                지난 번호 {request.shortCode} · {STATUS_TEXT[request.isExpired && request.status !== "CANCELLED" ? "EXPIRED" : request.status] ?? request.status}
                            </p>
                        ) : (
                            <p className="text-sm text-[var(--color-academy-muted)]">
                                토스 POS 로 받을 결제 번호를 만듭니다. 30분 동안 쓸 수 있어요.
                            </p>
                        )}
                        <div className="mt-4 flex">
                            <button type="button" onClick={() => void handleCreate()} disabled={busy} className="academy-button-primary ml-auto">
                                {busy ? "만드는 중…" : "결제 번호 만들기"}
                            </button>
                        </div>
                    </div>
                )}

                {message && (
                    <p role="alert" className="mt-3 text-sm font-semibold text-[var(--color-academy-danger)]">
                        {message}
                    </p>
                )}
            </div>
        </AdminModal>
        {/* 확인 창은 바깥에 — 창 안에 겹치면 키보드 포커스가 꼬인다 */}
        {confirmDialog}
        </>
    );
}
