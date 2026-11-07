"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { cancelPosChargeRequest, createPosChargeRequest, loadPosChargeRequest } from "@/app/actions/pos-charge";
import type { AdminChargeRequestView } from "@/lib/pos/chargeRequestService";

/**
 * «현장 결제» 창 — 청구서 1건을 토스 POS 로 보내 카드 결제를 받는다.
 *
 * 흐름(2026-11-08 개편): [POS로 결제 보내기] → 확인 한 번 → 결제 요청 생성
 *       → 토스 POS 플러그인이 요청을 받아 주문 메모·금액을 넣고 결제창을 «자동으로» 연다(사람이 번호를 옮겨 적지 않는다)
 *       → 카드 결제가 끝나면 토스가 알려 주고 서버가 확인해 납부완료로 바꾼다.
 *       창이 열려 있는 동안 3초마다 상태를 다시 읽어 결과를 바로 보여 준다(창을 닫거나 탭을 숨기면 멈춘다).
 * 결제 번호(shortCode)는 서버가 결제를 맞춰 보는 내부 값이라 크게 보여 주지 않는다.
 * 보류·지난 요청 줄에만 슬랙 알림과 대조할 수 있게 작은 회색 글씨로 남긴다.
 * 이 창은 돈을 직접 바꾸지 않는다. 납부완료는 토스 결제 확인으로만 된다.
 */

type Target = { id: string; studentName: string; amount: number; title: string };

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 자동으로 상태를 다시 읽는 간격(밀리초) */
const POS_CHARGE_POLL_MS = 3000;

/** 지난 요청 한 줄에 붙이는 말 */
const PAST_TEXT: Record<string, string> = {
    CANCELLED: "취소됨",
    EXPIRED: "만료됨",
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
    // 같은 순간에 두 번 읽지 않게(3초 자동 읽기와 취소 후 읽기가 겹칠 때)
    const inFlightRef = useRef(false);
    // 창이 닫힌 뒤 늦게 도착한 응답은 버린다
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = useCallback(async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        try {
            const result = await loadPosChargeRequest(target.id);
            if (!mountedRef.current) return;
            if (!result.ok) {
                setMessage(result.message);
                return;
            }
            setRequest(result.request);
            setMessage("");
            if (result.request?.status === "PAID") onPaidRef.current();
        } finally {
            inFlightRef.current = false;
            if (mountedRef.current) setLoading(false);
        }
    }, [target.id]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // POS 로 보낸 뒤 결제를 기다리는 상태
    const isWaiting = !!request && (request.status === "PENDING" || request.status === "SENT") && !request.isExpired;

    // 기다리는 동안만 3초마다 자동으로 다시 읽는다. 탭이 숨겨지면 멈추고, 다시 보이면 바로 한 번 읽고 이어 간다.
    // 창이 닫히면(컴포넌트가 사라지면) 정리 함수가 타이머를 멈춘다.
    useEffect(() => {
        if (!isWaiting) return;
        let timer: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (timer === null) timer = setInterval(() => void refresh(), POS_CHARGE_POLL_MS);
        };
        const stop = () => {
            if (timer !== null) clearInterval(timer);
            timer = null;
        };
        const onVisibility = () => {
            if (document.visibilityState === "visible") {
                void refresh();
                start();
            } else {
                stop();
            }
        };
        if (document.visibilityState === "visible") start();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [isWaiting, refresh]);

    async function handleCreate() {
        const ok = await confirm({
            title: "POS로 결제 보내기",
            description: `${target.studentName} · ${won(target.amount)} 을 토스 POS 로 보낼까요? POS에 결제창이 바로 열립니다.`,
            confirmLabel: "보내기",
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
        setMessage(result.existing ? "이미 보낸 요청이 있어 그 요청의 결제를 기다립니다." : "");
    }

    async function handleCancel() {
        if (!request) return;
        const ok = await confirm({
            title: "결제 요청 취소",
            description:
                request.status === "SENT"
                    ? "POS 에서 이미 결제를 진행 중일 수 있습니다. 취소한 뒤 결제가 들어오면 슬랙 확인 알림으로 넘어갑니다."
                    : "이 요청으로는 더 이상 자동 납부 반영이 되지 않습니다.",
            confirmLabel: "요청 취소",
            tone: "danger",
        });
        if (!ok) return;
        setBusy(true);
        const result = await cancelPosChargeRequest(request.id);
        setBusy(false);
        if (!result.ok) setMessage(result.message);
        await refresh();
    }

    // 지난 요청이 만료인지 취소인지(만료 시간이 지났으면 상태가 PENDING 이어도 만료로 본다)
    const pastStatus = request && request.isExpired && request.status !== "CANCELLED" ? "EXPIRED" : (request?.status ?? "");

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
                ) : isWaiting && request ? (
                    <div className="mt-4">
                        {/* 주인공 하나: 지금 상태 — 사람이 따로 할 일은 없고 POS 결제만 기다린다 */}
                        <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-4 py-4 text-center" aria-live="polite">
                            <p className="text-base font-extrabold text-[var(--color-academy-ink)]">POS로 보냈어요 · 결제 기다리는 중</p>
                            <p className="mt-1 text-xl font-extrabold text-[var(--color-academy-ink)]">{won(request.amount)}</p>
                            <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
                                보통 몇 초 안에 POS에 결제창이 열려요. 안 열리면 POS의 STIZ 탭에서 결제할 수 있어요.
                            </p>
                        </div>
                        <div className="mt-4 flex">
                            <button type="button" onClick={() => void handleCancel()} disabled={busy} className="academy-button-danger">
                                요청 취소
                            </button>
                        </div>
                    </div>
                ) : request?.status === "PAID" ? (
                    <div className="mt-4 rounded-lg border border-[var(--color-academy-line)] px-4 py-4">
                        <p className="text-base font-extrabold text-[var(--color-academy-success)]">납부완료로 반영됐습니다</p>
                        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                            {won(request.amount)}
                            {request.paidKst ? ` · ${request.paidKst} 결제` : ""}
                        </p>
                        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">랠리즈에도 납부 처리해 주세요.</p>
                    </div>
                ) : (
                    <div className="mt-4">
                        {request?.status === "HELD" ? (
                            <div className="rounded-lg border border-[var(--color-academy-danger)] px-4 py-3 text-sm">
                                <p className="font-bold text-[var(--color-academy-danger)]">자동 반영 보류</p>
                                <p className="mt-1 text-[var(--color-academy-ink)]">{request.note ?? "확인이 필요합니다."}</p>
                                <p className="mt-1 text-[var(--color-academy-muted)]">슬랙 결제 확인 알림에서 처리해 주세요.</p>
                                {/* 슬랙 알림과 맞춰 볼 때만 쓰는 내부 번호 — 작은 회색 글씨 */}
                                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{request.shortCode}</p>
                            </div>
                        ) : request ? (
                            <p className="text-sm text-[var(--color-academy-muted)]">
                                지난 요청 · {PAST_TEXT[pastStatus] ?? pastStatus}
                                <span className="ml-1 text-xs">{request.shortCode}</span>
                            </p>
                        ) : null}
                        <div className="mt-4 flex">
                            <button type="button" onClick={() => void handleCreate()} disabled={busy} className="academy-button-primary ml-auto">
                                {busy ? "보내는 중…" : "POS로 결제 보내기"}
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
