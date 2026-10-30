"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
    saveSessionReport,
    publishSessionReport,
    saveStudentSessionNotes,
} from "@/app/actions/admin";
// 사진 항목은 구버전(URL 문자열)과 선생님 앱이 저장한 객체가 섞여 있어 전용 파서를 씁니다.
import {
    appendSessionPhotoUrls,
    removeSessionPhotoEntryAt,
    toSessionReportPhotoViews,
} from "@/lib/sessionPhotoEntries";
import { compressImageForUpload } from "@/lib/clientImageCompression";

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

type AttendanceRecord = {
    id: string;
    studentId: string;
    status: string;
    studentName: string;
};

type NoteRecord = {
    id: string;
    studentId: string;
    note: string;
    rating: number | null;
    studentName: string;
};

type ReportData = {
    id: string;
    classId: string;
    date: string;
    topic: string | null;
    content: string | null;
    photosJSON: string | null;
    coachId: string | null;
    coachName: string | null;
    published: boolean;
    publishedAt: string | null;
    className: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    programName: string | null;
    attendances: AttendanceRecord[];
    notes: NoteRecord[];
};

type Coach = {
    id: string;
    name: string;
    role: string;
};

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 출석 상태 라벨/색상
const STATUS_MAP: Record<string, { label: string; color: string }> = {
    PRESENT: { label: "출석", color: "bg-green-100 text-green-700" },
    ABSENT: { label: "결석", color: "bg-red-100 text-red-700" },
    LATE: { label: "지각", color: "bg-yellow-100 text-yellow-700" },
};

type ReportPayload = {
    report: ReportData | null;
    coaches: Coach[];
};

function ReportEditLoadingFallback() {
    return (
        <div className="mx-auto max-w-4xl">
            <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                    <div className="h-5 w-28 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                    <div className="mt-3 h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-8 w-24 animate-pulse rounded-full bg-gray-100 dark:bg-gray-800" />
            </div>

            <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="h-7 w-32 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-5 space-y-4">
                    <div className="h-11 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                    <div className="h-11 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                    <div className="h-28 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                    <div className="h-10 w-32 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                </div>
            </div>

            <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="border-b border-gray-100 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900/50">
                    <div className="h-7 w-56 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-3 w-80 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    {Array.from({ length: 5 }).map((_, index) => (
                        <div key={index} className="px-5 py-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="h-5 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                <div className="h-6 w-14 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                            </div>
                            <div className="mb-3 h-5 w-32 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                            <div className="h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="h-10 w-32 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
                <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
            </div>
        </div>
    );
}

function ReportEditErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-4xl rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">수업 리포트 정보를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="academy-button-secondary mt-4"
            >
                다시 불러오기
            </button>
        </div>
    );
}

export default function ReportEditClient({
    report: initialReport,
    coaches: initialCoaches,
    sessionId,
}: {
    report?: ReportData | null;
    coaches?: Coach[];
    sessionId?: string;
}) {
    const hasInitialData = initialReport !== undefined && initialCoaches !== undefined;
    const [report, setReport] = useState<ReportData | null>(initialReport ?? null);
    const [coaches, setCoaches] = useState<Coach[]>(initialCoaches ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);

    const loadReport = useCallback(async () => {
        if (!sessionId) {
            setLoadError(true);
            setLoading(false);
            return;
        }

        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch(`/api/admin/attendance/report/${sessionId}`, { cache: "no-store" });
            if (!response.ok) throw new Error("Failed to load report.");
            const data = (await response.json()) as ReportPayload;
            setReport(data.report);
            setCoaches(data.coaches);
            setLoadError(!data.report);
        } catch (error) {
            console.error("Failed to load report:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, [sessionId]);

    useEffect(() => {
        if (hasInitialData) return;
        void loadReport();
    }, [hasInitialData, loadReport]);

    if (loading && !report) {
        return <ReportEditLoadingFallback />;
    }

    if (loadError || !report) {
        return <ReportEditErrorState onRetry={loadReport} />;
    }

    return <ReportEditForm report={report} coaches={coaches} />;
}

function ReportEditForm({
    report,
    coaches,
}: {
    report: ReportData;
    coaches: Coach[];
}) {

    // ── 리포트 기본 정보 상태 ──
    const [topic, setTopic] = useState(report.topic || "");
    const [content, setContent] = useState(report.content || "");
    const [coachId, setCoachId] = useState(report.coachId || "");
    const [photosJSON, setPhotosJSON] = useState(report.photosJSON || "[]");
    const [published, setPublished] = useState(report.published);

    // ── 학생별 노트 상태 (출석 목록 기반으로 초기화) ──
    // 기존 노트를 studentId로 빠르게 찾기 위한 맵
    const noteMap = new Map(report.notes.map((n) => [n.studentId, n]));
    const [studentNotes, setStudentNotes] = useState<
        Record<string, { note: string; rating: number | null }>
    >(() => {
        const initial: Record<string, { note: string; rating: number | null }> = {};
        for (const a of report.attendances) {
            const existing = noteMap.get(a.studentId);
            initial[a.studentId] = {
                note: existing?.note || "",
                rating: existing?.rating ?? null,
            };
        }
        return initial;
    });

    // ── 저장 상태 ──
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [publishing, setPublishing] = useState(false);

    // ── 사진 상태 ──
    // photosJSON에는 URL 문자열과 선생님 앱이 저장한 사진 객체가 섞여 있습니다.
    // 비공개 사진은 권한 검사를 거치는 프록시 경로(/api/staff/sessions/.../photos/...)로만 보입니다.
    const photos = toSessionReportPhotoViews(photosJSON, report.id);
    const [uploading, setUploading] = useState(false);
    const [photoError, setPhotoError] = useState<string | null>(null);
    // 불러오기에 실패한 사진 위치 — 빈 src로 되돌리는 대신 자리표시자를 보여주기 위함
    const [brokenPhotoIndexes, setBrokenPhotoIndexes] = useState<number[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 사진 업로드 (수업 기록 모달과 동일하게 /api/upload → class-logs 폴더 사용)
    const uploadPhotos = useCallback(async (files: FileList) => {
        setUploading(true);
        setPhotoError(null);
        try {
            const uploadedUrls: string[] = [];
            // 서버 부하를 줄이기 위해 한 장씩 순차 업로드합니다.
            for (const file of Array.from(files)) {
                const compressed = await compressImageForUpload(file);
                const formData = new FormData();
                formData.append("file", compressed);
                formData.append("folder", "class-logs");

                const res = await fetch("/api/upload", { method: "POST", body: formData });
                if (!res.ok) throw new Error(`사진 업로드 실패: ${file.name}`);

                const data = await res.json();
                if (data.url) uploadedUrls.push(data.url);
            }
            if (uploadedUrls.length === 0) return;
            // 기존 항목의 형태(문자열/객체)는 그대로 두고 뒤에 덧붙입니다.
            setPhotosJSON((prev) => appendSessionPhotoUrls(prev, uploadedUrls));
            setSaved(false);
        } catch (err) {
            setPhotoError(err instanceof Error ? err.message : "사진 업로드 중 오류가 발생했습니다.");
        } finally {
            setUploading(false);
        }
    }, []);

    const handlePhotoFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0) void uploadPhotos(files);
        // 같은 파일을 다시 고를 수 있도록 초기화
        e.target.value = "";
    }, [uploadPhotos]);

    // 사진 삭제 — 문자열/객체 어느 형태든 해당 위치 항목만 제거합니다.
    const removePhoto = useCallback((index: number) => {
        setPhotosJSON((prev) => removeSessionPhotoEntryAt(prev, index));
        setBrokenPhotoIndexes([]);
        setSaved(false);
    }, []);

    // 학생 노트 변경
    const updateNote = (studentId: string, note: string) => {
        setStudentNotes((prev) => ({
            ...prev,
            [studentId]: { ...prev[studentId], note },
        }));
        setSaved(false);
    };

    // 학생 평점 변경
    const updateRating = (studentId: string, rating: number | null) => {
        setStudentNotes((prev) => ({
            ...prev,
            [studentId]: { ...prev[studentId], rating },
        }));
        setSaved(false);
    };

    // ── 리포트 저장 (기본 정보 + 학생별 노트) ──
    async function handleSave() {
        setSaving(true);
        setSaved(false);
        try {
            // 1. 세션 리포트 기본 정보 저장
            await saveSessionReport({
                sessionId: report.id,
                topic: topic || undefined,
                content: content || undefined,
                photosJSON: photosJSON !== "[]" ? photosJSON : undefined,
                coachId: coachId || undefined,
            });

            // 2. 학생별 노트 저장 (노트가 있는 것만)
            const notesToSave = Object.entries(studentNotes)
                .filter(([, v]) => v.note.trim())
                .map(([studentId, v]) => ({
                    studentId,
                    note: v.note,
                    rating: v.rating,
                }));
            if (notesToSave.length > 0) {
                await saveStudentSessionNotes(report.id, notesToSave);
            }

            setSaved(true);
        } catch (err: any) {
            alert(err.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    }

    // ── 발행/발행취소 토글 ──
    async function handleTogglePublish() {
        const newState = !published;
        const msg = newState
            ? "리포트를 발행하시겠습니까? 학부모에게 알림이 전송됩니다."
            : "리포트 발행을 취소하시겠습니까? 학부모가 더 이상 볼 수 없습니다.";
        if (!confirm(msg)) return;

        setPublishing(true);
        try {
            await publishSessionReport(report.id, newState);
            setPublished(newState);
        } catch (err: any) {
            alert(err.message || "발행 상태 변경 실패");
        } finally {
            setPublishing(false);
        }
    }

    // 날짜 포맷
    const dateStr = new Date(report.date).toLocaleDateString("ko-KR", {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
    });

    return (
        <div className="max-w-4xl mx-auto">
            {/* 헤더: 뒤로가기 + 제목 */}
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <Link
                        href="/admin/attendance/report"
                        prefetch={false}
                        className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-200 flex items-center gap-1 mb-2"
                    >
                        <span className="material-symbols-outlined text-sm">arrow_back</span>
                        리포트 목록
                    </Link>
                    <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">수업 리포트 편집</h1>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
                        {dateStr} | {report.className} ({DAY_LABELS[report.dayOfWeek] || report.dayOfWeek} {report.startTime}~{report.endTime})
                        {report.programName && <span className="ml-2 text-gray-400">- {report.programName}</span>}
                    </p>
                </div>
                {/* 발행 상태 배지 */}
                <div className="flex items-center gap-3">
                    {published ? (
                        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold bg-green-100 text-green-700">
                            <span className="material-symbols-outlined text-base">check_circle</span>
                            발행됨
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                            <span className="material-symbols-outlined text-base">edit_note</span>
                            미발행
                        </span>
                    )}
                </div>
            </div>

            {/* 기본 정보 카드 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 mb-6">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined">description</span>
                    수업 정보
                </h2>

                <div className="space-y-4">
                    {/* 수업 주제 */}
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">수업 주제</label>
                        <input
                            type="text"
                            value={topic}
                            onChange={(e) => { setTopic(e.target.value); setSaved(false); }}
                            placeholder="예: 드리블 연습, 3대3 미니게임"
                            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500"
                        />
                    </div>

                    {/* 담당 코치 */}
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">담당 코치</label>
                        <select
                            value={coachId}
                            onChange={(e) => { setCoachId(e.target.value); setSaved(false); }}
                            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime bg-white dark:bg-gray-800"
                        >
                            <option value="">코치 선택</option>
                            {coaches.map((c) => (
                                <option key={c.id} value={c.id}>{c.name} ({c.role})</option>
                            ))}
                        </select>
                    </div>

                    {/* 수업 내용 */}
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">수업 내용</label>
                        <textarea
                            value={content}
                            onChange={(e) => { setContent(e.target.value); setSaved(false); }}
                            rows={4}
                            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime resize-y"
                        />
                    </div>

                    {/* 수업 사진 */}
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">수업 사진</label>
                        {photos.length > 0 && (
                            <div className="flex flex-wrap gap-3 mb-3">
                                {photos.map((photo, i) => (
                                    <div key={`${photo.index}-${photo.src}`} className="relative group">
                                        {brokenPhotoIndexes.includes(photo.index) ? (
                                            // 로드 실패 시 빈 src로 되돌리면 현재 페이지를 다시 요청하게 되므로 자리표시자를 그립니다.
                                            <div className="w-24 h-24 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center gap-1 px-1 text-center">
                                                <span className="material-symbols-outlined text-base text-gray-400">broken_image</span>
                                                <span className="text-[10px] leading-tight text-gray-400">사진을 불러올 수 없습니다</span>
                                            </div>
                                        ) : (
                                            <img
                                                src={photo.src}
                                                alt={`수업 사진 ${i + 1}`}
                                                className="w-24 h-24 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
                                                onError={() => {
                                                    setBrokenPhotoIndexes((prev) =>
                                                        prev.includes(photo.index) ? prev : [...prev, photo.index]
                                                    );
                                                }}
                                            />
                                        )}
                                        {/* 비공개(초상권 보호) 사진 표시 */}
                                        {photo.isPrivate && (
                                            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] font-bold text-white">
                                                비공개
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => removePhoto(photo.index)}
                                            aria-label={`수업 사진 ${i + 1} 삭제`}
                                            className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                                        >
                                            X
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="text-sm text-brand-orange-500 dark:text-brand-neon-lime font-bold hover:underline flex items-center gap-1 disabled:opacity-50"
                        >
                            <span className="material-symbols-outlined text-sm">add_photo_alternate</span>
                            {uploading ? "업로드 중..." : "사진 추가 (여러 장 선택 가능)"}
                        </button>
                        {/* 숨겨진 파일 선택창 — 수업 기록 모달과 동일한 방식 */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            onChange={handlePhotoFileChange}
                            className="hidden"
                        />
                        {photoError && (
                            <p className="mt-2 text-xs font-medium text-red-600">{photoError}</p>
                        )}
                    </div>
                </div>
            </div>

            {/* 출석 현황 + 학생별 노트 카드 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden mb-6">
                <div className="p-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                    <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        <span className="material-symbols-outlined">people</span>
                        출석 현황 및 학생별 코멘트
                    </h2>
                    <p className="text-gray-500 dark:text-gray-400 text-xs mt-1">
                        학부모에게 리포트 발행 시 함께 전달됩니다.
                    </p>
                </div>

                {report.attendances.length === 0 ? (
                    <div className="p-12 text-center text-gray-400">
                        출석 기록이 없습니다.
                    </div>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {report.attendances.map((a) => {
                            const statusInfo = STATUS_MAP[a.status] || { label: a.status, color: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400" };
                            const noteData = studentNotes[a.studentId] || { note: "", rating: null };

                            return (
                                <div key={a.studentId} className="px-5 py-4">
                                    {/* 학생 이름 + 출석 상태 */}
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="font-bold text-gray-900 dark:text-white">{a.studentName}</span>
                                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statusInfo.color}`}>
                                            {statusInfo.label}
                                        </span>
                                    </div>

                                    {/* 참여도 평점 (별 1~5) */}
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">참여도:</span>
                                        <div className="flex gap-0.5">
                                            {[1, 2, 3, 4, 5].map((star) => (
                                                <button
                                                    key={star}
                                                    onClick={() => updateRating(
                                                        a.studentId,
                                                        noteData.rating === star ? null : star
                                                    )}
                                                    className="focus:outline-none"
                                                >
                                                    <span
                                                        className={`material-symbols-outlined text-lg ${
                                                            noteData.rating && noteData.rating >= star
                                                                ? "text-yellow-400"
                                                                : "text-gray-300"
                                                        }`}
                                                        style={{
                                                            fontVariationSettings:
                                                                noteData.rating && noteData.rating >= star
                                                                    ? "'FILL' 1"
                                                                    : "'FILL' 0",
                                                        }}
                                                    >
                                                        star
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* 개별 코멘트 */}
                                    <textarea
                                        value={noteData.note}
                                        onChange={(e) => updateNote(a.studentId, e.target.value)}
                                        rows={2}
                                        className="w-full border border-gray-200 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime resize-y"
                                    />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 하단 버튼 바 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    {/* 발행/발행취소 버튼 */}
                    <button
                        onClick={handleTogglePublish}
                        disabled={publishing}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition flex items-center gap-1 ${
                            published
                                ? "bg-gray-200 text-gray-700 dark:text-gray-200 hover:bg-gray-300"
                                : "bg-green-600 text-white hover:bg-green-700"
                        } disabled:opacity-50`}
                    >
                        <span className="material-symbols-outlined text-base">
                            {published ? "unpublished" : "publish"}
                        </span>
                        {publishing ? "처리 중..." : published ? "발행 취소" : "학부모에게 발행"}
                    </button>
                </div>
                <div className="flex items-center gap-3">
                    {saved && (
                        <span className="text-sm text-green-600 font-medium">저장 완료</span>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-orange-600 transition disabled:opacity-50 flex items-center gap-1"
                    >
                        <span className="material-symbols-outlined text-base">save</span>
                        {saving ? "저장 중..." : "저장"}
                    </button>
                </div>
            </div>
        </div>
    );
}
