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
  issueEnrollmentChangeInvoice,
  releaseEnrollmentChangeHoldSheetRetired,
  type EnrollmentSyncActionResult,
} from "@/app/actions/enrollment-changes";
import { CHANGE_STATUS_LABEL, syncCheckBadge } from "@/lib/enrollment/changeRequestRules";
import { isSheetTargetDone } from "@/lib/operations-sync/sheetRetirement";
import type { AdminChangeRequestRow } from "@/lib/enrollment/admin-change-request";
import { RESUME_ADAPTER_HOLD_REASON, sheetHoldDisplayReason } from "@/lib/enrollment/sheetManualCheckRules";

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
}: {
  rows: AdminChangeRequestRow[];
  status: string;
  needsCheckCount?: number;
  /** 시트 원장 은퇴(2026-10~) 여부 — 서버(page.tsx)가 환경변수로 판정해 넘긴다. true 면 안내에서 "시트"를 뺀다. */
  sheetRetired?: boolean;
}) {
  const router = useRouter();
  // 사람이 직접 반영해야 하는 외부 장부 이름. 시트 은퇴 후엔 랠리즈만 남는다.
  const externalLabel = sheetRetired ? "랠리즈" : "시트·랠리즈";
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  function issueInvoice(requestId: string) {
    const row = rows.find(item => item.id === requestId);
    if (!row?.proration || !window.confirm(`${row.studentName} · ${row.effectiveFrom}\n${row.fromClassName} → ${row.toClassName}\n차액 ${row.proration.diff.toLocaleString()}원 사이트 청구서 1건을 생성할까요?\n문자·알림 발송과 ${externalLabel} 반영은 포함되지 않습니다.`)) return;
    setError("");
    startTransition(async () => {
      try {
      const result = await issueEnrollmentChangeInvoice(requestId, row.invoicePreviewKey);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
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
    if (!window.confirm(`${row.studentName} · ${row.fromClassName ?? "-"} · ${row.kindLabel}
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
        router.refresh();
      } catch {
        // 네트워크 끊김 등 결과 자체를 못 받은 경우만 여기로 온다.
        setError("반영 확인을 저장하지 못했습니다. 새로고침 후 다시 시도해 주세요.");
        router.refresh();
      }
    });
  }

  function decide(requestId: string, approve: boolean) {
    setError("");
    startTransition(async () => {
      const result = await decideEnrollmentChange({ requestId, approve, note: notes[requestId] });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-black text-brand-navy-900 dark:text-white">수강 변경 신청</h1>
        {/* 원장 결정(2026-10-05): 휴원·퇴원은 사이트만 자동. 랠리즈·시트는 사람이 반영하고 확인을 눌러야 끝난다. */}
        {/* 시트 은퇴(2026-10~) 후엔 시트를 언급하지 않는다 — 남은 사람 일은 랠리즈뿐이다. */}
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {sheetRetired
            ? "적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다. 랠리즈에 직접 반영한 뒤 '랠리즈 반영 확인'을 눌러 주세요. 적용일이 이미 지난 건은 승인 즉시 반영됩니다. 반 변경은 적용일에 자동으로 바뀌지 않습니다. 학부모 알림은 별도 승인 후 발송합니다."
            : "적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다(적용일이 이미 지난 건은 승인 즉시). 랠리즈·시트는 직접 반영한 뒤 '랠리즈 반영 확인'을 눌러 주세요. 반 변경은 적용일에 자동으로 바뀌지 않습니다. 학부모 알림은 별도 승인 후 발송합니다."}
        </p>
      </div>

      {/* 다른 탭을 보고 있어도 확인이 남은 건을 놓치지 않게 맨 위에 띄운다. */}
      {needsCheckCount > 0 && status !== "NEEDS_CHECK" && (
        <button
          type="button"
          onClick={() => router.push("/admin/enrollment-changes?status=NEEDS_CHECK")}
          className="block w-full rounded-xl bg-amber-50 p-3 text-left text-sm font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          사이트에만 반영되고 {externalLabel} 확인이 남은 건이 {needsCheckCount}건 있습니다. 눌러서 확인하세요.
        </button>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => router.push(`/admin/enrollment-changes?status=${item.value}`)}
            className={`min-h-11 rounded-xl px-4 text-sm font-bold ${
              status === item.value
                ? "bg-brand-navy-900 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                : "border border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            }`}
          >
            {item.label}
            {item.value === "NEEDS_CHECK" && needsCheckCount > 0 ? ` ${needsCheckCount}` : ""}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}

      {rows.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-sm text-gray-400 shadow-sm dark:bg-gray-900">
          해당하는 신청이 없습니다
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-base dark:text-white">{row.studentName}</strong>
                <span className="rounded-lg bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  {row.kindLabel}
                </span>
                {(() => {
                  // 자동 적용 건은 원장(시트·랠리즈) 확인 상태가 곧 진짜 상태다. "반영 완료"는 셋 다 끝났을 때만.
                  const badge = row.status === "APPLIED" ? syncCheckBadge(row.sheetStatus, row.rallyzStatus) : null;
                  if (badge?.needsCheck) {
                    return (
                      <span className="rounded-lg bg-amber-100 px-2 py-0.5 text-xs font-black text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                        {badge.label}
                      </span>
                    );
                  }
                  return <span className="text-xs font-bold text-gray-500">{badge?.label ?? CHANGE_STATUS_LABEL[row.status] ?? row.status}</span>;
                })()}
                {row.appliedAt && <span className="text-xs font-bold text-green-700">사이트 반영 {row.appliedAt}</span>}
              </div>

              {/* 자동 적용 후 남은 확인 단계: 시트 반영(자동 또는 직접 수정 확인) → 랠리즈 반영 확인(서버도 이 순서를 요구한다). */}
              {row.status === "APPLIED" && row.syncCommandId && syncCheckBadge(row.sheetStatus, row.rallyzStatus)?.needsCheck && (() => {
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
                    <p className="rounded-xl bg-amber-50 p-2 text-xs font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                      {/* 영문 종류 코드가 섞인 저장 문구는 화면에서만 한국어로 다듬는다. */}
                      {sheetSkipped
                        ? <>자동 반영 보류: {sheetHoldDisplayReason(row.kind, row.syncHoldReason)}{retiredResumeHold ? " — 랠리즈에 직접 반영한 뒤 '보류 해제 후 랠리즈 확인 진행'을 눌러 주세요." : ""}</>
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
                        className="min-h-11 rounded-xl border border-gray-300 text-sm font-bold text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
                      >
                        {row.sheetStatus === "SUCCEEDED" ? "시트 반영됨" : "시트에 반영"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={pending || !sheetDone || row.rallyzStatus === "SUCCEEDED" || row.syncCommandStatus === "HELD"}
                      onClick={() => confirmRallyz(row)}
                      title={!sheetDone ? "시트 반영을 먼저 해 주세요" : undefined}
                      className={`${row.kind === "RESUME" || sheetSkipped ? "col-span-2 " : ""}min-h-11 rounded-xl bg-brand-navy-900 text-sm font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900`}
                    >
                      랠리즈 반영 확인
                    </button>
                    {/* 자동 시트 반영이 실패·보류된 건의 탈출구(항상 보조로 노출). 시트가 끝났으면 숨긴다. */}
                    {!sheetSkipped && (row.sheetStatus !== "SUCCEEDED" || row.syncCommandStatus === "HELD") && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => confirmSheetManually(row)}
                        className="col-span-2 min-h-11 rounded-xl border border-dashed border-gray-300 text-sm font-bold text-gray-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
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
                        className="col-span-2 min-h-11 rounded-xl border border-dashed border-gray-300 text-sm font-bold text-gray-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
                      >
                        보류 해제 후 랠리즈 확인 진행
                      </button>
                    )}
                    {!sheetDone && (
                      <p className="col-span-2 text-xs text-gray-500">{row.kind === "RESUME"
                        ? "복귀는 시트 자동 반영을 지원하지 않습니다 — 시트를 직접 고친 뒤 '시트 직접 수정 완료'를 눌러 주세요."
                        : "시트 반영을 먼저 하면 '랠리즈 반영 확인'을 누를 수 있습니다. 자동 반영이 안 되면 시트를 직접 고친 뒤 '시트 직접 수정 완료'를 눌러 주세요."}</p>
                    )}
                  </div>
                </div>
                );
              })()}

              {/* 적용일 처리에서 사람 확인으로 보류된 건(반 변경·이미 바뀐 상태 등). 사이트는 바뀌지 않았다. */}
              {row.status === "APPROVED" && row.syncCommandStatus === "HELD" && (
                <p className="mt-2 rounded-xl bg-gray-50 p-2 text-xs font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  적용일 도래 · 자동 반영 안 함: {row.syncHoldReason ?? "관리자 확인 필요"}
                </p>
              )}

              <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
                {row.fromClassName ?? "-"}
                {row.toClassName ? ` → ${row.toClassName}` : ""} · {row.effectiveFrom}부터
                {row.resumeOn ? ` · ${row.resumeOn} 복귀 예정` : ""}
              </p>

              {/* 정원은 신청 당시가 아니라 지금 기준으로 다시 센다. 그 사이 자리가 났을 수 있다. */}
              {row.toClassName && row.toClassFull && (
                <p className="mt-2 rounded-xl bg-amber-50 p-2 text-xs font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  희망 반 정원이 지금도 차 있습니다{row.waitlisted ? " (신청 당시에도 마감)" : " (신청 당시에는 자리가 있었습니다)"}
                </p>
              )}
              {row.toClassName && !row.toClassFull && row.waitlisted && (
                <p className="mt-2 rounded-xl bg-green-50 p-2 text-xs font-bold text-green-800 dark:bg-green-950/30 dark:text-green-200">
                  신청 당시에는 마감이었지만 지금은 자리가 있습니다
                </p>
              )}

              {/* 일할 계산. 근거를 보여줘야 원장이 숫자를 믿고 발행할 수 있다.
                  금액은 발행 시 서버가 다시 계산한다(여기 숫자는 표시용). */}
              {row.proration && row.proration.needsProration && (
                <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
                  <p className="text-xs font-black text-gray-700 dark:text-gray-200">수강료 일할 계산</p>
                  {row.proration.lines.map((line) => (
                    <p key={line} className="mt-1 text-xs text-gray-600 dark:text-gray-300">{line}</p>
                  ))}
                  {!row.proration.scheduleUnavailable && (
                    <p className="mt-2 text-sm font-black text-brand-navy-900 dark:text-white">
                      {row.proration.diff > 0
                        ? `추가 청구 ${row.proration.diff.toLocaleString()}원`
                        : row.proration.diff < 0
                          ? `${Math.abs(row.proration.diff).toLocaleString()}원은 다음 달 청구에서 차감하세요`
                          : "차액 없음"}
                    </p>
                  )}
                  {row.status === "APPROVED" && row.proration.diff > 0 && !row.proration.scheduleUnavailable && (
                    row.invoicedPaymentId ? (
                      <p className="mt-2 text-xs font-bold text-amber-700">차액 기록 있음 · 청구서 연결 및 {externalLabel} 반영·알림은 별도 확인 필요</p>
                    ) : (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => issueInvoice(row.id)}
                        className="mt-2 min-h-11 w-full rounded-xl bg-brand-navy-900 text-sm font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                      >
                        차액 {row.proration.diff.toLocaleString()}원 사이트 청구서 생성
                      </button>
                    )
                  )}
                </div>
              )}

              {row.reason && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-300">{row.reason}</p>}
              <p className="mt-2 text-xs text-gray-400">신청 {row.createdAt}</p>

              {row.status === "PENDING" ? (
                <div className="mt-3 space-y-2">
                  <input
                    value={notes[row.id] ?? ""}
                    onChange={(event) => setNotes((prev) => ({ ...prev, [row.id]: event.target.value }))}
                    maxLength={500}
                    placeholder="학부모에게 전할 말 (거절 시 함께 전달됩니다)"
                    className="min-h-11 w-full rounded-xl border border-gray-200 px-3 text-sm dark:border-gray-700 dark:bg-gray-800"
                  />
                  {(row.kind === "PAUSE" || row.kind === "WITHDRAW") && (
                    <p className="text-xs text-gray-500">승인하면 적용일({row.effectiveFrom})에 사이트에 자동 반영됩니다. {sheetRetired ? "랠리즈는" : "랠리즈·시트는"} 직접 반영해 주세요.</p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => decide(row.id, false)}
                      className="min-h-12 rounded-xl border border-gray-300 font-bold text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
                    >
                      거절
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => decide(row.id, true)}
                      className="min-h-12 rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)] disabled:opacity-50"
                    >
                      승인
                    </button>
                  </div>
                </div>
              ) : (
                row.decisionNote && (
                  <p className="mt-2 rounded-xl bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    메모: {row.decisionNote}
                  </p>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
