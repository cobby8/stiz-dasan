"use client";

// 학생 상세 «청구/수납» 탭의 청구서 발행·수정·삭제 창(2026-11-09 원장 지시).
// 원장이 한 학생 청구를 고치려고 수납 관리로 가서 찾지 않아도 되게, 상세에서 바로 처리한다.
// - 발행: 서버 createPayment 재사용(같은 달 같은 청구가 있으면 «그래도 발행» 확인 후 force)
// - 수정: 서버 updateUnpaidPayment(미납·연체 + POS·학부모 결제에 안 묶인 건만)
// - 삭제: 서버 cancelUnpaidPayment(사유를 남기고 «취소» 상태로 — 기록은 지우지 않는다)
// 판정(청구 월·중복·수정 가능)은 lib/payments/studentBillingRules 한 곳 — 서버와 같은 함수를 쓴다.

import { useState, type FormEvent } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { cancelUnpaidPayment, createPayment, updateUnpaidPayment, type CreatePaymentResult } from "@/app/actions/admin";
import { monthlyBillingDueDate } from "@/lib/billing-due-date";
import { todayKst } from "@/lib/datetime/kst";
import {
    BILLING_TYPES,
    BILLING_TYPE_LABELS,
    billingTypeNeedsClass,
    defaultBillingDescription,
    defaultIssueDueDate,
    isDueDatePast,
} from "@/lib/payments/studentBillingRules";

// 입력칸 공통 모양 — 터치 44px, 글자 14px, 색은 토큰만
const FIELD_CLASS = "academy-input mt-1";
const LABEL_CLASS = "block text-xs font-medium text-[var(--color-academy-muted)]";

const STATUS_LABEL: Record<string, string> = { PENDING: "미납", OVERDUE: "연체", PAID: "완납" };

function formatWon(amount: number) {
    return `${amount.toLocaleString("ko-KR")}원`;
}

/**
 * 청구 월 "YYYY-MM" → 발행 창 기본 기한 = max(그 달 청구 기한(약관: 전월 말일), 오늘 KST).
 * 월중 신규생처럼 약관 기한이 이미 지났으면 오늘로 — 지난 날짜가 기본으로 들어가 바로 연체가 되지 않게.
 */
function dueDateForBillingMonth(billingMonth: string): string {
    const [y, m] = billingMonth.split("-").map(Number);
    let monthlyDue = "";
    try {
        monthlyDue = monthlyBillingDueDate(y, m);
    } catch {
        monthlyDue = "";
    }
    return defaultIssueDueDate(monthlyDue, todayKst());
}

export type BillingClassOption = { classId: string; label: string };

// ── 발행 ─────────────────────────────────────────────────────────────────────
export function IssueInvoiceModal({
    studentId,
    studentName,
    classOptions,
    hasParent,
    parentSendEnabled,
    onClose,
    onDone,
}: {
    studentId: string;
    studentName: string;
    /** 그 학생이 지금 수강 중(ACTIVE)인 반 */
    classOptions: BillingClassOption[];
    /** 학부모 계정이 연결돼 있나(알림 체크 가능 여부) */
    hasParent: boolean;
    /** 학부모 청구 안내 사이트 발송 잠금이 풀렸나(서버 환경변수) */
    parentSendEnabled: boolean;
    onClose: () => void;
    onDone: () => Promise<void> | void;
}) {
    // 청구 월 기본값 = 이번 달(KST). "YYYY-MM-DD" 문자열의 앞 7자리라 시간대 영향이 없다
    const initialMonth = todayKst().slice(0, 7);
    const [type, setType] = useState<string>("MONTHLY");
    const [classId, setClassId] = useState(classOptions.length === 1 ? classOptions[0].classId : "");
    const [amount, setAmount] = useState("");
    const [billingMonth, setBillingMonth] = useState(initialMonth);
    const [dueDate, setDueDate] = useState(dueDateForBillingMonth(initialMonth));
    // 기한을 손으로 고쳤으면 청구 월을 바꿔도 덮어쓰지 않는다
    const [dueTouched, setDueTouched] = useState(false);
    const [description, setDescription] = useState("");
    const [notifyParent, setNotifyParent] = useState(false); // 학부모 알림은 기본 끔
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 서버가 «같은 달 같은 청구가 있다»고 돌려준 목록 — 있으면 버튼이 «그래도 발행»으로 바뀐다
    const [duplicates, setDuplicates] = useState<Extract<CreatePaymentResult, { ok: false }>["duplicates"] | null>(null);

    const needsClass = billingTypeNeedsClass(type);
    const amountNumber = Number(amount);
    const notifyDisabled = !parentSendEnabled || !hasParent;
    // 경고는 원장이 지난 날짜를 «직접» 골랐을 때만(기본값은 오늘 이후라 경고가 뜨지 않는다)
    const duePast = dueTouched && isDueDatePast(dueDate, todayKst());

    // 입력이 바뀌면 중복 경고는 다시 확인해야 하므로 지운다
    function resetDuplicate() {
        if (duplicates) setDuplicates(null);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (busy) return;
        if (needsClass && !classId) return setError("수강료·셔틀비는 반을 골라 주세요.");
        if (!Number.isSafeInteger(amountNumber) || amountNumber <= 0) return setError("금액을 1원 이상 숫자로 적어 주세요.");
        if (!billingMonth || !dueDate) return setError("청구 월과 납부기한을 골라 주세요.");
        setBusy(true);
        setError(null);
        try {
            const result = await createPayment({
                studentId,
                classId: classId || null,
                amount: amountNumber,
                dueDate,
                billingMonth,
                status: "PENDING",
                type,
                // 설명을 비우면 «11월 수강료»처럼 채운다(청구서 제목이 영어 유형 코드로 보이지 않게)
                description: description.trim() || defaultBillingDescription(type, billingMonth),
                notifyParent: notifyParent && !notifyDisabled,
                force: Boolean(duplicates),
            });
            if (!result.ok) {
                setDuplicates(result.duplicates);
                return;
            }
            await onDone();
            onClose();
        } catch (err) {
            setError(adminErrorText(err, "청구서 발행에 실패했습니다."));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AdminModal titleId="issue-invoice-title" panelClassName="max-w-md p-5" onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={!busy}>
            <form onSubmit={(e) => void submit(e)} className="space-y-3">
                <div>
                    <h2 id="issue-invoice-title" className="text-lg font-bold text-[var(--color-academy-ink)]">청구서 발행</h2>
                    <p className="text-xs text-[var(--color-academy-muted)]">{studentName} · 미납 상태로 발행돼요</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <label className={LABEL_CLASS}>
                        유형
                        <select value={type} onChange={(e) => { setType(e.target.value); resetDuplicate(); }} className={FIELD_CLASS} data-admin-modal-initial-focus="true">
                            {BILLING_TYPES.map((value) => <option key={value} value={value}>{BILLING_TYPE_LABELS[value]}</option>)}
                        </select>
                    </label>
                    <label className={LABEL_CLASS}>
                        반{needsClass ? " *" : " (선택)"}
                        <select value={classId} onChange={(e) => { setClassId(e.target.value); resetDuplicate(); }} className={FIELD_CLASS}>
                            <option value="">{needsClass ? "반 선택" : "연결 안 함"}</option>
                            {classOptions.map((option) => <option key={option.classId} value={option.classId}>{option.label}</option>)}
                        </select>
                    </label>
                    <label className={LABEL_CLASS}>
                        금액 *
                        <input type="number" inputMode="numeric" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="예: 160000" className={FIELD_CLASS} />
                    </label>
                    <label className={LABEL_CLASS}>
                        청구 월 *
                        <input
                            type="month"
                            value={billingMonth}
                            onChange={(e) => {
                                setBillingMonth(e.target.value);
                                resetDuplicate();
                                // 기한을 안 건드렸으면 그 달 청구 기한으로 따라 바꾼다
                                if (!dueTouched) setDueDate(dueDateForBillingMonth(e.target.value));
                            }}
                            className={FIELD_CLASS}
                        />
                    </label>
                    <label className={`${LABEL_CLASS} col-span-2`}>
                        납부기한 *
                        <input type="date" value={dueDate} onChange={(e) => { setDueDate(e.target.value); setDueTouched(true); }} className={FIELD_CLASS} />
                        {duePast && <span className="mt-1 block text-xs font-medium text-[var(--color-academy-warning)]">기한이 이미 지난 날짜예요 — 발행하면 곧 연체로 보일 수 있어요.</span>}
                    </label>
                    <label className={`${LABEL_CLASS} col-span-2`}>
                        설명 (선택)
                        <input type="text" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={defaultBillingDescription(type, billingMonth)} className={FIELD_CLASS} />
                    </label>
                </div>
                <label className={`flex min-h-11 items-center gap-2 text-sm text-[var(--color-academy-muted)] ${notifyDisabled ? "opacity-60" : ""}`}>
                    <input type="checkbox" checked={notifyParent} disabled={notifyDisabled} onChange={(e) => setNotifyParent(e.target.checked)} className="h-5 w-5 shrink-0" />
                    발행 후 학부모에게 수납 안내 알림
                </label>
                {notifyDisabled && (
                    <p className="-mt-2 text-xs text-[var(--color-academy-faint)]">
                        {!parentSendEnabled ? "학부모 청구 안내 발송은 잠겨 있습니다(발송 스위치를 켜면 열립니다)." : "연결된 학부모 계정이 없어 알림을 보낼 수 없어요."}
                    </p>
                )}
                {duplicates && (
                    // 중복 경고 — 같은 학생·반·월·유형에 살아 있는 청구. «그래도 발행»을 눌러야만 하나 더 만든다
                    <div role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-ink)]">
                        <p className="font-semibold">같은 달 같은 청구가 이미 있어요</p>
                        <ul className="mt-1 space-y-0.5">
                            {duplicates.map((d) => (
                                <li key={d.id}>{d.description || BILLING_TYPE_LABELS[type as keyof typeof BILLING_TYPE_LABELS]} · {d.amount == null ? "—" : formatWon(d.amount)} · {STATUS_LABEL[d.status] ?? d.status}</li>
                            ))}
                        </ul>
                        <p className="mt-1">그래도 하나 더 발행하려면 아래 «그래도 발행»을 눌러 주세요.</p>
                    </div>
                )}
                {error && <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                <div className="flex items-center gap-3">
                    <button type="button" disabled={busy} onClick={onClose} className="academy-button-text">닫기</button>
                    <button type="submit" disabled={busy} className="academy-button-primary ml-auto">
                        {busy ? "처리 중…" : duplicates ? "그래도 발행" : "발행"}
                    </button>
                </div>
            </form>
        </AdminModal>
    );
}

// ── 수정 ─────────────────────────────────────────────────────────────────────
export type EditablePayment = {
    id: string;
    amount: number;
    description: string | null;
    /** "YYYY-MM-DD" */
    dueYmd: string;
    periodLabel: string;
};

export function EditInvoiceModal({
    studentId,
    payment,
    onClose,
    onDone,
}: {
    studentId: string;
    payment: EditablePayment;
    onClose: () => void;
    onDone: () => Promise<void> | void;
}) {
    const [amount, setAmount] = useState(String(payment.amount));
    const [dueDate, setDueDate] = useState(payment.dueYmd);
    const [description, setDescription] = useState(payment.description ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const amountNumber = Number(amount);
    // 기한을 바꿔서 지난 날짜가 됐을 때만 경고(원래 기한이 지난 연체 건을 열 때는 띄우지 않는다)
    const duePast = dueDate !== payment.dueYmd && isDueDatePast(dueDate, todayKst());

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (busy) return;
        if (!Number.isSafeInteger(amountNumber) || amountNumber <= 0) return setError("금액을 1원 이상 숫자로 적어 주세요.");
        if (!dueDate) return setError("납부기한을 골라 주세요.");
        setBusy(true);
        setError(null);
        try {
            await updateUnpaidPayment({ studentId, paymentId: payment.id, amount: amountNumber, description, dueDate });
            await onDone();
            onClose();
        } catch (err) {
            setError(adminErrorText(err, "청구서 수정에 실패했습니다."));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AdminModal titleId="edit-invoice-title" panelClassName="max-w-md p-5" onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={!busy}>
            <form onSubmit={(e) => void submit(e)} className="space-y-3">
                <div>
                    <h2 id="edit-invoice-title" className="text-lg font-bold text-[var(--color-academy-ink)]">청구서 수정</h2>
                    <p className="text-xs text-[var(--color-academy-muted)]">{payment.periodLabel} · 지금 {formatWon(payment.amount)}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <label className={LABEL_CLASS}>
                        금액 *
                        <input type="number" inputMode="numeric" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} className={FIELD_CLASS} data-admin-modal-initial-focus="true" />
                    </label>
                    <label className={LABEL_CLASS}>
                        납부기한 *
                        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={FIELD_CLASS} />
                    </label>
                    <label className={`${LABEL_CLASS} col-span-2`}>
                        설명
                        <input type="text" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD_CLASS} />
                    </label>
                </div>
                {duePast && <p className="text-xs font-medium text-[var(--color-academy-warning)]">기한이 이미 지난 날짜예요 — 연체로 보일 수 있어요.</p>}
                <p className="text-xs text-[var(--color-academy-faint)]">청구서 금액·기한도 같이 바뀌고, 바꾸기 전 값이 수납 이력에 남아요. 학부모 알림은 보내지 않아요.</p>
                {error && <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                <div className="flex items-center gap-3">
                    <button type="button" disabled={busy} onClick={onClose} className="academy-button-text">닫기</button>
                    <button type="submit" disabled={busy} className="academy-button-primary ml-auto">{busy ? "처리 중…" : "저장"}</button>
                </div>
            </form>
        </AdminModal>
    );
}

// ── 삭제(취소 처리) ───────────────────────────────────────────────────────────
export type CancelablePayment = { id: string; amount: number; statusLabel: string; periodLabel: string; classLabel: string };

export function CancelInvoiceModal({
    studentName,
    payment,
    onClose,
    onDone,
}: {
    studentName: string;
    payment: CancelablePayment;
    onClose: () => void;
    onDone: () => Promise<void> | void;
}) {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        if (busy) return;
        if (!reason.trim()) return setError("취소 사유를 입력해 주세요.");
        setBusy(true);
        setError(null);
        try {
            // 사유 앞에 «기간 반»을 붙이는 형식은 수납 관리 «청구서 삭제»와 같다(이력에서 같은 모양으로 보이게)
            await cancelUnpaidPayment(payment.id, `${payment.periodLabel} ${payment.classLabel}: ${reason.trim()}`);
            await onDone();
            onClose();
        } catch (err) {
            setError(adminErrorText(err, "청구서 삭제 실패"));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AdminModal titleId="cancel-invoice-title" panelClassName="max-w-md p-5" onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={!busy}>
            <div className="space-y-3">
                <h2 id="cancel-invoice-title" className="text-lg font-bold text-[var(--color-academy-ink)]">청구서 삭제</h2>
                <p className="text-sm text-[var(--color-academy-muted)]">{studentName} · {payment.periodLabel} · {payment.classLabel}</p>
                <p className="font-semibold tabular-nums text-[var(--color-academy-ink)]">{formatWon(payment.amount)} · {payment.statusLabel} → 취소</p>
                <p className="text-xs text-[var(--color-academy-muted)]">기록은 삭제하지 않고 취소 사유와 담당자를 감사 이력에 남깁니다. 학부모 알림은 보내지 않습니다.</p>
                <label className="block text-sm font-medium text-[var(--color-academy-muted)]">
                    취소 사유
                    <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={300}
                        rows={3}
                        data-admin-modal-initial-focus="true"
                        className="mt-1 w-full rounded-lg border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] p-3 text-[var(--color-academy-ink)]"
                    />
                </label>
                {error && <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                {/* 위험 확정은 오른쪽 끝 꽉 찬 위험색, 닫기는 왼쪽 글자 버튼 — 수납 관리와 같은 배치 */}
                <div className="flex items-center gap-3">
                    <button type="button" disabled={busy} onClick={onClose} className="academy-button-text">닫기</button>
                    <button type="button" disabled={busy || !reason.trim()} onClick={() => void submit()} className="academy-button-danger-solid ml-auto">{busy ? "처리 중…" : "청구서 삭제"}</button>
                </div>
            </div>
        </AdminModal>
    );
}
