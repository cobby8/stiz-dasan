"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CHANGE_KIND_LABEL,
  CHANGE_STATUS_LABEL,
  type ChangeKind,
} from "@/lib/enrollment/changeRequestRules";
import type { EnrollmentChangeOptions } from "@/lib/enrollment/parent-change-request";
import InlineConfirm from "@/components/parent/InlineConfirm";

const DAY_KO: Record<string, string> = {
  Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

const KIND_HELP: Record<ChangeKind, string> = {
  CLASS_CHANGE: "다른 요일·시간의 반으로 옮깁니다.",
  PAUSE: "잠시 쉬었다가 다시 나옵니다. 자리는 비워둡니다.",
  WITHDRAW: "그만둡니다. 자리가 다른 학생에게 넘어갑니다.",
};

export default function EnrollmentChangeClient({ initial }: { initial: EnrollmentChangeOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [childIdx, setChildIdx] = useState(0);
  const [kind, setKind] = useState<ChangeKind>("CLASS_CHANGE");
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

  const child = initial.children[childIdx];
  // 지금 다니는 반은 고를 수 없다. 골라봐야 아무것도 바뀌지 않는다.
  const selectable = useMemo(
    () => initial.classes.filter((item) => item.classId !== child?.currentClassId),
    [initial.classes, child?.currentClassId],
  );

  async function send(body: Record<string, unknown>) {
    if (sending.current || uncertain) return false;
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
        setError(typeof data?.error === "string" ? data.error : "요청을 처리할 수 없습니다. 입력 내용을 확인해 주세요.");
        return false;
      }
      if (data?.ok !== true) throw new Error("결과 확인 필요");
      return true;
    } catch {
      setUncertainSource(initial);
      setError("응답을 확인하지 못해 접수·취소 여부를 알 수 없습니다. 입력 내용은 유지했습니다. 다시 보내기 전에 현재 신청 내역을 확인해 주세요.");
      return false;
    } finally {
      sending.current = false;
    }
  }

  function submit() {
    if (!child) return;
    startTransition(async () => {
      const ok = await send({
        enrollmentId: child.enrollmentId,
        kind,
        toClassId: kind === "CLASS_CHANGE" ? toClassId : undefined,
        effectiveFrom: kind === "CLASS_CHANGE" ? effectiveFrom : undefined,
        resumeOn: kind === "PAUSE" ? resumeOn || undefined : undefined,
        reason,
      });
      if (!ok) return;
      setDone("신청이 접수되었습니다. 학원에서 확인 후 알려드립니다.");
      setToClassId("");
      setEffectiveFrom(initial.effectiveFrom);
      setResumeOn("");
      setReason("");
      router.refresh();
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      setDone("신청을 취소했습니다.");
      router.refresh();
    });
  }

  if (initial.children.length === 0) {
    return (
      <main className="mx-auto max-w-lg px-4 py-6">
        <h1 className="text-xl font-black text-brand-navy-900 dark:text-white">수강 변경 신청</h1>
        <p className="mt-3 rounded-2xl bg-white p-5 text-sm text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-300">
          지금 다니고 있는 반이 없습니다. 학원으로 문의해 주세요.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-black text-brand-navy-900 dark:text-white">수강 변경 신청</h1>
        {/* 적용일을 먼저 알린다. 언제부터 바뀌는지 모르고 신청하면 그게 곧 문의가 된다. */}
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          휴원·퇴원은 <b className="text-brand-navy-900 dark:text-white">{initial.effectiveFrom}</b>부터 적용됩니다.
          반 변경은 원하시는 날짜를 고를 수 있어요.
        </p>
      </div>

      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
      {uncertain && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm font-bold disabled:opacity-50">
            {pending ? "확인 중..." : "접수 결과 다시 확인"}
          </button>
          {uncertainSource !== initial && (
            <button type="button" disabled={pending} onClick={() => { setUncertainSource(null); setError(""); }} className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm font-bold disabled:opacity-50">
              내역 확인했어요
            </button>
          )}
        </div>
      )}

      {initial.children.length > 1 && (
        <select
          value={childIdx}
          onChange={(event) => setChildIdx(Number(event.target.value))}
          className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-800"
        >
          {initial.children.map((item, index) => (
            <option key={item.enrollmentId} value={index}>
              {item.studentName} · {item.currentClassName}
            </option>
          ))}
        </select>
      )}

      {child?.pending ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/30">
          <p className="text-sm font-black text-amber-900 dark:text-amber-200">
            {CHANGE_STATUS_LABEL.PENDING}인 신청이 있습니다
          </p>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
            {CHANGE_KIND_LABEL[child.pending.kind as ChangeKind] ?? child.pending.kind}
            {child.pending.toClassName ? ` · ${child.pending.toClassName}` : ""} · {child.pending.effectiveFrom}부터
            {child.pending.waitlisted ? " · 자리가 나면 배정됩니다" : ""}
          </p>
          {/* 신청 취소 = 그 자리 확인(C-M1) 후 기존 cancel(child.pending.id) 그대로 */}
          <InlineConfirm
            label="신청 취소하기"
            question="이 수강 변경 신청을 취소할까요?"
            confirmLabel="신청 취소하기"
            onConfirm={() => cancel(child.pending!.id)}
            disabled={uncertain}
            pending={pending}
            className="mt-3 flex"
            triggerClassName="w-full"
          />
        </section>
      ) : (
        <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm dark:bg-gray-800">
          <div>
            <p className="text-xs font-bold text-gray-500 dark:text-gray-400">지금 다니는 반</p>
            <p className="font-black text-brand-navy-900 dark:text-white">
              {child.currentClassName} <span className="text-sm font-bold text-gray-500">· {child.currentProgramName}</span>
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
          <p className="text-xs text-gray-500 dark:text-gray-400">{KIND_HELP[kind]}</p>

          {kind === "CLASS_CHANGE" && (
            <div>
              <label htmlFor="to-class" className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                옮기고 싶은 반
              </label>
              <select
                id="to-class"
                value={toClassId}
                onChange={(event) => setToClassId(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="">반을 선택해 주세요</option>
                {selectable.map((item) => (
                  <option key={item.classId} value={item.classId}>
                    {DAY_KO[item.dayOfWeek] ?? item.dayOfWeek} {item.startTime}~{item.endTime} · {item.programName}
                    {item.full ? " (정원 마감 · 대기)" : ` (${item.capacity - item.enrolled}자리)`}
                  </option>
                ))}
              </select>
              {/* 만석이어도 신청은 받는다(원장 결정). 대신 기대를 정확히 만든다. */}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                정원이 찬 반도 신청할 수 있어요. 자리가 나면 순서대로 배정됩니다.
              </p>

              {/* 시작일을 학부모가 고른다. 달 중간이면 그달 수강료는 회차대로 다시 계산된다. */}
              <label htmlFor="effective-from" className="mt-4 mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                언제부터 옮길까요?
              </label>
              <input
                id="effective-from"
                type="date"
                value={effectiveFrom}
                min={initial.minEffectiveFrom}
                max={initial.maxEffectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                달 중간부터 옮기면 그달 수강료를 수업 회차대로 다시 계산해 안내드립니다.
              </p>
            </div>
          )}

          {kind === "PAUSE" && (
            <div>
              <label htmlFor="resume-on" className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                복귀 예정일 (선택)
              </label>
              <input
                id="resume-on"
                type="date"
                value={resumeOn}
                onChange={(event) => setResumeOn(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
          )}

          <div>
            <label htmlFor="change-reason" className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
              사유 (선택)
            </label>
            <textarea
              id="change-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="학원에서 참고할 내용을 적어주세요"
              className="w-full rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>

          {kind === "WITHDRAW" ? (
            // 퇴원은 되돌리기 어렵다 → 위험색 버튼 + 한 번 더 확인(M-03). 확인 후 제출 함수·내용은 같다(submit)
            <InlineConfirm
              label="퇴원 신청하기"
              question="정말 퇴원을 신청할까요? 자리가 다른 학생에게 넘어갑니다."
              confirmLabel="퇴원 신청하기"
              keepLabel="돌아가기"
              onConfirm={submit}
              disabled={uncertain}
              pending={pending}
              pendingLabel="접수 중..."
              className="flex"
              triggerClassName="w-full"
            />
          ) : (
            <button
              type="button"
              disabled={pending || uncertain || (kind === "CLASS_CHANGE" && !toClassId)}
              onClick={submit}
              className="academy-button-primary w-full"
            >
              {pending ? "접수 중..." : "신청하기"}
            </button>
          )}
        </section>
      )}

      {done && <p className="rounded-xl bg-green-50 p-3 text-sm font-bold text-green-800">{done}</p>}

      <p className="text-center text-xs text-gray-400">
        요금이 달라지는 반으로 옮기면 학원에서 다시 안내드립니다.
      </p>
    </main>
  );
}
