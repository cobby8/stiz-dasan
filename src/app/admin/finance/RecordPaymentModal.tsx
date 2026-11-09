"use client";

/**
 * «납부 처리» 창(2026-11-08 원장 결정)
 *
 * 왜: 예전 «납부처리»는 누르는 즉시 PAID 가 돼 실수해도 단서가 없고 결제 이력이 남지 않았다.
 *     이제 이 창에서 결제 방법을 고르고 근거를 남겨야만 납부완료가 된다.
 *   - 계좌이체: 입금일·입금자명(필수)·메모(선택) → recordBankTransferPayment (감사 기록이 같이 남는다)
 *   - 현장 결제(POS): 이 창을 닫고 기존 현장 결제 창을 연다(납부완료는 토스 결제 확인으로만).
 *     같은 학생의 미납 청구(유니폼 제외)를 POS 결제 한 번으로 받는다(최대 10건).
 * 한 건(행 ⚡ 메뉴)과 여러 건(체크박스 «선택 항목 납부 처리»)이 같은 창을 쓴다.
 *
 * 2026-11-08 원장 지시 «막다른 흐린 버튼 없애기»:
 *   고른 청구 중 안 되는 건(이미 납부·유니폼 등)은 사유와 함께 빼고, 나머지로 바로 진행할 버튼을 항상 준다.
 *   학생이 여럿이면 학생마다 POS 버튼을 따로 보인다(한 번에 한 학생씩).
 */
import { useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { recordBankTransferPayment } from "@/app/actions/admin";
import { todayKst } from "@/lib/datetime/kst";
import {
    DEPOSITOR_NAME_MAX,
    EXCLUDE_REASON_LABEL,
    MEMO_MAX,
    excludedNotice,
    planBankTransfer,
    planPosCharge,
    planTargetLabel,
    targetNamesSummary,
    validateBankTransferInput,
    type ExcludeReason,
    type PosGroup,
} from "@/lib/payments/bankTransferRecord";

export type RecordPaymentTarget = {
    id: string;
    /** 같은 학생인지 확인(현장 결제 여러 건 묶음) */
    studentId: string;
    studentName: string;
    amount: number;
    type: string;
    status: string;
    /** 청구 월·연도(선택) — label 이 없을 때 «11월 수강료»처럼 만드는 데 쓴다 */
    month?: number | null;
    year?: number | null;
    /** 줄 이름(선택) — 예: «2026년 11월 수강료». 없으면 종류 이름으로 대체 */
    label?: string;
};

type Props = {
    targets: RecordPaymentTarget[];
    onClose: () => void;
    /** 현장 결제(POS) 선택 — 부모가 이 창을 닫고 현장 결제 창을 연다(같은 학생 결제 가능 청구만, 최대 10건) */
    onChoosePos: (targets: RecordPaymentTarget[]) => void;
    /** 계좌이체 기록 완료 — 부모가 목록을 다시 불러온다 */
    onRecorded: (message: string) => void;
    /** true 면 방법 고르기를 건너뛰고 «현장 결제 확인» 화면으로 바로 연다(POS 바로가기) */
    preferPos?: boolean;
};

type Step = "choose" | "transfer" | "pos";

function won(n: number) {
    return `${n.toLocaleString("ko-KR")}원`;
}

const inputClass =
    "mt-1 min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]";

/** POS 그룹 버튼 이름 — «홍길동 2건 5,000원 POS 결제», 10건 넘어 나뉘면 «홍길동 (1/2) …» */
function groupButtonText(g: PosGroup<RecordPaymentTarget>) {
    const part = g.parts > 1 ? ` (${g.part}/${g.parts})` : "";
    return `${g.studentName}${part} ${g.targets.length}건 ${won(g.total)} POS 결제`;
}

/**
 * 대상 목록 — 줄마다 학생명·청구 이름·금액.
 * struck: 이번 방법에서 빠지는 건(줄 긋고 회색 + 사유 칩) · notes: 빠지진 않지만 알릴 것(예: «POS 불가»)
 */
function TargetList({
    targets,
    struck,
    notes,
}: {
    targets: RecordPaymentTarget[];
    struck: Map<string, ExcludeReason>;
    notes?: Map<string, string>;
}) {
    return (
        <ul className="mt-3 max-h-52 divide-y divide-[var(--color-academy-line)] overflow-y-auto rounded-lg border border-[var(--color-academy-line)]">
            {targets.map((t) => {
                const reason = struck.get(t.id);
                const note = notes?.get(t.id);
                return (
                    <li key={t.id} className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-sm">
                        <span className={`min-w-0 flex-1 truncate ${reason ? "text-[var(--color-academy-muted)] line-through" : "text-[var(--color-academy-ink)]"}`}>
                            <span className="font-bold">{t.studentName || "이름 없음"}</span> · {planTargetLabel(t)}
                        </span>
                        {/* 사유 칩은 줄 긋기 밖에 두어 읽히게 한다 */}
                        {reason && (
                            <span className="shrink-0 rounded bg-[var(--color-academy-soft)] px-1.5 py-0.5 text-xs font-bold text-[var(--color-academy-muted)]">
                                {EXCLUDE_REASON_LABEL[reason]}
                            </span>
                        )}
                        {!reason && note && (
                            <span className="shrink-0 rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-bold text-[var(--color-academy-warning)]">
                                {note}
                            </span>
                        )}
                        <span className={`shrink-0 tabular-nums ${reason ? "text-[var(--color-academy-muted)] line-through" : "font-bold text-[var(--color-academy-ink)]"}`}>
                            {won(t.amount)}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

/** 빠지는 건이 있을 때 경고 상자 — 어느 건이 왜 빠지고 몇 건·얼마가 처리되는지 */
function WarnBox({ children }: { children: React.ReactNode }) {
    return (
        <p className="mt-2 flex gap-1.5 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-warning)]">
            <span className="material-symbols-outlined text-lg leading-5" aria-hidden="true">warning</span>
            <span>{children}</span>
        </p>
    );
}

export default function RecordPaymentModal({ targets, onClose, onChoosePos, onRecorded, preferPos = false }: Props) {
    // 단계: 방법 고르기 → 계좌이체 입력 / 현장 결제 확인(preferPos 면 바로 여기서 시작)
    const [step, setStep] = useState<Step>(() => (preferPos ? "pos" : "choose"));
    const [depositDate, setDepositDate] = useState(() => todayKst()); // 기본값 = 오늘(KST)
    const [depositorName, setDepositorName] = useState("");
    const [memo, setMemo] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 방법별 계획 — 안 되는 건은 사유와 함께 빼고 나머지만 처리한다
    const transfer = planBankTransfer(targets);
    const transferTotal = transfer.recordable.reduce((sum, t) => sum + t.amount, 0);
    const pos = planPosCharge(targets);
    const posCount = pos.groups.reduce((sum, g) => sum + g.targets.length, 0);
    const posTotal = pos.groups.reduce((sum, g) => sum + g.total, 0);

    const transferStruck = new Map(transfer.excluded.map((e) => [e.target.id, e.reason] as const));
    const posStruck = new Map(pos.excluded.map((e) => [e.target.id, e.reason] as const));
    // 방법 고르기 화면: 계좌이체로는 되지만 POS 로는 안 되는 건(유니폼·0원)에 «POS 불가» 칩
    const posOnlyNotes = new Map(
        pos.excluded
            .filter((e) => !transferStruck.has(e.target.id))
            .map((e) => [e.target.id, `POS 불가 · ${EXCLUDE_REASON_LABEL[e.reason]}`] as const),
    );
    const posOnlyExcluded = pos.excluded.filter((e) => !transferStruck.has(e.target.id));

    // POS 가 하나도 안 될 때 사유 한 줄(사유 종류만 모아서)
    const posNoneReason = Array.from(new Set(pos.excluded.map((e) => EXCLUDE_REASON_LABEL[e.reason]))).join(", ");

    const heading = targets.length === 1
        ? `${targets[0].studentName} · ${won(targets[0].amount)}`
        : `${targetNamesSummary(targets)} · ${targets.length}건 선택`;

    function close() {
        if (!submitting) onClose();
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        // 미납·연체인 건의 id 만 보낸다. 화면에서도 같은 규칙으로 먼저 검사(서버가 한 번 더 검사한다)
        const checked = validateBankTransferInput(
            { paymentIds: transfer.recordable.map((t) => t.id), depositDate, depositorName, memo },
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

    // POS 그룹 버튼들 — 그룹 1개면 호출부에서 큰 버튼 하나로 대신한다
    const groupButtons = (
        <div className="mt-2 grid gap-2">
            {pos.groups.map((g) => (
                <button
                    key={g.key}
                    type="button"
                    onClick={() => onChoosePos(g.targets)}
                    className="academy-button-secondary flex min-h-11 items-center justify-center gap-1.5"
                >
                    <span className="material-symbols-outlined" aria-hidden="true">contactless</span>
                    {groupButtonText(g)}
                </button>
            ))}
        </div>
    );

    // 현장 결제가 하나도 안 될 때 — 이때만 버튼 대신 사유와 계좌이체 안내
    const posNone = (
        <p className="mt-2 rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
            <span className="font-bold">현장 결제할 수 있는 청구가 없어요: {posNoneReason || "대상 없음"}.</span>
            {transfer.recordable.length > 0 && " 입금을 받았다면 계좌이체로 기록해 주세요."}
        </p>
    );

    return (
        <AdminModal titleId="record-payment-title" onClose={close} closeOnBackdrop={false} panelClassName="max-w-md">
            <div className="w-full p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-[var(--color-academy-ink)]">
                            {step === "pos" ? "현장 결제 확인" : step === "transfer" ? "계좌이체 기록" : "납부 처리"}
                        </p>
                        <h2 id="record-payment-title" className="mt-0.5 truncate text-lg font-extrabold text-[var(--color-academy-ink)]">
                            {heading}
                        </h2>
                    </div>
                    <button type="button" onClick={close} disabled={submitting} className="academy-button-text">
                        닫기
                    </button>
                </div>

                {step === "choose" && (
                    <div>
                        <TargetList targets={targets} struck={transferStruck} notes={posOnlyNotes} />
                        {transfer.excluded.length > 0 && (
                            <WarnBox>{excludedNotice(transfer.excluded, transfer.recordable.length, transferTotal)}</WarnBox>
                        )}
                        {transfer.excluded.length === 0 && transfer.recordable.length > 1 && (
                            <p className="mt-2 text-sm font-bold text-[var(--color-academy-ink)]">
                                {transfer.recordable.length}건 합계 {won(transferTotal)}
                            </p>
                        )}

                        <p className="mt-4 text-sm font-bold text-[var(--color-academy-ink)]">결제 방법을 골라 주세요</p>
                        <div className={`mt-2 grid gap-2 ${transfer.recordable.length > 0 && pos.groups.length === 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                            {transfer.recordable.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setStep("transfer")}
                                    className="academy-button-secondary flex min-h-14 flex-col items-center justify-center gap-0.5"
                                >
                                    <span className="material-symbols-outlined" aria-hidden="true">account_balance</span>
                                    계좌이체
                                    <span className="text-xs font-normal">{transfer.recordable.length}건 {won(transferTotal)}</span>
                                </button>
                            )}
                            {pos.groups.length === 1 && (
                                <button
                                    type="button"
                                    onClick={() => onChoosePos(pos.groups[0].targets)}
                                    className="academy-button-secondary flex min-h-14 flex-col items-center justify-center gap-0.5"
                                >
                                    <span className="material-symbols-outlined" aria-hidden="true">contactless</span>
                                    현장 결제(POS)
                                    <span className="text-xs font-normal">{pos.groups[0].targets.length}건 {won(pos.groups[0].total)}</span>
                                </button>
                            )}
                        </div>
                        {/* 학생이 여럿이면 학생마다 POS 버튼(한 번에 한 학생씩) */}
                        {pos.groups.length > 1 && (
                            <>
                                <p className="mt-3 text-sm text-[var(--color-academy-muted)]">현장 결제는 한 학생씩 받아요.</p>
                                {groupButtons}
                            </>
                        )}
                        {pos.groups.length === 0 && posNone}
                        {pos.groups.length > 0 && posOnlyExcluded.length > 0 && (
                            <p className="mt-2 text-xs text-[var(--color-academy-muted)]">
                                «POS 불가» {posOnlyExcluded.length}건은 현장 결제에서 빠져요(계좌이체로는 기록할 수 있어요).
                            </p>
                        )}
                        {transfer.recordable.length === 0 && (
                            <p className="mt-2 text-sm text-[var(--color-academy-muted)]">납부 처리할 미납·연체 청구가 없어요. 창을 닫고 다시 골라 주세요.</p>
                        )}
                    </div>
                )}

                {step === "pos" && (
                    <div>
                        <TargetList targets={targets} struck={posStruck} />
                        {pos.excluded.length > 0 && posCount > 0 && (
                            <WarnBox>{excludedNotice(pos.excluded, posCount, posTotal)}</WarnBox>
                        )}
                        {pos.groups.length === 1 && (
                            <>
                                <p className="mt-3 text-sm font-bold text-[var(--color-academy-ink)]">
                                    {pos.groups[0].studentName} · {pos.groups[0].targets.length}건 합계 {won(pos.groups[0].total)}
                                </p>
                                <button
                                    type="button"
                                    onClick={() => onChoosePos(pos.groups[0].targets)}
                                    className="academy-button-primary mt-2 flex min-h-11 w-full items-center justify-center gap-1.5"
                                >
                                    <span className="material-symbols-outlined" aria-hidden="true">contactless</span>
                                    POS로 결제 요청
                                </button>
                            </>
                        )}
                        {pos.groups.length > 1 && (
                            <>
                                <p className="mt-3 text-sm text-[var(--color-academy-muted)]">
                                    현장 결제는 한 학생씩 받아요 · 전체 {posCount}건 합계 {won(posTotal)}
                                </p>
                                {groupButtons}
                            </>
                        )}
                        {pos.groups.length === 0 && posNone}
                        {transfer.recordable.length > 0 && (
                            <div className="mt-3 flex">
                                <button type="button" onClick={() => setStep("transfer")} className="academy-button-text">
                                    다른 방법(계좌이체)
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {step === "transfer" && (
                    <form onSubmit={handleSubmit} className="space-y-3">
                        <TargetList targets={targets} struck={transferStruck} />
                        {transfer.excluded.length > 0 && (
                            <WarnBox>{excludedNotice(transfer.excluded, transfer.recordable.length, transferTotal)}</WarnBox>
                        )}
                        <p className="text-sm text-[var(--color-academy-ink)]">
                            <span className="font-bold">{transfer.recordable.length}건 합계 {won(transferTotal)}</span>
                            {/* 여러 건이면 입금 정보가 모든 건에 같이 들어간다는 것을 입력 직전에 알린다 */}
                            {transfer.recordable.length > 1 && (
                                <span className="text-[var(--color-academy-muted)]"> · 선택한 모든 건에 같은 입금 정보로 기록돼요.</span>
                            )}
                        </p>
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
                            <button type="submit" disabled={submitting || transfer.recordable.length === 0} className="academy-button-primary ml-auto">
                                {submitting ? "기록 중…" : `${transfer.recordable.length}건 납부완료로 기록`}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </AdminModal>
    );
}
