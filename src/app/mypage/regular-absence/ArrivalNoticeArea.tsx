"use client";

import { useState } from "react";
import Link from "next/link";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { academyTel } from "@/lib/academyPhoneRules";
import type { UpcomingClassDate } from "@/lib/regular/parent-regular-absence";
import type { ArrivalDateInfo } from "@/lib/regular/parent-arrival-notice";
import {
  ARRIVAL_CHANGE_LIMIT_MESSAGE,
  ARRIVAL_KINDS,
  ARRIVAL_KIND_LABEL,
  ARRIVAL_NOTICE_NAME,
  ARRIVAL_SHUTTLE_WORD,
  ARRIVAL_TIME_QUESTION,
  expectedTimeOptions,
  type ArrivalKind,
} from "@/lib/regular/arrivalNoticeRules";

// 결석 알리기 화면의 «늦어요 · 일찍 가요»(2026-11-14 원장 결정표 묶음 B).
//   · 결석이 아니다 — 아이는 수업에 온다. 보강권은 생기지 않는다.
//   · 지각은 수업 시작 전까지, 조퇴는 수업이 끝나기 전까지 알리거나·시각을 바꾸거나·취소할 수 있다(서버가 다시 막는다).
//   · 조퇴(지각)로 알리는 날 그 아이가 하원(등원) 셔틀을 타면 «셔틀도 안 타나요?»를 한 번 묻는다.
// 이 부품은 한 줄(아이·반·날짜) 아래에 붙는다: 알린 내용 줄 + 알리는 칸. 여는 버튼은 부모 화면의 동작 줄에 있다.

/** 지금 이 줄에서 새로 알릴 수 있는 종류 — 아직 안 알렸고, 시간이 남았고, 고를 시각이 있는 것만 */
export function arrivalAddableKinds(d: UpcomingClassDate, info: ArrivalDateInfo | undefined): ArrivalKind[] {
  if (!info || d.reported || d.locked) return [];
  if (expectedTimeOptions(d.startTime, info.endTime).length === 0) return [];
  return ARRIVAL_KINDS.filter((kind) => info.open[kind] && !info.notices.some((notice) => notice.kind === kind));
}

export default function ArrivalNoticeArea({
  d,
  info,
  formKind,
  onOpen,
  onClose,
  onChanged,
  academyPhone = null,
}: {
  d: UpcomingClassDate;
  info: ArrivalDateInfo | undefined;
  /** 이 줄에서 열려 있는 알리는 칸(없으면 null) — 부모 화면이 한 번에 한 칸만 열리게 들고 있다 */
  formKind: ArrivalKind | null;
  onOpen: (kind: ArrivalKind) => void;
  onClose: () => void;
  /** 일을 마치면 결과 글을 넘긴다(부모가 보이고 화면을 다시 읽는다) */
  onChanged: (message: string, error?: string) => Promise<void> | void;
  /** 학원 대표 번호(설정값) — 하루 변경 상한에 닿았을 때의 «학원에 전화하기» 버튼용. 없으면 글자만 보인다 */
  academyPhone?: string | null;
}) {
  // 부모가 이 부품을 «줄·열린 칸» 키로 다시 만들어 준다 — 시각 바꾸기로 열면 지금 시각이 미리 골라져 있다
  const [time, setTime] = useState(() => (formKind ? info?.notices.find((notice) => notice.kind === formKind)?.expectedTime ?? "" : ""));
  // 셔틀 질문의 답: null = 아직 안 고름
  const [skipShuttle, setSkipShuttle] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // 하루 변경 상한(5번)에 닿았나 — 닿으면 이 줄에 안내 글과 전화 버튼을 보인다
  const [limitHit, setLimitHit] = useState(false);

  // 결석을 알린 날은 지각·조퇴를 보이지 않는다(결석이 우선 — 서버도 같은 규칙)
  if (!info || d.reported || d.locked) return null;
  const options = expectedTimeOptions(d.startTime, info.endTime);
  const editing = formKind ? info.notices.find((notice) => notice.kind === formKind) ?? null : null;
  // 셔틀은 새로 알릴 때 한 번만 묻는다(시각만 바꿀 때는 묻지 않는다)
  const askShuttle = Boolean(formKind && !editing && info.ask[formKind]);
  if (info.notices.length === 0 && !formKind) return null;

  async function send(body: Record<string, unknown>, done: (result: Record<string, unknown> | null) => string, fallback: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/mypage/regular-absence/arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: d.studentId, classId: d.classId, date: d.date, ...body }),
      });
      const result = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok && result?.code === "ARRIVAL_CHANGE_LIMIT") {
        // 저장도 알림도 되지 않았다 — 글과 전화 버튼은 이 줄에서 보인다(위쪽 오류 칸에는 겹쳐 쓰지 않는다)
        setLimitHit(true);
        await onChanged("", "");
        return;
      }
      if (!res.ok) throw new Error(typeof result?.error === "string" ? result.error : fallback);
      setTime("");
      setSkipShuttle(null);
      onClose();
      await onChanged(done(result));
    } catch (error) {
      // 그 사이 수업이 시작됐거나 결석을 알렸을 수 있다 — 부모가 화면을 다시 읽는다
      await onChanged("", customerMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  }

  function submit(kind: ArrivalKind) {
    if (!time) return;
    void send(
      { kind, expectedTime: time, skipShuttle: askShuttle && skipShuttle === true },
      (result) => {
        if (result?.changed) return "예상 시각을 바꿨어요.";
        const head = kind === "LATE" ? `늦는다고 알렸어요. (${time} 도착 예정)` : `일찍 간다고 알렸어요. (${time}에 나가요)`;
        return result?.shuttleSkipped ? `${head} ${ARRIVAL_SHUTTLE_WORD[kind]} 셔틀도 안 타는 것으로 기사님께 알렸어요.` : head;
      },
      "알리지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  }

  function cancel(kind: ArrivalKind) {
    return send(
      { action: "cancel", kind },
      (result) => `${ARRIVAL_NOTICE_NAME[kind]} 알림을 취소했어요.${result?.shuttleRestored ? ` ${ARRIVAL_SHUTTLE_WORD[kind]} 셔틀은 다시 타는 것으로 바꿨어요.` : ""}`,
      "취소하지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  }

  return (
    <div className="mb-1.5 space-y-1.5">
      {/* 하루 변경 상한 — 여기서 더 바꿀 수 없으니 바로 전화로 잇는다(번호가 없으면 글자만) */}
      {limitHit && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">
          <span className="min-w-0 flex-1 break-keep">{ARRIVAL_CHANGE_LIMIT_MESSAGE}</span>
          {academyTel(academyPhone) && (
            <a href={`tel:${academyTel(academyPhone)}`} className="academy-button-secondary shrink-0">
              학원에 전화하기
            </a>
          )}
        </div>
      )}
      {/* 알린 내용 — 한 줄: «지각 예정 17:20» + (열려 있으면) 시각 바꾸기 · 알림 취소 */}
      {info.notices.map((notice) => (
        <div key={notice.kind} className="flex min-h-11 flex-wrap items-center justify-end gap-2">
          <span className="mr-auto flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs tabular-nums text-[var(--color-academy-info)]">
              {notice.label}
            </span>
            {notice.shuttleSkipped && (
              <span className="text-xs text-[var(--color-academy-muted)]">{ARRIVAL_SHUTTLE_WORD[notice.kind]} 셔틀 안 타요</span>
            )}
          </span>
          {info.open[notice.kind] && formKind !== notice.kind && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onOpen(notice.kind)}
                className="academy-button-text shrink-0"
              >
                시각 바꾸기
              </button>
              <InlineConfirm
                label="알림 취소"
                question={notice.shuttleSkipped
                  ? `${ARRIVAL_SHUTTLE_WORD[notice.kind]} 셔틀도 다시 타는 것으로 바뀌어요. 이 알림을 취소할까요?`
                  : `이 ${ARRIVAL_NOTICE_NAME[notice.kind]} 알림을 취소할까요?`}
                confirmLabel="알림 취소하기"
                onConfirm={() => cancel(notice.kind)}
                pending={busy}
                openClassName="basis-full"
              />
            </>
          )}
        </div>
      ))}

      {/* 알리는 칸 — 예상 시각 고르기 + (그날 그 방향 셔틀을 타는 아이면) 셔틀 질문 한 번 */}
      {formKind && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-32 flex-1 text-sm font-medium text-[var(--color-academy-ink)]">
            {ARRIVAL_TIME_QUESTION[formKind]}
            <select
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="academy-input mt-1 w-full tabular-nums"
            >
              <option value="">시각 선택</option>
              {/* 10분 간격에 없는 기존 시각도 고른 채로 보이게 */}
              {editing && !options.includes(editing.expectedTime) && <option value={editing.expectedTime}>{editing.expectedTime}</option>}
              {options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          {/* 셔틀 변경을 받는 범위(14일) 밖 날짜 — 질문 대신 한 줄 안내 + 셔틀 변경으로 가는 길 */}
          {!editing && !askShuttle && info.shuttleLater?.[formKind] && (
            <p className="basis-full break-keep text-xs text-[var(--color-academy-muted)]">
              {ARRIVAL_SHUTTLE_WORD[formKind]} 셔틀을 안 타면 날짜가 가까워졌을 때(2주 전부터){" "}
              <Link href={`/mypage/shuttle?studentId=${encodeURIComponent(d.studentId)}`} className="font-semibold underline">셔틀 변경</Link>
              에서 따로 알려 주세요.
            </p>
          )}

          {askShuttle && (
            <div role="group" aria-label={`${ARRIVAL_SHUTTLE_WORD[formKind]} 셔틀`} className="basis-full">
              <p className="mb-1 text-sm font-medium text-[var(--color-academy-ink)]">{ARRIVAL_SHUTTLE_WORD[formKind]} 셔틀도 안 타나요?</p>
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" aria-pressed={skipShuttle === true} disabled={busy} onClick={() => setSkipShuttle(true)} className="academy-choice break-keep">
                  안 타요
                </button>
                <button type="button" aria-pressed={skipShuttle === false} disabled={busy} onClick={() => setSkipShuttle(false)} className="academy-choice break-keep">
                  셔틀은 타요
                </button>
              </div>
              {skipShuttle === true && (
                <p className="mt-1 break-keep text-xs text-[var(--color-academy-muted)]">기사님 화면에도 바로 반영돼요.</p>
              )}
            </div>
          )}

          <div className="flex basis-full items-center justify-end gap-2">
            <button
              type="button"
              // 셔틀 질문이 있으면 답을 골라야 보낼 수 있다. 시각 바꾸기는 같은 시각이면 보낼 것이 없다
              disabled={busy || !time || (askShuttle && skipShuttle === null) || (editing?.expectedTime === time)}
              onClick={() => submit(formKind)}
              className="academy-button-primary"
            >
              {busy ? "보내는 중…" : editing ? "시각 바꾸기" : `${ARRIVAL_KIND_LABEL[formKind]} 알리기`}
            </button>
            <button type="button" disabled={busy} onClick={onClose} className="academy-button-text">
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
