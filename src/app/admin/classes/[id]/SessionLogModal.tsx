"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

/**
 * SessionLogModal — 수업 기록 + 사진 업로드 + 출석 체크 통합 모달
 *
 * 기능:
 * 1. 수업 날짜 / 코치 / 주제 / 내용 입력
 * 2. 사진 여러 장 업로드 (/api/upload, folder="class-logs")
 * 3. 학생별 출석 체크 (출석/결석/지각)
 * 4. 저장 → saveSessionLog Server Action 호출
 * 5. sessionId가 있으면 수정 모드 (initialData로 기존 데이터 채우기)
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { saveSessionLog } from "@/app/actions/admin";
import { compressImageForUpload } from "@/lib/clientImageCompression";
import AdminModal from "@/components/admin/AdminModal";

// ── 출석 상태 옵션 (AttendanceClient와 동일 패턴) ──
const STATUS_OPTIONS = [
    { value: "PRESENT", label: "출석", color: "bg-green-100 text-green-700 border-green-300" },
    { value: "ABSENT", label: "결석", color: "bg-red-100 text-red-700 border-red-300" },
    { value: "LATE", label: "지각", color: "bg-yellow-100 text-yellow-700 border-yellow-300" },
] as const;

// 오늘 날짜를 YYYY-MM-DD 형식으로 반환
function todayStr() {
    return new Date().toISOString().split("T")[0];
}

// ── 수정 모드에서 전달받는 기존 세션 데이터 ──
// 서버 함수(getSessionDetail)는 클라이언트에서 직접 호출 불가하므로,
// 부모(ClassDetailClient)에서 sessions 배열의 해당 항목을 가공하여 전달
export type SessionInitialData = {
    id: string;
    date: string;
    topic: string;
    content: string;
    coachId: string;
    photos: string[];           // photosJSON을 파싱한 URL 배열
    attendances: Array<{        // 기존 출석 데이터
        studentId: string;
        status: string;
    }>;
};

// ── Props 타입 ──
type Props = {
    isOpen: boolean;
    onClose: () => void;
    classId: string;
    date?: string;                              // 기본값 오늘
    initialData?: SessionInitialData;           // 수정 모드일 때 기존 데이터
    coaches: Array<{ id: string; name: string }>;
    students: Array<{ id: string; name: string; gender?: string | null }>;
    onSaved: () => void;                        // 저장 후 콜백 (목록 새로고침)
};

// 학생별 출석 상태 타입
type AttendanceRecord = {
    studentId: string;
    studentName: string;
    status: string;     // PRESENT | ABSENT | LATE
};

export default function SessionLogModal({
    isOpen,
    onClose,
    classId,
    date: defaultDate,
    initialData,
    coaches,
    students,
    onSaved,
}: Props) {
    // ── 폼 상태 ──
    const [date, setDate] = useState(defaultDate || todayStr());
    const [coachId, setCoachId] = useState("");
    const [topic, setTopic] = useState("");
    const [content, setContent] = useState("");

    // ── 사진 상태 ──
    const [photoUrls, setPhotoUrls] = useState<string[]>([]);   // 업로드 완료된 사진 URL 목록
    const [uploading, setUploading] = useState(false);           // 사진 업로드 진행 중 여부
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── 출석 상태 ──
    // 기본값: 모든 학생을 "PRESENT"(출석)으로 초기화
    const [attendances, setAttendances] = useState<AttendanceRecord[]>([]);

    // ── 저장 상태 ──
    const [saving, setSaving] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // ── 모달 열릴 때 초기화 / 수정 모드 데이터 채우기 ──
    useEffect(() => {
        if (!isOpen) return;

        if (initialData) {
            // 수정 모드: 기존 데이터로 폼 채우기
            setDate(initialData.date);
            setCoachId(initialData.coachId || "");
            setTopic(initialData.topic || "");
            setContent(initialData.content || "");
            setPhotoUrls(initialData.photos || []);

            // 출석 데이터: 기존 출석 + 신규 학생은 PRESENT로 채우기
            const existingMap = new Map(
                initialData.attendances.map((a) => [a.studentId, a.status])
            );
            setAttendances(
                students.map((s) => ({
                    studentId: s.id,
                    studentName: s.name,
                    status: existingMap.get(s.id) || "PRESENT",
                }))
            );
        } else {
            // 신규 모드: 빈 폼 + 모든 학생 출석
            setDate(defaultDate || todayStr());
            setCoachId("");
            setTopic("");
            setContent("");
            setPhotoUrls([]);
            setAttendances(
                students.map((s) => ({
                    studentId: s.id,
                    studentName: s.name,
                    status: "PRESENT",
                }))
            );
        }
        setErrorMsg(null);
    }, [isOpen, initialData, students, defaultDate]);

    // ── 모달 닫기 + 상태 초기화 ──
    const handleClose = useCallback(() => {
        setDate(defaultDate || todayStr());
        setCoachId("");
        setTopic("");
        setContent("");
        setPhotoUrls([]);
        setAttendances([]);
        setSaving(false);
        setUploading(false);
        setErrorMsg(null);
        onClose();
    }, [onClose, defaultDate]);

    // ── 사진 업로드 처리 ──
    // /api/upload 엔드포인트에 FormData로 전송, folder="class-logs"
    const handlePhotoUpload = useCallback(async (files: FileList) => {
        setUploading(true);
        setErrorMsg(null);

        try {
            const newUrls: string[] = [];

            // 각 파일을 순차적으로 업로드 (병렬 처리 시 서버 부하 방지)
            for (const file of Array.from(files)) {
                const compressed = await compressImageForUpload(file);
                const formData = new FormData();
                formData.append("file", compressed);
                formData.append("folder", "class-logs");    // 사진 저장 폴더

                const res = await fetch("/api/upload", {
                    method: "POST",
                    body: formData,
                });

                if (!res.ok) {
                    throw new Error(`사진 업로드 실패: ${file.name}`);
                }

                const data = await res.json();
                if (data.url) {
                    newUrls.push(data.url);
                }
            }

            // 기존 사진 목록에 새 사진 추가
            setPhotoUrls((prev) => [...prev, ...newUrls]);
        } catch (err: any) {
            setErrorMsg(adminErrorText(err, "사진 업로드 중 오류가 발생했습니다."));
        } finally {
            setUploading(false);
        }
    }, []);

    // 파일 input 변경 핸들러
    const handleFileChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                handlePhotoUpload(files);
            }
            // 같은 파일 재선택 가능하도록 값 초기화
            e.target.value = "";
        },
        [handlePhotoUpload]
    );

    // 사진 삭제 (URL 목록에서 제거)
    const removePhoto = useCallback((index: number) => {
        setPhotoUrls((prev) => prev.filter((_, i) => i !== index));
    }, []);

    // ── 출석 상태 변경 ──
    const setStatus = useCallback((studentId: string, status: string) => {
        setAttendances((prev) =>
            prev.map((a) =>
                a.studentId === studentId ? { ...a, status } : a
            )
        );
    }, []);

    // 전체 일괄 변경 (전체 출석 / 전체 결석)
    const markAll = useCallback((status: string) => {
        setAttendances((prev) => prev.map((a) => ({ ...a, status })));
    }, []);

    // ── 저장 처리 ──
    const handleSave = useCallback(async () => {
        // 필수값 검증
        if (!date) {
            setErrorMsg("수업 날짜를 선택해주세요.");
            return;
        }

        setSaving(true);
        setErrorMsg(null);

        try {
            // saveSessionLog Server Action 호출
            await saveSessionLog({
                classId,
                date,
                topic: topic || undefined,
                content: content || undefined,
                // 사진 URL 배열을 JSON 문자열로 변환하여 전달
                photosJSON: photoUrls.length > 0 ? JSON.stringify(photoUrls) : undefined,
                coachId: coachId || undefined,
                // 학생이 있을 때만 출석 데이터 전달
                attendances: attendances.length > 0
                    ? attendances.map((a) => ({ studentId: a.studentId, status: a.status }))
                    : undefined,
            });

            // 저장 성공 → 부모에 알리고 모달 닫기
            onSaved();
            handleClose();
        } catch (err: any) {
            setErrorMsg(adminErrorText(err, "저장에 실패했습니다. 다시 시도해주세요."));
        } finally {
            setSaving(false);
        }
    }, [classId, date, topic, content, photoUrls, coachId, attendances, onSaved, handleClose]);

    // 모달이 닫혀있으면 렌더링하지 않음
    if (!isOpen) return null;

    // 수정 모드 여부 판별
    const isEditMode = !!initialData;

    return (
        // 모달 배경 오버레이 — ExcelUploadModal과 동일한 패턴
        <AdminModal
            titleId="session-log-title"
            onClose={() => { if (!saving && !uploading) handleClose(); }}
            closeOnBackdrop={false}
            panelClassName="max-w-3xl"
        >
            {/* 모달 본체 */}
            <div
                className="flex w-full flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                {/* ── 헤더 ── */}
                <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
                    <h2 id="session-log-title" className="text-lg font-bold text-gray-900 dark:text-white">
                        {isEditMode ? "수업 기록 수정" : "수업 기록 추가"}
                    </h2>
                    {/* 닫기 버튼 */}
                    <button
                        onClick={handleClose}
                        className="p-2 hover:bg-gray-100 dark:bg-gray-800 rounded-lg transition text-gray-400 hover:text-gray-600 dark:text-gray-300"
                    >
                        {/* X 아이콘 (인라인 SVG — lucide-react 대신) */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* ── 본문 (스크롤 가능) ── */}
                <div className="p-6 overflow-y-auto flex-1 space-y-6">

                    {/* === 섹션 1: 수업 기본 정보 === */}
                    <div className="grid grid-cols-2 gap-4">
                        {/* 수업 날짜 */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                                수업 날짜 *
                            </label>
                            <input
                                type="date"
                                min="2020-01-01" max="2030-12-31"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-transparent"
                            />
                        </div>

                        {/* 코치 선택 */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                                담당 코치
                            </label>
                            <select
                                value={coachId}
                                onChange={(e) => setCoachId(e.target.value)}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-transparent"
                            >
                                <option value="">선택 안 함</option>
                                {coaches.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* 수업 주제 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                            수업 주제
                        </label>
                        <input
                            type="text"
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            placeholder="예: 드리블 기초, 슈팅 연습"
                            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-transparent"
                        />
                    </div>

                    {/* 수업 내용 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                            수업 내용
                        </label>
                        <textarea
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder="오늘 수업에서 진행한 내용을 기록해주세요"
                            rows={3}
                            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-transparent resize-none"
                        />
                    </div>

                    {/* === 섹션 2: 사진 업로드 === */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                            수업 사진
                        </label>

                        {/* 업로드된 사진 썸네일 그리드 */}
                        {photoUrls.length > 0 && (
                            <div className="grid grid-cols-4 gap-2 mb-3">
                                {photoUrls.map((url, idx) => (
                                    <div key={idx} className="relative group">
                                        <img
                                            src={url}
                                            alt={`수업 사진 ${idx + 1}`}
                                            className="w-full h-24 object-cover rounded-xl border border-gray-100 dark:border-gray-800"
                                        />
                                        {/* 삭제 버튼 — 호버 시 표시 */}
                                        <button
                                            type="button"
                                            onClick={() => removePhoto(idx)}
                                            className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition"
                                        >
                                            {/* X 표시 */}
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                                <line x1="18" y1="6" x2="6" y2="18" />
                                                <line x1="6" y1="6" x2="18" y2="18" />
                                            </svg>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* 사진 추가 버튼 */}
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="w-full border-2 border-dashed border-gray-200 rounded-xl p-4 text-sm text-gray-500 hover:border-brand-orange-300 dark:border-brand-neon-lime hover:text-brand-orange-500 dark:text-brand-neon-lime transition flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {uploading ? (
                                <>
                                    {/* 로딩 스피너 */}
                                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                                        <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" />
                                    </svg>
                                    업로드 중...
                                </>
                            ) : (
                                <>
                                    {/* 카메라 아이콘 (인라인 SVG) */}
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                                        <circle cx="12" cy="13" r="4" />
                                    </svg>
                                    사진 추가 (여러 장 선택 가능)
                                </>
                            )}
                        </button>

                        {/* 숨겨진 파일 input — 여러 장 선택 가능 (multiple) */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            onChange={handleFileChange}
                            className="hidden"
                        />
                    </div>

                    {/* === 섹션 3: 출석 체크 === */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                                출석 체크
                            </label>
                            {/* 전체 일괄 변경 버튼 */}
                            {students.length > 0 && (
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => markAll("PRESENT")}
                                        className="text-xs px-2 py-1 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition"
                                    >
                                        전체 출석
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => markAll("ABSENT")}
                                        className="text-xs px-2 py-1 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition"
                                    >
                                        전체 결석
                                    </button>
                                </div>
                            )}
                        </div>

                        {students.length === 0 ? (
                            // 수강생이 없는 경우 안내 메시지
                            <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-4 text-center text-sm text-gray-400">
                                수강생이 없습니다
                            </div>
                        ) : (
                            // 학생 목록 + 출석/결석/지각 토글 버튼
                            <div className="border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden">
                                {attendances.map((att, idx) => (
                                    <div
                                        key={att.studentId}
                                        className={`flex items-center justify-between px-4 py-3 ${
                                            idx < attendances.length - 1 ? "border-b border-gray-50" : ""
                                        }`}
                                    >
                                        {/* 학생 이름 */}
                                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                                            {att.studentName}
                                        </span>

                                        {/* 출석/결석/지각 버튼 그룹 */}
                                        <div className="flex gap-1">
                                            {STATUS_OPTIONS.map((opt) => {
                                                const isSelected = att.status === opt.value;
                                                return (
                                                    <button
                                                        key={opt.value}
                                                        type="button"
                                                        onClick={() => setStatus(att.studentId, opt.value)}
                                                        className={`text-xs px-3 py-1.5 rounded-lg border transition font-medium ${
                                                            isSelected
                                                                ? opt.color
                                                                : "bg-white dark:bg-gray-800 text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:bg-gray-900"
                                                        }`}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* ── 에러 메시지 ── */}
                    {errorMsg && (
                        <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl">
                            {errorMsg}
                        </div>
                    )}
                </div>

                {/* ── 푸터: 취소 + 저장 버튼 ── */}
                <div className="p-6 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3 flex-shrink-0">
                    <button
                        onClick={handleClose}
                        disabled={saving}
                        className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 transition disabled:opacity-50"
                    >
                        취소
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving || uploading}
                        className="px-6 py-2 text-sm font-bold text-white bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 rounded-xl hover:bg-orange-600 transition disabled:opacity-50 flex items-center gap-2"
                    >
                        {saving ? (
                            <>
                                {/* 저장 중 스피너 */}
                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                                    <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" />
                                </svg>
                                저장 중...
                            </>
                        ) : (
                            isEditMode ? "수정 완료" : "저장"
                        )}
                    </button>
                </div>
            </div>
        </AdminModal>
    );
}
