"use client";
import { adminErrorText, adminMessageText } from "@/components/admin/adminDisplayText";

/**
 * 수강생 데이터 이관 클라이언트 UI
 *
 * 3단계 워크플로:
 * 1. CSV 업로드 (텍스트 붙여넣기 또는 파일 업로드)
 * 2. 미리보기 (파싱 결과 확인 + 요약 통계)
 * 3. 실행 (DB 삽입 + 결과 확인)
 */

import { useState, useCallback } from "react";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

// ──────────────────────────────────────────────
// 타입 정의 (API 응답과 동일)
// ──────────────────────────────────────────────

interface TransformedStudent {
  parentName: string;
  parentPhone: string;
  name: string;
  birthDate: string | null;
  phone: string | null;
  school: string | null;
  grade: string | null;
  address: string | null;
  status: "ACTIVE" | "PAUSED" | "WITHDRAWN";
  paymentMethod: "RALLYZ" | "CARD" | "CASH" | "UNPAID" | null;
  amount: number | null;
  slotKeys: string[];
  rowNumber: number;
  branch: string;
}

interface PreviewSummary {
  totalRows: number;
  uniqueStudents: number;
  activeCount: number;
  pausedCount: number;
  withdrawnCount: number;
  branch1Count: number;
  branch2Count: number;
}

interface PreviewResult {
  students: TransformedStudent[];
  summary: PreviewSummary;
  errors: { rowNumber: number; reason: string }[];
}

interface ImportResultData {
  created: { users: number; students: number; enrollments: number; payments: number };
  skipped: { users: number; students: number; enrollments: number; payments: number };
  failed: { rowNumber: number; name: string; reason: string }[];
  sheetImport?: {
    batchId: string;
    rawRows: number;
    registrationRows: number;
    shuttleRows?: number;
    changeRows?: number;
    teamRows?: number;
    issues: number;
  };
}

interface AuxiliarySummary {
  shuttleRows: number;
  changeRows: number;
  teamRows: number;
  totalRows: number;
}

interface ImportSourceInfo {
  type: "csv" | "googleSheet";
  spreadsheetId: string | null;
  sourceUrl: string | null;
  fetchedSheets: string[];
  skippedSheets: { sheetName: string; reason: string }[];
}

interface ImportHistoryIssue {
  id: string;
  sheetName: string | null;
  rowNumber: number | null;
  severity: string;
  message: string;
  createdAt: string;
}

interface ImportHistoryBatch {
  id: string;
  source: string;
  spreadsheetTitle: string | null;
  status: string;
  totalRows: number;
  registrationRows: number;
  vehicleRows: number;
  changeRows: number;
  teamRows: number;
  errorRows: number;
  message: string | null;
  createdAt: string;
  completedAt: string | null;
  issues: ImportHistoryIssue[];
}

type ImportDetailType = "shuttle" | "changes" | "team" | "issues";

type ImportDetailRow = Record<string, string | number | boolean | null>;

interface ImportDetailState {
  batchId: string;
  type: ImportDetailType;
  loading: boolean;
  error: string | null;
  total: number;
  rows: ImportDetailRow[] | null;
}

// ──────────────────────────────────────────────
// 상태 상수
// ──────────────────────────────────────────────

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  ACTIVE: { text: "재원", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
  PAUSED: { text: "휴원", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
  WITHDRAWN: { text: "퇴원", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
};

const METHOD_LABEL: Record<string, string> = {
  RALLYZ: "랠리즈",
  CARD: "카드",
  CASH: "현금",
  UNPAID: "미결제",
};

// 이관 기록 상태값(영문 코드) → 화면 이름
const BATCH_STATUS_LABEL: Record<string, string> = {
  PENDING: "대기",
  RUNNING: "진행 중",
  COMPLETED: "완료",
  FAILED: "실패",
};

// ──────────────────────────────────────────────
// 메인 컴포넌트
// ──────────────────────────────────────────────

export default function ImportClient({ defaultSheetUrl = "" }: { defaultSheetUrl?: string }) {
  // 단계 관리: upload → preview → result
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");

  // CSV 텍스트 (붙여넣기 또는 파일에서 읽음)
  const [csvText, setCsvText] = useState("");
  const [sheetUrl, setSheetUrl] = useState(defaultSheetUrl);
  const [importSource, setImportSource] = useState<"csv" | "googleSheet">("csv");

  // 미리보기 결과
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [auxiliarySummary, setAuxiliarySummary] = useState<AuxiliarySummary | null>(null);
  const [sourceInfo, setSourceInfo] = useState<ImportSourceInfo | null>(null);

  // 실행 결과
  const [importResult, setImportResult] = useState<ImportResultData | null>(null);

  // 로딩/에러 상태
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportHistoryBatch[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // 테이블 필터
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  // ──── 파일 업로드 핸들러 ────
  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // .csv 또는 .txt 파일만 허용
      if (!file.name.endsWith(".csv") && !file.name.endsWith(".txt")) {
        setError("CSV 또는 TXT 파일만 업로드할 수 있습니다.");
        return;
      }

      const text = await file.text();
      setCsvText(text);
      setError(null);
      e.target.value = ""; // 같은 파일 재업로드 가능하게
    },
    []
  );

  // ──── 미리보기 요청 ────
  const handlePreview = useCallback(async (source: "csv" | "googleSheet" = "csv") => {
    if (source === "csv" && !csvText.trim()) {
      setError("CSV 데이터를 입력해주세요.");
      return;
    }
    if (source === "googleSheet" && !sheetUrl.trim()) {
      setError("구글시트 URL을 입력해주세요.");
      return;
    }

    setLoading(true);
    setError(null);
    setImportSource(source);

    try {
      const res = await fetch("/api/admin/import-students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          source === "googleSheet"
            ? { mode: "preview", source: "googleSheet", sheetUrl }
            : { mode: "preview", csvText }
        ),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(adminMessageText(data.error, "미리보기 실패"));
        return;
      }

      setPreview(data.preview);
      setAuxiliarySummary(data.auxiliarySheets?.summary ?? null);
      setSourceInfo(data.source ?? null);
      setStep("preview");
    } catch {
      setError("서버 통신 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [csvText, sheetUrl]);

  // ──── 실행 요청 ────
  const loadImportHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const res = await fetch("/api/admin/import-students/history", {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok) {
        setHistoryError(adminMessageText(data.error, "최근 이관 기록을 불러오지 못했습니다."));
        return;
      }

      setHistory(data.batches ?? []);
    } catch {
      setHistoryError("서버 통신 오류로 최근 이관 기록을 불러오지 못했습니다.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleExecute = useCallback(async () => {
    if (!confirm("자료를 가져오시겠습니까? 확인한 자료가 사이트에 등록됩니다.")) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/import-students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          importSource === "googleSheet"
            ? { mode: "execute", source: "googleSheet", sheetUrl }
            : { mode: "execute", csvText }
        ),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(adminMessageText(data.error, "이관 실행 실패"));
        return;
      }

      setImportResult(data.result);
      setAuxiliarySummary(data.auxiliarySheets?.summary ?? auxiliarySummary);
      setSourceInfo(data.source ?? sourceInfo);
      setStep("result");
      void loadImportHistory();
    } catch {
      setError("서버 통신 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [auxiliarySummary, csvText, importSource, loadImportHistory, sheetUrl, sourceInfo]);

  // ──── 초기화 (다시 시작) ────
  const handleReset = useCallback(() => {
    setStep("upload");
    setCsvText("");
    setPreview(null);
    setAuxiliarySummary(null);
    setSourceInfo(null);
    setImportResult(null);
    setError(null);
    setImportSource("csv");
    setStatusFilter("ALL");
  }, []);

  // 미리보기 필터링된 학생 목록
  const filteredStudents =
    preview?.students.filter(
      (s) => statusFilter === "ALL" || s.status === statusFilter
    ) || [];

  return (
    <div className="space-y-6">
      {/* 페이지 헤더 */}
      {/* 설명문구 제거: 제목 반복 + 개발자 용어(DB) */}
      <AdminPageHeader
        title="수강생 데이터 이관"
        actions={step !== "upload" ? (
          <button onClick={handleReset} className="academy-button-secondary">
            처음부터 다시
          </button>
        ) : undefined}
      />

      {/* 단계 표시 */}
      <StepIndicator current={step} />

      {/* 에러 표시 */}
      {error && (
        <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-danger)] rounded-lg p-4 flex items-start gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--color-academy-danger)]">오류</p>
            <p className="text-sm text-[var(--color-academy-danger)] mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* ===== 1단계: 업로드 ===== */}
      <ImportHistoryPanel
        batches={history}
        error={historyError}
        loading={historyLoading}
        onLoad={loadImportHistory}
      />

      {step === "upload" && (
        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
          <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]/70 p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--color-academy-ink)]">
                    구글시트에서 바로 가져오기
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                    등록·차량·변경 내역·대표팀 명단을 읽어 등록할 내용을 미리 확인합니다.
                  </p>
                </div>
                <div className="flex flex-col gap-2 md:flex-row">
                  <input
                    value={sheetUrl}
                    onChange={(event) => {
                      setSheetUrl(event.target.value);
                      setError(null);
                    }}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                    className="academy-input min-w-0 flex-1"
                  />
                  <button
                    onClick={() => handlePreview("googleSheet")}
                    disabled={loading || !sheetUrl.trim()}
                    className="academy-button-secondary shrink-0"
                  >
                    {loading ? "불러오는 중..." : "구글시트 미리보기"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <h2 className="academy-section-title">
            CSV 데이터 입력
          </h2>

          {/* 설명문구 제거: 아래 붙여넣기 placeholder + CSV 파일 선택 버튼과 중복 */}

          {/* 텍스트 입력 영역 */}
          <textarea
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value);
              setError(null);
            }}
            placeholder="여기에 스프레드시트 데이터를 붙여넣으세요... (Ctrl+V)&#10;&#10;헤더 행을 포함해서 전체를 복사해주세요."
            className="academy-input h-48 resize-y font-mono"
          />

          {/* 파일 업로드 */}
          <div className="flex items-center gap-4">
            <label className="academy-button-secondary cursor-pointer">
              CSV 파일 선택
              <input
                type="file"
                accept=".csv,.txt"
                className="hidden"
                onChange={handleFileUpload}
              />
            </label>

            {csvText && (
              <span className="text-sm text-[var(--color-academy-muted)]">
                {csvText.split("\n").filter((l) => l.trim()).length}행 입력됨
              </span>
            )}
          </div>

          {/* 미리보기 버튼 */}
          <div className="pt-2">
            <button
              onClick={() => handlePreview("csv")}
              disabled={loading || !csvText.trim()}
              className="academy-button-primary"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  읽는 중...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  미리보기
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ===== 2단계: 미리보기 ===== */}
      {step === "preview" && preview && (
        <>
          {/* 요약 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <SummaryCard label="전체 행" value={preview.summary.totalRows} icon="table_rows" />
            <SummaryCard label="고유 학생" value={preview.summary.uniqueStudents} icon="person" color="blue" />
            <SummaryCard label="재원" value={preview.summary.activeCount} icon="check_circle" color="green" />
            <SummaryCard label="휴원" value={preview.summary.pausedCount} icon="pause_circle" color="yellow" />
            <SummaryCard label="퇴원" value={preview.summary.withdrawnCount} icon="cancel" color="red" />
            <SummaryCard label="1호점" value={preview.summary.branch1Count} icon="location_on" />
            <SummaryCard label="2호점" value={preview.summary.branch2Count} icon="location_on" color="blue" />
          </div>

          {auxiliarySummary && auxiliarySummary.totalRows > 0 && (
            <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]/70 p-4 text-sm text-[var(--color-academy-ink)]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">보조 탭 감지</span>
                <span>차량 {auxiliarySummary.shuttleRows.toLocaleString()}행</span>
                <span>변동 {auxiliarySummary.changeRows.toLocaleString()}행</span>
                <span>대표팀 {auxiliarySummary.teamRows.toLocaleString()}행</span>
              </div>
              {sourceInfo?.type === "googleSheet" && (
                <p className="mt-2 text-xs text-[var(--color-academy-muted)]">
                  읽은 탭: {sourceInfo.fetchedSheets.join(", ")}
                </p>
              )}
            </div>
          )}

          {sourceInfo?.skippedSheets?.length ? (
            <div className="rounded-lg border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-4 text-sm text-[var(--color-academy-warning)]">
              일부 탭은 없거나 읽을 수 없어 건너뛰었습니다:{" "}
              {sourceInfo.skippedSheets.slice(0, 8).map((sheet) => sheet.sheetName).join(", ")}
              {sourceInfo.skippedSheets.length > 8 ? " ..." : ""}
            </div>
          ) : null}

          {/* 에러 목록 (있는 경우) */}
          {preview.errors.length > 0 && (
            <div className="bg-[var(--color-academy-warning-soft)] border border-[var(--color-academy-warning)] rounded-lg p-4">
              <p className="text-sm font-medium text-[var(--color-academy-warning)] mb-2">
                확인할 행 ({preview.errors.length}건)
              </p>
              <ul className="text-sm text-[var(--color-academy-warning)] space-y-1">
                {preview.errors.slice(0, 10).map((e, i) => (
                  <li key={i}>
                    행 {e.rowNumber}: {e.reason}
                  </li>
                ))}
                {preview.errors.length > 10 && (
                  <li className="text-[var(--color-academy-warning)]">... 외 {preview.errors.length - 10}건</li>
                )}
              </ul>
            </div>
          )}

          {/* 필터 탭 */}
          <div className="flex flex-wrap gap-2">
            {[
              { key: "ALL", label: "전체", count: preview.students.length },
              { key: "ACTIVE", label: "재원", count: preview.summary.activeCount },
              { key: "PAUSED", label: "휴원", count: preview.summary.pausedCount },
              { key: "WITHDRAWN", label: "퇴원", count: preview.summary.withdrawnCount },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatusFilter(tab.key)}
                aria-pressed={statusFilter === tab.key}
                className={`academy-choice is-tab ${statusFilter === tab.key ? "is-selected" : ""}`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          {/* 학생 테이블 */}
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-academy-soft)] border-b">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">#</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">지점</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">이름</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">학부모</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">학교/학년</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">상태</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">결제</th>
                    <th className="px-4 py-3 text-left font-medium text-[var(--color-academy-muted)]">수업</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredStudents.slice(0, 100).map((s, i) => {
                    const statusInfo = STATUS_LABEL[s.status] || { text: s.status, color: "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]" };
                    return (
                      <tr key={i} className="hover:bg-[var(--color-academy-soft)]">
                        <td className="px-4 py-3 text-[var(--color-academy-faint)]">{s.rowNumber}</td>
                        <td className="px-4 py-3">{s.branch}</td>
                        <td className="px-4 py-3 font-medium">{s.name}</td>
                        <td className="px-4 py-3 text-[var(--color-academy-muted)]">
                          {s.parentName}
                          <br />
                          <span className="text-xs text-[var(--color-academy-faint)]">{s.parentPhone}</span>
                        </td>
                        <td className="px-4 py-3 text-[var(--color-academy-muted)]">
                          {s.school || "-"}
                          {s.grade && <span className="text-xs text-[var(--color-academy-faint)] ml-1">{s.grade}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                            {statusInfo.text}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[var(--color-academy-muted)]">
                          {s.paymentMethod ? METHOD_LABEL[s.paymentMethod] || s.paymentMethod : "-"}
                          {s.amount ? (
                            <span className="text-xs text-[var(--color-academy-faint)] ml-1">
                              {s.amount.toLocaleString()}원
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          {s.slotKeys.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {s.slotKeys.map((key) => (
                                <span
                                  key={key}
                                  className="px-1.5 py-0.5 bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] text-xs rounded"
                                >
                                  {key}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[var(--color-academy-faint)]">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filteredStudents.length > 100 && (
              <div className="px-4 py-3 bg-[var(--color-academy-soft)] border-t text-sm text-[var(--color-academy-muted)]">
                상위 100명만 표시됨 (전체 {filteredStudents.length}명)
              </div>
            )}
          </div>

          {/* 실행 버튼 */}
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setStep("upload")}
              className="academy-button-secondary"
            >
              뒤로
            </button>
            <button
              onClick={handleExecute}
              disabled={loading || preview.students.length === 0}
              className="academy-button-primary"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  이관 실행 중...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  이관 실행 ({preview.students.length}명)
                </span>
              )}
            </button>
          </div>
        </>
      )}

      {/* ===== 3단계: 결과 ===== */}
      {step === "result" && importResult && (
        <div className="space-y-6">
          {/* 성공 배너 */}
          <div className="bg-[var(--color-academy-success-soft)] border border-[var(--color-academy-success)] rounded-lg p-6 text-center">
            <h2 className="text-lg font-bold text-[var(--color-academy-success)]">이관 완료</h2>
            {/* 개발자 표현(DB 삽입)만 다듬고 성공 안내는 유지 */}
            <p className="text-sm text-[var(--color-academy-success)] mt-1">
              데이터가 성공적으로 저장되었습니다.
            </p>
          </div>

          {/* 결과 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* 라벨에서 DB 모델 영문명 제거: 원장에게는 한국어 명칭만 의미가 있다 */}
            <ResultCard
              label="학부모"
              created={importResult.created.users}
              skipped={importResult.skipped.users}
            />
            <ResultCard
              label="학생"
              created={importResult.created.students}
              skipped={importResult.skipped.students}
            />
            <ResultCard
              label="수강"
              created={importResult.created.enrollments}
              skipped={importResult.skipped.enrollments}
            />
            <ResultCard
              label="결제"
              created={importResult.created.payments}
              skipped={importResult.skipped.payments}
            />
          </div>

          {importResult.sheetImport && (
            <div className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]/70 p-4 text-sm text-[var(--color-academy-ink)]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">시트 원본 저장</span>
                <span>원본 {importResult.sheetImport.rawRows.toLocaleString()}행</span>
                <span>등록 {importResult.sheetImport.registrationRows.toLocaleString()}행</span>
                <span>차량 {(importResult.sheetImport.shuttleRows ?? 0).toLocaleString()}행</span>
                <span>변동 {(importResult.sheetImport.changeRows ?? 0).toLocaleString()}행</span>
                <span>대표팀 {(importResult.sheetImport.teamRows ?? 0).toLocaleString()}행</span>
                <span>확인 필요 {importResult.sheetImport.issues.toLocaleString()}건</span>
              </div>
              {/* 내부 식별자(배치 ID) 표시 제거: 원장이 이 값으로 할 수 있는 조치가 없다 */}
            </div>
          )}

          {/* 실패 목록 */}
          {importResult.failed.length > 0 && (
            <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-danger)] rounded-lg p-4">
              <p className="text-sm font-medium text-[var(--color-academy-danger)] mb-2">
                실패 ({importResult.failed.length}건)
              </p>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {importResult.failed.map((f, i) => (
                  <p key={i} className="text-sm text-[var(--color-academy-danger)]">
                    행 {f.rowNumber} ({f.name}): {f.reason}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* 다시 시작 */}
          <div className="flex justify-center">
            <button
              onClick={handleReset}
              className="academy-button-primary"
            >
              새 이관 시작
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 서브 컴포넌트
// ──────────────────────────────────────────────

/** 최근 이관 기록 패널 */
function ImportHistoryPanel({
  batches,
  error,
  loading,
  onLoad,
}: {
  batches: ImportHistoryBatch[] | null;
  error: string | null;
  loading: boolean;
  onLoad: () => void;
}) {
  const [detail, setDetail] = useState<ImportDetailState | null>(null);

  const loadBatchDetail = async (batchId: string, type: ImportDetailType) => {
    setDetail({
      batchId,
      type,
      loading: true,
      error: null,
      total: 0,
      rows: null,
    });

    try {
      const params = new URLSearchParams({
        batchId,
        type,
        limit: "30",
      });
      const res = await fetch(`/api/admin/import-students/details?${params}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(adminMessageText(data.error, "상세 내역을 불러오지 못했습니다."));
      }

      setDetail({
        batchId,
        type,
        loading: false,
        error: null,
        total: data.total ?? 0,
        rows: Array.isArray(data.rows) ? data.rows : [],
      });
    } catch (err) {
      setDetail({
        batchId,
        type,
        loading: false,
        error: adminErrorText(err, "상세 내역을 불러오지 못했습니다."),
        total: 0,
        rows: [],
      });
    }
  };

  return (
    <section className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          {/* 내부 조회 동작 설명 제거 */}
          <h2 className="academy-section-title">
            최근 이관 기록
          </h2>
        </div>
        <button
          type="button"
          onClick={onLoad}
          disabled={loading}
          className="academy-button-secondary"
        >
          {loading ? "불러오는 중" : "최근 기록 불러오기"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">
          {error}
        </div>
      )}

      {/* 성능 최적화 설명문구 제거: 위 '최근 기록 불러오기' 버튼으로 자명 */}

      {batches?.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-academy-muted)]">
          아직 저장된 이관 기록이 없습니다.
        </p>
      ) : null}

      {batches && batches.length > 0 ? (
        <div className="mt-4 space-y-3">
          {batches.map((batch) => (
            <article
              key={batch.id}
              className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-4"
            >
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-success)]">
                      {BATCH_STATUS_LABEL[batch.status] ?? "상태 확인 필요"}
                    </span>
                    <span className="text-sm font-semibold text-[var(--color-academy-ink)]">
                      {batch.spreadsheetTitle || batch.source}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                    {new Date(batch.createdAt).toLocaleString("ko-KR")}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs md:min-w-72">
                  <ImportMetric label="원본" value={batch.totalRows} />
                  <ImportMetric label="등록" value={batch.registrationRows} />
                  <ImportMetric
                    label="확인"
                    value={batch.errorRows}
                    tone={batch.errorRows > 0 ? "warn" : "ok"}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--color-academy-muted)]">
                <span>차량 {batch.vehicleRows.toLocaleString()}건</span>
                <span>변동 {batch.changeRows.toLocaleString()}건</span>
                <span>대표팀 {batch.teamRows.toLocaleString()}건</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {([
                  ["shuttle", "차량 확인"],
                  ["changes", "변동 확인"],
                  ["team", "대표팀 확인"],
                  ["issues", "이슈 확인"],
                ] as const).map(([type, label]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => void loadBatchDetail(batch.id, type)}
                    disabled={detail?.batchId === batch.id && detail.type === type && detail.loading}
                    className="academy-button-tonal academy-button-sm disabled:cursor-wait"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {detail?.batchId === batch.id ? <ImportDetailBox detail={detail} /> : null}

              {batch.message ? (
                <p className="mt-2 text-sm text-[var(--color-academy-muted)]">{batch.message}</p>
              ) : null}

              {batch.issues.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {batch.issues.map((issue) => (
                    <div
                      key={issue.id}
                      className="rounded-md border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]"
                    >
                      <span className="font-semibold">{issue.severity}</span>
                      {issue.sheetName ? ` · ${issue.sheetName}` : ""}
                      {issue.rowNumber ? ` ${issue.rowNumber}행` : ""} · {issue.message}
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ImportDetailBox({ detail }: { detail: ImportDetailState }) {
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-academy-line)] bg-white p-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="academy-section-title">
          {getImportDetailTitle(detail.type)}
        </h3>
        <p className="text-xs text-[var(--color-academy-muted)]">
          전체 {detail.total.toLocaleString()}건 중 최대 30건 표시
        </p>
      </div>

      {detail.loading ? (
        <p className="mt-3 text-sm text-[var(--color-academy-muted)]">
          상세 내역을 불러오는 중입니다.
        </p>
      ) : null}

      {detail.error ? (
        <div className="mt-3 rounded-md border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs text-[var(--color-academy-danger)]">
          {detail.error}
        </div>
      ) : null}

      {!detail.loading && !detail.error && detail.rows?.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-academy-muted)]">
          표시할 상세 내역이 없습니다.
        </p>
      ) : null}

      {!detail.loading && !detail.error && detail.rows && detail.rows.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {detail.rows.map((row, index) => (
            <DetailRowCard key={String(row.id ?? index)} type={detail.type} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetailRowCard({ type, row }: { type: ImportDetailType; row: ImportDetailRow }) {
  if (type === "shuttle") {
    return (
      <div className="rounded-md bg-[var(--color-academy-soft)] px-3 py-2 text-xs text-[var(--color-academy-muted)]">
        <p className="font-semibold text-[var(--color-academy-ink)]">
          {detailText(row, "monthLabel")} · {detailText(row, "dayLabel")} {detailText(row, "classTime")}
        </p>
        <p className="mt-1">
          {detailText(row, "studentName")} · 도착 {detailText(row, "arrivalTime")} · {detailText(row, "destination")}
        </p>
        <p className="mt-1 text-[var(--color-academy-muted)]">
          {detailText(row, "memo") !== "-" ? detailText(row, "memo") : detailText(row, "note")}
        </p>
      </div>
    );
  }

  if (type === "changes") {
    return (
      <div className="rounded-md bg-[var(--color-academy-soft)] px-3 py-2 text-xs text-[var(--color-academy-muted)]">
        <p className="font-semibold text-[var(--color-academy-ink)]">
          {detailDate(row, "occurredAt")} · {detailText(row, "changeSummary")}
        </p>
        <p className="mt-1">
          등록 {detailBoolean(row, "registrationReflected")} · 랠리즈 {detailBoolean(row, "rallyzReflected")} · 차량 {detailBoolean(row, "vehicleReflected")}
        </p>
        <p className="mt-1 text-[var(--color-academy-muted)]">{detailText(row, "note")}</p>
      </div>
    );
  }

  if (type === "team") {
    return (
      <div className="rounded-md bg-[var(--color-academy-soft)] px-3 py-2 text-xs text-[var(--color-academy-muted)]">
        <p className="font-semibold text-[var(--color-academy-ink)]">
          #{detailText(row, "jerseyNumber")} {detailText(row, "studentName")}
        </p>
        <p className="mt-1">
          {detailText(row, "grade")} · {detailText(row, "branch")} · {detailText(row, "phone")}
        </p>
        <p className="mt-1 text-[var(--color-academy-muted)]">
          원생 연결 {detailText(row, "studentId") !== "-" ? "완료" : "확인 필요"}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">
      <p className="font-semibold">
        {detailText(row, "severity")} · {detailText(row, "sheetName")}
        {detailText(row, "rowNumber") !== "-" ? ` ${detailText(row, "rowNumber")}행` : ""}
      </p>
      <p className="mt-1">{detailText(row, "message")}</p>
    </div>
  );
}

function getImportDetailTitle(type: ImportDetailType) {
  if (type === "shuttle") return "차량 상세";
  if (type === "changes") return "변동내역 상세";
  if (type === "team") return "대표팀 상세";
  return "확인 필요 이슈";
}

function detailText(row: ImportDetailRow, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function detailDate(row: ImportDetailRow, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) return "-";
  return new Date(value).toLocaleDateString("ko-KR");
}

function detailBoolean(row: ImportDetailRow, key: string) {
  return row[key] ? "완료" : "대기";
}

function ImportMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "warn";
}) {
  const toneClass =
    tone === "warn"
      ? "text-[var(--color-academy-warning)]"
      : tone === "ok"
      ? "text-[var(--color-academy-success)]"
      : "text-[var(--color-academy-ink)]";

  return (
    <div className="rounded-md bg-white px-2 py-2">
      <p className="text-[var(--color-academy-muted)]">{label}</p>
      <p className={`font-semibold tabular-nums ${toneClass}`}>{value.toLocaleString()}</p>
    </div>
  );
}

/** 단계 표시 바 */
function StepIndicator({ current }: { current: "upload" | "preview" | "result" }) {
  const steps = [
    { key: "upload", label: "CSV 입력", icon: "upload_file" },
    { key: "preview", label: "미리보기", icon: "preview" },
    { key: "result", label: "완료", icon: "check_circle" },
  ];

  const currentIdx = steps.findIndex((s) => s.key === current);

  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          {i > 0 && (
            <div
              className={`w-8 h-0.5 ${
                i <= currentIdx ? "bg-[var(--color-academy-secondary-strong)]" : "bg-[var(--color-academy-line)]"
              }`}
            />
          )}
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${
              i === currentIdx
                ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)]"
                : i < currentIdx
                ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                : "bg-[var(--color-academy-soft)] text-[var(--color-academy-faint)]"
            }`}
          >
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 요약 카드 */
function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: number;
  icon: string;
  color?: string;
}) {

  return (
    <div className="bg-white rounded-lg shadow-sm border p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-[var(--color-academy-muted)]">{label}</span>
      </div>
      <p className="text-lg font-semibold tabular-nums text-[var(--color-academy-ink)]">{value.toLocaleString()}</p>
    </div>
  );
}

/** 결과 카드 (생성/건너뜀 표시) */
function ResultCard({
  label,
  created,
  skipped,
}: {
  label: string;
  created: number;
  skipped: number;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-4">
      <p className="text-sm font-medium text-[var(--color-academy-muted)] mb-2">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-[var(--color-academy-success)]">생성</span>
          <span className="font-semibold tabular-nums text-[var(--color-academy-success)]">{created}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--color-academy-faint)]">건너뜀 (중복)</span>
          <span className="text-[var(--color-academy-muted)]">{skipped}</span>
        </div>
      </div>
    </div>
  );
}
