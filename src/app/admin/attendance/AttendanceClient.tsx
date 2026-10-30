"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { saveAttendance } from "@/app/actions/admin";
import { kstLabel, todayKst } from "@/lib/datetime/kst";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";

type ClassItem = {
    id: string;
    lessonKey?: string;
    kind?: "REGULAR" | "SEASONAL";
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    location?: string | null;
    sessionDateId?: string | null;
    sessionId?: string | null;
    sessionStatus?: string | null;
    studentCount?: number;
    coachName?: string | null;
    program: { id: string; name: string } | null;
};

type StudentRecord = {
    studentId: string;
    studentName: string;
    status: string | null;
    attendanceId: string | null;
};

type AttendanceClassesPayload = {
    classes: ClassItem[];
};

// 출결 버튼 색: 하드코딩 색 대신 학원 테마 토큰(출석=초록, 결석=빨강, 지각=주황)
const STATUS_OPTIONS = [
    { value: "PRESENT", label: "출석", color: "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    { value: "ABSENT", label: "결석", color: "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
    { value: "LATE", label: "지각", color: "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
] as const;

// 수업 목록의 «구분» 칩(정규/특강). 이미 받아오는 kind 값만으로 센다(새 데이터 없음)
const KIND_ALL = "ALL";
const KIND_CHIPS = [
    { value: "REGULAR", label: "정규" },
    { value: "SEASONAL", label: "특강" },
] as const;

function lessonKeyOf(item: ClassItem) {
    return item.lessonKey || `${item.kind === "SEASONAL" ? "seasonal" : "regular"}:${item.sessionDateId || item.id}`;
}

function kindOf(item: ClassItem) {
    return item.kind === "SEASONAL" ? "SEASONAL" : "REGULAR";
}

// 정규/특강 표시 배지(목록 행과 패널 머리에서 같은 모양)
function KindBadge({ item }: { item: ClassItem }) {
    const isSeasonal = item.kind === "SEASONAL";
    return (
        <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${isSeasonal
            ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"
            : "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]"}`}
        >
            {isSeasonal ? "특강" : "정규"}
        </span>
    );
}

function AttendanceLoadingFallback() {
    return (
        <div className="max-w-4xl mx-auto">
            <div className="mb-3 flex items-center justify-between">
                <div className="h-8 w-32 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                <div className="h-11 w-28 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="h-11 animate-pulse border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] last:border-b-0" />
                ))}
            </div>
        </div>
    );
}

function AttendanceErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-4xl rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-4 text-center">
            <p className="text-sm font-bold text-[var(--color-academy-danger)]">출석 관리 데이터를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-3 min-h-11 rounded-lg bg-[var(--color-academy-danger)] px-4 text-sm font-bold text-white"
            >
                다시 불러오기
            </button>
        </div>
    );
}

export default function AttendanceClient({ classes: initialClasses }: { classes?: ClassItem[] }) {
    const hasInitialClasses = initialClasses !== undefined;
    const [classes, setClasses] = useState<ClassItem[]>(initialClasses ?? []);
    const [classesLoading, setClassesLoading] = useState(!hasInitialClasses);
    const [classesError, setClassesError] = useState(false);
    const [selectedClass, setSelectedClass] = useState("");
    // 한국 날짜 기준 "오늘" — UTC 로 구하면 KST 00~09시에 어제가 기본값이 된다(결석일·보강권 날짜가 하루 어긋남)
    const [date, setDate] = useState(todayKst());
    const [students, setStudents] = useState<StudentRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    // 저장하지 않은 출결 변경이 있는지(패널을 실수로 닫아 입력이 사라지지 않게 막는 데만 쓴다)
    const [dirty, setDirty] = useState(false);
    // 수업 목록 «구분» 칩 선택값(전체/정규/특강)
    const [kindFilter, setKindFilter] = useState<string>(KIND_ALL);

    const loadClasses = useCallback(async (targetDate = date) => {
        setClassesLoading(true);
        setClassesError(false);
        try {
            const response = await fetch(`/api/admin/attendance?date=${encodeURIComponent(targetDate)}`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load classes.");
            }
            const data = (await response.json()) as AttendanceClassesPayload;
            setClasses(data.classes);
        } catch (error) {
            console.error("Failed to load attendance classes:", error);
            setClassesError(true);
        } finally {
            setClassesLoading(false);
        }
    }, [date]);

    useEffect(() => {
        void loadClasses(date);
    }, [date, loadClasses]);

    useEffect(() => {
        if (!selectedClass) return;
        if (classes.some((item) => lessonKeyOf(item) === selectedClass)) return;
        setSelectedClass("");
        setStudents([]);
    }, [classes, selectedClass]);

    const selectedLesson = classes.find((item) => lessonKeyOf(item) === selectedClass) ?? null;

    const loadAttendance = useCallback(async (options?: { resetSaved?: boolean }) => {
        if (!selectedLesson || !date) return;
        setLoading(true);
        if (options?.resetSaved !== false) {
            setSaved(false);
        }
        try {
            const params = new URLSearchParams({ classId: selectedLesson.id, date });
            if (selectedLesson.sessionDateId) params.set("sessionDateId", selectedLesson.sessionDateId);
            const res = await fetch(`/api/admin/attendance?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                setStudents(data.students || []);
                // 서버 값으로 새로 채웠으니 «저장 안 한 변경» 없음
                setDirty(false);
            }
        } catch {
            setStudents([]);
        } finally {
            setLoading(false);
        }
    }, [date, selectedLesson]);

    useEffect(() => {
        loadAttendance();
    }, [loadAttendance]);

    function setStatus(studentId: string, status: string) {
        setStudents((prev) =>
            prev.map((s) =>
                s.studentId === studentId ? { ...s, status } : s
            )
        );
        setSaved(false);
        setDirty(true);
    }

    function markAll(status: string) {
        setStudents((prev) => prev.map((s) => ({ ...s, status })));
        setSaved(false);
        setDirty(true);
    }

    async function handleSave() {
        if (!selectedLesson || !date) return;
        const records = students
            .filter((s) => s.status)
            .map((s) => ({ studentId: s.studentId, status: s.status! }));
        if (records.length === 0) {
            alert("출결 상태를 선택해주세요.");
            return;
        }
        setSaving(true);
        try {
            await saveAttendance(selectedLesson.id, date, records, { sessionDateId: selectedLesson.sessionDateId });
            await loadAttendance({ resetSaved: false });
            setSaved(true);
        } catch (err: any) {
            alert(err.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    }

    // 행 클릭 → 그 수업의 출결 입력 패널을 연다(예전 «반 선택» 드롭다운과 같은 상태 selectedClass 를 쓴다)
    function openLesson(key: string) {
        if (key === selectedClass) return;
        setStudents([]);
        setDirty(false);
        setSelectedClass(key);
    }

    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, key: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openLesson(key);
        }
    }

    // 패널 닫기: 저장 안 한 변경이 있으면 한 번 묻는다(바깥 클릭은 아예 막아 둠)
    function closeLesson() {
        if (dirty && !window.confirm("저장하지 않은 출결이 있습니다. 닫을까요?")) return;
        setSelectedClass("");
        setStudents([]);
        setDirty(false);
        setSaved(false);
    }

    // 수업 목록: 시작 시간 → 반 이름 순(정규·특강을 한 목록에 시간표처럼)
    const sortedLessons = useMemo(
        () => [...classes].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name, "ko")),
        [classes],
    );
    const visibleLessons = kindFilter === KIND_ALL
        ? sortedLessons
        : sortedLessons.filter((item) => kindOf(item) === kindFilter);
    const kindChipItems = KIND_CHIPS.map((chip) => ({
        value: chip.value,
        label: chip.label,
        count: classes.filter((item) => kindOf(item) === chip.value).length,
    }));

    const presentCount = students.filter((s) => s.status === "PRESENT").length;
    const absentCount = students.filter((s) => s.status === "ABSENT").length;
    const lateCount = students.filter((s) => s.status === "LATE").length;
    const unmarkedCount = students.length - presentCount - absentCount - lateCount;

    if (classesLoading && classes.length === 0) {
        return <AttendanceLoadingFallback />;
    }

    if (classesError && classes.length === 0) {
        return <AttendanceErrorState onRetry={loadClasses} />;
    }

    return (
        <div className="max-w-4xl mx-auto">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">출결 관리</h1>
                {/* 수업 리포트 관리 페이지로 이동하는 버튼 */}
                <Link
                    href="/admin/attendance/report"
                    prefetch={false}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] transition hover:bg-[var(--color-academy-primary-hover)]"
                >
                    <span className="material-symbols-outlined text-base" aria-hidden="true">assignment</span>
                    수업 리포트
                </Link>
            </div>

            {/* 날짜 + 구분 칩(정규/특강 건수 — 누르면 그 구분만, 다시 누르면 전체) */}
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm font-bold text-[var(--color-academy-ink)]">
                    날짜
                    <input
                        type="date"
                        min="2020-01-01" max="2030-12-31"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    />
                </label>
                {/* 요일 표시는 KST 달력 기준(kstLabel → «10/30(목)») */}
                <span className="text-sm tabular-nums text-[var(--color-academy-muted)]">{kstLabel(date)}</span>
                <StatusCountChips
                    ariaLabel="수업 구분별 건수"
                    items={kindChipItems}
                    selected={kindFilter}
                    onSelect={setKindFilter}
                    allValue={KIND_ALL}
                />
                <span className="ml-auto text-sm text-[var(--color-academy-muted)]">
                    {classesLoading ? "불러오는 중..." : <>수업 <span className="tabular-nums">{visibleLessons.length}</span>개</>}
                </span>
            </div>

            {/* 그날 수업 목록 — 한 줄 행, 행을 누르면 그 반 출결 입력 패널 */}
            {visibleLessons.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    {classesError ? "수업 목록을 다시 불러오지 못했습니다." : "이 날짜에 수업이 없습니다."}
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                    <div className="overflow-x-auto">
                        {/* admin-list-table: 글자 왼쪽·시간/인원 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="admin-cell-num px-2 py-2">시간</th>
                                    <th className="px-2 py-2">반</th>
                                    <th className="px-2 py-2">구분</th>
                                    <th className="hidden px-2 py-2 md:table-cell">프로그램</th>
                                    <th className="hidden px-2 py-2 md:table-cell">코치</th>
                                    <th className="admin-cell-num px-2 py-2">인원</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--color-academy-line)]">
                                {visibleLessons.map((c) => {
                                    const key = lessonKeyOf(c);
                                    const active = key === selectedClass;
                                    return (
                                        <tr
                                            key={key}
                                            tabIndex={0}
                                            aria-label={`${c.name} ${c.startTime} 출결 입력`}
                                            onClick={() => openLesson(key)}
                                            onKeyDown={(event) => handleRowKeyDown(event, key)}
                                            className={`cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none ${active ? "bg-[var(--color-academy-primary-soft)]" : ""}`}
                                        >
                                            {/* 시간: «16:00~17:00» 오른쪽 정렬 */}
                                            <td className="admin-cell-num px-2 py-2.5 text-[var(--color-academy-ink)]">{c.startTime}~{c.endTime}</td>
                                            <td className="px-2 py-2.5 font-bold text-[var(--color-academy-ink)]">{c.name}</td>
                                            <td className="px-2 py-2.5"><KindBadge item={c} /></td>
                                            <td className="hidden px-2 py-2.5 text-[var(--color-academy-muted)] md:table-cell">{c.program?.name || "-"}</td>
                                            <td className="hidden px-2 py-2.5 text-[var(--color-academy-muted)] md:table-cell">{c.coachName || "-"}</td>
                                            {/* 인원: 특강만 서버가 세어 준다(정규는 값이 없어 «-»). 정규 인원은 패널의 «수강생 N명» */}
                                            <td className="admin-cell-num px-2 py-2.5 text-[var(--color-academy-ink)]">{c.kind === "SEASONAL" ? `${c.studentCount ?? 0}명` : "-"}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* 출결 입력 패널 — 데스크톱 오른쪽 패널 / 모바일 하단 시트.
                불러오기·전체 출석·저장 흐름은 예전 화면 아래 영역과 같다. 저장 안 한 변경이 있으면 바깥 클릭으로 닫히지 않는다 */}
            {selectedLesson && (
                <ListDetailPanel
                    onClose={closeLesson}
                    titleId="attendance-lesson-panel-title"
                    closeOnBackdrop={!dirty}
                >
                    <div className="border-b border-[var(--color-academy-line)] p-4 pb-3">
                        <div className="flex items-center gap-2">
                            <h3 id="attendance-lesson-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{selectedLesson.name}</h3>
                            <KindBadge item={selectedLesson} />
                            <button
                                type="button"
                                onClick={closeLesson}
                                aria-label="닫기"
                                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">close</span>
                            </button>
                        </div>
                        {/* 수업 정보: 긴 프로그램·장소 이름도 말줄임 없이(줄바꿈 허용) */}
                        <dl className="mt-1 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                            <dt className="font-bold text-[var(--color-academy-muted)]">일시</dt>
                            <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(date)} {selectedLesson.startTime}~{selectedLesson.endTime}</dd>
                            {selectedLesson.program?.name && (
                                <>
                                    <dt className="font-bold text-[var(--color-academy-muted)]">프로그램</dt>
                                    <dd className="break-keep text-[var(--color-academy-ink)]">{selectedLesson.program.name}</dd>
                                </>
                            )}
                            {selectedLesson.coachName && (
                                <>
                                    <dt className="font-bold text-[var(--color-academy-muted)]">코치</dt>
                                    <dd className="text-[var(--color-academy-ink)]">{selectedLesson.coachName}</dd>
                                </>
                            )}
                            {selectedLesson.location && (
                                <>
                                    <dt className="font-bold text-[var(--color-academy-muted)]">장소</dt>
                                    <dd className="break-keep text-[var(--color-academy-ink)]">{selectedLesson.location}</dd>
                                </>
                            )}
                        </dl>
                    </div>

                    {loading ? (
                        <p className="p-4 text-center text-sm text-[var(--color-academy-muted)]">불러오는 중...</p>
                    ) : students.length === 0 ? (
                        <p className="p-4 text-center text-sm text-[var(--color-academy-muted)]">이 반에 수강 등록된 원생이 없습니다.</p>
                    ) : (
                        <>
                            {/* 집계 줄: 수강생 수 + 출석/결석/지각/미입력 건수 + 전체 출석 처리 */}
                            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 text-xs font-bold">
                                <span className="mr-1 text-sm text-[var(--color-academy-ink)]">수강생 <span className="tabular-nums">{students.length}</span>명</span>
                                <span className="rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-[var(--color-academy-success)]">출석 <span className="tabular-nums">{presentCount}</span></span>
                                <span className="rounded-full bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-[var(--color-academy-danger)]">결석 <span className="tabular-nums">{absentCount}</span></span>
                                <span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-[var(--color-academy-warning)]">지각 <span className="tabular-nums">{lateCount}</span></span>
                                {unmarkedCount > 0 && (
                                    <span className="rounded-full bg-[var(--color-academy-soft)] px-2 py-0.5 text-[var(--color-academy-muted)]">미입력 <span className="tabular-nums">{unmarkedCount}</span></span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => markAll("PRESENT")}
                                    className="ml-auto inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-bold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-soft)]"
                                >
                                    전체 출석 처리
                                </button>
                            </div>

                            {/* 학생 한 줄 행: 이름 왼쪽 · 출석/결석/지각 버튼 오른쪽(44px) */}
                            <ul className="flex-1 divide-y divide-[var(--color-academy-line)] border-y border-[var(--color-academy-line)]">
                                {students.map((s) => (
                                    <li key={s.studentId} className="flex items-center justify-between gap-2 px-4 py-1">
                                        <span className="min-w-0 break-keep font-bold text-[var(--color-academy-ink)]">{s.studentName}</span>
                                        <div className="flex shrink-0 gap-1" role="group" aria-label={`${s.studentName} 출결`}>
                                            {STATUS_OPTIONS.map((opt) => {
                                                const on = s.status === opt.value;
                                                return (
                                                    <button
                                                        key={opt.value}
                                                        type="button"
                                                        aria-pressed={on}
                                                        onClick={() => setStatus(s.studentId, opt.value)}
                                                        className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm font-bold transition ${on
                                                            ? opt.color
                                                            : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                                                        }`}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </li>
                                ))}
                            </ul>

                            {/* 저장: 패널 아래에 붙여 학생이 많아도 바로 누를 수 있게 */}
                            <div className="sticky bottom-0 flex items-center justify-end gap-3 bg-[var(--color-academy-surface)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                                {saved && (
                                    <span className="text-sm font-bold text-[var(--color-academy-success)]">저장 완료</span>
                                )}
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="min-h-11 rounded-lg bg-[var(--color-academy-primary)] px-6 font-bold text-[var(--color-academy-on-primary)] transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50"
                                >
                                    {saving ? "저장 중..." : "출결 저장"}
                                </button>
                            </div>
                        </>
                    )}
                </ListDetailPanel>
            )}
        </div>
    );
}
