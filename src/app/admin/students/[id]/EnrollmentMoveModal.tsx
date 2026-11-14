"use client";

/**
 * 학생 상세 «수강 반» ⋯ → «반 이동» 창 (2026-11-09 원장 지시)
 *
 * 반 목록은 원생 등록 창과 같은 출처(getStudentRegisterOptions — 대상 학년·정원·시간)와 같은 줄 모양(요일 탭 + 한 줄 행)을 쓴다.
 * 등록 창은 여러 반을 고르지만(주 n회) 여기서는 한 반만 고른다.
 * 저장은 서버 moveEnrollmentToClass — 기존 수강은 적용일로 «수강 종료», 새 반 수강을 같은 조건으로 만든다(한 트랜잭션).
 */
import { useEffect, useMemo, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { getStudentRegisterOptions, type RegisterClassOption } from "@/app/actions/student-register";
import { moveEnrollmentToClass } from "@/app/actions/enrollment-admin-edit";
import { todayKst, toKstYmd } from "@/lib/datetime/kst";
import { moveEffectiveMinYmd } from "@/lib/enrollment/admin-enrollment-edit";
import type { EnrollmentEndCleanupSummary, OpenRequestView } from "@/lib/enrollment/enrollment-end-cleanup";
import { OpenRequestsBox } from "./EnrollmentCleanupNotice";

const DAY_KEYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_LABELS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

export type EnrollmentMoveSource = {
    enrollmentId: string; classId: string; className: string; dayOfWeek: string;
    /** 적용일 하한 계산용 — 개시일(없으면 등록일). 서버 판정과 같은 함수(moveEffectiveMinYmd) */
    startsOn?: string | null; createdAt?: Date | string | null;
};

export default function EnrollmentMoveModal({
    studentName,
    source,
    onClose,
    onMoved,
}: {
    studentName: string;
    source: EnrollmentMoveSource;
    onClose: () => void;
    /** 이동 성공 — 부모가 목록을 다시 읽고 안내를 띄운다(옛 반 결석·보강권 정리 결과·미납 청구 포함) */
    onMoved: (message: string, cleanup: EnrollmentEndCleanupSummary) => void;
}) {
    const [classes, setClasses] = useState<RegisterClassOption[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [dayTab, setDayTab] = useState<string>(source.dayOfWeek);
    const [toClassId, setToClassId] = useState("");
    const [effectiveFrom, setEffectiveFrom] = useState(todayKst());
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 정원 초과 반을 골랐을 때 «그래도 옮기기» 확인 단계
    const [overCapacityAsk, setOverCapacityAsk] = useState<string | null>(null);
    // 처리 중 수강 변경 신청 확인 상자(함께 정리할지 묻기 / 막힘 안내)
    const [openRequests, setOpenRequests] = useState<{ code: "OPEN_REQUESTS" | "BLOCKED_REQUESTS"; message: string; requests: OpenRequestView[] } | null>(null);
    // 정원 확인과 신청 확인을 둘 다 거칠 수 있어, 앞에서 고른 답을 기억해 다음 저장에 같이 보낸다
    const [allowOverCapacityChosen, setAllowOverCapacityChosen] = useState(false);

    useEffect(() => {
        let alive = true;
        getStudentRegisterOptions()
            .then((options) => { if (alive) setClasses(options.classes); })
            .catch(() => { if (alive) setLoadError("반 목록을 불러오지 못했어요. 창을 닫고 다시 열어 주세요."); });
        return () => { alive = false; };
    }, []);

    // 지금 반은 고를 수 없게 뺀다
    const candidates = useMemo(() => (classes ?? []).filter((c) => c.id !== source.classId), [classes, source.classId]);
    const dayClasses = candidates.filter((c) => c.dayOfWeek === dayTab);
    const picked = candidates.find((c) => c.id === toClassId) ?? null;
    // 적용일 하한(기존 수강 시작일) — 서버도 같은 함수로 다시 막는다
    const minDate = moveEffectiveMinYmd(source.startsOn ?? null, source.createdAt ? toKstYmd(source.createdAt) : null, todayKst());

    // closeOpenRequests: 확인 상자에 보여 준 신청 id 목록(서버가 다시 읽은 것과 다르면 다시 묻는다)
    async function submit(allowOverCapacityInput = false, closeOpenRequests?: string[]) {
        const allowOverCapacity = allowOverCapacityInput || allowOverCapacityChosen;
        if (!picked || saving) return;
        if (effectiveFrom > todayKst()) {
            setError("미래 날짜 이동은 «수강 변경 신청»(예약)으로 해 주세요.");
            return;
        }
        if (minDate && effectiveFrom < minDate) {
            setError(`이동 적용일은 기존 수강 시작일(${minDate}) 이후로 골라 주세요.`);
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const result = await moveEnrollmentToClass({ enrollmentId: source.enrollmentId, toClassId: picked.id, effectiveFrom, reason, allowOverCapacity, closeOpenRequests });
            if (result.ok) {
                onMoved(`${source.className} → ${picked.name} 으로 옮겼어요(${effectiveFrom} 적용).`, result.cleanup);
                return;
            }
            if (allowOverCapacity) setAllowOverCapacityChosen(true);
            if (result.code === "OPEN_REQUESTS" || result.code === "BLOCKED_REQUESTS") {
                setOverCapacityAsk(null);
                setOpenRequests({ code: result.code, message: result.message, requests: result.requests });
            } else if (result.code === "OVER_CAPACITY") setOverCapacityAsk(result.message);
            else setError(result.message);
        } catch {
            setError("반 이동에 실패했어요. 잠시 후 다시 해 주세요.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <AdminModal
            titleId="enrollment-move-title"
            panelClassName="max-w-lg p-5"
            onClose={() => { if (!saving) onClose(); }}
            closeOnBackdrop={!saving}
        >
            <div className="space-y-3">
                <h2 id="enrollment-move-title" className="text-lg font-bold text-[var(--color-academy-ink)]">반 이동</h2>
                <p className="text-sm text-[var(--color-academy-muted)]">
                    {studentName} · <b className="text-[var(--color-academy-ink)]">{source.className}</b> → 옮길 반을 고르세요. 지금 반은 적용일로 «수강 종료»됩니다.
                </p>

                {/* 요일 탭 + 한 줄 행 — 원생 등록 창과 같은 모양 */}
                <div role="tablist" aria-label="요일" className="flex gap-1 overflow-x-auto pb-1">
                    {DAY_KEYS.map((day) => {
                        const count = candidates.filter((c) => c.dayOfWeek === day).length;
                        if (count === 0) return null;
                        return (
                            <button
                                key={day}
                                type="button"
                                role="tab"
                                aria-selected={dayTab === day}
                                onClick={() => setDayTab(day)}
                                className={`academy-choice is-tab min-w-11 shrink-0 ${dayTab === day ? "is-selected" : ""}`}
                            >
                                {DAY_LABELS[day]}
                            </button>
                        );
                    })}
                </div>
                {!classes && !loadError && <p className="py-2 text-sm text-[var(--color-academy-muted)]">반 목록을 불러오는 중…</p>}
                {loadError && <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{loadError}</p>}
                <ul className="max-h-72 divide-y divide-[var(--color-academy-line)] overflow-y-auto rounded-lg border border-[var(--color-academy-line)]">
                    {dayClasses.map((c) => {
                        const checked = c.id === toClassId;
                        const full = c.activeCount >= c.capacity;
                        return (
                            <li key={c.id}>
                                <label className={`flex min-h-11 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${checked ? "bg-[var(--color-academy-secondary-soft)]" : "hover:bg-[var(--color-academy-soft)]"}`}>
                                    <input type="radio" name="move-to-class" checked={checked} onChange={() => { setToClassId(c.id); setOverCapacityAsk(null); setOpenRequests(null); setAllowOverCapacityChosen(false); }} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-academy-ink)]">{c.name}</span>
                                    {c.gradeRange && <span className="max-w-[6.5rem] shrink-0 truncate text-xs text-[var(--color-academy-ink)]" title={`대상 ${c.gradeRange}`}>{c.gradeRange}</span>}
                                    <span className="hidden shrink-0 text-xs text-[var(--color-academy-muted)] sm:inline">{c.startTime}~{c.endTime}</span>
                                    <span className={`shrink-0 text-xs tabular-nums ${full ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
                                        {c.activeCount}/{c.capacity}{full ? " 정원" : ""}
                                    </span>
                                </label>
                            </li>
                        );
                    })}
                    {classes && dayClasses.length === 0 && <li className="px-3 py-2 text-sm text-[var(--color-academy-muted)]">이 요일에는 옮길 반이 없습니다.</li>}
                </ul>

                <div className="grid grid-cols-2 gap-3">
                    <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                        이동 적용일
                        <input
                            type="date"
                            required
                            min={minDate ?? undefined}
                            max={todayKst()}
                            value={effectiveFrom}
                            onChange={(event) => setEffectiveFrom(event.target.value)}
                            className="academy-input mt-1"
                        />
                    </label>
                    <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                        사유 (선택)
                        <input
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            className="academy-input mt-1"
                        />
                    </label>
                </div>
                <p className="text-xs text-[var(--color-academy-muted)]">새 반은 적용일부터 출석부·수강료 계산에 들어갑니다(아직 개시 전인 수강이면 원래 개시일을 이어받아요).</p>

                {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
                {overCapacityAsk && (
                    <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">
                        {overCapacityAsk} 그래도 옮기려면 «정원 넘겨 옮기기»를 눌러 주세요.
                    </p>
                )}
                {openRequests && (
                    <OpenRequestsBox
                        code={openRequests.code}
                        message={openRequests.message}
                        requests={openRequests.requests}
                        busy={saving}
                        onConfirm={() => void submit(false, openRequests.requests.map((r) => r.id))}
                    />
                )}
                <div className="flex items-center gap-3 pt-1">
                    <button type="button" onClick={onClose} disabled={saving} className="academy-button-text">그만</button>
                    {overCapacityAsk ? (
                        <button type="button" onClick={() => void submit(true)} disabled={saving || !picked} className="ml-auto academy-button-primary">
                            {saving ? "옮기는 중…" : "정원 넘겨 옮기기"}
                        </button>
                    ) : (
                        <button type="button" onClick={() => void submit(false)} disabled={saving || !picked} className="ml-auto academy-button-primary">
                            {saving ? "옮기는 중…" : picked ? `${picked.name}(으)로 옮기기` : "반을 고르세요"}
                        </button>
                    )}
                </div>
            </div>
        </AdminModal>
    );
}
