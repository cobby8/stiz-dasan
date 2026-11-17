"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import ScopeBackLink from "@/components/navigation/ScopeBackLink";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { profilePhotoUrl } from "@/lib/profilePhoto/rules";

// 수업 기록을 고치는 길은 하나다(2026-11-17 원장 결정 — 이 화면에 있던 «수업 기록» 창을 없앴다).
//   새 기록 = 출결 화면에서 출석을 저장하면 그 반·그 날짜 기록이 만들어진다.
//   고치기 = 리포트 편집 화면(주제·내용·사진·코치·학생별 코멘트·학부모 발행).
// 출결 화면은 반·날짜를 주소로 받지 않아 첫 화면으로 보낸다.
const ATTENDANCE_HREF = "/admin/attendance";
const reportEditHref = (sessionId: string) => `/admin/attendance/report/${encodeURIComponent(sessionId)}`;

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
        /** 프로필 사진 캐시 버전(사진 없으면 null) */
        photoVersion?: string | null;
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
            {/* 오류 안내는 아이콘 없이 글자로(2026-11-13 UI 통일) */}
            <p className="font-semibold text-[var(--color-academy-danger)]">{message}</p>
            <button
                type="button"
                onClick={onRetry}
                className="academy-button-primary mt-4"
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

    const { classData, sessions } = detail;

    // 탭 정의 — 라벨 + 카운트(아이콘 없이 글자로 말한다)
    const tabs: { key: TabKey; label: string; count?: number }[] = [
        { key: "students", label: "학생 명단", count: classData.students.length },
        { key: "sessions", label: "수업 기록", count: sessions.length },
        { key: "attendance", label: "출석 현황" },
    ];

    return (
        <div className="max-w-5xl mx-auto space-y-6">
            {/* ── 상단 헤더: 뒤로가기 + 반 정보 ── */}
            <div className="min-w-0">
                {/* 뒤로가기는 글자 버튼, 제목은 공용 머리말 부품(모양 한 가지) */}
                <ScopeBackLink fallbackHref="/admin/classes" prefetch={false} className="academy-button-text academy-button-sm -ml-2">
                    ← 반 목록으로
                </ScopeBackLink>
                <AdminPageHeader
                    className="mt-1"
                    title={classData.name}
                    description={
                        <>
                            {/* 프로그램명 + 요일/시간 + 수강생 수/정원 */}
                            {classData.programName && <span>{classData.programName} · </span>}
                            {DAY_LABELS[classData.dayOfWeek] || classData.dayOfWeek}요일{" "}
                            <span className="tabular-nums">{classData.startTime}~{classData.endTime}</span>
                            {" · "}
                            <span className="tabular-nums">
                                {classData.students.length}/{classData.capacity}명
                            </span>
                        </>
                    }
                />
            </div>

            {/* ── 요약 카드 3개 ── */}
            <div className="grid grid-cols-3 gap-4">
                {/* 수강생 수 */}
                <div className="bg-white p-4 rounded-2xl shadow-sm border border-[var(--color-academy-line)]">
                    <p className="text-xs text-[var(--color-academy-muted)] mb-1">수강생</p>
                    <p className="text-2xl font-bold tabular-nums text-[var(--color-academy-ink)]">
                        {classData.students.length}
                        <span className="text-sm font-normal text-[var(--color-academy-faint)]">/{classData.capacity}</span>
                    </p>
                </div>
                {/* 수업 횟수 */}
                <div className="bg-white p-4 rounded-2xl shadow-sm border border-[var(--color-academy-line)]">
                    <p className="text-xs text-[var(--color-academy-muted)] mb-1">수업 기록</p>
                    <p className="text-2xl font-bold tabular-nums text-[var(--color-academy-ink)]">{sessions.length}회</p>
                </div>
                {/* 평균 출석률 */}
                <div className="bg-white p-4 rounded-2xl shadow-sm border border-[var(--color-academy-line)]">
                    <p className="text-xs text-[var(--color-academy-muted)] mb-1">평균 출석률</p>
                    <p className="text-2xl font-bold tabular-nums text-[var(--color-academy-ink)]">
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
                                type="button"
                                aria-current={isActive ? "page" : undefined}
                                onClick={() => setActiveTab(tab.key)}
                                // 지금 보는 탭 = 보조 색(하늘색) 밑줄 + 같은 계열 글자. 주 색(네이비)은 누르는 주 버튼에만 쓴다
                                className={`flex min-h-11 items-center gap-2 pb-3 px-1 text-sm border-b-2 transition ${
                                    isActive
                                        ? "border-[var(--color-academy-secondary-strong)] font-semibold text-[var(--color-academy-secondary-ink)]"
                                        : "border-transparent font-medium text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)]"
                                }`}
                            >
                                {tab.label}
                                {/* 카운트 뱃지 */}
                                {tab.count !== undefined && (
                                    <span className={`text-xs font-normal tabular-nums px-1.5 py-0.5 rounded-full ${
                                        isActive ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
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
                {activeTab === "sessions" && <SessionsTab sessions={sessions} />}
                {activeTab === "attendance" && <AttendanceTab sessions={sessions} />}
            </div>
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
                                        className="inline-flex items-center gap-2 font-medium text-[var(--color-academy-ink)] hover:text-[var(--color-academy-primary)] transition"
                                    >
                                        {/* 아이 사진 28px(없으면 이름 첫 글자, 2026-11-14) */}
                                        <ProfileAvatar decorative name={s.studentName} size={28} src={profilePhotoUrl({ kind: "student", id: s.studentId }, s.photoVersion ?? null, true)} />
                                        {s.studentName}
                                    </Link>
                                </td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.gender || "-"}</td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.school || "-"}</td>
                                <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.grade || "-"}</td>
                                <td className="py-3 px-4 tabular-nums text-[var(--color-academy-muted)]">{s.phone || "-"}</td>
                                <td className="py-3 px-4 tabular-nums text-[var(--color-academy-muted)]">{toDateStr(s.enrolledAt)}</td>
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
function SessionsTab({ sessions }: { sessions: SessionRow[] }) {
    return (
        <div className="space-y-4">
            {/* 상단: 새 기록은 출결 화면에서 만든다 — 어디로 가는지 버튼 글자와 안내 한 줄로 알린다 */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-keep text-sm text-[var(--color-academy-muted)]">
                    수업 기록은 출결 화면에서 출석을 저장하면 만들어집니다. 주제·내용·사진은 아래 기록을 눌러 리포트 편집에서 고칩니다.
                </p>
                <Link
                    href={ATTENDANCE_HREF}
                    prefetch={false}
                    className="academy-button-primary academy-button-sm shrink-0"
                >
                    출결 화면에서 기록하기
                </Link>
            </div>

            {sessions.length === 0 ? (
                <div className="bg-white p-8 rounded-2xl shadow-sm border border-[var(--color-academy-line)] text-center">
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
                            // 기록 한 칸 전체가 리포트 편집 화면으로 가는 링크(예전처럼 칸 어디를 눌러도 된다)
                            <Link
                                key={s.id}
                                href={reportEditHref(s.id)}
                                prefetch={false}
                                className="bg-white rounded-2xl shadow-sm border border-[var(--color-academy-line)] p-4 flex gap-4 hover:shadow-md transition"
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
                                {/* 사진 없을 때 — 아이콘 대신 글자로 알린다 */}
                                {!firstPhotoUrl && (
                                    <div className="w-20 h-20 rounded-xl bg-[var(--color-academy-soft)] flex-shrink-0 flex items-center justify-center text-xs text-[var(--color-academy-faint)]">
                                        사진 없음
                                    </div>
                                )}

                                {/* 수업 기록 텍스트 정보 */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-semibold tabular-nums text-[var(--color-academy-ink)]">{toDateStr(s.date)}</span>
                                        {s.coachName && (
                                            <span className="text-xs bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] px-2 py-0.5 rounded-full">
                                                {s.coachName} 코치
                                            </span>
                                        )}
                                    </div>
                                    {/* 수업 주제 */}
                                    {s.topic && (
                                        <p className="text-sm text-[var(--color-academy-muted)] truncate">{s.topic}</p>
                                    )}
                                    {/* 출석률 바 */}
                                    <div className="flex items-center gap-2 mt-2">
                                        <div className="flex-1 bg-[var(--color-academy-soft)] rounded-full h-1.5 max-w-[120px]">
                                            <div
                                                className="bg-[var(--color-academy-success)] rounded-full h-1.5 transition-all"
                                                style={{ width: `${rate}%` }}
                                            />
                                        </div>
                                        <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">
                                            출석 {s.presentCount}/{s.attendanceCount}명 ({rate}%)
                                        </span>
                                    </div>
                                </div>
                                {/* 가는 곳을 글자로 — 칸 전체가 링크라 여기는 모양만 버튼 */}
                                <span className="academy-button-secondary academy-button-sm shrink-0 self-center">
                                    리포트 편집
                                </span>
                            </Link>
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
                                    <td className="py-3 px-4 tabular-nums text-[var(--color-academy-ink)]">{toDateStr(s.date)}</td>
                                    <td className="py-3 px-4 text-[var(--color-academy-muted)]">{s.coachName || "-"}</td>
                                    <td className="py-3 px-4">
                                        <span className="tabular-nums text-[var(--color-academy-success)]">{s.presentCount}명</span>
                                    </td>
                                    <td className="py-3 px-4">
                                        <span className={absentOrLate > 0 ? "tabular-nums text-[var(--color-academy-danger)] font-medium" : "tabular-nums text-[var(--color-academy-faint)]"}>
                                            {absentOrLate}명
                                        </span>
                                    </td>
                                    <td className="py-3 px-4">
                                        {/* 출석률에 따라 색상 변경 */}
                                        <span className={`text-xs tabular-nums px-2 py-0.5 rounded-full ${
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
