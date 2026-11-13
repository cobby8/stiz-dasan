"use client";

// 학생 상세 «수강·출결» 탭의 «기간 결석» 카드 (2026-11-09 원장 결정 «기간 결석 만들기»).
// 부상·질병은 휴원이 아니라 결석 — 반 자리·셔틀 명단은 그대로 두고, 그 기간 수업일만 날짜별 결석(확정)으로 남긴다.
// 목록(한 줄 행, 눌러서 날짜·반 펼치기) + «+ 기간 결석»(모달/모바일 하단 시트) + 기간마다 «복귀 처리»·«등록 취소».
import { useCallback, useEffect, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { statusToneClass } from "@/components/admin/StatusBadge";
import { addDaysKst, todayKst } from "@/lib/datetime/kst";
import { REASON_LABEL, VALID_REASONS } from "@/lib/regular/regularAbsenceRules";
import { DEFAULT_PERIOD_REASON, shortDateLabel } from "@/lib/regular/absence-period-plan";
import type { AbsencePeriodView } from "@/lib/regular/absence-period-service";
import {
    cancelAbsencePeriod,
    createAbsencePeriod,
    endAbsencePeriod,
    listAbsencePeriods,
} from "@/app/actions/absence-period-admin";

export type AbsencePeriodClassOption = { classId: string; className: string; dayLabel: string; startTime: string };

// 입력칸은 테마 공용 모양(academy-input)
const INPUT_CLASS = "academy-input mt-1";

/** 복귀일이 이미 지났는가(KST 오늘 기준) — 복귀일을 정해 등록한 진행 중 기간도 그날이 지나면 «복귀함» */
function hasReturned(p: AbsencePeriodView, today: string): boolean {
    return p.status === "ENDED" || Boolean(p.returnDate && p.returnDate <= today);
}

/** 기간 한 줄의 상태 칩 — 결석 중 / 복귀함 / 등록 취소 */
function statusChip(p: AbsencePeriodView, today: string): { label: string; className: string } {
    if (p.status === "CANCELLED") return { label: "등록 취소", className: statusToneClass("neutral") };
    if (hasReturned(p, today)) return { label: "복귀함", className: statusToneClass("success") };
    return { label: "결석 중", className: statusToneClass("warning") };
}

export default function AbsencePeriodPanel({
    studentId,
    studentName,
    activeClasses,
}: {
    studentId: string;
    studentName: string;
    /** 그 학생의 수강 중(ACTIVE) 반 — 대상 반 고르기 기본값(전부) */
    activeClasses: AbsencePeriodClassOption[];
}) {
    const today = todayKst();
    const [periods, setPeriods] = useState<AbsencePeriodView[] | null>(null);
    const [available, setAvailable] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [returnTarget, setReturnTarget] = useState<AbsencePeriodView | null>(null);
    const { confirm, confirmDialog } = useAdminConfirm();

    // 목록 다시 읽기 — 등록·복귀·취소 뒤에 부른다
    const load = useCallback(async () => {
        const result = await listAbsencePeriods(studentId);
        if (!result.ok) { setLoadError(result.message); return; }
        setLoadError(null);
        setAvailable(result.available);
        setPeriods(result.periods);
    }, [studentId]);

    useEffect(() => { void load(); }, [load]);

    async function cancelPeriod(p: AbsencePeriodView) {
        const live = p.absences.filter((a) => a.status !== "CANCELLED").length;
        // 위험 작업 확인 — 무엇이 사라지는지 숫자로 보여 준다
        const ok = await confirm({
            title: `"${studentName}" 기간 결석 등록 취소`,
            description: `${shortDateLabel(p.startDate)}~ 기간으로 만든 결석 ${live}회를 모두 취소합니다.\n청구에서 정산됐거나 보강이 잡힌 결석은 그대로 남깁니다. 잘못 등록했을 때만 쓰세요 — 아이가 돌아왔으면 «복귀 처리»를 쓰세요.`,
            confirmLabel: "등록 취소",
            tone: "danger",
        });
        if (!ok) return;
        setBusyId(p.id);
        try {
            const result = await cancelAbsencePeriod({ periodId: p.id });
            setFeedback({ type: result.ok ? "success" : "error", message: result.message });
            if (result.ok) await load();
        } catch {
            setFeedback({ type: "error", message: "등록 취소를 하지 못했어요. 잠시 후 다시 해 주세요." });
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="academy-panel p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="academy-section-title">기간 결석</h3>
                {available && (
                    <button
                        type="button"
                        onClick={() => { setFeedback(null); setShowCreate(true); }}
                        disabled={activeClasses.length === 0}
                        title={activeClasses.length === 0 ? "수강 중인 반이 없습니다" : undefined}
                        className="academy-button-secondary"
                    >
                        기간 결석 등록
                    </button>
                )}
            </div>

            {feedback && (
                <p
                    role={feedback.type === "error" ? "alert" : "status"}
                    className={`mb-2 rounded-lg px-3 py-2 text-sm font-medium ${feedback.type === "error"
                        ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                        : "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"}`}
                >
                    {feedback.message}
                </p>
            )}

            {loadError && <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{loadError}</p>}
            {!available && <p className="text-sm text-[var(--color-academy-muted)]">기간 결석은 아직 준비 중입니다. 잠시 후 다시 열어 주세요.</p>}
            {available && !periods && !loadError && <p className="text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>}
            {available && periods && periods.length === 0 && (
                <p className="text-sm text-[var(--color-academy-faint)]">
                    부상·질병으로 쉬는 기간을 한 번에 결석으로 남깁니다. 반 자리·셔틀 명단은 그대로예요.
                </p>
            )}

            {periods && periods.length > 0 && (
                <ul className="divide-y divide-[var(--color-academy-line)]">
                    {periods.map((p) => {
                        const chip = statusChip(p, today);
                        const live = p.absences.filter((a) => a.status !== "CANCELLED");
                        const open = openId === p.id;
                        const returnText = p.returnDate ? `복귀 ${shortDateLabel(p.returnDate)}` : "복귀 미정";
                        return (
                            <li key={p.id}>
                                {/* 한 줄 행 — 누르면 날짜·반 펼치기 */}
                                <button
                                    type="button"
                                    aria-expanded={open}
                                    onClick={() => setOpenId(open ? null : p.id)}
                                    className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-sm"
                                >
                                    <span className="min-w-0 flex-1 truncate text-[var(--color-academy-ink)]">
                                        <b>{shortDateLabel(p.startDate)}~</b>
                                        <span className="text-[var(--color-academy-muted)]"> · {returnText} · {REASON_LABEL[p.reason] ?? p.reason} · 결석 {live.length}회</span>
                                    </span>
                                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${chip.className}`}>{chip.label}</span>
                                    <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-muted)]">{open ? "▴" : "▾"}</span>
                                </button>

                                {open && (
                                    <div className="space-y-2 pb-3">
                                        {p.note && <p className="text-xs text-[var(--color-academy-muted)]">메모: {p.note}</p>}
                                        {p.absences.length === 0 ? (
                                            <p className="text-xs text-[var(--color-academy-faint)]">만든 결석이 없습니다(그 기간에 수업일이 없거나 연간 일정이 아직 없습니다).</p>
                                        ) : (
                                            <ul className="flex flex-wrap gap-1.5">
                                                {p.absences.map((a) => (
                                                    <li
                                                        key={a.id}
                                                        className={`rounded-md border border-[var(--color-academy-line)] px-2 py-1 text-xs ${a.status === "CANCELLED"
                                                            ? "text-[var(--color-academy-faint)] line-through"
                                                            : "text-[var(--color-academy-ink)]"}`}
                                                        title={a.status === "CANCELLED" ? "취소됨" : "결석(확정)"}
                                                    >
                                                        {shortDateLabel(a.date)} {a.className}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                        {p.status !== "CANCELLED" && (
                                            <div className="flex items-center gap-2 pt-1">
                                                {/* 복귀일이 이미 지난 기간은 다시 복귀 처리할 일이 없다 — 칩이 «복귀함» */}
                                                {p.status === "ACTIVE" && !hasReturned(p, today) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => { setFeedback(null); setReturnTarget(p); }}
                                                        disabled={busyId === p.id}
                                                        className="academy-button-secondary min-h-11"
                                                    >
                                                        복귀 처리
                                                    </button>
                                                )}
                                                {/* 위험 작업은 오른쪽 끝으로 떼어 둔다 */}
                                                <button
                                                    type="button"
                                                    onClick={() => void cancelPeriod(p)}
                                                    disabled={busyId === p.id}
                                                    className="ml-auto academy-button-danger"
                                                >
                                                    등록 취소
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {showCreate && (
                <CreatePeriodModal
                    studentId={studentId}
                    studentName={studentName}
                    activeClasses={activeClasses}
                    onClose={() => setShowCreate(false)}
                    onDone={async (message) => {
                        setShowCreate(false);
                        setFeedback({ type: "success", message });
                        await load();
                    }}
                />
            )}
            {returnTarget && (
                <ReturnModal
                    period={returnTarget}
                    onClose={() => setReturnTarget(null)}
                    onDone={async (message) => {
                        setReturnTarget(null);
                        setFeedback({ type: "success", message });
                        await load();
                    }}
                />
            )}
            {confirmDialog}
        </div>
    );
}

// ── «+ 기간 결석» 모달(모바일은 하단 시트) ──
function CreatePeriodModal({
    studentId,
    studentName,
    activeClasses,
    onClose,
    onDone,
}: {
    studentId: string;
    studentName: string;
    activeClasses: AbsencePeriodClassOption[];
    onClose: () => void;
    onDone: (message: string) => Promise<void>;
}) {
    const [startDate, setStartDate] = useState(todayKst());
    const [returnDate, setReturnDate] = useState("");
    const [reason, setReason] = useState<string>(DEFAULT_PERIOD_REASON);
    const [note, setNote] = useState("");
    // 기본 = 수강 중 반 전부
    const [picked, setPicked] = useState<string[]>(activeClasses.map((c) => c.classId));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function toggle(classId: string) {
        setPicked((prev) => (prev.includes(classId) ? prev.filter((id) => id !== classId) : [...prev, classId]));
    }

    async function submit() {
        if (!startDate) { setError("시작일을 골라 주세요."); return; }
        if (returnDate && returnDate <= startDate) { setError("복귀일은 시작일 다음 날 이후여야 합니다."); return; }
        if (picked.length === 0) { setError("결석할 반을 하나 이상 골라 주세요."); return; }
        setSaving(true);
        setError(null);
        try {
            const result = await createAbsencePeriod({
                studentId,
                startDate,
                returnDate: returnDate || null,
                reason,
                note: note.trim() || null,
                classIds: picked,
            });
            if (!result.ok) { setError(result.message); return; }
            await onDone(result.message);
        } catch {
            setError("기간 결석을 등록하지 못했어요. 잠시 후 다시 해 주세요.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <AdminModal
            titleId="absence-period-create-title"
            layout="side"
            panelClassName="p-5"
            onClose={() => { if (!saving) onClose(); }}
            closeOnBackdrop={!saving}
        >
            <div className="space-y-3">
                <h2 id="absence-period-create-title" className="text-lg font-bold text-[var(--color-academy-ink)]">기간 결석 등록</h2>
                <p className="text-sm text-[var(--color-academy-muted)]">
                    {studentName} · 그 기간 수업일을 결석(확정)으로 남깁니다. 반 자리·셔틀 명단·청구는 그대로이고 알림은 보내지 않아요.
                </p>
                <div className="grid grid-cols-2 gap-3">
                    <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                        시작일
                        <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} className={INPUT_CLASS} data-admin-modal-initial-focus />
                    </label>
                    <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                        복귀일 (비우면 미정)
                        <input type="date" value={returnDate} min={startDate ? addDaysKst(startDate, 1) : undefined} onChange={(e) => setReturnDate(e.target.value)} className={INPUT_CLASS} />
                    </label>
                </div>
                <p className="text-xs text-[var(--color-academy-muted)]">
                    복귀일 = 다시 나오는 첫날(그날은 결석이 아닙니다). 미정이면 다음 달 말일까지 만들고 매일 자동으로 늘립니다.
                </p>
                <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                    사유
                    <select value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT_CLASS}>
                        {VALID_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
                    </select>
                </label>
                <fieldset>
                    <legend className="text-sm font-medium text-[var(--color-academy-ink)]">대상 반</legend>
                    <ul className="mt-1 divide-y divide-[var(--color-academy-line)] rounded-lg border border-[var(--color-academy-line)]">
                        {activeClasses.map((c) => (
                            <li key={c.classId}>
                                <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm">
                                    <input type="checkbox" checked={picked.includes(c.classId)} onChange={() => toggle(c.classId)} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-academy-ink)]">{c.className}</span>
                                    <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">{c.dayLabel} {c.startTime}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                </fieldset>
                <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                    메모 (선택)
                    <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="예: 발목 골절, 깁스 4주" className={INPUT_CLASS} />
                </label>
                {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                <div className="flex items-center gap-3 pt-1">
                    <button type="button" onClick={onClose} disabled={saving} className="academy-button-text min-h-11">그만</button>
                    <button type="button" onClick={() => void submit()} disabled={saving} className="ml-auto academy-button-primary min-h-11">
                        {saving ? "등록하는 중…" : "기간 결석 등록"}
                    </button>
                </div>
            </div>
        </AdminModal>
    );
}

// ── «복귀 처리» 모달 — 복귀일(기본 오늘)부터의 결석을 취소한다 ──
function ReturnModal({
    period,
    onClose,
    onDone,
}: {
    period: AbsencePeriodView;
    onClose: () => void;
    onDone: (message: string) => Promise<void>;
}) {
    const today = todayKst();
    // 기본 오늘. 다만 시작일 다음 날보다 앞일 수는 없다
    const [returnDate, setReturnDate] = useState(period.returnDate ?? (today > period.startDate ? today : ""));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const after = period.absences.filter((a) => a.status !== "CANCELLED" && returnDate && a.date >= returnDate).length;

    async function submit() {
        if (!returnDate || returnDate <= period.startDate) { setError("복귀일은 시작일 다음 날 이후여야 합니다."); return; }
        setSaving(true);
        setError(null);
        try {
            const result = await endAbsencePeriod({ periodId: period.id, returnDate });
            if (!result.ok) { setError(result.message); return; }
            await onDone(result.message);
        } catch {
            setError("복귀 처리를 하지 못했어요. 잠시 후 다시 해 주세요.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <AdminModal
            titleId="absence-period-return-title"
            panelClassName="max-w-sm p-5"
            onClose={() => { if (!saving) onClose(); }}
            closeOnBackdrop={!saving}
        >
            <div className="space-y-3">
                <h2 id="absence-period-return-title" className="text-lg font-bold text-[var(--color-academy-ink)]">복귀 처리</h2>
                <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                    복귀일 (다시 나오는 첫날)
                    <input type="date" required value={returnDate} min={addDaysKst(period.startDate, 1)} onChange={(e) => setReturnDate(e.target.value)} className={INPUT_CLASS} data-admin-modal-initial-focus />
                </label>
                <p className="text-xs text-[var(--color-academy-muted)]">
                    {returnDate ? `이 날부터의 결석 ${after}회를 취소합니다.` : "복귀일을 골라 주세요."} 청구 정산·보강이 잡힌 결석은 남깁니다.
                </p>
                {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                <div className="flex items-center gap-3 pt-1">
                    <button type="button" onClick={onClose} disabled={saving} className="academy-button-text min-h-11">그만</button>
                    <button type="button" onClick={() => void submit()} disabled={saving} className="ml-auto academy-button-primary min-h-11">
                        {saving ? "처리하는 중…" : "복귀 처리"}
                    </button>
                </div>
            </div>
        </AdminModal>
    );
}
