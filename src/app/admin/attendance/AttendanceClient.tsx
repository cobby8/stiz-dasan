"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { saveAttendance } from "@/app/actions/admin";
import { todayKst } from "@/lib/datetime/kst";

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

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

const STATUS_OPTIONS = [
    { value: "PRESENT", label: "출석", color: "bg-green-100 text-green-700 border-green-300" },
    { value: "ABSENT", label: "결석", color: "bg-red-100 text-red-700 border-red-300" },
    { value: "LATE", label: "지각", color: "bg-yellow-100 text-yellow-700 border-yellow-300" },
] as const;


function lessonKeyOf(item: ClassItem) {
    return item.lessonKey || `${item.kind === "SEASONAL" ? "seasonal" : "regular"}:${item.sessionDateId || item.id}`;
}

function AttendanceLoadingFallback() {
    return (
        <div className="max-w-4xl mx-auto">
            <div className="mb-6 flex items-center justify-between">
                <div className="space-y-2">
                    <div className="h-8 w-32 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="h-4 w-72 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-10 w-28 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
                    <div className="h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
                </div>
            </div>
        </div>
    );
}

function AttendanceErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-4xl rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">출석 관리 데이터를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700"
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
    }

    function markAll(status: string) {
        setStudents((prev) => prev.map((s) => ({ ...s, status })));
        setSaved(false);
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

    const presentCount = students.filter((s) => s.status === "PRESENT").length;
    const absentCount = students.filter((s) => s.status === "ABSENT").length;
    const lateCount = students.filter((s) => s.status === "LATE").length;

    if (classesLoading && classes.length === 0) {
        return <AttendanceLoadingFallback />;
    }

    if (classesError && classes.length === 0) {
        return <AttendanceErrorState onRetry={loadClasses} />;
    }

    return (
        <div className="max-w-4xl mx-auto">
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">출결 관리</h1>
                </div>
                {/* 수업 리포트 관리 페이지로 이동하는 버튼 */}
                <Link
                    href="/admin/attendance/report"
                    prefetch={false}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold bg-brand-navy-900 text-white hover:bg-gray-800 transition"
                >
                    <span className="material-symbols-outlined text-base">assignment</span>
                    수업 리포트
                </Link>
            </div>

            {/* Selector */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-6 shadow-sm">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">날짜</label>
                        <input
                            type="date"
                            min="2020-01-01" max="2030-12-31"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">반 선택</label>
                        <select
                            value={selectedClass}
                            onChange={(e) => setSelectedClass(e.target.value)}
                            className="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime bg-white dark:bg-gray-800"
                        >
                            <option value="">반을 선택하세요</option>
                            {classes.map((c) => (
                                <option key={lessonKeyOf(c)} value={lessonKeyOf(c)}>
                                    [{c.kind === "SEASONAL" ? "특강" : "정규"}] {c.name} ({DAY_LABELS[c.dayOfWeek] || c.dayOfWeek} {c.startTime}~{c.endTime}) — {c.program?.name}{c.coachName ? ` · ${c.coachName}` : ""}{c.kind === "SEASONAL" ? ` · ${c.studentCount ?? 0}명` : ""}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {/* Attendance Grid */}
            {selectedLesson && (
                <>
                    {loading ? (
                        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
                            불러오는 중...
                        </div>
                    ) : students.length === 0 ? (
                        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
                            이 반에 수강 등록된 원생이 없습니다.
                        </div>
                    ) : (
                        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
                            {/* Header with stats */}
                            <div className="p-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between flex-wrap gap-3">
                                <div className="flex items-center gap-4">
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">수강생 {students.length}명</span>
                                    {presentCount + absentCount + lateCount > 0 && (
                                        <div className="flex gap-2 text-xs">
                                            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-bold">출석 {presentCount}</span>
                                            <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold">결석 {absentCount}</span>
                                            <span className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-bold">지각 {lateCount}</span>
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => markAll("PRESENT")}
                                    className="text-xs text-brand-orange-500 dark:text-brand-neon-lime font-bold hover:underline"
                                >
                                    전체 출석 처리
                                </button>
                            </div>

                            {/* Student list */}
                            <div className="divide-y divide-gray-100">
                                {students.map((s) => (
                                    <div key={s.studentId} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:bg-gray-900 transition-colors">
                                        <span className="font-medium text-gray-900 dark:text-white">{s.studentName}</span>
                                        <div className="flex gap-2">
                                            {STATUS_OPTIONS.map((opt) => (
                                                <button
                                                    key={opt.value}
                                                    onClick={() => setStatus(s.studentId, opt.value)}
                                                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition
                                                        ${s.status === opt.value
                                                            ? opt.color + " ring-2 ring-offset-1 ring-gray-300"
                                                            : "bg-gray-50 dark:bg-gray-900 text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:bg-gray-800"
                                                        }`}
                                                >
                                                    {opt.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Save button */}
                            <div className="p-5 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 flex justify-end gap-3">
                                {saved && (
                                    <span className="text-sm text-green-600 font-medium self-center">저장 완료</span>
                                )}
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-orange-600 transition disabled:opacity-50"
                                >
                                    {saving ? "저장 중..." : "출결 저장"}
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
