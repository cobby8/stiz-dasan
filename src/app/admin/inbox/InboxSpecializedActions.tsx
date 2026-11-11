"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  approveWithdrawalRequest,
  rejectWithdrawalRequest,
} from "@/app/actions/account-withdrawal-admin";
import { confirmInstagramMediaRemoved } from "@/app/actions/media-revocations";
import {
  confirmSeasonalAbsence,
  resolveSeasonalAbsence,
  revertSeasonalAbsenceConfirm,
} from "@/app/actions/seasonal-absence-admin";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import type { InboxRow } from "@/lib/requests/admin-inbox";
import KakaoRequestsClient from "../kakao-requests/KakaoRequestsClient";
import {
  assignInboxSeasonalMakeup,
  decideInboxSeasonalMakeup,
  readInboxKakaoRequest,
  readInboxMediaRevocation,
  readInboxSeasonalAbsence,
  readInboxSeasonalMakeup,
  readInboxSeasonalMakeupOptions,
  readInboxWithdrawal,
  retryInboxMediaRevocation,
} from "@/app/admin/inbox/specialized-actions";

type Props = { row: InboxRow; onChanged?: () => void };

type Result<T> =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; value: T };

function useSelectedRecord<T>(id: string, read: (id: string) => Promise<T>) {
  const [result, setResult] = useState<Result<T>>({ state: "loading" });
  const refresh = useCallback(async () => {
    try {
      setResult({ state: "ready", value: await read(id) });
    } catch {
      setResult({ state: "error" });
    }
  }, [id, read]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { result, refresh };
}

function LoadingOrError({ state, onRetry }: { state: "loading" | "error"; onRetry: () => void }) {
  if (state === "loading") return <p role="status" className="mt-4 text-sm">처리 정보를 불러오는 중입니다.</p>;
  return (
    <div className="mt-4 space-y-2">
      <p role="alert" className="text-sm text-[var(--color-academy-danger)]">처리 정보를 불러오지 못했습니다.</p>
      <button type="button" className="academy-button-secondary" onClick={onRetry}>다시 조회</button>
    </div>
  );
}

function useInlineAction(onChanged?: () => void, refresh?: () => Promise<void>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function run(action: () => Promise<unknown>, { notify = true } = {}) {
    setError("");
    startTransition(async () => {
      try {
        await action();
        await refresh?.();
        if (notify) onChanged?.();
      } catch (caught) {
        setError(adminErrorText(caught, "처리 결과를 확인하지 못했습니다. 다시 조회해 주세요."));
      }
    });
  }
  return { pending, error, run };
}

function InlineError({ text }: { text: string }) {
  return text ? <p role="alert" className="text-sm font-bold text-[var(--color-academy-danger)]">{text}</p> : null;
}

function KakaoActions({ row, onChanged }: Props) {
  const { result, refresh } = useSelectedRecord(row.id, readInboxKakaoRequest);
  if (result.state !== "ready") return <LoadingOrError state={result.state} onRetry={refresh} />;
  if (!result.value.schemaReady || result.value.rows.length === 0) {
    return <p role="status" className="mt-4 text-sm">현재 카카오 접수를 확인할 수 없습니다.</p>;
  }
  return <KakaoRequestsClient {...result.value} inlineId={row.id} onChanged={() => {
    void refresh();
    onChanged?.();
  }} />;
}

const ABSENCE_RESOLUTIONS = [
  ["MAKEUP", "보강"],
  ["CARRYOVER", "이월"],
  ["REFUND", "환불"],
] as const;

function SeasonalAbsenceActions({ row, onChanged }: Props) {
  const { result, refresh } = useSelectedRecord(row.id, readInboxSeasonalAbsence);
  const { pending, error, run } = useInlineAction(onChanged, refresh);
  const { confirm, confirmDialog } = useAdminConfirm();
  const [choice, setChoice] = useState<string | null>(null);
  if (result.state !== "ready") return <LoadingOrError state={result.state} onRetry={refresh} />;
  const record = result.value;
  if (!record || record.status === "CANCELLED") return <p className="mt-4 text-sm">처리할 수 있는 결석 신고가 없습니다.</p>;
  const assigned = ABSENCE_RESOLUTIONS.some(([value]) => value === record.resolution);
  const resolution = choice ?? (assigned ? record.resolution : "");
  const hasUnsavedChoice = choice !== null && choice !== record.resolution;

  return (
    <section aria-label="특강 결석 처리" className="mt-4 space-y-3">
      <label className="block text-sm font-bold">
        결석 처리 방식
        <select className="academy-input mt-1 w-full" value={resolution} onChange={(event) => setChoice(event.target.value)} disabled={pending}>
          <option value="" disabled>선택</option>
          {ABSENCE_RESOLUTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="academy-button-secondary" disabled={pending || !hasUnsavedChoice} onClick={() => run(async () => {
          await resolveSeasonalAbsence({ absenceId: row.id, resolution });
          setChoice(null);
        })}>방식 저장</button>
        {record.status === "REPORTED" && <button type="button" className="academy-button-primary" disabled={pending || !assigned || hasUnsavedChoice} onClick={() => run(() => confirmSeasonalAbsence({ absenceId: row.id }))}>결석 확정</button>}
        {record.status === "CONFIRMED" && <button type="button" className="academy-button-danger" disabled={pending} onClick={async () => {
          if (await confirm({ title: "특강 결석 확정 취소", description: "신고를 확인 대기 상태로 되돌립니다.", confirmLabel: "확정 취소" })) {
            run(() => revertSeasonalAbsenceConfirm({ absenceId: row.id }));
          }
        }}>확정 취소</button>}
      </div>
      {record.status === "CONFIRMED" && record.resolution === "MAKEUP" && !hasUnsavedChoice && <AssignSeasonalMakeup absenceId={row.id} onChanged={onChanged} />}
      <InlineError text={error} />
      {confirmDialog}
    </section>
  );
}

type MakeupOptions = Awaited<ReturnType<typeof readInboxSeasonalMakeupOptions>>;

function AssignSeasonalMakeup({ absenceId, onChanged }: { absenceId: string; onChanged?: () => void }) {
  const [options, setOptions] = useState<MakeupOptions>(null);
  const [selection, setSelection] = useState("");
  const { pending, error, run } = useInlineAction(onChanged);
  const { confirm, confirmDialog } = useAdminConfirm();
  const candidates = options ? [
    ...options.seasonalCandidates.map((item) => ({
      key: item.sessionDateId,
      label: `특강 · ${item.label}`,
      target: { targetType: "SEASONAL", targetSessionDateId: item.sessionDateId } as const,
    })),
    ...options.regularCandidates.map((item) => ({
      key: item.classId,
      label: `정규 · ${item.nextLabel ?? ""} ${item.name} · ${item.schedule}`,
      target: { targetType: "REGULAR", targetClassId: item.classId, targetDate: item.nextDate } as const,
    })),
  ] : [];
  const picked = candidates.find((candidate) => candidate.key === selection);
  function loadOptions() {
    run(async () => {
      const loaded = await readInboxSeasonalMakeupOptions(absenceId);
      if (!loaded) throw new Error("보강을 배정할 수 있는 결석 상태가 아닙니다.");
      setOptions(loaded);
      setSelection("");
    }, { notify: false });
  }
  return (
    <div className="space-y-2 border-t border-[var(--color-academy-line)] pt-3">
      {!options && <button type="button" className="academy-button-secondary" disabled={pending} onClick={loadOptions}>보강 수업 조회</button>}
      {options?.alreadyAssigned && <p className="text-sm">이미 보강이 배정된 결석입니다.</p>}
      {options && !options.alreadyAssigned && (candidates.length ? <>
        <label className="block text-sm font-bold">보강 수업
          <select className="academy-input mt-1 w-full" value={selection} disabled={pending} onChange={(event) => setSelection(event.target.value)}>
            <option value="">수업을 선택해 주세요</option>
            {candidates.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
          </select>
        </label>
        <button type="button" className="academy-button-primary" disabled={pending || !picked} onClick={async () => {
          if (!picked || !await confirm({ title: "보강 배정", description: picked.label, confirmLabel: "배정", tone: "primary" })) return;
          run(async () => {
            const result = await assignInboxSeasonalMakeup(absenceId, options.absence.enrollmentDateId, picked.target);
            if (!result.ok) {
              setOptions(null);
              const message = {
                SOURCE: "결석 처리 방식이 바뀌었습니다. 신청을 다시 확인해 주세요.",
                ASSIGNED: "이미 보강이 배정된 결석입니다.",
                TARGET: "선택한 수업에 보강을 배정할 수 없습니다. 수업을 다시 조회해 주세요.",
              }[result.reason];
              throw new Error(message);
            }
            setOptions({ ...options, alreadyAssigned: { id: result.id, status: result.status } });
          });
        }}>보강 배정</button>
      </> : <p className="text-sm">배정할 수 있는 수업이 없습니다.</p>)}
      <InlineError text={error} />
      {confirmDialog}
    </div>
  );
}

type MakeupDecision = Parameters<typeof decideInboxSeasonalMakeup>[2];
const MAKEUP_ACTIONS: Record<string, Array<{ value: MakeupDecision; label: string }>> = {
  REQUESTED: [{ value: "REJECT", label: "거절" }, { value: "APPROVE", label: "승인" }],
  APPROVED: [{ value: "CANCEL", label: "예약 취소" }],
  SCHEDULED: [{ value: "CANCEL", label: "예약 취소" }, { value: "NO_SHOW", label: "미출석" }, { value: "ATTENDED", label: "출석 확정" }],
  ATTENDED: [{ value: "CANCEL", label: "예약 취소" }],
  NO_SHOW: [{ value: "CANCEL", label: "예약 취소" }],
};

function SeasonalMakeupActions({ row, onChanged }: Props) {
  const { confirm, confirmDialog } = useAdminConfirm();
  const { result, refresh } = useSelectedRecord(row.id, readInboxSeasonalMakeup);
  const { pending, error, run } = useInlineAction(onChanged, refresh);
  if (result.state !== "ready") return <LoadingOrError state={result.state} onRetry={refresh} />;
  const status = result.value?.status;
  const actions = status ? MAKEUP_ACTIONS[status] : null;
  if (!status || !actions) return <InlineError text={error} />;
  return (
    <section aria-label="특강 보강 처리" className="mt-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map(({ value, label }) => <button key={value} type="button" disabled={pending} className={value === "CANCEL" || value === "REJECT" ? "academy-button-danger" : "academy-button-primary"} onClick={async () => {
          if (!await confirm({ title: `특강 보강 ${label}`, description: row.summary, confirmLabel: label, tone: value === "CANCEL" || value === "REJECT" ? "danger" : "primary" })) return;
          run(async () => {
            const result = await decideInboxSeasonalMakeup(row.id, status, value);
            if (!result.ok) {
              await refresh();
              onChanged?.();
              throw new Error(result.reason === "SEAT" ? "보강 수업에 이미 등록된 좌석이 있습니다." : "상태가 바뀌었습니다. 최신 신청을 확인해 주세요.");
            }
          });
        }}>{label}</button>)}
      </div>
      <InlineError text={error} />
      {confirmDialog}
    </section>
  );
}

function WithdrawalActions({ row, onChanged }: Props) {
  const { result, refresh } = useSelectedRecord(row.id, readInboxWithdrawal);
  const { pending, error, run } = useInlineAction(onChanged, refresh);
  const { confirm, confirmDialog } = useAdminConfirm();
  if (result.state !== "ready") return <LoadingOrError state={result.state} onRetry={refresh} />;
  if (!result.value) return null;
  if (result.value.administrativeHold) {
    return <p className="mt-4 text-sm font-bold text-[var(--color-academy-warning)]">{result.value.reviewMessage ?? "업무·권한 이관 후 처리해 주세요."}</p>;
  }
  const activeEnrollments = result.value.activeEnrollments;
  return (
    <section aria-label="탈퇴 신청 처리" className="mt-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="academy-button-secondary" disabled={pending} onClick={async () => {
          if (!await confirm({ title: "탈퇴 신청 반려", description: "회원의 신청 표시를 지우고 계정은 계속 이용할 수 있습니다.", confirmLabel: "반려", tone: "primary" })) return;
          run(async () => {
            const result = await rejectWithdrawalRequest(row.id);
            if ("error" in result) throw new Error(result.error);
          });
        }}>신청 반려</button>
        <button type="button" className="academy-button-danger" disabled={pending} onClick={async () => {
          if (!await confirm({
            title: "회원 탈퇴 처리",
            description: <>로그인 계정과 연락처를 삭제하며 되돌릴 수 없습니다.{activeEnrollments > 0 && <b className="text-[var(--color-academy-warning)]"> 수강 중인 반이 {activeEnrollments}개 있습니다.</b>}</>,
            confirmLabel: "정말 삭제",
          })) return;
          run(async () => {
            const result = await approveWithdrawalRequest(row.id);
            if ("error" in result) throw new Error(result.error);
          });
        }}>탈퇴 처리</button>
      </div>
      <InlineError text={error} />
      {confirmDialog}
    </section>
  );
}

function instagramPostUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function MediaRevocationActions({ row, onChanged }: Props) {
  const { result, refresh } = useSelectedRecord(row.id, readInboxMediaRevocation);
  const { pending, error, run } = useInlineAction(onChanged, refresh);
  const { confirm, confirmDialog } = useAdminConfirm();
  const [evidence, setEvidence] = useState("");
  if (result.state !== "ready") return <LoadingOrError state={result.state} onRetry={refresh} />;
  const record = result.value;
  if (!record) return <p className="mt-4 text-sm">현재 회수 작업을 확인할 수 없습니다.</p>;
  const manual = record.channel === "INSTAGRAM" && record.status === "MANUAL_REQUIRED";
  const url = manual ? instagramPostUrl(record.resourceUrl) : null;
  const retryable = record.status === "PENDING" || record.status === "FAILED";

  return (
    <section aria-label="사진 공개 회수 처리" className="mt-4 space-y-2">
      {retryable && <button type="button" className="academy-button-secondary" disabled={pending} onClick={async () => {
        if (!await confirm({ title: "사진 공개 회수", description: "이 회수 작업을 실행합니다. 갤러리 사진이면 게시물을 비공개합니다.", confirmLabel: "회수 처리" })) return;
        run(async () => {
          const result = await retryInboxMediaRevocation(row.id);
          if (!result.processed) throw new Error("아직 실행할 수 없습니다. 자동 재시도 시각이나 현재 상태를 확인해 주세요.");
          if (result.failed) throw new Error("회수하지 못했습니다. 상태를 다시 확인해 주세요.");
        });
      }}>이 작업 처리</button>}
      {manual && <>
        {url && <a className="academy-button-secondary" href={url} target="_blank" rel="noreferrer">인스타그램 게시물 확인</a>}
        <label className="block text-sm font-bold">
          외부 삭제 확인 근거
          <textarea className="academy-input mt-1 w-full" rows={2} value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={500} disabled={pending} />
        </label>
        <button type="button" className="academy-button-primary" disabled={pending || evidence.trim().length < 5} onClick={async () => {
          if (!await confirm({ title: "인스타그램 외부 삭제 확인", description: "실제 게시물 삭제를 확인한 근거를 기록합니다.", confirmLabel: "확인 저장", tone: "primary" })) return;
          run(async () => {
            const formData = new FormData();
            formData.set("jobId", row.id);
            formData.set("evidence", evidence.trim());
            await confirmInstagramMediaRemoved(formData);
            setEvidence("");
          });
        }}>외부 삭제 확인</button>
      </>}
      <InlineError text={error} />
      {confirmDialog}
    </section>
  );
}

export default function InboxSpecializedActions(props: Props) {
  switch (props.row.kind) {
    case "KAKAO": return <KakaoActions {...props} />;
    case "SEASONAL_ABSENCE": return <SeasonalAbsenceActions {...props} />;
    case "SEASONAL_MAKEUP": return <SeasonalMakeupActions {...props} />;
    case "WITHDRAWAL": return props.row.rawStatus === "REQUESTED" ? <WithdrawalActions {...props} /> : null;
    case "MEDIA_REVOCATION": return <MediaRevocationActions {...props} />;
    default: return null;
  }
}
