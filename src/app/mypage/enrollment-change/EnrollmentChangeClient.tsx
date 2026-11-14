"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CHANGE_KIND_LABEL,
  CHANGE_STATUS_LABEL,
  MAX_PAUSE_CLASSES_PER_REQUEST,
  REQUEST_KIND_LABEL,
  earliestResumeOn,
  pauseResumeLabel,
  type ChangeKind,
} from "@/lib/enrollment/changeRequestRules";
import type { ChangeHistoryRow, ChildChangeOption, EnrollmentChangeOptions } from "@/lib/enrollment/parent-change-request";
import { parentKindName, shortMd } from "@/lib/enrollment/parentChangeStatus";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { presetIndex, type RequestPreset } from "@/lib/mypage/requestPreset";
// 남은 자리는 숫자 대신 3단계(여유/임박)로(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_LABEL } from "@/lib/seats/seatLevel";

const DAY_KO: Record<string, string> = {
  Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

const KIND_HELP: Record<ChangeKind, string> = {
  CLASS_CHANGE: "다른 요일·시간의 반으로 옮깁니다.",
  PAUSE: "잠시 쉬었다가 다시 나옵니다. 자리는 비워둡니다.",
  WITHDRAW: "그만둡니다. 자리가 다른 학생에게 넘어갑니다.",
};

type PendingRequest = NonNullable<ChildChangeOption["pending"]>;

/** 종류 이름(복귀 포함). 모르는 값이면 «수강 변경». */
const kindLabel = (kind: string) => REQUEST_KIND_LABEL[kind] ?? "수강 변경";

export default function EnrollmentChangeClient({ initial, preset }: { initial: EnrollmentChangeOptions; preset?: RequestPreset }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // 수업 탭 반 카드에서 왔으면 그 반을 먼저 고른다(없으면 첫 반 — 예전 그대로)
  const [childIdx, setChildIdx] = useState(preset ? presetIndex(initial.children, preset, (c) => c) : 0);
  // 반 카드 [반 변경·휴원 ▾]에서 고른 종류(반 변경·휴원·퇴원만 받는다. 복귀는 휴원 중인 반이면 화면이 알아서 바꾼다)
  const presetKind: ChangeKind =
    preset?.kind === "PAUSE" || preset?.kind === "WITHDRAW" || preset?.kind === "CLASS_CHANGE" ? preset.kind : "CLASS_CHANGE";
  const [kind, setKind] = useState<ChangeKind>(presetKind);
  const [toClassId, setToClassId] = useState("");
  // 반 변경만 시작일을 고를 수 있다(원장 지시). 기본값은 다음 달 1일.
  const [effectiveFrom, setEffectiveFrom] = useState(initial.effectiveFrom);
  const [resumeOn, setResumeOn] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const sending = useRef(false);
  const [uncertainSource, setUncertainSource] = useState<EnrollmentChangeOptions | null>(null);
  const uncertain = uncertainSource !== null;
  // 접수에 성공한 수강 등록. 새 내역(검토 중)이 화면에 올 때까지 같은 신청을 다시 못 누르게 잠근다.
  // (router.refresh 는 끝날 때까지 기다려 주지 않아, 그 사이 «신청하기»가 다시 살아나
  //  두 번째 누름이 «이미 검토 중인 신청» 오류가 됐다 — 2026-11-09 휴원 신청 신고)
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);
  // 방금 접수한 신청(서버가 돌려준 id 포함). 새로고침을 기다리지 않고 «검토 중 + 취소 버튼»을 바로 보여 준다.
  const [localPending, setLocalPending] = useState<{ enrollmentId: string; pending: PendingRequest } | null>(null);
  // 방금 취소한 신청 id. 새로고침이 늦게 와도 취소한 신청을 다시 보여 주지 않는다(다시 누르면 «이미 처리됨» 오류).
  const [canceledId, setCanceledId] = useState<string | null>(null);
  // 휴원 중인 반의 복귀 희망일(= 다시 나오는 날)
  const [resumeFrom, setResumeFrom] = useState("");
  // 휴원 시작일(2026-11-10 원장 결정 m7). 비어 있으면 그 반의 가장 이른 날(오늘 수업 전이면 오늘, 아니면 내일).
  const [pauseFrom, setPauseFrom] = useState("");
  const [additionalPauseIds, setAdditionalPauseIds] = useState<string[]>([]);

  const child = initial.children[childIdx];
  // 화면에 보일 «검토 중» 신청 = 서버 내역(방금 취소한 건 제외) → 없으면 방금 접수한 건
  const serverPending = child?.pending && child.pending.id !== canceledId ? child.pending : null;
  const shownPending: PendingRequest | null =
    serverPending ?? (localPending && localPending.enrollmentId === child?.enrollmentId ? localPending.pending : null);
  const awaitingReload = Boolean(child && !shownPending && submittedFor === child.enrollmentId);
  const paused = child?.enrollmentStatus === "PAUSED";
  // 휴원 시작일 = 고른 날 → 없으면 그 반의 가장 이른 날 → (옛 데이터) 다음 달 1일
  const otherPauseOptions = initial.canGroupPause && child ? initial.children.filter((item) =>
    item.studentId === child.studentId && item.currentClassId !== child.currentClassId
      && item.enrollmentStatus === "ACTIVE" && !item.pending && !item.scheduled,
  ) : [];
  const additionalPauseClasses = otherPauseOptions.filter((item) => additionalPauseIds.includes(item.enrollmentId));
  const minPauseFrom = additionalPauseClasses.reduce(
    (latest, item) => item.minPauseFrom && item.minPauseFrom > latest ? item.minPauseFrom : latest,
    child?.minPauseFrom || initial.effectiveFrom,
  );
  const pauseStart = pauseFrom || minPauseFrom;
  // 지금 다니는 반은 고를 수 없다. 골라봐야 아무것도 바뀌지 않는다.
  const selectable = useMemo(
    () => initial.classes.filter((item) => item.classId !== child?.currentClassId),
    [initial.classes, child?.currentClassId],
  );

  /** 보내고 서버 응답(성공일 때만)을 돌려준다. 실패·불확실이면 null. */
  async function send(body: Record<string, unknown>): Promise<Record<string, any> | null> {
    if (sending.current || uncertain) return null;
    sending.current = true;
    setError("");
    setDone("");
    try {
      const response = await fetch("/api/mypage/enrollment-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 전송 실패와 미접수는 다릅니다. 결과 확인 전에는 중복 신청을 막습니다.
      if (response.status >= 500) throw new Error("결과 확인 필요");
      const data = await response.json();
      if (!response.ok) {
        setError(customerMessage(data?.error, "요청을 처리할 수 없습니다. 입력 내용을 확인해 주세요."));
        return null;
      }
      if (data?.ok !== true) throw new Error("결과 확인 필요");
      return data;
    } catch {
      setUncertainSource(initial);
      setError("결과를 확인하지 못해 접수·취소 여부를 알 수 없습니다. 입력 내용은 유지했습니다. 다시 보내기 전에 현재 신청 내역을 확인해 주세요.");
      return null;
    } finally {
      sending.current = false;
    }
  }

  /** 접수 성공 뒤 공통 처리 — 서버가 신청 id 를 주면 그 자리에서 «검토 중» 상자로 바꾼다. */
  function afterSubmitted(enrollmentId: string, data: Record<string, any>) {
    setSubmittedFor(enrollmentId);
    if (typeof data.id === "string" && data.id) {
      setLocalPending({
        enrollmentId,
        pending: {
          id: data.id,
          kind: String(data.kind ?? ""),
          toClassName: data.toClassName ?? null,
          effectiveFrom: String(data.effectiveFrom ?? ""),
          resumeOn: data.resumeOn ?? null,
          waitlisted: Boolean(data.waitlisted),
        },
      });
    }
    setDone("신청이 접수되었습니다. 학원에서 확인 후 알려드립니다.");
    setToClassId("");
    setEffectiveFrom(initial.effectiveFrom);
    setResumeOn("");
    setResumeFrom("");
    setPauseFrom("");
    setAdditionalPauseIds([]);
    setReason("");
    router.refresh();
  }

  function submit() {
    if (!child) return;
    // 아이폰 날짜 고르기는 min 을 무시해 휴원 시작일 이전 복귀일도 고를 수 있다. 보내기 전에 언제부터인지 알려 준다.
    // 문자열 비교로 충분하다("YYYY-MM-DD" 는 글자 순서 = 날짜 순서).
    // 아이폰은 휴원 시작일 min·max 도 무시한다 — 범위를 벗어나면 보내기 전에 알려 준다(서버도 같은 규칙으로 다시 본다).
    if (kind === "PAUSE" && (pauseStart < minPauseFrom || (initial.maxEffectiveFrom && pauseStart > initial.maxEffectiveFrom))) {
      setDone("");
      setError(`휴원 시작일은 ${minPauseFrom}부터 ${initial.maxEffectiveFrom} 사이로 골라 주세요.`);
      return;
    }
    const firstResume = earliestResumeOn(pauseStart);
    if (kind === "PAUSE" && resumeOn && firstResume && resumeOn < firstResume) {
      setDone("");
      setError(`휴원은 ${pauseStart}부터라 복귀 예정일은 ${firstResume} 이후로 골라 주세요. 아직 모르면 비워 두셔도 됩니다.`);
      return;
    }
    startTransition(async () => {
      const data = await send({
        enrollmentId: child.enrollmentId,
        ...(kind === "PAUSE" && additionalPauseClasses.length ? {
          enrollmentIds: [child.enrollmentId, ...additionalPauseClasses.map((item) => item.enrollmentId)],
        } : {}),
        kind,
        toClassId: kind === "CLASS_CHANGE" ? toClassId : undefined,
        effectiveFrom: kind === "CLASS_CHANGE" ? effectiveFrom : kind === "PAUSE" ? pauseStart : undefined,
        resumeOn: kind === "PAUSE" ? resumeOn || undefined : undefined,
        reason,
      });
      if (!data) return;
      afterSubmitted(child.enrollmentId, data);
    });
  }

  /** 휴원 중인 반의 복귀 신청. 날짜 범위는 서버가 다시 검사하고, 여기서는 아이폰(min 무시)용으로 먼저 알려 준다. */
  function submitResume() {
    if (!child) return;
    if (!resumeFrom) {
      setDone("");
      setError("복귀 희망일을 골라 주세요.");
      return;
    }
    if ((initial.minResumeFrom && resumeFrom < initial.minResumeFrom) || (initial.maxResumeFrom && resumeFrom > initial.maxResumeFrom)) {
      setDone("");
      setError(`복귀 희망일은 ${initial.minResumeFrom}부터 ${initial.maxResumeFrom} 사이로 골라 주세요.`);
      return;
    }
    startTransition(async () => {
      const data = await send({ enrollmentId: child.enrollmentId, kind: "RESUME", effectiveFrom: resumeFrom, reason });
      if (!data) return;
      afterSubmitted(child.enrollmentId, data);
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      setSubmittedFor(null);
      setLocalPending(null);
      setCanceledId(id);
      setDone("신청을 취소했습니다.");
      router.refresh();
    });
  }

  // 결과 문구는 방금 누른 버튼 바로 위에 둔다(2026-11-09 휴원 신청 «동작 안 함» 신고).
  // 화면 맨 위에 두면 휴대폰에서 아래로 내려 «신청하기»를 누른 사람에게는
  // 오류(예: 복귀일이 휴원 시작일 이전)도 접수 완료도 보이지 않아 «무반응»으로 느껴진다.
  const notice = (
    <>
      {error && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
      {uncertain && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="academy-button-secondary">
            {pending ? "확인 중..." : "접수 결과 다시 확인"}
          </button>
          {uncertainSource !== initial && (
            <button type="button" disabled={pending} onClick={() => { setUncertainSource(null); setError(""); }} className="academy-button-secondary">
              내역 확인했어요
            </button>
          )}
        </div>
      )}
      {done && <p role="status" className="rounded-xl bg-[var(--color-academy-success-soft)] p-3 text-sm font-medium text-[var(--color-academy-success)]">{done}</p>}
    </>
  );

  // 원장이 승인했지만 아직 적용 전인 신청(휴원 예정 등). 학부모가 직접 취소할 수 없어 연락 안내만 한다.
  const scheduledBox = child?.scheduled ? (
    <section className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
      <p className="text-sm font-semibold text-[var(--color-academy-ink)]">
        {kindLabel(child.scheduled.kind)} 예정 · {child.scheduled.effectiveFrom}부터
        <span className="ml-1 text-xs font-medium text-[var(--color-academy-muted)]">(학원 승인 완료)</span>
      </p>
      {child.scheduled.kind === "PAUSE" && (
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">{pauseResumeLabel(child.scheduled.resumeOn)}</p>
      )}
      <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
        취소하거나 날짜를 바꾸려면 학원에 연락해 주세요.
      </p>
    </section>
  ) : null;

  if (initial.children.length === 0) {
    return (
      <main className="mx-auto max-w-lg px-4 py-6">
        <h1 className="academy-heading">수강 변경 신청</h1>
        <p className="mt-3 rounded-2xl bg-white p-5 text-sm text-[var(--color-academy-muted)] shadow-sm">
          지금 다니고 있는 반이 없습니다. 학원으로 문의해 주세요.
        </p>
        {/* 퇴원한 뒤에도 지난 결과(거절 사유 등)는 볼 수 있게 */}
        <div className="mt-4"><ChangeHistoryList rows={initial.history ?? []} /></div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
      <div>
        <h1 className="academy-heading">수강 변경 신청</h1>
        {/* 적용일을 먼저 알린다. 언제부터 바뀌는지 모르고 신청하면 그게 곧 문의가 된다. */}
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
          퇴원은 <b className="text-[var(--color-academy-ink)]">{initial.effectiveFrom}</b>부터 적용됩니다.
          반 변경·휴원은 원하시는 날짜를 고를 수 있어요.
        </p>
      </div>

      {initial.children.length > 1 && (
        <select
          value={childIdx}
          onChange={(event) => {
            setChildIdx(Number(event.target.value));
            setAdditionalPauseIds([]);
          }}
          className="academy-input"
        >
          {initial.children.map((item, index) => (
            <option key={item.enrollmentId} value={index}>
              {item.studentName} · {item.currentClassName}{item.enrollmentStatus === "PAUSED" ? " (휴원 중)" : ""}
            </option>
          ))}
        </select>
      )}

      {shownPending ? (
        <section className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-warning-soft)] p-5">
          <p className="text-sm font-semibold text-[var(--color-academy-warning)]">
            {CHANGE_STATUS_LABEL.PENDING}인 신청이 있습니다
          </p>
          <p className="mt-1 text-sm text-[var(--color-academy-warning)]">
            {kindLabel(shownPending.kind)}
            {shownPending.toClassName ? ` · ${shownPending.toClassName}` : ""} · {shownPending.effectiveFrom}부터
            {shownPending.waitlisted ? " · 자리가 나면 배정됩니다" : ""}
          </p>
          {shownPending.kind === "PAUSE" && (
            <p className="mt-1 text-sm font-medium text-[var(--color-academy-warning)]">
              {pauseResumeLabel(shownPending.resumeOn)}
            </p>
          )}
          {(error || uncertain || done) && <div className="mt-3 space-y-2">{notice}</div>}
          {/* 신청 취소 = 그 자리 확인(C-M1) 후 기존 cancel(id) 그대로. 문구는 종류를 붙여 «휴원 신청 취소»처럼 */}
          <InlineConfirm
            label={`${kindLabel(shownPending.kind)} 신청 취소`}
            question={`이 ${kindLabel(shownPending.kind)} 신청을 취소할까요?`}
            confirmLabel={`${kindLabel(shownPending.kind)} 신청 취소`}
            onConfirm={() => cancel(shownPending.id)}
            disabled={uncertain}
            pending={pending}
            className="mt-3 flex"
            triggerClassName="w-full"
          />
        </section>
      ) : paused ? (
        // 휴원 중인 반 = 복귀 신청만 받는다. 복귀가 이미 승인돼 기다리는 중이면 안내만 보여 준다.
        scheduledBox ?? (
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <div>
              <p className="text-xs font-medium text-[var(--color-academy-muted)]">휴원 중인 반</p>
              <p className="font-semibold text-[var(--color-academy-ink)]">
                {child.currentClassName} <span className="text-sm font-normal text-[var(--color-academy-muted)]">· {child.currentProgramName}</span>
              </p>
            </div>

            <div>
              <label htmlFor="resume-from" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                언제부터 다시 나올까요?
              </label>
              <input
                id="resume-from"
                type="date"
                value={resumeFrom}
                min={initial.minResumeFrom}
                max={initial.maxResumeFrom}
                onChange={(event) => setResumeFrom(event.target.value)}
                className="academy-input box-border min-w-0 max-w-full appearance-none"
              />
              <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                학원에서 확인한 뒤 그날부터 다시 수업에 들어갑니다.
              </p>
            </div>

            <div>
              <label htmlFor="resume-reason" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                전할 말 (선택)
              </label>
              <textarea
                id="resume-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="학원에서 참고할 내용을 적어주세요"
                className="academy-input"
              />
            </div>

            {notice}

            <button
              type="button"
              disabled={pending || uncertain || awaitingReload || !resumeFrom}
              onClick={submitResume}
              className="academy-button-primary w-full"
            >
              {awaitingReload ? "접수됨 · 신청 내역 불러오는 중..." : pending ? "접수 중..." : "복귀 신청하기"}
            </button>
            {awaitingReload && !pending && (
              <button type="button" onClick={() => router.refresh()} className="academy-button-secondary w-full">
                신청 내역 다시 불러오기
              </button>
            )}
          </section>
        )
      ) : (
        <>
          {scheduledBox}
          <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <div>
              <p className="text-xs font-medium text-[var(--color-academy-muted)]">지금 다니는 반</p>
              <p className="font-semibold text-[var(--color-academy-ink)]">
                {child.currentClassName} <span className="text-sm font-normal text-[var(--color-academy-muted)]">· {child.currentProgramName}</span>
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(CHANGE_KIND_LABEL) as ChangeKind[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  // 고른 칩 = academy-choice(체크·연한 바탕). 꽉 찬 색은 맨 아래 제출 버튼만(C-M2)
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}
                  className="academy-choice break-keep px-1!"
                >
                  {CHANGE_KIND_LABEL[value]}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--color-academy-muted)]">{KIND_HELP[kind]}</p>

            {kind === "CLASS_CHANGE" && (
              <div>
                <label htmlFor="to-class" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                  옮기고 싶은 반
                </label>
                <select
                  id="to-class"
                  value={toClassId}
                  onChange={(event) => setToClassId(event.target.value)}
                  className="academy-input"
                >
                  <option value="">반을 선택해 주세요</option>
                  {selectable.map((item) => (
                    <option key={item.classId} value={item.classId}>
                      {DAY_KO[item.dayOfWeek] ?? item.dayOfWeek} {item.startTime}~{item.endTime} · {item.programName}
                      {item.full ? " (정원 마감 · 대기)" : ` (${SEAT_LEVEL_LABEL[item.seatLevel]})`}
                    </option>
                  ))}
                </select>
                {/* 만석이어도 신청은 받는다(원장 결정). 대신 기대를 정확히 만든다. */}
                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                  정원이 찬 반도 신청할 수 있어요. 자리가 나면 순서대로 배정됩니다.
                </p>

                {/* 시작일을 학부모가 고른다. 달 중간이면 그달 수강료는 회차대로 다시 계산된다. */}
                <label htmlFor="effective-from" className="mt-4 mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                  언제부터 옮길까요?
                </label>
                <input
                  id="effective-from"
                  type="date"
                  value={effectiveFrom}
                  min={initial.minEffectiveFrom}
                  max={initial.maxEffectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                  className="academy-input box-border min-w-0 max-w-full appearance-none"
                />
                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                  달 중간부터 옮기면 그달 수강료를 수업 회차대로 다시 계산해 안내드립니다.
                </p>
              </div>
            )}

            {kind === "PAUSE" && (
              <div>
                {otherPauseOptions.length > 0 && (
                  <fieldset className="mb-3" disabled={pending || uncertain}>
                    <legend className="text-xs font-medium text-[var(--color-academy-muted)]">같이 휴원할 반</legend>
                    {otherPauseOptions.map((item) => (
                      <label key={item.enrollmentId} className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={additionalPauseIds.includes(item.enrollmentId)}
                          disabled={!additionalPauseIds.includes(item.enrollmentId)
                            && additionalPauseClasses.length >= MAX_PAUSE_CLASSES_PER_REQUEST - 1}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setAdditionalPauseIds((ids) => checked
                              ? [...ids, item.enrollmentId]
                              : ids.filter((id) => id !== item.enrollmentId));
                          }}
                        />
                        {item.currentClassName}
                      </label>
                    ))}
                  </fieldset>
                )}
                {/* 갑작스러운 휴원도 받는다(원장 결정 k10) — 오늘 수업 전이면 오늘부터, 아니면 내일부터 */}
                <label htmlFor="pause-from" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                  언제부터 쉴까요?
                </label>
                <input
                  id="pause-from"
                  type="date"
                  value={pauseStart}
                  min={minPauseFrom}
                  max={initial.maxEffectiveFrom}
                  onChange={(event) => setPauseFrom(event.target.value)}
                  className="academy-input box-border min-w-0 max-w-full appearance-none"
                />
                <p className="mt-1 mb-4 text-xs text-[var(--color-academy-muted)]">
                  이미 낸 수강료는 학원이 승인할 때 빠지는 수업만큼 이월·환불로 안내드립니다.
                </p>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label htmlFor="resume-on" className="text-xs font-medium text-[var(--color-academy-muted)]">
                    복귀 예정일
                  </label>
                  {resumeOn && (
                    <button
                      type="button"
                      disabled={pending || uncertain}
                      onClick={() => setResumeOn("")}
                      className="academy-button-text shrink-0"
                    >
                      날짜 지우기
                    </button>
                  )}
                </div>
                <input
                  id="resume-on"
                  type="date"
                  value={resumeOn}
                  min={earliestResumeOn(pauseStart)}
                  aria-describedby="resume-on-help"
                  onChange={(event) => setResumeOn(event.target.value)}
                  className="academy-input box-border min-w-0 max-w-full appearance-none"
                />
                <p id="resume-on-help" className="mt-1 text-xs text-[var(--color-academy-muted)]">
                  {resumeOn ? `${resumeOn} 복귀 예정` : "아직 정해지지 않았다면 비워두세요. ‘복귀일 미정’으로 접수됩니다."}
                  {" "}예정일에 자동으로 복귀 처리되지는 않습니다. 휴원이 시작된 뒤 이 화면에서 «복귀 신청»을 해 주세요.
                </p>
              </div>
            )}

            <div>
              <label htmlFor="change-reason" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                사유 (선택)
              </label>
              <textarea
                id="change-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                maxLength={500}
                placeholder="학원에서 참고할 내용을 적어주세요"
                className="academy-input"
              />
            </div>

            {notice}

            {kind === "WITHDRAW" ? (
              // 퇴원은 되돌리기 어렵다 → 위험색 버튼 + 한 번 더 확인(M-03). 확인 후 제출 함수·내용은 같다(submit)
              <InlineConfirm
                label="퇴원 신청하기"
                question="정말 퇴원을 신청할까요? 자리가 다른 학생에게 넘어갑니다."
                confirmLabel="퇴원 신청하기"
                keepLabel="돌아가기"
                onConfirm={submit}
                disabled={uncertain || awaitingReload}
                pending={pending}
                pendingLabel="접수 중..."
                className="flex"
                triggerClassName="w-full"
              />
            ) : (
              <button
                type="button"
                disabled={pending || uncertain || awaitingReload || (kind === "CLASS_CHANGE" && !toClassId)}
                onClick={submit}
                className="academy-button-primary w-full"
              >
                {awaitingReload ? "접수됨 · 신청 내역 불러오는 중..." : pending ? "접수 중..." : "신청하기"}
              </button>
            )}
            {/* 새 내역이 끝내 안 오면(전파 지연·통신 끊김) 손으로 다시 불러온다. 다시 «신청»하게 두지 않는다. */}
            {awaitingReload && !pending && (
              <button type="button" onClick={() => router.refresh()} className="academy-button-secondary w-full">
                신청 내역 다시 불러오기
              </button>
            )}
          </section>
        </>
      )}

      <ChangeHistoryList rows={initial.history ?? []} />

      <p className="text-center text-xs text-[var(--color-academy-faint)]">
        요금이 달라지는 반으로 옮기면 학원에서 다시 안내드립니다.
      </p>
    </main>
  );
}

/** 결과 이름 — 승인됐지만 반영까지 끝난 건은 «반영 완료». */
function historyStatusLabel(row: ChangeHistoryRow): string {
  if (row.status === "APPROVED" && row.applied) return CHANGE_STATUS_LABEL.APPLIED;
  return CHANGE_STATUS_LABEL[row.status] ?? row.status;
}

/** 결과 글자 색 — 거절만 눈에 띄게(위험색), 나머지는 차분하게. */
function historyStatusClass(status: string): string {
  if (status === "REJECTED") return "text-[var(--color-academy-danger)]";
  if (status === "CANCELED" || status === "SUPERSEDED") return "text-[var(--color-academy-faint)]";
  return "text-[var(--color-academy-ink)]";
}

/**
 * «지난 결과» — 최근 3개월 승인·반영·거절·취소를 한 줄씩(2026-11-10).
 * 예전엔 결정이 나면 화면에서 사라져, 거절됐는지·왜 거절됐는지 학부모가 알 길이 없었다.
 * 거절 건은 원장 사유를 바로 아래 작은 글씨로 보여 준다.
 */
function ChangeHistoryList({ rows }: { rows: ChangeHistoryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="change-history-heading" className="overflow-hidden rounded-2xl bg-white shadow-sm">
      <h2 id="change-history-heading" className="academy-section-title border-b border-[var(--color-academy-line)] px-4 py-2">
        지난 결과 <span className="text-xs font-normal text-[var(--color-academy-muted)]">최근 3개월</span>
      </h2>
      <ul className="divide-y divide-[var(--color-academy-line)]">
        {rows.map((row) => (
          <li key={row.id} className="px-4 py-2">
            <div className="flex min-h-7 items-center justify-between gap-2 text-sm">
              <span className="min-w-0 break-keep text-[var(--color-academy-ink)]">
                {row.studentName} · {row.fromClassName ?? "반"} {parentKindName(row.kind)}
                {row.kind === "CLASS_CHANGE" && row.toClassName ? ` → ${row.toClassName}` : ""}
                {shortMd(row.effectiveFrom) && (
                  <span className="ml-1 text-xs text-[var(--color-academy-muted)]">({shortMd(row.effectiveFrom)}부터)</span>
                )}
              </span>
              <span className="shrink-0 text-right">
                <span className={`block text-sm font-medium ${historyStatusClass(row.status)}`}>{historyStatusLabel(row)}</span>
                <span className="block text-xs tabular-nums text-[var(--color-academy-muted)]">{shortMd(row.decidedOn)}</span>
              </span>
            </div>
            {row.status === "REJECTED" && row.decisionNote && (
              <p className="mt-0.5 break-keep text-xs text-[var(--color-academy-muted)]">학원 답변: {row.decisionNote}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
