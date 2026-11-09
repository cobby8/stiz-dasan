"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { SessionInitialData } from "./SessionLogModal";

const SessionLogModal = dynamic(() => import("./SessionLogModal"), {
    loading: () => null,
});

// 요일 한글 변환 맵
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 날짜를 YYYY-MM-DD 문자열로 변환하는 유틸리티 함수
function toDateStr(d: Date | string | null): string {
    if (!d) return "-";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}

// === 타입 정의 ===

// 반 정보 + 수강생 목록 (getClassWithStudents 반환값)
type ClassData = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    slotKey: string | null;
    programName: string | null;
    programId: string | null;
    students: {
        enrollmentId: string;
        status: string;
        startsOn?: string | null;
        displayStatus?: string;
        enrolledAt: Date | string;
        studentId: string;
        studentName: string;
        phone: string | null;
        school: string | null;
        grade: string | null;
        birthDate: Date | string | null;
        gender: string | null;
    }[];
};

// 수업 기록 (getSessionsByClass 반환값)
type SessionRow = {
    id: string;
    date: Date | string;
    topic: string | null;
    notes: string | null;
    photosJSON: string | null;
    coachId: string | null;
    coachName: string | null;
    attendanceCount: number;
    presentCount: number;
};

// 코치 정보 (getCoaches 반환값)
type Coach = {
    id: string;
    name: string;
    role: string | null;
};

// 탭 종류 — 3개 탭을 타입으로 제한
type TabKey = "students" | "sessions" | "attendance";

// === Props ===
type ClassDetailPayload = {
    classData: ClassData;
    sessions: SessionRow[];
    coaches: Coach[];
};

type Props = {
    classData?: ClassData;
    sessions?: SessionRow[];
    coaches?: Coach[];
    classId?: string;
};

function SymbolIcon({
    name,
    size = 18,
    className = "",
}: {
    name: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={`material-symbols-outlined leading-none ${className}`}
            style={{ fontSize: `${size}px` }}
            aria-hidden="true"
        >
            {name}
        </span>
    );
}

function ClassDetailLoadingSkeleton() {
    return (
        <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-lg bg-[var(--color-academy-soft)] animate-pulse" />
                <div className="flex-1">
                    <div className="h-8 w-48 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                    <div className="mt-2 h-4 w-72 max-w-full rounded bg-[var(--color-academy-soft)] animate-pulse" />
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4 shadow-sm"
                    >
                        <div className="h-4 w-16 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="mt-3 h-8 w-12 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                    </div>
                ))}
            </div>

            <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white shadow-sm">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-4 border-b border-[var(--color-academy-line)] p-4 last:border-b-0">
                        <div className="h-10 w-10 rounded-full bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="min-w-0 flex-1">
                            <div className="h-4 w-32 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                            <div className="mt-2 h-3 w-48 max-w-full rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ClassDetailErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="max-w-5xl mx-auto rounded-2xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
            <SymbolIcon name="error" size={36} className="mx-auto mb-3 text-[var(--color-academy-danger)]" />
            <p className="font-bold text-[var(--color-academy-ink)]">{message}</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-xl bg-[var(--color-academy-primary)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)]"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function ClassDetailClient({
    classData: initialClassData,
    sessions: initialSessions = [],
    coaches: initialCoaches = [],
    classId,
}: Props) {
    const initialDetail = initialClassData
        ? { classData: initialClassData, sessions: initialSessions, coaches: initialCoaches }
        : null;
    const [detail, setDetail] = useState<ClassDetailPayload | null>(initialDetail);
    const [detailLoading, setDetailLoading] = useState(!initialDetail && Boolean(classId));
    const [detailError, setDetailError] = useState<string | null>(
        initialDetail || classId ? null : "반 정보를 불러올 수 없습니다.",
    );
    // 현재 활성 탭 상태 관리
    const [activeTab, setActiveTab] = useState<TabKey>("students");
    // SessionLogModal 표시 여부
    const [showSessionLog, setShowSessionLog] = useState(false);
    // 수정 모드일 때 기존 세션 데이터 (null이면 신규 모드)
    const [editingSession, setEditingSession] = useState<SessionInitialData | null>(null);
    // 세션 상세 로딩 상태
    const [loadingSession, setLoadingSession] = useState(false);

    const loadDetail = useCallback(async () => {
        if (!classId) {
            setDetailLoading(false);
            setDetailError("반 정보를 불러올 수 없습니다.");
            return;
        }

        setDetailLoading(true);
        setDetailError(null);

        try {
            const res = await fetch(`/api/admin/classes/${classId}/detail`, { cache: "no-store" });
            if (!res.ok) throw new Error("반 상세 정보를 불러올 수 없습니다");
            const data = (await res.json()) as ClassDetailPayload;
            setDetail(data);
        } catch {
            setDetailError("반 상세 정보를 불러오지 못했습니다.");
        } finally {
            setDetailLoading(false);
        }
    }, [classId]);

    useEffect(() => {
        if (detail || !classId) return;
        void loadDetail();
    }, [classId, detail, loadDetail]);

    // 수업 기록 추가 (신규 모드)
    const handleAddSession = useCallback(() => {
        setEditingSession(null);
        setShowSessionLog(true);
    }, []);

    // 수업 기록 수정 (수정 모드 — API로 상세 데이터 가져오기)
    const handleEditSession = useCallback(async (sessionId: string) => {
        setLoadingSession(true);
        try {
            const res = await fetch(`/api/admin/session-detail?sessionId=${sessionId}`);
            if (!res.ok) throw new Error("세션 데이터를 불러올 수 없습니다");
            const data = await res.json();
            setEditingSession(data as SessionInitialData);
            setShowSessionLog(true);
        } catch (err) {
            alert("세션 데이터를 불러오는 데 실패했습니다.");
        } finally {
            setLoadingSession(false);
        }
    }, []);

    // 저장 후 콜백 — 전체 페이지 대신 상세 데이터만 새로고침
    const handleSaved = useCallback(() => {
        void loadDetail();
    }, [loadDetail]);

    if (!detail && detailLoading) {
        return <ClassDetailLoadingSkeleton />;
    }

    if (!detail) {
        return (
            <ClassDetailErrorState
                message={detailError ?? "반 상세 정보를 불러오지 못했습니다."}
                onRetry={loadDetail}
            />
        );
    }

    const { classData, sessions, coaches } = detail;

    // 탭 정의 — 아이콘 + 라벨 + 카운트
    const tabs: { key: TabKey; label: string; iconName: string; count?: number }[] = [
        { key: "students", label: "학생 명단", iconName: "groups", count: classData.students.length },
        { key: "sessions", label: "수업 기록", iconName: "menu_book", count: sessions.length },
        { key: "attendance", label: "출석 현황", iconName: "event_available" },
    ];

    return (
        <div className="max-w-5xl mx-auto space-y-6">
            {/* ── 상단 헤더: 뒤로가기 + 반 정보 ── */}
            <div className="flex items-center gap-4">
                <Link href="/admin/classes" prefetch={false} className="p-2 hover:bg-[var(--color-academy-soft)] rounded-lg transition">
                    <SymbolIcon name="arrow_back" size={20} className="text-[var(--color-academy-muted)]" />
                </Link>
                <div className="flex-1">
                    <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">
                        {classData.name}
                    </h1>
                    <p className="text-sm text-[var(--color-academy-muted)]">
                        {/* 프로그램명 + 요일/시간 + 수강생 수/정원 */}
                        {classData.programName && <span>{classData.programName} · </span>}
                        {DAY_LABELS[classData.dayOfWeek] || classData.dayOfWeek}요일{" "}
                        {classData.startTime}~{classData.endTime}
                        {" · "}
                        <span className="font-medium text-[var(--color-academy-muted)]">
                            {classData.students.length}/{classData.capacity}명
                        </span>
                    </p>
                </div>
            </div>

            {/* ── 요약 카드 3개 ── */}
            <div className="grid grid-cols-3 gap-4">
                {/* 수강생 수 */}
                <div className="bg-white p-4 rounded-2xl shadow-sm border border-[var(--color-academy-line)]">
                    <p className="text-xs text-[var(--color-academy-muted)] mb-1">수강생</p>
                    <p className="text-2xl font-extrabold text-[var(--color-academy-ink)]">
                        {classData.students.length}
                        <span className="text-sm font-normal text-[var(--color-academy-faint)]">/{classData.capacity}</span>
                    </p>
                </div>
                {/* 수업 횟수 */}
                <div className="bg-white p-4 rounded-2xl shadow-sm border border-[var(--color-academy-line)]">
                    <p className="text-xs text-[var(--color-academy-muted)] mb-1">수업 기록</p>
                    <p className="text-2xl font-extrabold text-[var(--color-academy-ink)]">{sessions.length}회</p>
                </div>
                {/* 평균 출석률 */}
                <div className="bg-white p-4 rounded-2xl shadow-sm border border-[var(--color-academy-line)]">
                    <p className="text-xs text-[var(--color-academy-muted)] mb-1">평균 출석률</p>
                    <p className="text-2xl font-extrabold text-[var(--color-academy-ink)]">
                        {/* 전체 세션의 출석률 평균 계산 */}
                        {sessions.length > 0
                            ? Math.round(
                                sessions.reduce((sum, s) =>
                                    sum + (s.attendanceCount > 0 ? (s.presentCount / s.attendanceCount) * 100 : 0)
                                , 0) / sessions.length
                              )
                            : 0}%
                    </p>
                </div>
            </div>

            {/* ── 탭 네비게이션 ── */}
            <div className="border-b border-[var(--color-academy-line)]">
                <nav className="flex gap-6">
                    {tabs.map((tab) => {
                        const isActive = activeTab === tab.key;
                        return (
                            <button
                                key={tab.key}
                                onClick={() => setActiveTab(tab.key)}
                                className={`flex items-center gap-2 pb-3 px-1 text-sm font-medium border-b-2 transition ${
                                    isActive
                                        ? "border-[var(--color-academy-primary)] text-[var(--color-academy-ink)]"
                                        : "border-transparent text-[var(--color-academy-muted)] hover:text-[var(--color-academy-muted)]"
                                }`}
                            >
                                <SymbolIcon name={tab.iconName} size={16} />
                                {tab.label}
                                {/* 카운트 뱃지 */}
                                {tab.count !== undefined && (
                                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                                        isActive ? "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
                                    }`}>
                                        {tab.count}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </nav>
            </div>

            {/* ── 탭 콘텐츠 ── */}
            <div>
                {activeTab === "students" && <StudentsTab students={classData.students} />}
                {activeTab === "sessions" && (
                    <SessionsTab
                        sessions={sessions}
                        onAddSession={handleAddSession}
                        onEditSession={handleEditSession}
                        loadingSession={loadingSession}
                    />
                )}
                {activeTab === "attendance" && <AttendanceTab sessions={sessions} />}
            </div>

            {/* 수업 기록 모달 (신규/수정 모드) */}
            {showSessionLog && (
                <SessionLogModal
                    isOpen={showSessionLog}
                    onClose={() => {
                        setShowSessionLog(false);
                        setEditingSession(null);
                    }}
                    classId={classData.id}
                    initialData={editingSession ?? undefined}
                    coaches={coaches.map((c) => ({ id: c.id, name: c.name }))}
                    students={classData.students.map((s) => ({
                        id: s.studentId,
                        name: s.studentName,
                        gender: s.gender,
                        startsOn: s.startsOn,
                    }))}
                    onSaved={handleSaved}
                />
            )}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// 학생 명단 탭
// ────────────────────────────────────────────────────────────────────────────
function StudentsTab({ students }: { students: ClassData["students"] }) {
    if (students.length === 0) {
        return (
            <div className="bg-white p-8 rounded-2xl shadow-sm border border-[var(--color-academy-line)] text-center">
                <SymbolIcon name="groups" size={40} className="mx-auto mb-3 text-[var(--color-academy-faint)]" />
                <p className="text-[var(--color-academy-muted)]">등록된 수강생이 없습니다</p>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-[var(--color-academy-line)] overflow-hidden">
            <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead>
                        <tr className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]">
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">이름</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">성별</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">학교</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">학년</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">연락처</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">등록일</th>
                        </tr>
                    </thead>
                    <tbody>
                        {students.map((s) => (
                            <tr key={s.enrollmentId} className="border-b border-[var(--color-academy-line)] hover:bg-[var(--color-academy-line)] transition">
                                {/* 학생 이름 — 클릭하면 학생 상세 페이지로 이동 */}
                                <td className="py-3 px-4">
                                    <Link
                                        href={`/admin/students/${s.studentId}`}
                                        prefetch={false}
                                        className="font-medium text-[var(--color-academy-ink)] hover:text-[var(--color-academy-ink)] transition"
                                    >
                                        {s.studentName}
                                    </Link>
                                </td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.gender || "-"}</td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.school || "-"}</td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.grade || "-"}</td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.phone || "-"}</td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{toDateStr(s.enrolledAt)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// 수업 기록 탭
// ────────────────────────────────────────────────────────────────────────────
function SessionsTab({ sessions, onAddSession, onEditSession, loadingSession }: {
    sessions: SessionRow[];
    onAddSession: () => void;
    onEditSession: (sessionId: string) => void;
    loadingSession: boolean;
}) {
    return (
        <div className="space-y-4">
            {/* 상단: 수업 기록 추가 버튼 */}
            <div className="flex justify-end">
                <button
                    onClick={onAddSession}
                    className="flex items-center gap-2 bg-[var(--color-academy-primary)] text-white px-4 py-2 rounded-xl font-bold text-sm hover:bg-[var(--color-academy-primary-hover)] transition"
                >
                    <SymbolIcon name="add" size={16} />
                    수업 기록 추가
                </button>
            </div>

            {sessions.length === 0 ? (
                <div className="bg-white p-8 rounded-2xl shadow-sm border border-[var(--color-academy-line)] text-center">
                    <SymbolIcon name="menu_book" size={40} className="mx-auto mb-3 text-[var(--color-academy-faint)]" />
                    <p className="text-[var(--color-academy-muted)]">수업 기록이 없습니다</p>
                </div>
            ) : (
                <div className="grid gap-3">
                    {sessions.map((s) => {
                        // 출석률 계산: (출석 인원 / 전체 출석 기록) * 100
                        const rate = s.attendanceCount > 0
                            ? Math.round((s.presentCount / s.attendanceCount) * 100)
                            : 0;

                        // photosJSON 파싱하여 첫 번째 사진 URL 추출
                        let firstPhotoUrl: string | null = null;
                        if (s.photosJSON) {
                            try {
                                const photos = JSON.parse(s.photosJSON);
                                if (Array.isArray(photos) && photos.length > 0) {
                                    // photos가 문자열 배열이면 첫 번째 요소, 객체 배열이면 url 프로퍼티
                                    firstPhotoUrl = typeof photos[0] === "string" ? photos[0] : photos[0]?.url ?? null;
                                }
                            } catch {
                                // JSON 파싱 실패 시 무시
                            }
                        }

                        return (
                            <div
                                key={s.id}
                                onClick={() => onEditSession(s.id)}
                                className={`bg-white rounded-2xl shadow-sm border border-[var(--color-academy-line)] p-4 flex gap-4 hover:shadow-md transition cursor-pointer ${
                                    loadingSession ? "opacity-50 pointer-events-none" : ""
                                }`}
                            >
                                {/* 사진 썸네일 — 사진이 있을 때만 표시 */}
                                {firstPhotoUrl && (
                                    <div className="w-20 h-20 rounded-xl overflow-hidden bg-[var(--color-academy-soft)] flex-shrink-0">
                                        <img
                                            src={firstPhotoUrl}
                                            alt="수업 사진"
                                            className="w-full h-full object-cover"
                                        />
                                    </div>
                                )}
                                {/* 사진 없을 때 아이콘 placeholder */}
                                {!firstPhotoUrl && (
                                    <div className="w-20 h-20 rounded-xl bg-[var(--color-academy-soft)] flex-shrink-0 flex items-center justify-center">
                                        <SymbolIcon name="photo_camera" size={24} className="text-[var(--color-academy-faint)]" />
                                    </div>
                                )}

                                {/* 수업 기록 텍스트 정보 */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-bold text-[var(--color-academy-ink)]">{toDateStr(s.date)}</span>
                                        {s.coachName && (
                                            <span className="text-xs bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] px-2 py-0.5 rounded-full">
                                                {s.coachName} 코치
                                            </span>
                                        )}
                                    </div>
                                    {/* 수업 주제 */}
                                    {s.topic && (
                                        <p className="text-sm text-[var(--color-academy-muted)] font-medium truncate">{s.topic}</p>
                                    )}
                                    {/* 출석률 바 */}
                                    <div className="flex items-center gap-2 mt-2">
                                        <div className="flex-1 bg-[var(--color-academy-soft)] rounded-full h-1.5 max-w-[120px]">
                                            <div
                                                className="bg-[var(--color-academy-success)] rounded-full h-1.5 transition-all"
                                                style={{ width: `${rate}%` }}
                                            />
                                        </div>
                                        <span className="text-xs text-[var(--color-academy-muted)]">
                                            출석 {s.presentCount}/{s.attendanceCount}명 ({rate}%)
                                        </span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// 출석 현황 탭 — 각 세션별 출석 요약 목록
// ────────────────────────────────────────────────────────────────────────────
function AttendanceTab({ sessions }: { sessions: SessionRow[] }) {
    if (sessions.length === 0) {
        return (
            <div className="bg-white p-8 rounded-2xl shadow-sm border border-[var(--color-academy-line)] text-center">
                <SymbolIcon name="event_available" size={40} className="mx-auto mb-3 text-[var(--color-academy-faint)]" />
                <p className="text-[var(--color-academy-muted)]">출석 기록이 없습니다</p>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-[var(--color-academy-line)] overflow-hidden">
            <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead>
                        <tr className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]">
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">날짜</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">코치</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">출석</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">결석/지각</th>
                            <th className="text-left py-3 px-4 text-xs text-[var(--color-academy-muted)] font-medium">출석률</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sessions.map((s) => {
                            // 출석률 계산
                            const rate = s.attendanceCount > 0
                                ? Math.round((s.presentCount / s.attendanceCount) * 100)
                                : 0;
                            // 결석/지각 수 = 전체 출석 기록 - 출석 인원
                            const absentOrLate = s.attendanceCount - s.presentCount;

                            return (
                                <tr key={s.id} className="border-b border-[var(--color-academy-line)] hover:bg-[var(--color-academy-line)] transition">
                                    <td className="py-3 px-4 font-medium text-[var(--color-academy-ink)]">{toDateStr(s.date)}</td>
                                    <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.coachName || "-"}</td>
                                    <td className="py-3 px-4">
                                        <span className="text-[var(--color-academy-success)] font-medium">{s.presentCount}명</span>
                                    </td>
                                    <td className="py-3 px-4">
                                        <span className={absentOrLate > 0 ? "text-[var(--color-academy-danger)] font-medium" : "text-[var(--color-academy-faint)]"}>
                                            {absentOrLate}명
                                        </span>
                                    </td>
                                    <td className="py-3 px-4">
                                        {/* 출석률에 따라 색상 변경 */}
                                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                            rate >= 80
                                                ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                                                : rate >= 50
                                                    ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"
                                                    : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                                        }`}>
                                            {rate}%
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
