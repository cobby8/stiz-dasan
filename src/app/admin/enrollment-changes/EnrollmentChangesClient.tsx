"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
// 시트·랠리즈 확인은 결과 객체를 돌려주는 래퍼만 부른다.
// (운영 동기화 함수를 직접 부르면 실패 이유가 운영 빌드에서 영어 일반 문구로 가려진다.)
import {
  applyEnrollmentChangeSheet,
  confirmEnrollmentChangeRallyz,
  confirmEnrollmentChangeSheetManually,
  decideEnrollmentChange,
  decideEnrollmentChangeCancelRequest,
  issueEnrollmentChangeInvoice,
  markPauseCarryHandled,
  markPauseTuitionLineDone,
  releaseEnrollmentChangeHoldSheetRetired,
  retryPauseTuitionRefund,
  settlePauseTuition,
  type EnrollmentSyncActionResult,
} from "@/app/actions/enrollment-changes";
import { CHANGE_STATUS_LABEL, pauseResumeLabel, syncCheckBadge } from "@/lib/enrollment/changeRequestRules";
import { isSheetTargetDone } from "@/lib/operations-sync/sheetRetirement";
import type { AdminCancelRequestRow, AdminChangeRequestRow } from "@/lib/enrollment/admin-change-request";
import { SETTLEMENT_MODES, SETTLEMENT_MODE_LABEL, SETTLEMENT_PROBLEM_APPROVE_NOTE, type SettlementMode } from "@/lib/enrollment/pause-settlement-plan";
import { RESUME_ADAPTER_HOLD_REASON, sheetHoldDisplayReason } from "@/lib/enrollment/sheetManualCheckRules";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

const ENROLLMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "수강 중",
  PAUSED: "휴원",
  WITHDRAWN: "퇴원",
  COMPLETED: "수료",
  PENDING: "수강 예정",
};

const FILTERS = [
  { value: "PENDING", label: "검토 중" },
  // 사이트에는 자동 반영됐지만 시트·랠리즈 확인이 남은 건
  { value: "NEEDS_CHECK", label: "확인 필요" },
  { value: "APPROVED", label: "승인" },
  { value: "REJECTED", label: "거절" },
  { value: "ALL", label: "전체" },
];

export default function EnrollmentChangesClient({
  rows,
  status,
  needsCheckCount = 0,
  sheetRetired = false,
  rallyzRetired = true,
  cancelRequests = [],
  openSettlementCount = 0,
  inline = false,
  onRefresh,
}: {
  rows: AdminChangeRequestRow[];
  /** 휴원 수강료 처리 중 남은 일(사람 환불·랠리즈 반영·토스 확인 중·남은 이월)이 있는 건수 */
  openSettlementCount?: number;
  /** 승인된 휴원·퇴원에 학부모가 낸 «취소 요청»(d8) — 탭과 무관하게 맨 위에 보인다 */
  cancelRequests?: AdminCancelRequestRow[];
  status?: string;
  inline?: boolean;
  onRefresh?: () => Promise<void>;
  needsCheckCount?: number;
  /** 시트 원장 은퇴(2026-10~) 여부 — 서버(page.tsx)가 환경변수로 판정해 넘긴다. true 면 안내에서 "시트"를 뺀다. */
  sheetRetired?: boolean;
  /**
   * 랠리즈 은퇴(2026-11-14 원장 결정) 여부 — 서버(page.tsx)가 환경변수로 판정해 넘긴다.
   * 기본값 true(은퇴): «랠리즈 반영 확인» 버튼·안내·대기 표시를 그리지 않는다. false 는 스위치 "0"(옛 방식)일 때만.
   */
  rallyzRetired?: boolean;
}) {
  const router = useRouter();
  // 사람이 직접 반영해야 하는 외부 장부 이름. 시트 은퇴 후엔 랠리즈만 남는다.
  const externalLabel = sheetRetired ? "랠리즈" : "시트·랠리즈";
  // 랠리즈 은퇴 뒤 화면에 쓰는 이름 — 랠리즈를 뺀다. 시트도 은퇴했으면 남는 외부 장부가 없다(null).
  const externalNote = rallyzRetired ? (sheetRetired ? null : "시트") : externalLabel;

  // 확인 상태 배지. 랠리즈 은퇴 뒤에는 랠리즈 칸을 «확인할 일»로 보지 않는다(끝난 칸으로 취급).
  // 보류(HELD)된 건은 랠리즈와 무관하게 사람이 봐야 하므로 «보류 확인 필요»로 남긴다.
  function checkBadge(row: AdminChangeRequestRow) {
    if (!rallyzRetired) return syncCheckBadge(row.sheetStatus, row.rallyzStatus);
    if (!row.sheetStatus && !row.rallyzStatus) return null;
    const badge = syncCheckBadge(row.sheetStatus, row.rallyzStatus ? "SUCCEEDED" : row.rallyzStatus);
    if (badge && !badge.needsCheck && row.syncCommandStatus === "HELD") return { label: "사이트 반영됨 · 보류 확인 필요", needsCheck: true };
    return badge;
  }
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  // 행 클릭 상세 패널 대상(신청 id) — 확인 단계·일할 계산·승인 입력은 패널에 있다
  const [detailId, setDetailId] = useState<string | null>(null);

  async function refreshResults() {
    await onRefresh?.();
    router.refresh();
  }

  function issueInvoice(requestId: string) {
    const row = rows.find(item => item.id === requestId);
    if (!row?.proration || !window.confirm(`${row.studentName} · ${row.effectiveFrom}\n${row.fromClassName} → ${row.toClassName}\n차액 ${row.proration.diff.toLocaleString()}원 사이트 청구서 1건을 생성할까요?\n${externalNote ? `문자·알림 발송과 ${externalNote} 반영은 포함되지 않습니다.` : "문자·알림 발송은 포함되지 않습니다."}`)) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await issueEnrollmentChangeInvoice(requestId, row.invoicePreviewKey);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        await refreshResults();
      } catch {
        setError("청구 처리 결과를 확인하지 못했습니다. 새로고침하여 생성 여부를 확인한 뒤 다시 시도해 주세요.");
      }
    });
  }

  // 구글 시트에 휴원·퇴원을 반영한다. 시트를 실제로 고치므로 확인창을 한 번 띄운다.
  function applySheet(row: AdminChangeRequestRow) {
    if (!row.syncCommandId) return;
    if (!window.confirm(`${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}\n구글 시트에 ${row.effectiveFrom.slice(0, 7)} ${row.kindLabel}을(를) 반영할까요?`)) return;
    runSyncAction(() => applyEnrollmentChangeSheet(row.syncCommandId!));
  }

  // 시트 행 없음·학생 식별 불가·공통 상태 충돌처럼 자동 반영이 끝내 안 되는 건의 탈출구.
  // 원장이 구글 시트를 직접 고친 뒤 누르면 시트 확인 완료로 기록되고(감사기록 남음) 랠리즈 확인으로 넘어간다.
  function confirmSheetManually(row: AdminChangeRequestRow) {
    if (!row.syncCommandId) return;
    if (!window.confirm(`${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}
구글 시트를 직접 고쳤습니까?
확인을 누르면 시트 반영 완료(수동 확인)로 기록됩니다.`)) return;
    runSyncAction(() => confirmEnrollmentChangeSheetManually(row.syncCommandId!));
  }

  // 시트 은퇴 상태에서 복귀(RESUME) 보류를 푼다. 풀린 뒤 '랠리즈 반영 확인'을 눌러야 완료된다.
  function releaseRetiredResumeHold(row: AdminChangeRequestRow) {
    if (!row.syncCommandId) return;
    // 랠리즈 은퇴 뒤에는 이어지는 랠리즈 확인 단계가 없다 — 보류만 푼다.
    if (!window.confirm(rallyzRetired
      ? `${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}
구글 시트 운영이 끝나 시트 확인 없이 보류를 풉니다.
보류를 풀까요?`
      : `${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}
구글 시트 운영이 끝나 시트 확인 없이 보류를 풉니다.
보류를 풀고 랠리즈 반영 확인으로 넘어갈까요?`)) return;
    runSyncAction(() => releaseEnrollmentChangeHoldSheetRetired(row.syncCommandId!));
  }

  // 랠리즈는 자동으로 바꾸지 않는다. 원장이 랠리즈에서 직접 처리한 뒤 "처리했다"를 기록한다.
  function confirmRallyz(row: AdminChangeRequestRow) {
    if (!row.syncCommandId) return;
    if (!window.confirm(`${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}\n랠리즈에서 ${row.kindLabel} 처리를 직접 마쳤나요?\n확인을 누르면 랠리즈 반영 완료로 기록됩니다.`)) return;
    runSyncAction(() => confirmEnrollmentChangeRallyz(row.syncCommandId!));
  }

  function runSyncAction(action: () => Promise<EnrollmentSyncActionResult>) {
    setError("");
    startTransition(async () => {
      try {
        const result = await action();
        // 서버가 돌려준 한국어 실패 이유를 그대로 보여 준다(보류로 바뀌었을 수 있어 목록도 새로 읽는다).
        if (!result.ok) setError(result.message);
        await refreshResults();
      } catch {
        // 네트워크 끊김 등 결과 자체를 못 받은 경우만 여기로 온다.
        setError("반영 확인을 저장하지 못했습니다. 새로고침 후 다시 시도해 주세요.");
        await refreshResults();
      }
    });
  }

  // 학부모 취소 요청(d8) 승인·거절. 승인 = 그 휴원·퇴원 신청을 취소(적용 전에만 — 서버가 다시 확인)
  function decideCancel(row: AdminCancelRequestRow, approve: boolean) {
    const question = approve
      ? `${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}(${row.effectiveFrom}부터)\n승인된 ${row.kindLabel}을 취소할까요? 학부모에게 앱 알림이 갑니다.`
      : `${row.studentName} · ${row.kindLabel} 취소 요청을 거절할까요? 원래 승인(${row.effectiveFrom}부터)은 그대로 진행됩니다.`;
    if (!window.confirm(question)) return;
    setError("");
    startTransition(async () => {
      const result = await decideEnrollmentChangeCancelRequest({ requestId: row.id, approve, note: notes[`cancel:${row.id}`] });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await refreshResults();
    });
  }

  // 휴원 수강료 처리 방식(신청 id → 이월·환불·없음). 고르기 전엔 비어 있다.
  const [modes, setModes] = useState<Record<string, SettlementMode>>({});

  /** 이 휴원에 처리할 금액이 있는가(낸 돈 또는 미납 청구) — 있으면 승인 전에 방식을 골라야 한다 */
  function needsSettlementChoice(row: AdminChangeRequestRow) {
    const p = row.settlementPreview;
    return Boolean(p && !row.settlement && p.problems.length === 0 && (p.paidTotal > 0 || p.unpaidTotal > 0));
  }

  /** 돈이 움직이는 처리라 확인창에 금액·길을 그대로 적는다(서버가 실행 순간 다시 계산해 같을 때만 실행) */
  function settlementConfirmText(row: AdminChangeRequestRow, mode: SettlementMode): string {
    const p = row.settlementPreview!;
    const won = (n: number) => `${n.toLocaleString()}원`;
    const lines = [`${row.studentName} · ${row.fromClassName ?? "-"} · 휴원 ${row.effectiveFrom}부터`, `수강료 처리: ${SETTLEMENT_MODE_LABEL[mode]}`];
    if (mode === "REFUND" && p.paidTotal > 0) {
      lines.push(`환불 ${won(p.paidTotal)}`);
      if (p.channels.includes("TOSS")) lines.push("· 토스 온라인 결제분은 확인을 누르면 바로 부분 취소됩니다(되돌릴 수 없음).");
      if (p.channels.some((c) => c !== "TOSS")) lines.push("· 현금·랠리즈·POS 등은 «환불 할 일»로 남습니다.");
    }
    if (mode === "CARRY" && p.paidTotal > 0) lines.push(`이월 ${won(p.paidTotal)} — 다음 청구에서 차감`);
    if (mode !== "NONE" && p.unpaidTotal > 0) lines.push(`미납 청구 ${won(p.unpaidTotal)} 감액`);
    if (mode === "NONE") lines.push("돈은 움직이지 않고 기록만 남깁니다.");
    return lines.join("\n");
  }

  function decide(requestId: string, approve: boolean) {
    const row = rows.find((item) => item.id === requestId);
    if (approve && row?.settlementReadFailed) return;
    const mode = modes[requestId];
    // 처리할 금액이 있는 휴원은 방식을 골라야 승인된다(⚡ 승인은 패널을 열어 고르게 한다)
    if (approve && row && needsSettlementChoice(row)) {
      if (!mode) {
        setDetailId(requestId);
        setError("휴원 수강료 처리(이월·환불·없음)를 먼저 골라 주세요.");
        return;
      }
      if (!window.confirm(`${settlementConfirmText(row, mode)}\n\n승인할까요?`)) return;
    }
    if (inline && approve && row && !needsSettlementChoice(row)
        && !window.confirm(`${row.fromClassName ?? "선택한 반"}의 ${row.kindLabel} 신청을 승인할까요?`)) return;
    setError("");
    startTransition(async () => {
      const settlement = approve && row && needsSettlementChoice(row) && mode
        ? { mode, expectedPreviewKey: row.settlementPreview!.previewKey }
        : null;
      const result = await decideEnrollmentChange({ requestId, approve, note: notes[requestId], settlement });
      if (!result.ok) {
        setError(result.message);
        // 서버가 «방식을 골라 주세요»로 거절(금액이 바뀜) → 상세 칸을 열어 새 미리보기(아래 새로고침)에서 고르게 한다
        if ("needsSettlementChoice" in result && result.needsSettlementChoice) setDetailId(requestId);
        await refreshResults();
        return;
      }
      // 토스 부분 취소가 확인되지 않았으면 승인은 됐지만 남은 일이 있다고 알린다
      const refund = result.settlement?.refund;
      if (refund && (refund.failed > 0 || refund.uncertain > 0)) {
        setError(`승인됐어요. 다만 토스 환불 ${refund.failed + refund.uncertain}건을 확인하지 못했어요: ${refund.messages[0] ?? ""} — 상세에서 «다시 시도»해 주세요.`);
      }
      await refreshResults();
    });
  }

  /** 이미 승인된 휴원의 수강료 처리 실행 */
  function settleLater(row: AdminChangeRequestRow) {
    const mode = modes[row.id];
    if (!mode || !row.settlementPreview) {
      setError("수강료 처리(이월·환불·없음)를 골라 주세요.");
      return;
    }
    if (!window.confirm(`${settlementConfirmText(row, mode)}\n\n실행할까요?`)) return;
    setError("");
    startTransition(async () => {
      const result = await settlePauseTuition({ requestId: row.id, settlement: { mode, expectedPreviewKey: row.settlementPreview!.previewKey } });
      if (!result.ok) setError(result.message);
      else if (result.settlement.refund && (result.settlement.refund.failed > 0 || result.settlement.refund.uncertain > 0)) {
        setError(`토스 환불 ${result.settlement.refund.failed + result.settlement.refund.uncertain}건을 확인하지 못했어요: ${result.settlement.refund.messages[0] ?? ""}`);
      }
      await refreshResults();
    });
  }

  function retryRefund(settlementId: string) {
    if (!window.confirm("토스 부분 취소를 다시 확인·시도할까요?\n이미 취소된 건은 다시 취소되지 않고 확인만 합니다.")) return;
    setError("");
    startTransition(async () => {
      const result = await retryPauseTuitionRefund(settlementId);
      if (result.refund.failed > 0 || result.refund.uncertain > 0) setError(result.refund.messages[0] ?? "토스 환불을 확인하지 못했어요.");
      await refreshResults();
    });
  }

  function markLineDone(lineId: string, todo: string) {
    if (!window.confirm(`${todo}\n\n직접 처리를 마쳤나요? 확인을 누르면 «직접 처리함»으로 기록됩니다.`)) return;
    setError("");
    startTransition(async () => {
      const result = await markPauseTuitionLineDone({ lineId });
      if (!result.ok) setError(result.message);
      await refreshResults();
    });
  }

  function markCarryDone(settlementId: string, amount: number) {
    if (!window.confirm(`남은 이월 ${amount.toLocaleString()}원을 다음 청구에서 직접 차감했나요?\n확인을 누르면 이월이 끝난 것으로 기록됩니다.`)) return;
    setError("");
    startTransition(async () => {
      const result = await markPauseCarryHandled({ settlementId });
      if (!result.ok) setError(result.message);
      await refreshResults();
    });
  }

  // 상태 배지 — 자동 적용 건은 원장(시트·랠리즈) 확인 상태가 곧 진짜 상태다. "반영 완료"는 셋 다 끝났을 때만.
  function statusBadge(row: AdminChangeRequestRow) {
    if (row.status === "APPROVED" && !row.appliedAt && (row.syncCommandStatus === "HELD" || row.effectiveDateReached)) {
      return <span className="text-xs font-medium text-[var(--color-academy-warning)]">반영 확인 필요</span>;
    }
    const badge = row.status === "APPLIED" ? checkBadge(row) : null;
    if (badge?.needsCheck) {
      return (
        <span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-warning)]">
          {badge.label}
        </span>
      );
    }
    return <span className="text-xs text-[var(--color-academy-muted)]">{badge?.label ?? CHANGE_STATUS_LABEL[row.status] ?? row.status}</span>;
  }

  // ⚡ 작업 — 검토 중(PENDING) 건의 승인·거절만(예전 카드 버튼과 같은 decide 호출, 확인창 없던 그대로).
  // 시트·랠리즈 확인·청구서 생성은 잠금 조건이 많아 상세 패널에서 예전 버튼 그대로 쓴다.
  function buildActions(row: AdminChangeRequestRow): AdminQuickAction[] {
    if (row.status !== "PENDING") return [];
    const id = row.id; // 대상 값을 미리 붙잡아 둔다
    // 처리할 수강료가 있는 휴원은 금액을 보고 이월·환불·없음을 골라야 해서 패널을 연다
    if (needsSettlementChoice(row)) {
      return [
        { key: "approve", label: "승인…(수강료 처리)", icon: "check", tone: "primary", disabled: pending, onSelect: () => setDetailId(id) },
        { key: "reject", label: "거절…", icon: "block", disabled: pending, onSelect: () => setDetailId(id) },
      ];
    }
    return [
      { key: "approve", label: "승인", icon: "check", tone: "primary", disabled: pending, onSelect: () => decide(id, true) },
      // 거절은 사유·전할 말을 보고 하도록 패널을 연다
      { key: "reject", label: "거절…", icon: "block", disabled: pending, onSelect: () => setDetailId(id) },
    ];
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  const detail = detailId ? rows.find((item) => item.id === detailId) ?? null : null;

  if (inline) {
    return (
      <div className="mt-3 space-y-3">
        {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
        {rows.map((row) => (
          <section key={row.id} className="rounded-xl border border-[var(--color-academy-line)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">
                {row.fromClassName ?? "수강 반 확인 필요"}{row.toClassName ? ` → ${row.toClassName}` : ""}
              </h3>
              {statusBadge(row)}
            </div>
            {renderDetail(row)}
            {cancelRequests.some((request) => request.id === row.id) && (
              <ul aria-label="학부모 취소 요청" className="mt-3 rounded-xl border border-[var(--color-academy-warning)]">
                {cancelRequests.filter((request) => request.id === row.id).map(renderCancelRequest)}
              </ul>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-3 p-4">
      <div>
        <h1 className="academy-page-title">수강 변경 신청</h1>
        {/* 원장 결정(2026-10-05): 휴원·퇴원은 사이트만 자동. 랠리즈·시트는 사람이 반영하고 확인을 눌러야 끝난다. */}
        {/* 시트 은퇴(2026-10~) 후엔 시트를 언급하지 않는다 — 남은 사람 일은 랠리즈뿐이다. */}
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
          {/* 랠리즈 은퇴(2026-11-14) 후엔 사람이 따로 반영·확인할 외부 장부가 없다 — 사이트 반영만 안내한다. */}
          {rallyzRetired
            ? "적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다(적용일이 이미 지난 건은 승인 즉시). 반 변경은 적용일에 자동으로 바뀌지 않습니다. 학부모 알림은 별도 승인 후 발송합니다."
            : sheetRetired
            ? "적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다. 랠리즈에 직접 반영한 뒤 '랠리즈 반영 확인'을 눌러 주세요. 적용일이 이미 지난 건은 승인 즉시 반영됩니다. 반 변경은 적용일에 자동으로 바뀌지 않습니다. 학부모 알림은 별도 승인 후 발송합니다."
            : "적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다(적용일이 이미 지난 건은 승인 즉시). 랠리즈·시트는 직접 반영한 뒤 '랠리즈 반영 확인'을 눌러 주세요. 반 변경은 적용일에 자동으로 바뀌지 않습니다. 학부모 알림은 별도 승인 후 발송합니다."}
        </p>
      </div>

      {/* 다른 탭을 보고 있어도 확인이 남은 건을 놓치지 않게 맨 위에 띄운다. */}
      {needsCheckCount > 0 && status !== "NEEDS_CHECK" && (
        <button
          type="button"
          onClick={() => { setDetailId(null); router.push("/admin/enrollment-changes?status=NEEDS_CHECK"); }}
          className="block min-h-11 w-full rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-left text-sm font-medium text-[var(--color-academy-warning)]"
        >
          {rallyzRetired
            ? <>사이트에 반영된 뒤 확인이 남은 건이 {needsCheckCount}건 있습니다. 눌러서 확인하세요.</>
            : <>사이트에만 반영되고 {externalLabel} 확인이 남은 건이 {needsCheckCount}건 있습니다. 눌러서 확인하세요.</>}
        </button>
      )}

      {/* 휴원 수강료 처리 남은 일(현금·랠리즈 환불, 토스 확인 중, 남은 이월) — 관리자 할 일 */}
      {openSettlementCount > 0 && status !== "ALL" && (
        <button
          type="button"
          onClick={() => { setDetailId(null); router.push("/admin/enrollment-changes?status=ALL"); }}
          className="block min-h-11 w-full rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-left text-sm font-medium text-[var(--color-academy-warning)]"
        >
          휴원 수강료 처리에 남은 일이 {openSettlementCount}건 있습니다(환불·감액·이월). 눌러서 확인하세요.
        </button>
      )}

      {/* 학부모 «취소 요청»(d8) — 승인됐지만 적용 전인 휴원·퇴원. 적용일 전에 처리해야 하므로 탭과 무관하게 맨 위 */}
      {cancelRequests.length > 0 && (
        <section aria-labelledby="cancel-requests-heading" className="rounded-xl border border-[var(--color-academy-warning)] bg-[var(--color-academy-surface)]">
          <h2 id="cancel-requests-heading" className="border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-warning)]">
            학부모 취소 요청 {cancelRequests.length}건 · 적용일 전에 처리해 주세요
          </h2>
          <ul className="divide-y divide-[var(--color-academy-line)]">
            {cancelRequests.map(renderCancelRequest)}
          </ul>
        </section>
      )}

      {/* 상태 필터 — 서버가 상태별로 읽어 주므로(다른 상태 건수는 모름) 건수 칩 대신 예전 버튼을 유지 */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={status === item.value}
            onClick={() => { setDetailId(null); router.push(`/admin/enrollment-changes?status=${item.value}`); }}
            className={`academy-choice is-tab${status === item.value ? " is-selected" : ""}`}
          >
            {item.label}
            {item.value === "NEEDS_CHECK" && needsCheckCount > 0 ? ` ${needsCheckCount}` : ""}
          </button>
        ))}
      </div>

      {error && !detail && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
          해당하는 신청이 없습니다
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {/* 한 줄 행: 예전 «기존 반 → 바꿀 반 · 적용일부터 · 복귀 예정» 을 칸별로 나눴다 */}
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-semibold text-[var(--color-academy-muted)]">
              <tr>
                <th className="admin-cell-num hidden px-2 py-2 md:table-cell">신청</th>
                <th className="px-2 py-2">원생</th>
                <th className="px-2 py-2">종류</th>
                <th className="px-2 py-2">상태</th>
                <th className="hidden px-2 py-2 sm:table-cell">기존 반</th>
                <th className="hidden px-2 py-2 sm:table-cell">바꿀 반</th>
                <th className="admin-cell-num px-2 py-2">적용일</th>
                <th className="admin-cell-num hidden px-2 py-2 lg:table-cell">복귀 예정</th>
                <th className="admin-cell-num hidden px-2 py-2 lg:table-cell">차액</th>
                <th className="admin-cell-center px-2 py-2">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {rows.map((row) => {
                const actions = buildActions(row);
                const diff = row.proration && row.proration.needsProration && !row.proration.scheduleUnavailable ? row.proration.diff : null;
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    aria-label={`${row.studentName} ${row.kindLabel} 신청 상세 보기`}
                    onClick={() => setDetailId(row.id)}
                    onKeyDown={(event) => handleRowKeyDown(event, row.id)}
                    className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                  >
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{row.createdAt}</td>
                    <td className="px-2 py-1.5 font-medium text-[var(--color-academy-ink)]">{row.studentName}</td>
                    <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{row.kindLabel}</td>
                    <td className="px-2 py-1.5">{statusBadge(row)}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] sm:table-cell">{row.fromClassName ?? "-"}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] sm:table-cell">
                      {row.toClassName ?? "-"}
                      {/* 희망 반 정원이 지금도 차 있으면 표시만, 설명은 상세 패널 */}
                      {row.toClassName && row.toClassFull && (
                        <span className="ml-1 text-xs text-[var(--color-academy-warning)]" aria-label="희망 반 정원 마감">마감</span>
                      )}
                    </td>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">
                      {row.effectiveFrom}
                      {row.kind === "PAUSE" && <span className="mt-0.5 block text-xs font-normal text-[var(--color-academy-muted)] lg:hidden">{pauseResumeLabel(row.resumeOn)}</span>}
                    </td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] lg:table-cell">{row.kind === "PAUSE" ? pauseResumeLabel(row.resumeOn) : "-"}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-ink)] lg:table-cell">{diff === null || diff === 0 ? "-" : `${diff > 0 ? "+" : ""}${diff.toLocaleString()}원`}</td>
                    {/* 관리: ⚡(승인·거절). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                    <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                      {actions.length > 0 ? (
                        <AdminQuickActionMenu label={`${row.studentName} ${row.kindLabel} 빠른 작업`} actions={actions} />
                      ) : (
                        <span className="text-xs text-[var(--color-academy-muted)]">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 행 클릭 상세 패널 — 예전 카드 본문(시트·랠리즈 확인 단계, 일할 계산·청구서, 승인·거절 입력)을 그대로 옮겼다 */}
      {detail && (() => {
        const row = detail;
        return (
          <ListDetailPanel onClose={() => setDetailId(null)} titleId="enrollment-change-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 id="enrollment-change-detail-panel-title" className="min-w-0 break-keep text-lg font-bold text-[var(--color-academy-ink)]">{row.studentName}</h3>
              <span className="rounded-lg bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-ink)]">{row.kindLabel}</span>
              {statusBadge(row)}
              {row.appliedAt && <span className="text-xs font-medium text-[var(--color-academy-success)]">사이트 반영 <span className="tabular-nums">{row.appliedAt}</span></span>}
              <button
                type="button"
                onClick={() => setDetailId(null)}
                aria-label="닫기"
                className="ml-auto academy-button-text academy-button-sm shrink-0"
              >
                닫기
              </button>
            </div>

            {error && <p role="alert" className="mb-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}

            {renderDetail(row)}
          </ListDetailPanel>
        );
      })()}
    </main>
  );

  function renderCancelRequest(row: AdminCancelRequestRow) {
    return (
      <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-sm">
        <span className="font-semibold text-[var(--color-academy-ink)]">{row.studentName}</span>
        <span className="text-[var(--color-academy-ink)]">{row.kindLabel} · {row.fromClassName ?? "-"}</span>
        <span className="tabular-nums text-[var(--color-academy-muted)]">{row.effectiveFrom}부터{row.kind === "PAUSE" ? ` · ${pauseResumeLabel(row.resumeOn)}` : ""}</span>
        {row.requestedAt && <span className="tabular-nums text-xs text-[var(--color-academy-muted)]">요청 {row.requestedAt}</span>}
        {row.reason && <span className="basis-full break-keep text-xs text-[var(--color-academy-ink)]">사유: {row.reason}</span>}
        {row.tooLate && <span className="basis-full text-xs font-medium text-[var(--color-academy-danger)]">적용일이 지났거나 이미 반영돼 취소할 수 없습니다 — 거절로 닫아 주세요.</span>}
        <input
          value={notes[`cancel:${row.id}`] ?? ""}
          onChange={(event) => setNotes((prev) => ({ ...prev, [`cancel:${row.id}`]: event.target.value }))}
          maxLength={500}
          placeholder="학부모에게 전할 말(거절 시 함께 전달)"
          aria-label={`${row.studentName} 취소 요청 답변`}
          className="academy-input min-w-0 flex-1"
        />
        <span className="flex shrink-0 gap-2">
          <button type="button" disabled={pending} onClick={() => decideCancel(row, false)} className="academy-button-secondary">
            요청 거절
          </button>
          <button type="button" disabled={pending || row.tooLate} onClick={() => decideCancel(row, true)} className="academy-button-primary">
            취소 승인
          </button>
        </span>
      </li>
    );
  }

  function renderDetail(row: AdminChangeRequestRow) {
    const enrollmentStatus = row.enrollmentStatus && ENROLLMENT_STATUS_LABEL[row.enrollmentStatus];
    return (
      <>
        {inline && (
          <p className="mt-1 text-xs font-medium text-[var(--color-academy-muted)]">
            사이트 수강 상태 · {enrollmentStatus ?? "확인 필요"}
            {row.appliedAt ? ` · 신청 반영 ${row.appliedAt}` : ""}
          </p>
        )}
        {/* 자동 적용 후 남은 확인 단계: 시트 반영(자동 또는 직접 수정 확인) → 랠리즈 반영 확인(서버도 이 순서를 요구한다). */}
        {row.status === "APPLIED" && row.syncCommandId && checkBadge(row)?.needsCheck && (() => {
          // 시트 은퇴로 건너뛴 칸(SKIPPED) = 시트 할 일 없음 → 시트 버튼 둘을 숨기고 랠리즈 잠금을 푼다.
          // 은퇴 전에 만들어진 PENDING/FAILED 시트 칸은 그대로 두어 '시트 직접 수정 완료'로 끝낼 수 있다.
          const sheetSkipped = row.sheetStatus === "SKIPPED";
          const sheetDone = isSheetTargetDone(row.sheetStatus);
          // 시트 은퇴 + 복귀 어댑터 보류 = 은퇴 후엔 풀어도 되는 보류(서버도 같은 판정 함수로 다시 확인한다).
          // 반 변경·학생 미확정 같은 다른 사유의 보류는 버튼 없이 사유만 보여 준다.
          const retiredResumeHold = sheetSkipped && row.syncCommandStatus === "HELD"
            && row.kind === "RESUME" && row.syncHoldReason?.trim() === RESUME_ADAPTER_HOLD_REASON;
          return (
          <div className="mt-3 space-y-2">
            {/* 보류 사유는 계속 보여 준다. 시트를 직접 고친 뒤 '시트 직접 수정 완료'로 이어갈 수 있다. */}
            {row.syncCommandStatus === "HELD" && (
              <p className="rounded-xl bg-[var(--color-academy-warning-soft)] p-2 text-xs font-medium text-[var(--color-academy-warning)]">
                {/* 영문 종류 코드가 섞인 저장 문구는 화면에서만 한국어로 다듬는다. */}
                {sheetSkipped
                  ? <>자동 반영 보류: {sheetHoldDisplayReason(row.kind, row.syncHoldReason)}{retiredResumeHold ? (rallyzRetired ? " — '보류 해제'를 눌러 주세요." : " — 랠리즈에 직접 반영한 뒤 '보류 해제 후 랠리즈 확인 진행'을 눌러 주세요.") : ""}</>
                  : <>시트 자동 반영 보류: {sheetHoldDisplayReason(row.kind, row.syncHoldReason)} — 구글 시트를 직접 고친 뒤 '시트 직접 수정 완료'를 눌러 주세요.</>}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              {/* 복귀(RESUME)는 시트 자동 반영을 지원하지 않는다 → 버튼을 숨기고 수동 확인만 쓴다. 시트 은퇴 칸도 숨긴다. */}
              {row.kind !== "RESUME" && !sheetSkipped && (
                <button
                  type="button"
                  disabled={pending || row.sheetStatus === "SUCCEEDED" || row.syncCommandStatus === "HELD"}
                  onClick={() => applySheet(row)}
                  className={`${rallyzRetired ? "col-span-2 " : ""}academy-button-secondary`}
                >
                  {row.sheetStatus === "SUCCEEDED" ? "시트 반영됨" : "시트에 반영"}
                </button>
              )}
              {/* 랠리즈 은퇴(2026-11-14) 뒤에는 «랠리즈 반영 확인» 버튼을 그리지 않는다. */}
              {!rallyzRetired && (
              <button
                type="button"
                disabled={pending || !sheetDone || row.rallyzStatus === "SUCCEEDED" || row.syncCommandStatus === "HELD"}
                onClick={() => confirmRallyz(row)}
                title={!sheetDone ? "시트 반영을 먼저 해 주세요" : undefined}
                className={`${row.kind === "RESUME" || sheetSkipped ? "col-span-2 " : ""}academy-button-primary`}
              >
                랠리즈 반영 확인
              </button>
              )}
              {/* 자동 시트 반영이 실패·보류된 건의 탈출구(항상 보조로 노출). 시트가 끝났으면 숨긴다. */}
              {!sheetSkipped && (row.sheetStatus !== "SUCCEEDED" || row.syncCommandStatus === "HELD") && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => confirmSheetManually(row)}
                  className="academy-button-secondary col-span-2"
                >
                  시트 직접 수정 완료
                </button>
              )}
              {/* 시트 은퇴 상태의 복귀 보류 탈출구 — 시트 칸은 그대로 두고 보류만 푼다(감사기록 남음). */}
              {retiredResumeHold && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => releaseRetiredResumeHold(row)}
                  className="academy-button-secondary col-span-2"
                >
                  {rallyzRetired ? "보류 해제" : "보류 해제 후 랠리즈 확인 진행"}
                </button>
              )}
              {!sheetDone && (
                <p className="col-span-2 text-xs text-[var(--color-academy-muted)]">{row.kind === "RESUME"
                  ? "복귀는 시트 자동 반영을 지원하지 않습니다 — 시트를 직접 고친 뒤 '시트 직접 수정 완료'를 눌러 주세요."
                  : rallyzRetired
                    ? "자동 반영이 안 되면 시트를 직접 고친 뒤 '시트 직접 수정 완료'를 눌러 주세요."
                    : "시트 반영을 먼저 하면 '랠리즈 반영 확인'을 누를 수 있습니다. 자동 반영이 안 되면 시트를 직접 고친 뒤 '시트 직접 수정 완료'를 눌러 주세요."}</p>
              )}
            </div>
          </div>
          );
        })()}

        {/* 적용일 처리에서 사람 확인으로 보류된 건(반 변경·이미 바뀐 상태 등). 사이트는 바뀌지 않았다. */}
        {row.status === "APPROVED" && (row.syncCommandStatus === "HELD" || row.effectiveDateReached) && (
          <p className="mt-2 rounded-xl bg-[var(--color-academy-soft)] p-2 text-xs font-medium text-[var(--color-academy-ink)]">
            적용일 도래 · {row.syncHoldReason ?? "신청 반영 상태를 확인해 주세요."}
          </p>
        )}

        <p className="mt-2 text-sm text-[var(--color-academy-ink)]">
          {row.fromClassName ?? "-"}
          {row.toClassName ? ` → ${row.toClassName}` : ""} · {row.effectiveFrom}부터
          {row.kind === "PAUSE" ? ` · ${pauseResumeLabel(row.resumeOn)}` : ""}
        </p>

        {/* 정원은 신청 당시가 아니라 지금 기준으로 다시 센다. 그 사이 자리가 났을 수 있다. */}
        {row.toClassName && row.toClassFull && (
          <p className="mt-2 rounded-xl bg-[var(--color-academy-warning-soft)] p-2 text-xs font-medium text-[var(--color-academy-warning)]">
            희망 반 정원이 지금도 차 있습니다{row.waitlisted ? " (신청 당시에도 마감)" : " (신청 당시에는 자리가 있었습니다)"}
          </p>
        )}
        {row.toClassName && !row.toClassFull && row.waitlisted && (
          <p className="mt-2 rounded-xl bg-[var(--color-academy-success-soft)] p-2 text-xs font-medium text-[var(--color-academy-success)]">
            신청 당시에는 마감이었지만 지금은 자리가 있습니다
          </p>
        )}

        {/* 일할 계산. 근거를 보여줘야 원장이 숫자를 믿고 발행할 수 있다.
            금액은 발행 시 서버가 다시 계산한다(여기 숫자는 표시용). */}
        {row.proration && row.proration.needsProration && (
          <div className="mt-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
            <p className="text-xs font-semibold text-[var(--color-academy-ink)]">수강료 일할 계산</p>
            {row.proration.lines.map((line) => (
              <p key={line} className="mt-1 text-xs text-[var(--color-academy-ink)]">{line}</p>
            ))}
            {!row.proration.scheduleUnavailable && (
              <p className="mt-2 text-sm font-semibold text-[var(--color-academy-ink)]">
                {row.proration.diff > 0
                  ? `추가 청구 ${row.proration.diff.toLocaleString()}원`
                  : row.proration.diff < 0
                    ? `${Math.abs(row.proration.diff).toLocaleString()}원은 다음 달 청구에서 차감하세요`
                    : "차액 없음"}
              </p>
            )}
            {row.status === "APPROVED" && row.proration.diff > 0 && !row.proration.scheduleUnavailable && (
              row.invoicedPaymentId ? (
                <p className="mt-2 text-xs font-medium text-[var(--color-academy-warning)]">{externalNote ? `차액 기록 있음 · 청구서 연결 및 ${externalNote} 반영·알림은 별도 확인 필요` : "차액 기록 있음 · 청구서 연결·알림은 별도 확인 필요"}</p>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => issueInvoice(row.id)}
                  className="academy-button-primary mt-2 w-full"
                >
                  차액 {row.proration.diff.toLocaleString()}원 사이트 청구서 생성
                </button>
              )
            )}
          </div>
        )}

        {/* 학생 상세 ⋯ «반 이동»으로 바로 적용한 건 — 차액 청구서는 여기서 따로 만들지 않는다 */}
        {row.adminDirectMove && (
          <p className="mt-2 text-xs font-medium text-[var(--color-academy-ink)]">관리자 즉시 이동 — 차액은 다음 달 청구 준비에서 반영</p>
        )}
        {/* 휴원 수강료 처리(2026-11-10 원장 결정 m6) — 이미 한 처리 기록 또는 미리보기·방식 고르기 */}
        {row.kind === "PAUSE" && row.settlement && (
          <SettlementRecord
            settlement={row.settlement}
            pending={pending}
            onRetry={() => retryRefund(row.settlement!.id)}
            onLineDone={markLineDone}
            onCarryDone={() => markCarryDone(row.settlement!.id, row.settlement!.carryRemaining)}
          />
        )}
        {row.kind === "PAUSE" && !row.settlement && row.settlementPreview && (
          <div className="mt-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
            <p className="text-xs font-semibold text-[var(--color-academy-ink)]">이번 휴원 수강료 처리</p>
            {row.settlementPreview.lines.length === 0 && row.settlementPreview.problems.length === 0 && (
              <p className="mt-1 text-xs text-[var(--color-academy-muted)]">휴원 기간에 걸친 수강료 청구가 없어 처리할 금액이 없습니다.</p>
            )}
            {row.settlementPreview.lines.map((line) => (
              <p key={line} className="mt-1 text-xs tabular-nums text-[var(--color-academy-ink)]">{line}</p>
            ))}
            {(row.settlementPreview.paidTotal > 0 || row.settlementPreview.unpaidTotal > 0) && (
              <p className="mt-2 text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">
                {row.settlementPreview.paidTotal > 0 ? `낸 수강료에서 ${row.settlementPreview.paidTotal.toLocaleString()}원` : ""}
                {row.settlementPreview.paidTotal > 0 && row.settlementPreview.unpaidTotal > 0 ? " · " : ""}
                {row.settlementPreview.unpaidTotal > 0 ? `미납 청구 ${row.settlementPreview.unpaidTotal.toLocaleString()}원 감액` : ""}
              </p>
            )}
            {row.settlementPreview.problems.map((problem) => (
              <p key={problem} className="mt-1 text-xs font-medium text-[var(--color-academy-danger)]">{problem}</p>
            ))}
            {/* 계산 문제가 있으면 방식을 고를 수 없다 — 검토 중이면 승인 결과를 미리 알린다(신청함과 같은 문구) */}
            {row.status === "PENDING" && row.settlementPreview.problems.length > 0 && (
              <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{SETTLEMENT_PROBLEM_APPROVE_NOTE}</p>
            )}
            {!row.settlementPreview.tablesReady && (
              <p className="mt-1 text-xs font-medium text-[var(--color-academy-warning)]">수강료 처리 기록 준비 전이라 지금은 금액 미리보기만 됩니다.</p>
            )}
            {needsSettlementChoice(row) && (
              <>
                <div role="radiogroup" aria-label="휴원 수강료 처리 방식" className="mt-2 grid grid-cols-3 gap-2">
                  {SETTLEMENT_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={modes[row.id] === mode}
                      onClick={() => setModes((prev) => ({ ...prev, [row.id]: mode }))}
                      className="academy-choice"
                    >
                      {SETTLEMENT_MODE_LABEL[mode]}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                  이월 = 다음 청구에서 차감 · 환불 = 토스 온라인 결제는 바로 부분 취소, 그 밖은 환불 할 일로 남김 · 없음 = 기록만(미납 청구도 그대로)
                </p>
                {/* 이미 승인된 휴원 = 여기서 처리만 실행. 검토 중이면 아래 «승인»이 처리까지 함께 한다 */}
                {row.status !== "PENDING" && (
                  <button
                    type="button"
                    disabled={pending || !modes[row.id] || !row.settlementPreview.ready}
                    onClick={() => settleLater(row)}
                    className="academy-button-primary mt-2 w-full"
                  >
                    수강료 처리 실행
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {row.reason && <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--color-academy-ink)]">{row.reason}</p>}
        <p className="mt-2 text-xs text-[var(--color-academy-muted)]">신청 {row.createdAt}</p>

        {row.settlementReadFailed && (
          <div className="mt-2 text-sm text-[var(--color-academy-warning)]">
            수강료 처리 내역을 확인하지 못했습니다.
            <button type="button" disabled={pending} onClick={() => startTransition(refreshResults)} className="academy-button-text ml-2">
              다시 조회
            </button>
          </div>
        )}
        {row.status === "PENDING" ? (
          <div className="mt-3 space-y-2">
            <input
              value={notes[row.id] ?? ""}
              onChange={(event) => setNotes((prev) => ({ ...prev, [row.id]: event.target.value }))}
              maxLength={500}
              placeholder="학부모에게 전할 말 (거절 시 함께 전달됩니다)"
              className="academy-input"
            />
            {/* 복귀(RESUME)도 승인하면 복귀일에 휴원 → 수강 중으로 자동 반영된다(due-change-plan). */}
            {(row.kind === "PAUSE" || row.kind === "WITHDRAW" || row.kind === "RESUME") && (
              <p className="text-xs text-[var(--color-academy-muted)]">승인하면 적용일({row.effectiveFrom})에 사이트에 자동 반영됩니다.{rallyzRetired ? "" : ` ${sheetRetired ? "랠리즈는" : "랠리즈·시트는"} 직접 반영해 주세요.`}</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => decide(row.id, false)}
                className="academy-button-secondary"
              >
                거절
              </button>
              <button
                type="button"
                // 처리할 수강료가 있으면 방식을 고르고 표가 준비돼야 승인(처리까지 한 번에)
                disabled={pending || row.settlementReadFailed || (needsSettlementChoice(row) && (!modes[row.id] || !row.settlementPreview?.ready))}
                onClick={() => decide(row.id, true)}
                className="academy-button-primary"
              >
                {needsSettlementChoice(row) && modes[row.id] ? `승인 · ${SETTLEMENT_MODE_LABEL[modes[row.id]]}` : "승인"}
              </button>
            </div>
          </div>
        ) : (
          row.decisionNote && (
            <p className="mt-2 rounded-xl bg-[var(--color-academy-soft)] p-2 text-xs text-[var(--color-academy-ink)]">
              메모: {row.decisionNote}
            </p>
          )
        )}
      </>
    );
  }

}

type SettlementViewProp = NonNullable<AdminChangeRequestRow["settlement"]>;

const LINE_KIND_LABEL: Record<string, string> = {
  REFUND: "환불",
  CARRY_CREDIT: "이월 적립",
  UNPAID_REDUCE: "미납 감액",
  NONE: "기록만",
  CARRY_APPLY: "이월 차감",
  CARRY_MANUAL: "이월 직접 차감",
};
const LINE_STATUS_LABEL: Record<string, string> = {
  DONE: "완료",
  DONE_MANUAL: "직접 처리함",
  TODO: "할 일",
  REQUESTED: "확인 중",
  FAILED: "실패",
};

/**
 * 이미 실행한 휴원 수강료 처리 — 무엇을(방식)·얼마·언제·누가 + 줄별 결과·남은 일.
 * 남은 일: 사람 환불·랠리즈 감액 → «직접 처리함» · 토스 확인 중·실패 → «다시 시도» · 남은 이월 → «직접 차감함».
 */
function SettlementRecord({ settlement, pending, onRetry, onLineDone, onCarryDone }: {
  settlement: SettlementViewProp;
  pending: boolean;
  onRetry: () => void;
  onLineDone: (lineId: string, todo: string) => void;
  onCarryDone: () => void;
}) {
  const hasTossRetry = settlement.lines.some((line) => line.channel === "TOSS" && line.kind === "REFUND" && (line.status === "REQUESTED" || line.status === "FAILED"));
  return (
    <div className="mt-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
      <p className="text-xs font-semibold text-[var(--color-academy-ink)]">
        휴원 수강료 처리 · {SETTLEMENT_MODE_LABEL[settlement.mode]}
        <span className={`ml-2 ${settlement.status === "DONE" ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-warning)]"}`}>
          {settlement.status === "DONE" ? "끝남" : "남은 일 있음"}
        </span>
      </p>
      <p className="mt-1 text-xs tabular-nums text-[var(--color-academy-muted)]">
        {settlement.createdAt} · {settlement.decidedByName ?? "관리자"} · 낸 수강료 {settlement.paidAmount.toLocaleString()}원
        {settlement.unpaidAmount > 0 ? ` · 미납 감액 ${settlement.unpaidAmount.toLocaleString()}원` : ""}
      </p>
      <ul className="mt-2 space-y-1">
        {settlement.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-academy-ink)]">
            <span className="tabular-nums">{line.ym ?? "-"}</span>
            <span>{LINE_KIND_LABEL[line.kind] ?? line.kind}</span>
            <span className="tabular-nums">{line.amount.toLocaleString()}원</span>
            <span className={line.status === "FAILED" ? "font-medium text-[var(--color-academy-danger)]" : line.todo ? "font-medium text-[var(--color-academy-warning)]" : "text-[var(--color-academy-muted)]"}>
              {LINE_STATUS_LABEL[line.status] ?? line.status}
            </span>
            {line.todo && <span className="basis-full text-[var(--color-academy-warning)]">{line.todo}</span>}
            {!line.todo && line.message && <span className="text-[var(--color-academy-muted)]">{line.message}</span>}
            {(line.status === "TODO" || line.status === "FAILED") && line.todo && (
              <button
                type="button"
                disabled={pending}
                onClick={() => onLineDone(line.id, line.todo!)}
                className="academy-button-tonal academy-button-sm"
              >
                직접 처리함
              </button>
            )}
          </li>
        ))}
      </ul>
      {settlement.carryRemaining > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium text-[var(--color-academy-warning)]">
          <span>남은 이월 {settlement.carryRemaining.toLocaleString()}원 — 사이트에 다음 미납 수강료 청구가 생기면 자동 차감(매일)</span>
          <button
            type="button"
            disabled={pending}
            onClick={onCarryDone}
            className="academy-button-tonal academy-button-sm"
          >
            직접 차감함
          </button>
        </div>
      )}
      {hasTossRetry && (
        <button
          type="button"
          disabled={pending}
          onClick={onRetry}
          className="academy-button-secondary mt-2 w-full"
        >
          토스 부분 취소 다시 시도·확인
        </button>
      )}
    </div>
  );
}
