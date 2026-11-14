"use client";

import { useRef, useState } from "react";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { FEED_LINE_MAX } from "@/lib/feed/rules";
import { PLAN_PREFILL_NOTICE, type WorkspacePhase } from "@/components/staff/sessionWorkspaceRules";
import { STAFF_SESSION_EDIT_DAYS } from "@/lib/staff/sessionEditWindow";

export type LessonTextSaveResult = { ok: true } | { ok: false; message: string };

/**
 * «수업 내용» 통합 글칸(2026-11-15 원장 지시 — 수업 내용과 수업 피드는 같은 내용이라 하나로).
 *
 * - 수업 전: 미리 쓴 내용으로 저장한다(선생님만 본다).
 * - 수업 중·후: 수업 내용으로 저장한다 — 학부모는 «수업 종료 + 발행» 뒤에만 본다.
 * - 미리 쓴 내용을 불러와 채운 상태(prefilled)는 자동 저장하지 않는다. 저장을 눌러야 수업 내용이 된다.
 * 값은 부모가 들고(value/onChange) — 수업 종료 확인 창의 한 줄과 같은 값을 쓰게. 어디에 저장할지도 부모(save)가 정한다.
 */
export function LessonTextEditor({
  inputId,
  phase,
  value,
  onChange,
  save,
  prefilledFromPlan = false,
  onBusyChange,
  disabled = false,
}: {
  inputId: string;
  phase: WorkspacePhase;
  value: string;
  onChange: (next: string) => void;
  /** 저장 — 수업 전이면 미리 쓴 내용, 수업 중·후면 수업 내용으로(부모가 단계에 맞는 서버 기능을 부른다) */
  save: (text: string) => Promise<LessonTextSaveResult>;
  /** 미리 쓴 내용을 불러와 채웠는가(저장 전) */
  prefilledFromPlan?: boolean;
  /** 음성 변환·저장 중 여부(수업 종료 버튼 잠금용) */
  onBusyChange?: (busy: boolean) => void;
  /** 읽기 전용 — 완료한 수업의 수정 기간이 지났을 때(글은 보이고 음성·저장 버튼은 없다) */
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  // 마지막으로 저장된 글 — 바깥에서 값이 바뀌어도(수업 계획 불러오기 등) «저장 안 됨»을 알아보게 한다. 채운 값은 아직 저장 전이다.
  const [savedValue, setSavedValue] = useState<string | null>(prefilledFromPlan ? null : value);
  const unsaved = value !== savedValue;
  // 음성 변환과 저장을 따로 센다 — 한쪽이 끝났다고 다른 쪽이 진행 중인데 «안 바쁨»으로 알리지 않게(수업 종료 잠금이 먼저 풀리던 문제)
  const busyRef = useRef({ voice: false, saving: false });
  function reportBusy(kind: "voice" | "saving", busy: boolean) {
    busyRef.current[kind] = busy;
    onBusyChange?.(busyRef.current.voice || busyRef.current.saving);
  }

  async function submit() {
    if (status === "saving") return;
    const sending = value;
    setStatus("saving");
    setError("");
    reportBusy("saving", true);
    try {
      const result = await save(sending);
      if (!result.ok) {
        setStatus("error");
        setError(result.message);
        return;
      }
      setStatus("saved");
      setSavedValue(sending);
    } catch {
      setStatus("error");
      setError("저장하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러 주세요.");
    } finally {
      reportBusy("saving", false);
    }
  }

  const hint = phase === "PLANNED"
    // 사실대로: 수업 전에는 선생님만 보지만, 수업을 시작하면 이 글이 수업 내용 칸에 채워지고 그대로 종료하면 학부모에게 나간다
    ? "수업을 종료하면 이 내용이 학부모에게 보일 수 있어요(종료할 때 고칠 수 있습니다)"
    : `수업 종료 뒤 학부모에게 보여요 · 수업 뒤 ${STAFF_SESSION_EDIT_DAYS}일 동안 고칠 수 있어요`;

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <label htmlFor={inputId} className="pt-1 text-xs text-[var(--color-academy-muted)]">
          {phase === "PLANNED" ? "오늘 진행할 내용·준비물" : "오늘 수업 한 줄"}
        </label>
        {!disabled && <VoiceToTextButton
          onBusyChange={(busy) => reportBusy("voice", busy)}
          onText={(text) => { setStatus("dirty"); onChange(value ? `${value}\n${text}` : text); }}
        />}
      </div>
      <textarea
        id={inputId}
        value={value}
        disabled={disabled}
        onChange={(event) => { setStatus("dirty"); onChange(event.target.value); }}
        rows={3}
        maxLength={FEED_LINE_MAX}
        placeholder="예: 드리블 기본기 연습했습니다. 다들 잘 따라왔어요."
        className="academy-input mt-1.5 leading-6"
      />
      {/* 미리 쓴 내용을 채워 보여 줄 뿐 아직 저장 전이라는 것을 알린다(저장하면 사라진다) */}
      {prefilledFromPlan && unsaved && (
        <p role="status" className="mt-1.5 text-xs text-[var(--color-academy-info)]">{PLAN_PREFILL_NOTICE}</p>
      )}
      {!disabled && <div className="mt-1.5 flex items-center justify-between gap-2">
        <span aria-live="polite" className={`min-w-0 text-xs ${status === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
          {status === "saving" ? "저장 중…" : status === "error" ? error : unsaved || status === "dirty" ? "저장하지 않은 변경이 있어요" : status === "saved" ? "저장됨" : hint}
        </span>
        <button type="button" disabled={status === "saving"} onClick={() => void submit()} className="academy-button-secondary academy-button-sm shrink-0">
          수업 내용 저장
        </button>
      </div>}
    </div>
  );
}
