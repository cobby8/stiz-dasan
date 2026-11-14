"use client";

/**
 * 수업 리포트(= 수업 피드 게시물 하나) 편집 부품 — 2026-11-14 «수업 피드» 개편 때 리포트 편집 화면에서 떼어냈다.
 *
 * 쓰는 곳 두 군데가 같은 코드를 쓴다(한쪽만 고쳐지는 사고 방지):
 *   1) /admin/attendance/report/[sessionId] 편집 화면(옛 링크 보존) — 넓은 모양
 *   2) /admin/attendance/feed 오른쪽 편집 패널·휴대폰 시트 — compact 모양
 *
 * 쓰기는 기존 서버 액션 그대로(saveSessionReport·saveStudentSessionNotes·publishSessionReport).
 * 새 쓰기 경로를 만들지 않는다 — 권한 확인(requireAdmin)·캐시 무효화도 그 액션들이 한다.
 * 발행 확인은 브라우저 confirm 창 대신 버튼 자리에서 한 번 더 묻는다(휴대폰 잘못 누름 방지).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { adminErrorText } from "@/components/admin/adminDisplayText";
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
import { ATTENDANCE_TONE, statusBadgeClass } from "@/lib/ui/statusTones";

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

export type SessionReportAttendance = {
    id: string;
    studentId: string;
    status: string;
    studentName: string;
};

export type SessionReportNote = {
    id: string;
    studentId: string;
    note: string;
    rating: number | null;
    studentName: string;
};

export type SessionReportData = {
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
    attendances: SessionReportAttendance[];
    notes: SessionReportNote[];
};

export type SessionReportCoach = {
    id: string;
    name: string;
    role: string;
};

// 출결 상태색 = 공용 지도(statusTones): 출석 정상 · 지각 주의 · 결석 위험
const STATUS_MAP: Record<string, { label: string; color: string }> = {
    PRESENT: { label: "출석", color: statusBadgeClass(ATTENDANCE_TONE.PRESENT) },
    ABSENT: { label: "결석", color: statusBadgeClass(ATTENDANCE_TONE.ABSENT) },
    LATE: { label: "지각", color: statusBadgeClass(ATTENDANCE_TONE.LATE) },
};

export type SessionReportEditorProps = {
    report: SessionReportData;
    coaches: SessionReportCoach[];
    /** 피드 오른쪽 패널·휴대폰 시트용 좁은 모양 */
    compact?: boolean;
    /** 저장이 끝났을 때(피드 카드 갱신용) */
    onSaved?: () => void;
    /** 발행 상태가 바뀌었을 때 */
    onPublishedChange?: (published: boolean) => void;
    /** 저장하지 않은 수정이 생기거나(true) 저장해 없어졌을 때(false) */
    onDirtyChange?: (dirty: boolean) => void;
};

export default function SessionReportEditor({
    report,
    coaches,
    compact = false,
    onSaved,
    onPublishedChange,
    onDirtyChange,
}: SessionReportEditorProps) {
    // ── 리포트 기본 정보 상태 ──
    const [topic, setTopic] = useState(report.topic || "");
    const [content, setContent] = useState(report.content || "");
    const [coachId, setCoachId] = useState(report.coachId || "");
    const [photosJSON, setPhotosJSON] = useState(report.photosJSON || "[]");
    const [published, setPublished] = useState(report.published);

    // ── 학생별 노트 상태 (출석 목록 기반으로 초기화) ──
    const [studentNotes, setStudentNotes] = useState<
        Record<string, { note: string; rating: number | null }>
    >(() => {
        // 기존 노트를 studentId로 빠르게 찾기 위한 맵
        const noteMap = new Map(report.notes.map((n) => [n.studentId, n]));
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
    // 저장하지 않은 수정이 있는가 — 피드에서 다른 게시물로 옮길 때 묻는 데 쓴다
    const [dirty, setDirty] = useState(false);
    const [publishing, setPublishing] = useState(false);
    // 발행/발행 취소를 누르면 버튼 자리에서 한 번 더 묻는다(confirm 창 대신)
    const [confirmingPublish, setConfirmingPublish] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    // 수정이 생겼다고 표시(저장 완료 글자는 지운다)
    const markEdited = useCallback(() => {
        setSaved(false);
        setDirty(true);
    }, []);

    useEffect(() => {
        onDirtyChange?.(dirty);
    }, [dirty, onDirtyChange]);

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
            markEdited();
        } catch (err) {
            setPhotoError(adminErrorText(err, "사진 업로드 중 오류가 발생했습니다."));
        } finally {
            setUploading(false);
        }
    }, [markEdited]);

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
        markEdited();
    }, [markEdited]);

    // 학생 노트 변경
    const updateNote = (studentId: string, note: string) => {
        setStudentNotes((prev) => ({
            ...prev,
            [studentId]: { ...prev[studentId], note },
        }));
        markEdited();
    };

    // 학생 평점 변경
    const updateRating = (studentId: string, rating: number | null) => {
        setStudentNotes((prev) => ({
            ...prev,
            [studentId]: { ...prev[studentId], rating },
        }));
        markEdited();
    };

    // ── 리포트 저장 (기본 정보 + 학생별 노트) ──
    async function handleSave() {
        setSaving(true);
        setSaved(false);
        setActionError(null);
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
            setDirty(false);
            onSaved?.();
        } catch (err) {
            setActionError(adminErrorText(err, "저장 실패"));
        } finally {
            setSaving(false);
        }
    }

    // ── 발행/발행취소 (확인 단계에서 «발행하기»를 눌렀을 때) ──
    async function handleTogglePublish() {
        const newState = !published;
        setPublishing(true);
        setActionError(null);
        try {
            await publishSessionReport(report.id, newState);
            setPublished(newState);
            setConfirmingPublish(false);
            onPublishedChange?.(newState);
        } catch (err) {
            setActionError(adminErrorText(err, "발행 상태 변경 실패"));
        } finally {
            setPublishing(false);
        }
    }

    // 모양 — 넓은 화면(편집 페이지)은 카드 세 장, 패널은 여백을 줄인 같은 순서
    const cardClass = compact
        ? "mb-3 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3"
        : "bg-[var(--color-academy-surface)] rounded-xl border border-[var(--color-academy-line)] shadow-sm p-6 mb-6";
    const thumbClass = compact ? "w-20 h-20" : "w-24 h-24";

    // 수업 내용 칸 — 학부모 피드의 «수업 한 줄». 모양에 따라 자리만 다르다
    const contentField = (
        <div>
            <label htmlFor={`report-content-${report.id}`} className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">수업 내용</label>
            <textarea
                id={`report-content-${report.id}`}
                value={content}
                onChange={(e) => { setContent(e.target.value); markEdited(); }}
                rows={4}
                className="academy-input resize-y"
            />
        </div>
    );

    return (
        <div className="min-w-0">
            {/* 기본 정보 카드 */}
            <div className={cardClass}>
                <h2 className={compact ? "mb-2 text-sm font-semibold text-[var(--color-academy-ink)]" : "academy-section-title mb-4"}>수업 정보</h2>

                <div className={compact ? "space-y-3" : "space-y-4"}>
                    {/* 피드 패널(compact)은 «수업 한 줄»을 먼저 — 옛 편집 화면은 원래 순서(주제 → 코치 → 내용) */}
                    {compact && contentField}

                    {/* 수업 주제 */}
                    <div>
                        <label htmlFor={`report-topic-${report.id}`} className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">수업 주제</label>
                        <input
                            id={`report-topic-${report.id}`}
                            type="text"
                            value={topic}
                            onChange={(e) => { setTopic(e.target.value); markEdited(); }}
                            placeholder="예: 드리블 연습, 3대3 미니게임"
                            className="academy-input"
                        />
                    </div>

                    {/* 담당 코치 */}
                    <div>
                        <label htmlFor={`report-coach-${report.id}`} className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">담당 코치</label>
                        <select
                            id={`report-coach-${report.id}`}
                            value={coachId}
                            onChange={(e) => { setCoachId(e.target.value); markEdited(); }}
                            className="academy-input"
                        >
                            <option value="">코치 선택</option>
                            {coaches.map((c) => (
                                <option key={c.id} value={c.id}>{c.name} ({c.role})</option>
                            ))}
                        </select>
                    </div>

                    {!compact && contentField}

                    {/* 수업 사진 */}
                    <div>
                        <p className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">
                            수업 사진{photos.length > 0 && <> <span className="tabular-nums">{photos.length}</span>장</>}
                        </p>
                        {photos.length > 0 && (
                            <div className={compact ? "mb-2 flex flex-wrap gap-2" : "flex flex-wrap gap-3 mb-3"}>
                                {photos.map((photo, i) => (
                                    <div key={`${photo.index}-${photo.src}`} className="relative group">
                                        {brokenPhotoIndexes.includes(photo.index) ? (
                                            // 로드 실패 시 빈 src로 되돌리면 현재 페이지를 다시 요청하게 되므로 자리표시자를 그립니다.
                                            <div className={`${thumbClass} rounded-lg border border-dashed border-[var(--color-academy-line-input)] bg-[var(--color-academy-soft)] flex flex-col items-center justify-center gap-1 px-1 text-center`}>
                                                <span className="break-keep text-xs leading-tight text-[var(--color-academy-faint)]">사진을 불러올 수 없습니다</span>
                                            </div>
                                        ) : (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={photo.src}
                                                alt={`수업 사진 ${i + 1}`}
                                                loading="lazy"
                                                className={`${thumbClass} object-cover rounded-lg border border-[var(--color-academy-line)]`}
                                                onError={() => {
                                                    setBrokenPhotoIndexes((prev) =>
                                                        prev.includes(photo.index) ? prev : [...prev, photo.index]
                                                    );
                                                }}
                                            />
                                        )}
                                        {/* 비공개(초상권 보호) 사진 표시 */}
                                        {photo.isPrivate && (
                                            <span className="absolute left-1 top-1 rounded bg-[var(--color-academy-ink)] px-1 text-xs text-[var(--color-academy-on-primary)]">
                                                비공개
                                            </span>
                                        )}
                                        {/* 사진 삭제 — 마우스 올림이 없는 휴대폰에서도 보이게 사진 아래 «삭제» 글자 버튼(터치 44px) */}
                                        <button
                                            type="button"
                                            onClick={() => removePhoto(photo.index)}
                                            aria-label={`수업 사진 ${i + 1} 삭제`}
                                            className="academy-button-text academy-button-sm mt-0.5 min-h-11 w-full justify-center text-[var(--color-academy-danger)]"
                                        >
                                            삭제
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="academy-button-secondary academy-button-sm"
                        >
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
                            <p className="mt-2 text-xs font-medium text-[var(--color-academy-danger)]">{photoError}</p>
                        )}
                    </div>
                </div>
            </div>

            {/* 출석 현황 + 학생별 노트 카드 */}
            <div className={compact ? "mb-3 overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]" : "bg-[var(--color-academy-surface)] rounded-xl border border-[var(--color-academy-line)] shadow-sm overflow-hidden mb-6"}>
                <div className={compact ? "border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-3 py-2" : "p-5 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]"}>
                    <h2 className={compact ? "text-sm font-semibold text-[var(--color-academy-ink)]" : "academy-section-title"}>출석 현황 및 학생별 코멘트</h2>
                    <p className="text-[var(--color-academy-muted)] text-xs mt-1">
                        학부모에게 리포트 발행 시 함께 전달됩니다.
                    </p>
                </div>

                {report.attendances.length === 0 ? (
                    <div className={compact ? "p-4 text-center text-sm text-[var(--color-academy-faint)]" : "p-12 text-center text-[var(--color-academy-faint)]"}>
                        출석 기록이 없습니다.
                    </div>
                ) : (
                    <div className="divide-y divide-[var(--color-academy-line)]">
                        {report.attendances.map((a) => {
                            const statusInfo = STATUS_MAP[a.status] || { label: a.status, color: statusBadgeClass("neutral") };
                            const noteData = studentNotes[a.studentId] || { note: "", rating: null };

                            return (
                                <div key={a.studentId} className={compact ? "px-3 py-2.5" : "px-5 py-4"}>
                                    {/* 학생 이름 + 출석 상태 */}
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="font-semibold text-[var(--color-academy-ink)]">{a.studentName}</span>
                                        <span className={`px-2 py-0.5 rounded text-xs ${statusInfo.color}`}>
                                            {statusInfo.label}
                                        </span>
                                    </div>

                                    {/* 참여도 평점 (별 1~5) */}
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-xs text-[var(--color-academy-muted)]">참여도:</span>
                                        <div className="flex gap-0.5">
                                            {[1, 2, 3, 4, 5].map((star) => (
                                                <button
                                                    key={star}
                                                    type="button"
                                                    aria-label={`${a.studentName} 참여도 ${star}점`}
                                                    aria-pressed={noteData.rating === star}
                                                    onClick={() => updateRating(
                                                        a.studentId,
                                                        noteData.rating === star ? null : star
                                                    )}
                                                    className={compact ? "grid min-h-11 min-w-11 place-items-center focus:outline-none" : "focus:outline-none"}
                                                >
                                                    <span aria-hidden="true" className={`text-lg leading-none ${
                                                            noteData.rating && noteData.rating >= star
                                                                ? "text-[var(--color-academy-warning)]"
                                                                : "text-[var(--color-academy-faint)]"
                                                        }`}>{noteData.rating && noteData.rating >= star ? "★" : "☆"}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* 개별 코멘트 */}
                                    <textarea
                                        value={noteData.note}
                                        onChange={(e) => updateNote(a.studentId, e.target.value)}
                                        rows={2}
                                        aria-label={`${a.studentName} 코멘트`}
                                        className="academy-input resize-y"
                                    />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 하단 버튼 바 */}
            <div className={compact ? "rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3" : "bg-[var(--color-academy-surface)] rounded-xl border border-[var(--color-academy-line)] shadow-sm p-5"}>
                {confirmingPublish ? (
                    // 발행/발행 취소 확인 — 버튼 자리에서 한 번 더 묻는다
                    <div role="group" aria-label="발행 확인" className="space-y-2">
                        <p className="text-sm text-[var(--color-academy-ink)]">
                            {published
                                ? "발행을 취소할까요? 학부모가 더 이상 이 소식을 볼 수 없습니다."
                                : "학부모에게 발행할까요? 이 수업에 참여한 학부모에게 알림이 갑니다."}
                        </p>
                        {dirty && (
                            <p className="text-xs text-[var(--color-academy-warning)]">
                                저장하지 않은 수정이 있습니다. 발행에는 마지막으로 저장한 내용이 나갑니다 — 먼저 저장하세요.
                            </p>
                        )}
                        <div className="flex flex-wrap justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setConfirmingPublish(false)}
                                disabled={publishing}
                                className="academy-button-secondary"
                            >
                                그만두기
                            </button>
                            <button
                                type="button"
                                onClick={handleTogglePublish}
                                disabled={publishing}
                                className={published ? "academy-button-danger" : "academy-button-primary"}
                            >
                                {publishing ? "처리 중..." : published ? "발행 취소하기" : "발행하기"}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            {/* 발행/발행취소 버튼 — 이 화면의 주 버튼은 «저장» 하나라 보조 버튼(누르면 그 자리에서 한 번 묻는다) */}
                            <button
                                type="button"
                                onClick={() => { setActionError(null); setConfirmingPublish(true); }}
                                disabled={publishing}
                                className="academy-button-secondary"
                            >
                                {published ? "발행 취소" : "학부모에게 발행"}
                            </button>
                        </div>
                        <div className="flex items-center gap-3">
                            {saved && (
                                <span className="text-sm text-[var(--color-academy-success)] font-medium">저장 완료</span>
                            )}
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving}
                                className="academy-button-primary"
                            >
                                {saving ? "저장 중..." : "저장"}
                            </button>
                        </div>
                    </div>
                )}
                {actionError && (
                    <p role="alert" className="mt-2 text-xs font-medium text-[var(--color-academy-danger)]">{actionError}</p>
                )}
            </div>
        </div>
    );
}

/**
 * 수업 id 만 받아 리포트를 불러온 뒤 편집 부품을 그린다(피드 패널용).
 * 읽기는 기존 관리자 API(/api/admin/attendance/report/[sessionId], requireAdmin)를 그대로 쓴다.
 */
export function SessionReportEditorLoader({
    sessionId,
    ...rest
}: Omit<SessionReportEditorProps, "report" | "coaches" | "compact"> & { sessionId: string }) {
    const [data, setData] = useState<{ report: SessionReportData; coaches: SessionReportCoach[] } | null>(null);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setError(false);
        setData(null);
        try {
            const response = await fetch(`/api/admin/attendance/report/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
            if (!response.ok) throw new Error("리포트를 불러오지 못했습니다.");
            const body = (await response.json()) as { report: SessionReportData | null; coaches: SessionReportCoach[] };
            if (!body.report) throw new Error("리포트를 불러오지 못했습니다.");
            setData({ report: body.report, coaches: body.coaches ?? [] });
        } catch {
            setError(true);
        }
    }, [sessionId]);

    useEffect(() => {
        // 화면을 그린 뒤 불러온다(그리는 도중 상태를 바꾸지 않게)
        const timer = window.setTimeout(() => { void load(); }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    if (error) {
        return (
            <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] p-3 text-center">
                <p className="text-sm font-semibold text-[var(--color-academy-danger)]">수업 리포트를 불러오지 못했습니다.</p>
                <button type="button" onClick={() => void load()} className="academy-button-secondary academy-button-sm mt-2">다시 불러오기</button>
            </div>
        );
    }
    if (!data) {
        return <p className="py-6 text-center text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>;
    }
    return <SessionReportEditor key={data.report.id} report={data.report} coaches={data.coaches} compact {...rest} />;
}
