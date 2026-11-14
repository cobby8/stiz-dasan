"use client";

import { useState } from "react";
import { saveSessionFeedLine } from "@/app/actions/staff-sessions";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { SessionPhotoUploader } from "@/components/staff/SessionPhotoUploader";
import { SessionVideoUploader } from "@/components/staff/SessionVideoUploader";
import { FEED_LINE_MAX } from "@/lib/feed/rules";

/**
 * «오늘 수업 한 줄»(Session.content) 입력 칸 — 수업 전·중·후, 수업 당일 자정까지 쓰고 고친다(2026-11-14 원장 결정).
 * 학부모 소식·홈 카드의 본문이 된다. 값은 부모가 들고(value/onChange) — 수업 종료 확인 창과 같은 값을 쓰게.
 */
export function FeedLineEditor({
  sessionId,
  value,
  onChange,
  onBusyChange,
  onSaved,
  disabled = false,
}: {
  sessionId: string;
  value: string;
  onChange: (next: string) => void;
  /** 저장이 끝난 값(비우면 null) — 바깥 목록을 고칠 때 */
  onSaved?: (content: string | null) => void;
  /** 음성 변환·저장 중 여부(수업 종료 버튼 잠금용) */
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  // 마지막으로 저장된 글 — 바깥에서 값이 바뀌어도(수업 계획 불러오기 등) «저장 안 됨»을 알아보게 한다
  const [savedValue, setSavedValue] = useState(value);
  const unsaved = value !== savedValue;

  async function save() {
    if (status === "saving") return;
    const sending = value;
    setStatus("saving");
    setError("");
    onBusyChange?.(true);
    try {
      const result = await saveSessionFeedLine({ sessionId, content: sending });
      if (!result.ok) {
        setStatus("error");
        setError(result.message);
        return;
      }
      setStatus("saved");
      setSavedValue(sending);
      onSaved?.(result.content);
    } catch {
      setStatus("error");
      setError("저장하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러 주세요.");
    } finally {
      onBusyChange?.(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`feed-line-${sessionId}`} className="text-sm font-medium text-[var(--color-academy-ink)]">
          오늘 수업 한 줄 <span className="font-normal text-[var(--color-academy-faint)]">(학부모에게 보여요)</span>
        </label>
        {!disabled && (
          <VoiceToTextButton
            onBusyChange={onBusyChange}
            onText={(text) => { setStatus("dirty"); onChange(value ? `${value}\n${text}` : text); }}
          />
        )}
      </div>
      <textarea
        id={`feed-line-${sessionId}`}
        value={value}
        disabled={disabled}
        onChange={(event) => { setStatus("dirty"); onChange(event.target.value); }}
        rows={2}
        maxLength={FEED_LINE_MAX}
        placeholder="예: 드리블 기본기 연습했습니다. 다들 잘 따라왔어요."
        className="academy-input mt-1.5 leading-6"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span aria-live="polite" className={`text-xs ${status === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
          {status === "saving" ? "저장 중…" : status === "error" ? error : unsaved || status === "dirty" ? "저장하지 않은 변경이 있어요" : status === "saved" ? "저장됨" : "수업 당일 자정까지 고칠 수 있어요"}
        </span>
        <button type="button" disabled={disabled || status === "saving"} onClick={() => void save()} className="academy-button-secondary academy-button-sm shrink-0">
          한 줄 저장
        </button>
      </div>
    </div>
  );
}

/**
 * 선생님 «수업 피드» 칸 — 한 줄 + 사진 + 영상(2026-11-14).
 * 수업 진행 화면 밖(오늘 수업 홈의 수업 시트: 시작 전·끝난 수업)에서 쓴다.
 * - 시작 전: 한 줄만(사진·영상은 수업을 시작한 뒤에 올린다)
 * - 끝난 뒤: 한 줄·사진·영상 모두 당일 자정까지. 추가해도 학부모 알림은 다시 보내지 않는다.
 */
export function SessionFeedPanel({
  sessionId,
  initialLine,
  started,
  onLineSaved,
}: {
  sessionId: string;
  initialLine: string | null;
  onLineSaved?: (content: string | null) => void;
  /** 수업을 시작했는가(진행 중·완료) — 아니면 사진·영상 칸을 숨긴다 */
  started: boolean;
}) {
  const [line, setLine] = useState(initialLine ?? "");
  return (
    <div className="space-y-4">
      <FeedLineEditor sessionId={sessionId} value={line} onChange={setLine} onSaved={onLineSaved} />
      {started ? (
        <>
          <section aria-labelledby={`feed-photos-${sessionId}`}>
            <h3 id={`feed-photos-${sessionId}`} className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 사진</h3>
            <SessionPhotoUploader sessionId={sessionId} />
          </section>
          <section aria-labelledby={`feed-videos-${sessionId}`}>
            <h3 id={`feed-videos-${sessionId}`} className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 영상</h3>
            <SessionVideoUploader sessionId={sessionId} />
          </section>
        </>
      ) : (
        <p className="text-xs text-[var(--color-academy-muted)]">사진·영상은 수업을 시작한 뒤에 올릴 수 있어요.</p>
      )}
    </div>
  );
}
