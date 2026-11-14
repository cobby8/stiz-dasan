"use client";

/**
 * 학부모 «결석 알리기 › 여러 날» (2026-11-15 원장 결정: 한도 4주·모든 사유)
 *
 * 왜: 며칠 쉬는 아이의 부모가 같은 일을 날짜마다 다시 눌러야 했다. 시작일·끝일과 사유를 한 번만 고르면
 * 그 사이 수업일(휴무일·이미 알린 날 제외)을 서버가 계산해 미리 보여 주고, «알리기» 한 번으로 끝낸다.
 * - 수업일은 화면이 계산하지 않는다 — 서버 미리보기가 준 글자만 보인다(연간일정·마감 기준이 한 곳).
 * - 4주가 넘으면 휴원 신청으로 잇는다(글만 두지 않고 바로 가는 버튼).
 * - 아이콘 없이 글자, 굵기 400/500/600, 색은 토큰, 누르는 것은 44px.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { addDaysKst, todayKst } from "@/lib/datetime/kst";
import { EVIDENCE_MAX_PHOTOS, ILLNESS_REASON, REASON_TEXT_MAX } from "@/lib/regular/illnessCarryRules";
import { PARENT_PERIOD_MAX_DAYS } from "@/lib/regular/parentAbsencePeriodRules";
import type { ParentAbsencePeriodRow, ParentPeriodPreview } from "@/lib/regular/parent-absence-period";

const REASONS: { value: string; label: string }[] = [
  { value: "ILLNESS_INJURY", label: "질병/부상" },
  { value: "PERSONAL", label: "개인 사정" },
  { value: "FAMILY_TRIP", label: "가족 여행" },
  { value: "SCHOOL_EVENT", label: "학교 행사" },
  { value: "ETC", label: "기타" },
];
const EVIDENCE_ACCEPT = "image/jpeg,image/png,image/webp";
const WEEKS = PARENT_PERIOD_MAX_DAYS / 7;

type Kid = { studentId: string; studentName: string };
type Notice = (message: string, error?: string) => void | Promise<void>;

async function postPeriod(body: Record<string, unknown>) {
  const res = await fetch("/api/mypage/regular-absence/period", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error || "처리에 실패했습니다."), { tooLong: json?.tooLong === true });
  return json;
}

/** 진행 중인 «여러 날 결석» — «복귀했어요»(복귀일 고르기) · «알림 취소»(아직 안 지난 날만) */
export function ActivePeriodList({ periods, onChanged }: { periods: ParentAbsencePeriodRow[]; onChanged: Notice }) {
  const today = todayKst();
  const [returnId, setReturnId] = useState("");
  const [returnDate, setReturnDate] = useState(today);
  const [busyId, setBusyId] = useState("");
  if (periods.length === 0) return null;

  const close = async (period: ParentAbsencePeriodRow, action: "return" | "cancel") => {
    setBusyId(period.id);
    try {
      const result = await postPeriod({ action, periodId: period.id, returnDate });
      const parts = [action === "return" ? `복귀를 알렸어요. 결석 ${result.canceledCount}회를 취소했어요.` : `결석 알림 ${result.canceledCount}회를 취소했어요.`];
      // 그대로 둔 날이 있으면 이유와 함께 알린다 — 아래 날짜 목록에서 하루씩 정리할 수 있다
      if (result.makeupKept > 0) parts.push(`보강이 예약된 ${result.makeupKept}회는 그대로예요. 아래에서 하루씩 취소해 주세요.`);
      if (result.closedByDeadline > 0) parts.push(`마감이 지난 오늘 수업 ${result.closedByDeadline}회는 그대로예요.`);
      setReturnId("");
      await onChanged(parts.join(" "));
    } catch (e) {
      await onChanged("", customerMessage(e, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    } finally {
      setBusyId("");
    }
  };

  return (
    <section aria-label="알린 여러 날 결석" className="mb-4 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
      <h2 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--color-academy-ink)]">
        <span>알린 여러 날 결석</span>
        <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{periods.length}</span>
      </h2>
      <ul className="divide-y divide-[var(--color-academy-line)]">
        {periods.map((period) => {
          const busy = busyId === period.id;
          return (
            <li key={period.id} className="px-3 py-2">
              {/* 한 줄: 아이·사유(왼쪽) · 기간·횟수(오른쪽) */}
              <div className="flex min-h-11 items-center gap-2">
                <p className="min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                  {period.studentName}
                  <span className="ml-1.5 font-normal text-[var(--color-academy-muted)]">{period.reasonLabel}</span>
                </p>
                <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">
                  {period.rangeLabel} <span className="text-[var(--color-academy-muted)]">{period.count}회</span>
                </span>
              </div>
              {period.openEnded && (
                <p className="text-xs text-[var(--color-academy-muted)]">끝일을 정하지 않아 {WEEKS}주까지만 알렸어요.</p>
              )}
              <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                {returnId === period.id ? (
                  // 복귀일 = 다시 나오는 날. 그날부터의 결석을 취소한다(지난 날은 그대로)
                  <>
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-[var(--color-academy-ink)]">
                      <span className="shrink-0">다시 나오는 날</span>
                      <input
                        type="date"
                        value={returnDate}
                        min={today}
                        max={addDaysKst(period.endDate, 1)}
                        onChange={(e) => setReturnDate(e.target.value)}
                        className="academy-input min-w-0 flex-1"
                      />
                    </label>
                    <button type="button" disabled={busy || !returnDate} onClick={() => void close(period, "return")} className="academy-button-primary">
                      {busy ? "알리는 중…" : "복귀 알리기"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setReturnId("")} className="academy-button-text">닫기</button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setReturnDate(today); setReturnId(period.id); }}
                      className="academy-button-tonal shrink-0"
                    >
                      복귀했어요
                    </button>
                    <InlineConfirm
                      label="알림 취소"
                      question="아직 지나지 않은 날의 결석 알림을 모두 취소할까요?"
                      confirmLabel="알림 취소하기"
                      onConfirm={() => close(period, "cancel")}
                      pending={busy}
                      openClassName="basis-full"
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** «여러 날» 알리기 칸 — 아이·시작일·끝일(또는 아직 몰라요)·사유 → 미리보기 → 알리기 */
export default function PeriodAbsencePanel({
  kids, presetStudentId = null, uploadEvidence, onChanged,
}: {
  kids: Kid[];
  presetStudentId?: string | null;
  /** 증빙 사진 한 장 올리기(하루 알리기와 같은 함수) */
  uploadEvidence: (absenceId: string, file: File) => Promise<void>;
  onChanged: Notice;
}) {
  const today = todayKst();
  const [studentId, setStudentId] = useState(kids.find((kid) => kid.studentId === presetStudentId)?.studentId ?? kids[0]?.studentId ?? "");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [unknownEnd, setUnknownEnd] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<ParentPeriodPreview | null>(null);
  const [problem, setProblem] = useState<{ text: string; tooLong: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const maxStart = useMemo(() => addDaysKst(today, PARENT_PERIOD_MAX_DAYS - 1), [today]);
  const maxEnd = useMemo(() => (startDate ? addDaysKst(startDate, PARENT_PERIOD_MAX_DAYS - 1) : ""), [startDate]);
  const ready = Boolean(studentId && startDate && (unknownEnd || endDate));
  const illness = reason === ILLNESS_REASON;

  // 날짜가 정해지면 서버에 수업일을 물어 미리 보여 준다(입력이 멈춘 뒤 한 번만)
  useEffect(() => {
    if (!ready) { setPreview(null); setProblem(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const query = new URLSearchParams({ studentId, startDate, ...(unknownEnd ? {} : { endDate }) });
        const res = await fetch(`/api/mypage/regular-absence/period?${query}`, { cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (!alive) return;
        if (res.ok) { setPreview(json.preview); setProblem(null); }
        else { setPreview(null); setProblem({ text: json?.error || "수업일을 확인하지 못했습니다.", tooLong: json?.tooLong === true }); }
      } catch {
        if (alive) { setPreview(null); setProblem({ text: "수업일을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", tooLong: false }); }
      }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [ready, studentId, startDate, endDate, unknownEnd]);

  const submit = async () => {
    if (!reason) { setProblem({ text: "결석 사유를 선택해 주세요.", tooLong: false }); return; }
    if (illness && !reasonText.trim()) { setProblem({ text: "어디가 아픈지 한 줄로 적어 주세요. (예: 독감, 발목 염좌)", tooLong: false }); return; }
    setBusy(true);
    setProblem(null);
    try {
      const result = await postPeriod({
        action: "create", studentId, startDate, endDate: unknownEnd ? null : endDate, reason, reasonText: illness ? reasonText.trim() : null,
      });
      // 질병·부상: 고른 사진을 기간의 첫 결석에 올린다(기간 전체에 쓰인다). 실패해도 결석은 이미 알렸다
      let uploaded = 0;
      let uploadError = "";
      if (result.evidenceAbsenceId) {
        for (const file of files.slice(0, EVIDENCE_MAX_PHOTOS)) {
          try { await uploadEvidence(result.evidenceAbsenceId, file); uploaded += 1; }
          catch (e) { uploadError = customerMessage(e, "사진을 올리지 못했어요."); }
        }
      }
      const head = `결석 ${result.count}회를 알렸어요.`;
      const tail = result.carryPending
        ? uploaded > 0
          ? "사진을 확인한 뒤 다음 달 수강료에서 빼 드려요."
          : "마지막 결석일부터 7일 안에 증빙 사진을 올려 주시면 확인한 뒤 다음 달 수강료에서 빼 드려요."
        : result.makeupCredits > 0 ? `보강권 ${result.makeupCredits}장이 생겼어요.` : "학원에서 확인합니다.";
      setEndDate(""); setUnknownEnd(false); setReason(""); setReasonText(""); setFiles([]); setPreview(null);
      await onChanged(`${head} ${tail}`, uploadError ? `${uploadError} 위 «질병·부상 결석»에서 다시 올려 주세요.` : undefined);
    } catch (e) {
      setProblem({ text: customerMessage(e, "결석을 알리지 못했습니다. 잠시 후 다시 시도해 주세요."), tooLong: (e as { tooLong?: boolean })?.tooLong === true });
    } finally {
      setBusy(false);
    }
  };

  if (kids.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-academy-line-input)] bg-white px-6 py-16 text-center text-sm text-[var(--color-academy-muted)]">
        다가오는 정규수업이 없습니다.
      </div>
    );
  }

  return (
    <section aria-label="여러 날 결석 알리기" className="space-y-3 rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
      {/* 형제가 있을 때만 아이를 고른다 */}
      {kids.length > 1 && (
        <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
          아이
          <select value={studentId} onChange={(e) => setStudentId(e.target.value)} className="academy-input mt-1 w-full">
            {kids.map((kid) => <option key={kid.studentId} value={kid.studentId}>{kid.studentName}</option>)}
          </select>
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
          시작일
          <input type="date" value={startDate} min={today} max={maxStart} onChange={(e) => setStartDate(e.target.value)} className="academy-input mt-1 w-full" />
        </label>
        <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
          끝일
          <input
            type="date" value={unknownEnd ? "" : endDate} min={startDate || today} max={maxEnd} disabled={unknownEnd}
            onChange={(e) => setEndDate(e.target.value)} className="academy-input mt-1 w-full"
          />
        </label>
      </div>
      {/* 끝일을 모르면 4주까지만 잡는다 — 끝나기 전에 앱 알림이 간다 */}
      <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-academy-ink)]">
        <input type="checkbox" className="h-5 w-5" checked={unknownEnd} onChange={(e) => setUnknownEnd(e.target.checked)} />
        끝일은 아직 몰라요 <span className="text-xs text-[var(--color-academy-muted)]">({WEEKS}주까지만 알려요)</span>
      </label>

      <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
        사유
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="academy-input mt-1 w-full" aria-label="결석 사유">
          <option value="">사유 선택</option>
          {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>

      {/* 질병·부상: 사유 글(필수) + 증빙 사진은 기간 전체에 한 묶음(1~3장) */}
      {illness && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
            어디가 아픈가요?
            <input
              type="text" value={reasonText} onChange={(e) => setReasonText(e.target.value)} maxLength={REASON_TEXT_MAX}
              placeholder="예: 독감, 발목 염좌" className="academy-input mt-1 w-full"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`academy-button-secondary shrink-0 ${busy ? "pointer-events-none opacity-60" : "cursor-pointer"}`}>
              증빙 사진 고르기
              <input
                type="file" accept={EVIDENCE_ACCEPT} multiple disabled={busy} className="sr-only"
                onChange={(e) => { const picked = Array.from(e.target.files || []).slice(0, EVIDENCE_MAX_PHOTOS); e.target.value = ""; setFiles(picked); }}
              />
            </label>
            <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">
              {files.length > 0 ? `${files.length}장 골랐어요` : `기간 전체에 한 번만 (1~${EVIDENCE_MAX_PHOTOS}장)`}
            </span>
          </div>
        </div>
      )}

      {/* 미리보기 — 서버가 계산한 수업일 */}
      {preview && (
        <div className="rounded-xl bg-[var(--color-academy-secondary-soft)] px-3 py-2">
          {preview.count > 0 ? (
            <p className="break-keep text-sm font-medium tabular-nums text-[var(--color-academy-secondary-ink)]">{preview.datesLabel}</p>
          ) : (
            <p className="text-sm text-[var(--color-academy-muted)]">이 기간에 알릴 수업이 없습니다.</p>
          )}
          {preview.skippedNote && <p className="mt-0.5 break-keep text-xs text-[var(--color-academy-muted)]">{preview.skippedNote}</p>}
        </div>
      )}
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-academy-danger-soft)] px-3 py-2">
          <p className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-danger)]">{problem.text}</p>
          {/* 4주가 넘으면 글만 두지 않고 휴원 신청으로 바로 잇는다 */}
          {problem.tooLong && <Link href="/mypage/enrollment-change" className="academy-button-secondary shrink-0">휴원 신청</Link>}
        </div>
      )}

      <div className="flex justify-end">
        <button type="button" disabled={busy || !ready || !preview || preview.count === 0} onClick={() => void submit()} className="academy-button-primary">
          {busy ? "보내는 중…" : preview && preview.count > 0 ? `${preview.count}회 알리기` : "알리기"}
        </button>
      </div>
    </section>
  );
}
