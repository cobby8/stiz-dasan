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

    // 묶음(같은 학생 여러 건을 POS 결제 한 번으로 받은 것) — 취소하면 묶인 청구가 «전부» 환불된다.
    // 그래서 제목은 고른 한 건이 아니라 묶음 전체(«홍길동 · 수강료 11월 외 1건 · 합계 280,000원»)를 보인다.
    const isBundle = (cancel?.itemCount ?? 1) > 1;
    // 다 불러오기 전에는 금액을 쓰지 않는다 — 고른 한 건 금액이 먼저 떴다가 묶음 합계로 바뀌면 헷갈린다
    const heading = !cancel
        ? (loading ? `${target.studentName} · 불러오는 중` : target.studentName)
        : isBundle
            ? `${target.studentName} · ${cancel.itemLabel} · 합계 ${won(cancel.amount)}`
            : `${target.studentName} · ${won(cancel.amount)}`;

    async function handleRequest() {
        if (!cancel) return;
        // 돈이 나가는 작업 — 위험 작업 확인 창. 무엇이 얼마 환불되는지 줄마다 보이고,
        // «되돌릴 수 없음» 체크를 해야 확정 버튼이 켜진다(진입 버튼과 글자도 달라 연달아 두 번 눌러 환불되지 않게).
        const ok = await confirm({
            title: "결제 취소 · 환불",
            description: (
                <>
                    <CancelItemList cancel={cancel} />
                    <span className="mt-2 block font-semibold text-[var(--color-academy-danger)]">
                        POS 결제(카드·현금)가 바로 취소되고 되돌릴 수 없어요.
                        {isBundle
                            ? ` 함께 결제한 청구 ${cancel.itemCount}건이 모두 환불로 바뀝니다.`
                            : " POS 결제가 취소되고 청구는 환불로 바뀝니다."}
                    </span>
                </>
            ),
            acknowledgeLabel: "되돌릴 수 없는 환불임을 확인했어요",
            // 확정 버튼 = 누구에게 얼마를 돌려주는지 그대로(«결제시험(원장) 5,000원 환불하기»)
            confirmLabel: `${target.studentName} ${won(cancel.amount)} 환불하기`,
            tone: "danger",
        });
        if (!ok) return;
        setBusy(true);
        // try/finally — 연결이 끊겨 오류가 나도 «보내는 중…»에서 굳지 않게
        try {
            const result = await requestPosChargeCancel(target.id);
            if (!result.ok) {
                setMessage(result.message);
                await refresh();
                return;
            }
            setCancel(result.cancel);
            setMessage("");
        } catch {
            // 서버에는 취소가 남았을 수도 있다 — 다시 읽어 실제 상태를 보인다
            setMessage("연결이 끊겨 결과를 받지 못했어요. 상태를 다시 확인합니다.");
            void refresh();
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    }

    const state = cancel?.cancelState ?? null;

    return (
        <>
        <AdminModal titleId="pos-cancel-title" onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={false} panelClassName="max-w-md">
            <div className="w-full p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-[var(--color-academy-danger)]">결제 취소 · 토스 POS</p>
                        <h2 id="pos-cancel-title" className={`mt-0.5 text-lg font-extrabold text-[var(--color-academy-ink)] ${isBundle ? "break-words" : "truncate"}`}>
                            {heading}
                        </h2>
                        <p className="text-sm text-[var(--color-academy-muted)]">
                            {isBundle ? `함께 결제한 청구 ${cancel?.itemCount ?? 0}건이 같이 취소돼요` : target.title}
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
                        <p className="text-base font-extrabold text-[var(--color-academy-success)]">
                            환불 처리됐습니다{isBundle && cancel ? ` · 청구 ${cancel.itemCount}건 모두` : ""}
                        </p>
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
                        {cancel.confirmLate && (
                            <p role="alert" className="mt-3 text-sm font-semibold text-[var(--color-academy-danger)]">
                                POS 취소는 됐지만 토스 확인이 늦어요. 잠시 후 수납 화면에서 확인해 주세요.
                            </p>
                        )}
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
                        {/* 환불될 청구를 줄마다(종류·월·금액) + 합계 */}
                        <div className="mt-3 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm">
                            <CancelItemList cancel={cancel} />
                        </div>
                        {!cancel.canRequest && cancel.blockReason && (
                            <p className="mt-2 text-sm text-[var(--color-academy-muted)]">{cancel.blockReason}</p>
                        )}
                        {/* 위험 등급(빨강) · 오른쪽 끝(위의 «닫기»와 떨어진 자리) · 확인창 확정 버튼과 다른 글자 */}
                        <div className="mt-4 flex">
                            <button
                                type="button"
                                onClick={() => void handleRequest()}
                                disabled={busy || !cancel.canRequest}
                                className="academy-button-danger ml-auto"
                            >
                                {busy ? "보내는 중…" : state === "FAILED" || state === "PARTIAL" ? "다시 환불 진행…" : "환불 진행…"}
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

/** 환불될 청구 목록 — 줄마다 «2026년 11월 수강료 … 180,000원», 맨 아래 합계 굵게(취소 창·확인창 공용) */
function CancelItemList({ cancel }: { cancel: AdminChargeCancelView }) {
    return (
        <span className="block">
            {cancel.items.map((it) => (
                <span key={it.paymentId} className="flex justify-between gap-3 py-0.5 text-[var(--color-academy-ink)]">
                    <span className="min-w-0 break-keep">{it.itemLabel}</span>
                    <span className="shrink-0 tabular-nums">{won(it.amount)}</span>
                </span>
            ))}
            <span className="mt-1 flex justify-between gap-3 border-t border-[var(--color-academy-line)] pt-1 font-extrabold text-[var(--color-academy-ink)]">
                <span>합계{cancel.itemCount > 1 ? ` · ${cancel.itemCount}건` : ""}</span>
                <span className="shrink-0 tabular-nums">{won(cancel.amount)}</span>
            </span>
        </span>
    );
}
