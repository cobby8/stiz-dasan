"use client";
import { adminMessageText } from "@/components/admin/adminDisplayText";

/**
 * ExcelUploadModal — 엑셀 파일 업로드 -> 미리보기 -> 일괄 등록 모달
 *
 * 3단계 UI 흐름:
 * 1) 파일 업로드 (드래그앤드롭 + 파일 선택)
 * 2) 미리보기 테이블 (파싱 결과 확인 + 중복 옵션 선택)
 * 3) 등록 결과 요약
 */

import { useState, useRef, useCallback } from "react";
import { bulkCreateStudents } from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";

// parse-excel API에서 반환하는 파싱된 학생 데이터 타입
// route.ts에서 export한 ParsedStudent와 동일한 구조
type ParsedStudent = {
    rowNumber: number;
    name: string;
    managementName: string | null;
    className: string | null;
    phone: string | null;
    guardian1Relation: string | null;
    guardian1Phone: string | null;
    guardian2Relation: string | null;
    guardian2Phone: string | null;
    guardian3Relation: string | null;
    guardian3Phone: string | null;
    school: string | null;
    grade: string | null;
    gender: string | null;
    address: string | null;
    enrollDate: string | null;
    paymentDate: string | null;
    birthDate: string | null;
    memo: string | null;
};

// 파싱 에러 타입
type ParseError = {
    rowNumber: number;
    reason: string;
};

// bulkCreateStudents 결과 타입
type BulkCreateResult = {
    created: number;
    skipped: number;
    updated: number;
    enrolled: number;       // 자동 수강 등록 성공 수
    enrollErrors: string[]; // 수강 등록 실패/매칭 실패 목록
    errors: { rowNumber: number; name: string; reason: string }[];
};

// 모달 Props
type ExcelUploadModalProps = {
    isOpen: boolean;
    onClose: () => void;
    onComplete: () => void; // 등록 완료 후 목록 새로고침 트리거
};

// 3단계 화면 상태
type Step = "upload" | "preview" | "result";

export default function ExcelUploadModal({
    isOpen,
    onClose,
    onComplete,
}: ExcelUploadModalProps) {
    // ── 상태 관리 ──
    const [step, setStep] = useState<Step>("upload");
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // 파싱 결과
    const [parsedStudents, setParsedStudents] = useState<ParsedStudent[]>([]);
    const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
    const [totalRows, setTotalRows] = useState(0);

    // 중복 처리 옵션 (기본: 건너뛰기)
    const [duplicateMode, setDuplicateMode] = useState<"skip" | "overwrite">("skip");

    // 등록 결과
    const [result, setResult] = useState<BulkCreateResult | null>(null);

    // 드래그 상태 (드래그 영역 하이라이트용)
    const [isDragging, setIsDragging] = useState(false);

    // 파일 input ref (숨겨진 input을 프로그래밍으로 클릭하기 위해)
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── 모달 닫기 + 상태 초기화 ──
    const handleClose = useCallback(() => {
        // 모든 상태를 초기화하고 모달 닫기
        setStep("upload");
        setLoading(false);
        setErrorMsg(null);
        setParsedStudents([]);
        setParseErrors([]);
        setTotalRows(0);
        setDuplicateMode("skip");
        setResult(null);
        setIsDragging(false);
        onClose();
    }, [onClose]);

    // ── 파일 처리: parse-excel API 호출 ──
    const handleFile = useCallback(async (file: File) => {
        // .xlsx 파일만 허용
        if (!file.name.toLowerCase().endsWith(".xlsx") && !file.name.toLowerCase().endsWith(".xls")) {
            setErrorMsg("엑셀 파일(.xlsx, .xls)만 업로드할 수 있습니다.");
            return;
        }

        setLoading(true);
        setErrorMsg(null);

        try {
            // FormData에 파일을 담아 파싱 API로 전송
            const formData = new FormData();
            formData.append("file", file);

            const res = await fetch("/api/admin/parse-excel", {
                method: "POST",
                body: formData,
            });

            const data = await res.json();

            if (!res.ok) {
                // API가 에러를 반환한 경우
                setErrorMsg(adminMessageText(data.error, "엑셀 파일을 읽지 못했습니다."));
                return;
            }

            // 파싱 성공 — 결과 저장하고 미리보기 화면으로 전환
            setParsedStudents(data.students || []);
            setParseErrors(data.errors || []);
            setTotalRows(data.totalRows || 0);
            setStep("preview");
        } catch (err) {
            setErrorMsg("서버 연결에 실패했습니다. 다시 시도해주세요.");
        } finally {
            setLoading(false);
        }
    }, []);

    // ── 파일 선택 (input change) ──
    const handleFileChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            // input 값 초기화 (같은 파일 재선택 가능하도록)
            e.target.value = "";
        },
        [handleFile]
    );

    // ── 드래그앤드롭 이벤트 ──
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
        },
        [handleFile]
    );

    // ── 일괄 등록 실행 ──
    const handleBulkCreate = useCallback(async () => {
        setLoading(true);
        setErrorMsg(null);

        try {
            // ParsedStudent를 BulkStudentInput 형태로 변환
            // bulkCreateStudents가 필요로 하는 필드만 매핑
            // className도 전달하여 자동 수강 등록에 사용
            const input = parsedStudents.map((s) => ({
                rowNumber: s.rowNumber,
                name: s.name,
                birthDate: s.birthDate,
                gender: s.gender,
                phone: s.phone,
                school: s.school,
                grade: s.grade,
                address: s.address,
                enrollDate: s.enrollDate,
                memo: s.memo,
                className: s.className,
                guardian1Relation: s.guardian1Relation,
                guardian1Phone: s.guardian1Phone,
                guardian2Relation: s.guardian2Relation,
                guardian2Phone: s.guardian2Phone,
                guardian3Relation: s.guardian3Relation,
                guardian3Phone: s.guardian3Phone,
            }));

            // Server Action 직접 호출
            const bulkResult = await bulkCreateStudents(input, duplicateMode);
            setResult(bulkResult);
            setStep("result");
        } catch (err) {
            setErrorMsg("등록 중 오류가 발생했습니다. 다시 시도해주세요.");
        } finally {
            setLoading(false);
        }
    }, [parsedStudents, duplicateMode]);

    // ── 결과 화면에서 "확인" 클릭 ──
    const handleFinish = useCallback(() => {
        onComplete(); // 부모에게 새로고침 트리거
        handleClose(); // 모달 닫기 + 상태 초기화
    }, [onComplete, handleClose]);

    // ── 모달이 닫혀있으면 렌더링 안 함 ──
    if (!isOpen) return null;

    // ── 생년월일을 읽기 좋은 형태로 변환하는 유틸 ──
    function formatDate(isoStr: string | null): string {
        if (!isoStr) return "-";
        try {
            const d = new Date(isoStr);
            // YYYY-MM-DD 형태로 표시
            return d.toISOString().split("T")[0];
        } catch {
            return "-";
        }
    }

    // 성별 표시용 변환
    function formatGender(g: string | null): string {
        if (g === "MALE") return "남";
        if (g === "FEMALE") return "여";
        return "-";
    }

    // 요일 매핑 (클래스명 파싱 미리보기에 사용)
    const dayNameToKey: Record<string, string> = {
        "월요일": "Mon", "화요일": "Tue", "수요일": "Wed", "목요일": "Thu",
        "금요일": "Fri", "토요일": "Sat", "일요일": "Sun",
    };

    /**
     * 클래스명에서 slotKey를 파싱할 수 있는지 미리 확인
     * 성공하면 slotKey 반환, 실패하면 null
     */
    function canParseClassName(className: string | null): string | null {
        if (!className) return null;
        const cleaned = className.replace(/^\d+\.\s*/, "").trim();
        let dayKey: string | null = null;
        for (const [korDay, key] of Object.entries(dayNameToKey)) {
            if (cleaned.includes(korDay)) { dayKey = key; break; }
        }
        if (!dayKey) return null;
        const periodMatch = cleaned.match(/(\d+)교시/);
        if (!periodMatch) return null;
        return `${dayKey}-${periodMatch[1]}`;
    }

    // 정상 학생 수 (에러 제외)
    const validCount = parsedStudents.length;
    const errorCount = parseErrors.length;

    return (
        // 모달 배경 오버레이
        <AdminModal
            titleId="excel-upload-title"
            onClose={handleClose}
            closeOnBackdrop={false}
            panelClassName="max-w-4xl"
        >
            {/* 모달 본체 */}
            <div
                className="flex w-full flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                {/* ── 헤더 ── */}
                <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
                    <h2 id="excel-upload-title" className="text-lg font-bold text-gray-900 dark:text-white">
                        {step === "upload" && "엑셀 파일 업로드"}
                        {step === "preview" && "업로드 미리보기"}
                        {step === "result" && "등록 결과"}
                    </h2>
                    <button
                        onClick={handleClose}
                        className="p-1 hover:bg-gray-100 dark:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-300 transition"
                    >
                        {/* X 아이콘 (SVG) */}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* ── 본문 ── */}
                <div className="p-6 overflow-y-auto flex-1">
                    {/* ────────────────────────────────────── */}
                    {/* 화면 1: 파일 업로드 */}
                    {/* ────────────────────────────────────── */}
                    {step === "upload" && (
                        <div className="space-y-4">
                            {/* 드래그앤드롭 영역 */}
                            <div
                                className={`
                                    flex flex-col items-center justify-center w-full h-48
                                    border-2 border-dashed rounded-xl cursor-pointer transition
                                    ${isDragging
                                        ? "border-brand-orange-500 dark:border-brand-neon-lime bg-orange-50"
                                        : "border-gray-300 hover:bg-gray-50 dark:bg-gray-900"
                                    }
                                    ${loading ? "opacity-50 pointer-events-none" : ""}
                                `}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                {loading ? (
                                    // 로딩 스피너
                                    <div className="flex flex-col items-center gap-3">
                                        <div className="w-8 h-8 border-3 border-brand-orange-500 dark:border-brand-neon-lime border-t-transparent rounded-full animate-spin" />
                                        <span className="text-sm text-gray-500 dark:text-gray-400">엑셀 파일을 분석하고 있습니다...</span>
                                    </div>
                                ) : (
                                    <>
                                        {/* 업로드 아이콘 */}
                                        <svg
                                            className="w-10 h-10 text-gray-400 mb-3"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                            strokeWidth="1.5"
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                                            />
                                        </svg>
                                        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                                            엑셀 파일을 여기에 끌어다 놓거나 클릭하여 선택
                                        </span>
                                        <span className="text-xs text-gray-400 mt-1">
                                            .xlsx 파일만 지원 (최대 10MB)
                                        </span>
                                    </>
                                )}
                                {/* 숨겨진 파일 input */}
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    className="hidden"
                                    accept=".xlsx,.xls"
                                    onChange={handleFileChange}
                                />
                            </div>

                            {/* 에러 메시지 */}
                            {errorMsg && (
                                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
                                    {errorMsg}
                                </div>
                            )}

                            {/* 안내 텍스트 */}
                            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 text-sm text-gray-600 dark:text-gray-300 space-y-1">
                                <p className="font-medium text-gray-700 dark:text-gray-200">랠리즈 엑셀 파일 형식</p>
                                <p>랠리즈에서 다운로드한 원생 목록 엑셀 파일을 그대로 업로드하세요.</p>
                            </div>
                        </div>
                    )}

                    {/* ────────────────────────────────────── */}
                    {/* 화면 2: 미리보기 */}
                    {/* ────────────────────────────────────── */}
                    {step === "preview" && (
                        <div className="space-y-4">
                            {/* 요약 정보 */}
                            <div className="flex flex-wrap items-center gap-3">
                                <span className="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-sm font-medium">
                                    총 {totalRows}행
                                </span>
                                <span className="bg-green-50 text-green-700 px-3 py-1 rounded-full text-sm font-medium">
                                    정상 {validCount}명
                                </span>
                                {errorCount > 0 && (
                                    <span className="bg-red-50 text-red-700 px-3 py-1 rounded-full text-sm font-medium">
                                        오류 {errorCount}건
                                    </span>
                                )}
                            </div>

                            {/* 중복 처리 옵션 */}
                            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                                <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                                    이름+생년월일이 같은 기존 학생이 있을 때:
                                </p>
                                <div className="flex gap-4">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="duplicateMode"
                                            value="skip"
                                            checked={duplicateMode === "skip"}
                                            onChange={() => setDuplicateMode("skip")}
                                            className="text-brand-orange-500 dark:text-brand-neon-lime focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-200">건너뛰기 (기본)</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="duplicateMode"
                                            value="overwrite"
                                            checked={duplicateMode === "overwrite"}
                                            onChange={() => setDuplicateMode("overwrite")}
                                            className="text-brand-orange-500 dark:text-brand-neon-lime focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-200">덮어쓰기 (기존 정보 업데이트)</span>
                                    </label>
                                </div>
                            </div>

                            {/* 파싱 에러 목록 (있을 때만) */}
                            {parseErrors.length > 0 && (
                                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                                    <p className="text-sm font-medium text-red-700 mb-1">
                                        읽지 못한 행 ({parseErrors.length}건)
                                    </p>
                                    <ul className="text-xs text-red-600 space-y-0.5">
                                        {parseErrors.map((err, i) => (
                                            <li key={i}>
                                                {err.rowNumber}행: {err.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* 미리보기 테이블 — 스크롤 가능 */}
                            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                                <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                                        <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0">
                                            <tr>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">행</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">이름</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">클래스</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">생년월일</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">성별</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">학교</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">학년</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">보호자1</th>
                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">전화번호</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {parsedStudents.map((s, i) => (
                                                <tr key={i} className="hover:bg-gray-50 dark:bg-gray-900">
                                                    <td className="px-3 py-2 text-gray-400">{s.rowNumber}</td>
                                                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{s.name}</td>
                                                    {/* 클래스 매칭 상태: 매칭 성공=초록, 실패=회색 */}
                                                    <td className="px-3 py-2">
                                                        {s.className ? (
                                                            canParseClassName(s.className) ? (
                                                                <span className="text-xs text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                                                                    {s.className.replace(/^\d+\.\s*/, "")}
                                                                </span>
                                                            ) : (
                                                                <span className="text-xs text-gray-400">
                                                                    매칭 없음
                                                                </span>
                                                            )
                                                        ) : (
                                                            <span className="text-xs text-gray-300">-</span>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{formatDate(s.birthDate)}</td>
                                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{formatGender(s.gender)}</td>
                                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{s.school || "-"}</td>
                                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{s.grade || "-"}</td>
                                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                                                        {s.guardian1Relation || "-"}
                                                    </td>
                                                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                                                        {s.guardian1Phone || "-"}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* 에러 메시지 (등록 시 발생) */}
                            {errorMsg && (
                                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
                                    {errorMsg}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ────────────────────────────────────── */}
                    {/* 화면 3: 등록 결과 */}
                    {/* ────────────────────────────────────── */}
                    {step === "result" && result && (
                        <div className="space-y-4">
                            {/* 결과 요약 카드 */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                <div className="bg-green-50 rounded-lg p-4 text-center">
                                    <div className="text-2xl font-bold text-green-700">{result.created}</div>
                                    <div className="text-sm text-green-600">신규 등록</div>
                                </div>
                                <div className="bg-yellow-50 rounded-lg p-4 text-center">
                                    <div className="text-2xl font-bold text-yellow-700">
                                        {duplicateMode === "skip" ? result.skipped : result.updated}
                                    </div>
                                    <div className="text-sm text-yellow-600">
                                        {duplicateMode === "skip" ? "건너뛰기" : "덮어쓰기"}
                                    </div>
                                </div>
                                {/* 자동 수강 등록 결과 카드 */}
                                <div className="bg-blue-50 rounded-lg p-4 text-center">
                                    <div className="text-2xl font-bold text-blue-700">{result.enrolled}</div>
                                    <div className="text-sm text-blue-600">수강 등록</div>
                                </div>
                                <div className="bg-red-50 rounded-lg p-4 text-center">
                                    <div className="text-2xl font-bold text-red-700">{result.errors.length}</div>
                                    <div className="text-sm text-red-600">오류</div>
                                </div>
                            </div>

                            {/* 수강 등록 매칭 실패 목록 (있을 때만) */}
                            {result.enrollErrors && result.enrollErrors.length > 0 && (
                                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                                    <p className="text-sm font-medium text-yellow-700 mb-2">
                                        수강 등록 경고 ({result.enrollErrors.length}건)
                                    </p>
                                    <div className="max-h-32 overflow-y-auto">
                                        <ul className="text-xs text-yellow-600 space-y-0.5">
                                            {result.enrollErrors.map((msg, i) => (
                                                <li key={i}>{msg}</li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            )}

                            {/* 오류 상세 목록 (있을 때만) */}
                            {result.errors.length > 0 && (
                                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                                    <p className="text-sm font-medium text-red-700 mb-2">
                                        등록 실패 목록
                                    </p>
                                    <div className="max-h-40 overflow-y-auto">
                                        <table className="min-w-full text-sm">
                                            <thead>
                                                <tr className="text-left text-xs text-red-600">
                                                    <th className="pr-3 pb-1">행</th>
                                                    <th className="pr-3 pb-1">이름</th>
                                                    <th className="pb-1">사유</th>
                                                </tr>
                                            </thead>
                                            <tbody className="text-red-700">
                                                {result.errors.map((err, i) => (
                                                    <tr key={i}>
                                                        <td className="pr-3 py-0.5">{err.rowNumber}</td>
                                                        <td className="pr-3 py-0.5">{err.name}</td>
                                                        <td className="py-0.5">{err.reason}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {/* 성공 메시지 */}
                            {result.errors.length === 0 && (
                                <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg p-4 text-sm text-center">
                                    모든 학생이 정상적으로 등록되었습니다.
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* ── 하단 버튼 영역 ── */}
                <div className="p-6 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3 flex-shrink-0">
                    {/* 화면 1: 업로드 — 취소 버튼만 */}
                    {step === "upload" && (
                        <button
                            onClick={handleClose}
                            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-xl transition"
                        >
                            취소
                        </button>
                    )}

                    {/* 화면 2: 미리보기 — 취소 + 등록하기 */}
                    {step === "preview" && (
                        <>
                            <button
                                onClick={handleClose}
                                disabled={loading}
                                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-xl transition disabled:opacity-50"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleBulkCreate}
                                disabled={loading || parsedStudents.length === 0}
                                className="px-6 py-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold rounded-xl hover:bg-orange-600 transition disabled:opacity-50"
                            >
                                {loading ? (
                                    <span className="flex items-center gap-2">
                                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        등록 중...
                                    </span>
                                ) : (
                                    `${validCount}명 등록하기`
                                )}
                            </button>
                        </>
                    )}

                    {/* 화면 3: 결과 — 확인 버튼 */}
                    {step === "result" && (
                        <button
                            onClick={handleFinish}
                            className="px-6 py-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold rounded-xl hover:bg-orange-600 transition"
                        >
                            확인
                        </button>
                    )}
                </div>
            </div>
        </AdminModal>
    );
}
