"use client";

/**
 * «납부 처리» 창(2026-11-08 원장 결정)
 *
 * 왜: 예전 «납부처리»는 누르는 즉시 PAID 가 돼 실수해도 단서가 없고 결제 이력이 남지 않았다.
 *     이제 이 창에서 결제 방법을 고르고 근거를 남겨야만 납부완료가 된다.
 *   - 계좌이체: 입금일·입금자명(필수)·메모(선택) → recordBankTransferPayment (감사 기록이 같이 남는다)
 *   - 현장 결제(POS): 이 창을 닫고 기존 현장 결제 창을 연다(납부완료는 토스 결제 확인으로만).
 *     여러 건이어도 같은 학생의 수강료·셔틀비 미납이면 POS 결제 한 번으로 받는다(2026-11-08 원장 결정).
 * 한 건(행 ⚡ 메뉴)과 여러 건(체크박스 «선택 항목 납부 처리»)이 같은 창을 쓴다.
 */
import { useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { recordBankTransferPayment } from "@/app/actions/admin";
import { todayKst } from "@/lib/datetime/kst";
import {
    DEPOSITOR_NAME_MAX,
    MEMO_MAX,
    posChargeAvailability,
    targetNamesSummary,
    validateBankTransferInput,
} from "@/lib/payments/bankTransferRecord";

export type RecordPaymentTarget = {
    id: string;
    /** 같은 학생인지 확인(현장 결제 여러 건 묶음) */
    studentId: string;
    studentName: string;
    amount: number;
    type: string;
    status: string;
};

type Props = {
    targets: RecordPaymentTarget[];
    onClose: () => void;
    /** 현장 결제(POS) 선택 — 부모가 이 창을 닫고 현장 결제 창을 연다(1건, 또는 같은 학생 여러 건) */
    onChoosePos: (targets: RecordPaymentTarget[]) => void;
    /** 계좌이체 기록 완료 — 부모가 목록을 다시 불러온다 */
    onRecorded: (message: string) => void;
};

function won(n: number) {
    return `${n.toLocaleString("ko-KR")}원`;
}

const inputClass =
    "mt-1 min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]";

export default function RecordPaymentModal({ targets, onClose, onChoosePos, onRecorded }: Props) {
    // 단계: 방법 고르기 → 계좌이체 입력
    const [step, setStep] = useState<"choose" | "transfer">("choose");
    const [depositDate, setDepositDate] = useState(() => todayKst()); // 기본값 = 오늘(KST)
    const [depositorName, setDepositorName] = useState("");
    const [memo, setMemo] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const total = targets.reduce((sum, t) => sum + t.amount, 0);
    const pos = posChargeAvailability(targets);
    const heading = targets.length === 1
        ? `${targets[0].studentName} · ${won(targets[0].amount)}`
        : `${targets.length}건 · 합계 ${won(total)}`;

    function close() {
        if (!submitting) onClose();
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        // 화면에서도 같은 규칙으로 먼저 검사(서버가 한 번 더 검사한다)
        const checked = validateBankTransferInput(
            { paymentIds: targets.map((t) => t.id), depositDate, depositorName, memo },
            todayKst(),
        );
        if (!checked.ok) { setError(checked.error); return; }

        setSubmitting(true);
        setError(null);
        try {
            const result = await recordBankTransferPayment(checked.value);
            onRecorded(result.message);
        } catch (err: unknown) {
            setError(adminErrorText(err, "계좌이체 납부 기록에 실패했어요. 다시 시도해 주세요."));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AdminModal titleId="record-payment-title" onClose={close} closeOnBackdrop={false} panelClassName="max-w-md">
            <div className="w-full p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-[var(--color-academy-primary)]">납부 처리</p>
                        <h2 id="record-payment-title" className="mt-0.5 truncate text-lg font-extrabold text-[var(--color-academy-ink)]">
                            {heading}
                        </h2>
                        {targets.length > 1 && (
                            <>
                                {/* 누구 청구인지 창 안에서 확인 — 많으면 «홍길동, 김철수 외 N명» */}
                                <p className="truncate text-sm font-bold text-[var(--color-academy-ink)]">
                                    대상 {targetNamesSummary(targets)}
                                </p>
                                <p className="text-sm text-[var(--color-academy-muted)]">선택한 모든 건에 같은 입금 정보로 기록돼요.</p>
                            </>
                        )}
                    </div>
                    <button type="button" onClick={close} disabled={submitting} className="academy-button-text">
                        닫기
                    </button>
                </div>

                {step === "choose" ? (
                    <div className="mt-4">
                        <p className="text-sm font-bold text-[var(--color-academy-ink)]">결제 방법을 골라 주세요</p>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setStep("transfer")}
                                className="academy-button-secondary flex min-h-14 flex-col items-center justify-center gap-0.5"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">account_balance</span>
                                계좌이체
                            </button>
                            <button
                                type="button"
                                onClick={() => { if (pos.enabled) onChoosePos(targets); }}
                                disabled={!pos.enabled}
                                aria-describedby={pos.enabled ? undefined : "record-payment-pos-reason"}
                                className="academy-button-secondary flex min-h-14 flex-col items-center justify-center gap-0.5"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">contactless</span>
                                현장 결제(POS)
                            </button>
                        </div>
                        {/* 비활성 이유는 숨기지 않고 한 줄로 보인다 */}
                        {!pos.enabled && (
                            <p id="record-payment-pos-reason" className="mt-2 text-xs text-[var(--color-academy-muted)]">
                                {pos.reason}
                            </p>
                        )}
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                            <label className="block text-sm font-bold text-[var(--color-academy-ink)]">
                                입금일 *
                                <input
                                    type="date"
                                    value={depositDate}
                                    max={todayKst()}
                                    onChange={(e) => setDepositDate(e.target.value)}
                                    required
                                    className={inputClass}
                                />
                            </label>
                            <label className="block text-sm font-bold text-[var(--color-academy-ink)]">
                                입금자명 *
                                <input
                                    type="text"
                                    value={depositorName}
                                    onChange={(e) => setDepositorName(e.target.value)}
                                    maxLength={DEPOSITOR_NAME_MAX}
                                    required
                                    autoFocus
                                    placeholder="통장에 찍힌 이름"
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className="block text-sm font-bold text-[var(--color-academy-ink)]">
                            메모 <span className="font-normal text-[var(--color-academy-muted)]">(선택)</span>
                            <textarea
                                value={memo}
                                onChange={(e) => setMemo(e.target.value)}
                                maxLength={MEMO_MAX}
                                rows={2}
                                placeholder="예: 형제 두 명 합산 입금"
                                className={`${inputClass} py-2`}
                            />
                        </label>

                        {error && (
                            <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">
                                {error}
                            </p>
                        )}

                        <div className="flex items-center gap-2 pt-1">
                            <button type="button" onClick={() => { setError(null); setStep("choose"); }} disabled={submitting} className="academy-button-text">
                                방법 다시 고르기
                            </button>
                            <button type="submit" disabled={submitting} className="academy-button-primary ml-auto">
                                {submitting ? "기록 중…" : "납부완료로 기록"}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </AdminModal>
    );
}
