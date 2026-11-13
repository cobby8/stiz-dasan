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
                <div className="p-6 border-b border-[var(--color-academy-line)] flex items-center justify-between flex-shrink-0">
                    <h2 id="excel-upload-title" className="text-lg font-bold text-[var(--color-academy-ink)]">
                        {step === "upload" && "엑셀 파일 업로드"}
                        {step === "preview" && "업로드 미리보기"}
                        {step === "result" && "등록 결과"}
                    </h2>
                    <button
                        type="button"
                        onClick={handleClose}
                        aria-label="닫기"
                        className="-my-2 -mr-2 academy-button-text academy-button-sm shrink-0"
                    >
                        닫기
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
                                        ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)]"
                                        : "border-[var(--color-academy-line-input)] hover:bg-[var(--color-academy-soft)]"
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
                                        <div className="w-8 h-8 border-3 border-[var(--color-academy-primary)] border-t-transparent rounded-full animate-spin" />
                                        <span className="text-sm text-[var(--color-academy-muted)]">엑셀 파일을 분석하고 있습니다...</span>
                                    </div>
                                ) : (
                                    <>
                                        <span className="text-sm font-medium text-[var(--color-academy-muted)]">
                                            엑셀 파일을 여기에 끌어다 놓거나 클릭하여 선택
                                        </span>
                                        <span className="text-xs text-[var(--color-academy-faint)] mt-1">
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
                                <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-line)] text-[var(--color-academy-danger)] rounded-lg p-3 text-sm">
                                    {errorMsg}
                                </div>
                            )}

                            {/* 안내 텍스트 */}
                            <div className="bg-[var(--color-academy-soft)] rounded-lg p-4 text-sm text-[var(--color-academy-muted)] space-y-1">
                                <p className="font-medium text-[var(--color-academy-muted)]">랠리즈 엑셀 파일 형식</p>
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
                                <span className="bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] px-3 py-1 rounded-full text-sm font-medium">
                                    총 {totalRows}행
                                </span>
                                <span className="bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] px-3 py-1 rounded-full text-sm font-medium">
                                    정상 {validCount}명
                                </span>
                                {errorCount > 0 && (
                                    <span className="bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] px-3 py-1 rounded-full text-sm font-medium">
                                        오류 {errorCount}건
                                    </span>
                                )}
                            </div>

                            {/* 중복 처리 옵션 */}
                            <div className="bg-[var(--color-academy-soft)] rounded-lg p-4">
                                <p className="text-sm font-medium text-[var(--color-academy-muted)] mb-2">
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
                                            className="text-[var(--color-academy-ink)] focus:ring-[var(--color-academy-primary)]"
                                        />
                                        <span className="text-sm text-[var(--color-academy-muted)]">건너뛰기 (기본)</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="duplicateMode"
                                            value="overwrite"
                                            checked={duplicateMode === "overwrite"}
                                            onChange={() => setDuplicateMode("overwrite")}
                                            className="text-[var(--color-academy-ink)] focus:ring-[var(--color-academy-primary)]"
                                        />
                                        <span className="text-sm text-[var(--color-academy-muted)]">덮어쓰기 (기존 정보 업데이트)</span>
                                    </label>
                                </div>
                            </div>

                            {/* 파싱 에러 목록 (있을 때만) */}
                            {parseErrors.length > 0 && (
                                <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-line)] rounded-lg p-3">
                                    <p className="text-sm font-medium text-[var(--color-academy-danger)] mb-1">
                                        읽지 못한 행 ({parseErrors.length}건)
                                    </p>
                                    <ul className="text-xs text-[var(--color-academy-danger)] space-y-0.5">
                                        {parseErrors.map((err, i) => (
                                            <li key={i}>
                                                {err.rowNumber}행: {err.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* 미리보기 테이블 — 스크롤 가능 */}
                            <div className="border border-[var(--color-academy-line)] rounded-lg overflow-hidden">
                                <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                                    <table className="min-w-full divide-y divide-[var(--color-academy-line)] text-sm">
                                        <thead className="bg-[var(--color-academy-soft)] sticky top-0">
                                            <tr>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">행</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">이름</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">클래스</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">생년월일</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">성별</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">학교</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">학년</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">보호자1</th>
                                                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-academy-muted)]">전화번호</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[var(--color-academy-line)]">
                                            {parsedStudents.map((s, i) => (
                                                <tr key={i} className="hover:bg-[var(--color-academy-line)]">
                                                    <td className="px-3 py-2 text-[var(--color-academy-faint)]">{s.rowNumber}</td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-ink)]">{s.name}</td>
                                                    {/* 클래스 매칭 상태: 매칭 성공=초록, 실패=회색 */}
                                                    <td className="px-3 py-2">
                                                        {s.className ? (
                                                            canParseClassName(s.className) ? (
                                                                <span className="text-xs text-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] px-1.5 py-0.5 rounded">
                                                                    {s.className.replace(/^\d+\.\s*/, "")}
                                                                </span>
                                                            ) : (
                                                                <span className="text-xs text-[var(--color-academy-faint)]">
                                                                    매칭 없음
                                                                </span>
                                                            )
                                                        ) : (
                                                            <span className="text-xs text-[var(--color-academy-faint)]">-</span>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-muted)]">{formatDate(s.birthDate)}</td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-muted)]">{formatGender(s.gender)}</td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-muted)]">{s.school || "-"}</td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-muted)]">{s.grade || "-"}</td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-muted)]">
                                                        {s.guardian1Relation || "-"}
                                                    </td>
                                                    <td className="px-3 py-2 text-[var(--color-academy-muted)]">
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
                                <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-line)] text-[var(--color-academy-danger)] rounded-lg p-3 text-sm">
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
                                <div className="bg-[var(--color-academy-success-soft)] rounded-lg p-4 text-center">
                                    <div className="text-2xl font-semibold tabular-nums text-[var(--color-academy-success)]">{result.created}</div>
                                    <div className="text-sm text-[var(--color-academy-success)]">신규 등록</div>
                                </div>
                                <div className="bg-[var(--color-academy-warning-soft)] rounded-lg p-4 text-center">
                                    <div className="text-2xl font-semibold tabular-nums text-[var(--color-academy-warning)]">
                                        {duplicateMode === "skip" ? result.skipped : result.updated}
                                    </div>
                                    <div className="text-sm text-[var(--color-academy-warning)]">
                                        {duplicateMode === "skip" ? "건너뛰기" : "덮어쓰기"}
                                    </div>
                                </div>
                                {/* 자동 수강 등록 결과 카드 */}
                                <div className="bg-[var(--color-academy-soft)] rounded-lg p-4 text-center">
                                    <div className="text-2xl font-semibold tabular-nums text-[var(--color-academy-muted)]">{result.enrolled}</div>
                                    <div className="text-sm text-[var(--color-academy-muted)]">수강 등록</div>
                                </div>
                                <div className="bg-[var(--color-academy-danger-soft)] rounded-lg p-4 text-center">
                                    <div className="text-2xl font-semibold tabular-nums text-[var(--color-academy-danger)]">{result.errors.length}</div>
                                    <div className="text-sm text-[var(--color-academy-danger)]">오류</div>
                                </div>
                            </div>

                            {/* 수강 등록 매칭 실패 목록 (있을 때만) */}
                            {result.enrollErrors && result.enrollErrors.length > 0 && (
                                <div className="bg-[var(--color-academy-warning-soft)] border border-[var(--color-academy-line)] rounded-lg p-4">
                                    <p className="text-sm font-medium text-[var(--color-academy-warning)] mb-2">
                                        수강 등록 경고 ({result.enrollErrors.length}건)
                                    </p>
                                    <div className="max-h-32 overflow-y-auto">
                                        <ul className="text-xs text-[var(--color-academy-warning)] space-y-0.5">
                                            {result.enrollErrors.map((msg, i) => (
                                                <li key={i}>{msg}</li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            )}

                            {/* 오류 상세 목록 (있을 때만) */}
                            {result.errors.length > 0 && (
                                <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-line)] rounded-lg p-4">
                                    <p className="text-sm font-medium text-[var(--color-academy-danger)] mb-2">
                                        등록 실패 목록
                                    </p>
                                    <div className="max-h-40 overflow-y-auto">
                                        <table className="min-w-full text-sm">
                                            <thead>
                                                <tr className="text-left text-xs text-[var(--color-academy-danger)]">
                                                    <th className="pr-3 pb-1">행</th>
                                                    <th className="pr-3 pb-1">이름</th>
                                                    <th className="pb-1">사유</th>
                                                </tr>
                                            </thead>
                                            <tbody className="text-[var(--color-academy-danger)]">
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
                                <div className="bg-[var(--color-academy-success-soft)] border border-[var(--color-academy-line)] text-[var(--color-academy-success)] rounded-lg p-4 text-sm text-center">
                                    모든 학생이 정상적으로 등록되었습니다.
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* ── 하단 버튼 영역 ── */}
                <div className="p-6 border-t border-[var(--color-academy-line)] flex justify-end gap-3 flex-shrink-0">
                    {/* 화면 1: 업로드 — 취소 버튼만 */}
                    {step === "upload" && (
                        <button
                            type="button"
                            onClick={handleClose}
                            className="academy-button-secondary"
                        >
                            취소
                        </button>
                    )}

                    {/* 화면 2: 미리보기 — 취소 + 등록하기 */}
                    {step === "preview" && (
                        <>
                            <button
                                type="button"
                                onClick={handleClose}
                                disabled={loading}
                                className="academy-button-secondary"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handleBulkCreate}
                                disabled={loading || parsedStudents.length === 0}
                                className="academy-button-primary"
                            >
                                {loading ? (
                                    <span className="flex items-center gap-2">
                                        <span className="w-4 h-4 border-2 border-[var(--color-academy-on-primary)] border-t-transparent rounded-full animate-spin" />
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
                            type="button"
                            onClick={handleFinish}
                            className="academy-button-primary"
                        >
                            확인
                        </button>
                    )}
                </div>
            </div>
        </AdminModal>
    );
}
