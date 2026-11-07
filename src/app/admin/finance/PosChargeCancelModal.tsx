"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { loadPosChargeCancel, requestPosChargeCancel } from "@/app/actions/pos-charge";
import type { AdminChargeCancelView } from "@/lib/pos/chargeRequestService";

/**
 * «결제 취소» 창 — 토스 POS(현장 결제)로 납부된 청구서 1건의 POS 결제를 사이트에서 취소한다(2026-11-08 원장 지시).
 *
 * 흐름: [결제 취소] → 위험 작업 확인 → 서버가 «취소할 일»을 남김 → POS 플러그인이 가져가 토스 POS 결제를 취소
 *       → 토스가 취소를 알려 주면(웹훅) 서버가 확인해 청구를 «환불»로 바꾼다.
 *       창이 열려 있는 동안 3초마다 상태를 다시 읽는다(현장 결제 창과 같은 방식 — 탭을 숨기면 멈춘다).
 * 이 창은 돈을 직접 바꾸지 않는다. 환불은 토스 확인으로만 된다. POS 에서 직접 취소해도 같은 길로 환불된다.
 */

type Target = { id: string; studentName: string; amount: number; title: string };

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

/** 자동으로 상태를 다시 읽는 간격(밀리초) — 현장 결제 창과 같다 */
const POS_CANCEL_POLL_MS = 3000;

export default function PosChargeCancelModal({
    target,
    onClose,
    onRefunded,
}: {
    target: Target;
    onClose: () => void;
    /** 환불이 확인되면 목록을 다시 읽게 한다 */
    onRefunded: () => void;
}) {
    const { confirm, confirmDialog } = useAdminConfirm();
    const [cancel, setCancel] = useState<AdminChargeCancelView | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    // 부모가 매번 새 함수를 넘겨도 다시 불러오기가 반복되지 않게 ref 로 들고 있는다
    const onRefundedRef = useRef(onRefunded);
    useEffect(() => {
        onRefundedRef.current = onRefunded;
    }, [onRefunded]);
    // 같은 순간에 두 번 읽지 않게 · 창이 닫힌 뒤 늦게 온 응답은 버린다
    const inFlightRef = useRef(false);
    const mountedRef = useRef(true);
    // 환불 확인 알림(목록 다시 읽기)은 한 번만
    const refundedNotifiedRef = useRef(false);
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
            const result = await loadPosChargeCancel(target.id);
            if (!mountedRef.current) return;
            if (!result.ok) {
                setMessage(result.message);
                return;
            }
            setCancel(result.cancel);
            setMessage("");
            if (result.cancel?.cancelState === "DONE" && !refundedNotifiedRef.current) {
                refundedNotifiedRef.current = true;
                onRefundedRef.current();
            }
        } finally {
            inFlightRef.current = false;
            if (mountedRef.current) setLoading(false);
        }
    }, [target.id]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // POS 가 취소하는 중(요청함·가져감) — 이때만 3초마다 자동으로 다시 읽는다
    const isWorking = cancel?.cancelState === "REQUESTED" || cancel?.cancelState === "SENT";

    useEffect(() => {
        if (!isWorking) return;
        let timer: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (timer === null) timer = setInterval(() => void refresh(), POS_CANCEL_POLL_MS);
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
    }, [isWorking, refresh]);

    async function handleRequest() {
        // 돈이 나가는 작업 — 위험 작업 확인 창(대상·금액·되돌릴 수 없음을 보고 누르게)
        const ok = await confirm({
            title: `${target.studentName} · ${won(target.amount)} 결제 취소`,
            description: "POS 결제가 취소되고 청구는 환불로 바뀝니다. 되돌릴 수 없습니다.",
            confirmLabel: "결제 취소",
            tone: "danger",
        });
        if (!ok) return;
        setBusy(true);
        const result = await requestPosChargeCancel(target.id);
        setBusy(false);
        if (!result.ok) {
            setMessage(result.message);
            await refresh();
            return;
        }
        setCancel(result.cancel);
        setMessage("");
    }

    const state = cancel?.cancelState ?? null;

    return (
        <>
        <AdminModal titleId="pos-cancel-title" onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={false} panelClassName="max-w-md">
            <div className="w-full p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-[var(--color-academy-danger)]">결제 취소 · 토스 POS</p>
                        <h2 id="pos-cancel-title" className="mt-0.5 truncate text-lg font-extrabold text-[var(--color-academy-ink)]">
                            {target.studentName} · {won(target.amount)}
                        </h2>
                        <p className="text-sm text-[var(--color-academy-muted)]">
                            {target.title}
                            {cancel?.paidKst ? ` · ${cancel.paidKst} 결제` : ""}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} disabled={busy} className="academy-button-text">
                        닫기
                    </button>
                </div>

                {loading && !cancel ? (
                    <p className="mt-6 text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>
                ) : !cancel ? (
                    <p className="mt-4 text-sm text-[var(--color-academy-muted)]">
                        현장 결제(토스 POS) 기록을 찾지 못했습니다. POS 에서 직접 취소해 주세요.
                    </p>
                ) : state === "DONE" ? (
                    <div className="mt-4 rounded-lg border border-[var(--color-academy-line)] px-4 py-4" aria-live="polite">
                        <p className="text-base font-extrabold text-[var(--color-academy-success)]">환불 처리됐습니다</p>
                        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                            POS 결제 취소가 확인됐습니다{cancel.refundedKst ? ` · ${cancel.refundedKst}` : ""}
                        </p>
                    </div>
                ) : isWorking ? (
                    <div className="mt-4">
                        {/* 주인공 하나: 지금 상태 — POS 가 취소하고 토스가 확인해 주기를 기다린다 */}
                        <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-4 py-4 text-center" aria-live="polite">
                            <p className="text-base font-extrabold text-[var(--color-academy-ink)]">POS 에서 결제 취소 중</p>
                            <p className="mt-1 text-xl font-extrabold text-[var(--color-academy-ink)]">{won(cancel.amount)}</p>
                            <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
                                {cancel.reported
                                    ? "POS 에서 취소를 마쳤어요. 토스 확인이 오면 바로 환불로 바뀝니다."
                                    : "보통 몇 초 안에 끝나요. POS 화면에 확인 창이 뜨면 눌러 주세요."}
                            </p>
                        </div>
                        {cancel.pickupLate && (
                            <p role="alert" className="mt-3 text-sm font-semibold text-[var(--color-academy-danger)]">
                                POS 가 응답하지 않습니다. POS 에서 직접 취소해 주세요. 취소하면 여기서도 자동으로 환불로 바뀝니다.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="mt-4">
                        {state === "FAILED" ? (
                            <div className="rounded-lg border border-[var(--color-academy-danger)] px-4 py-3 text-sm">
                                <p className="font-bold text-[var(--color-academy-danger)]">POS 에서 취소하지 못했습니다</p>
                                {cancel.cancelReportMessage && <p className="mt-1 text-[var(--color-academy-ink)]">{cancel.cancelReportMessage}</p>}
                                <p className="mt-1 text-[var(--color-academy-muted)]">POS 에서 직접 취소해 주세요. 취소하면 여기서도 자동으로 환불로 바뀝니다.</p>
                            </div>
                        ) : state === "PARTIAL" ? (
                            <div className="rounded-lg border border-[var(--color-academy-danger)] px-4 py-3 text-sm">
                                <p className="font-bold text-[var(--color-academy-danger)]">일부 결제만 취소됐습니다</p>
                                <p className="mt-1 text-[var(--color-academy-muted)]">
                                    나눠 낸 결제 중 일부만 취소돼 청구는 납부완료 그대로입니다. 남은 결제도 취소하면 환불로 바뀝니다.
                                </p>
                            </div>
                        ) : (
                            <p className="text-sm text-[var(--color-academy-muted)]">
                                POS 로 받은 결제를 취소합니다. 카드는 승인 취소, 현금은 POS 기록이 취소됩니다.
                            </p>
                        )}
                        {!cancel.canRequest && cancel.blockReason && (
                            <p className="mt-2 text-sm text-[var(--color-academy-muted)]">{cancel.blockReason}</p>
                        )}
                        <div className="mt-4 flex">
                            <button
                                type="button"
                                onClick={() => void handleRequest()}
                                disabled={busy || !cancel.canRequest}
                                className="academy-button-danger ml-auto"
                            >
                                {busy ? "보내는 중…" : state === "FAILED" || state === "PARTIAL" ? "다시 결제 취소" : "결제 취소"}
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
