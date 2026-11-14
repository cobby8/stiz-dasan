"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendInquiryFollowUp } from "@/app/actions/parent-inquiry";
import { INQUIRY_BODY_MAX } from "@/lib/requests/inquiryThreadRules";
// 서버 안내를 그대로 띄우지 않고 고객용 문장인지 한 번 거른다(오류 원문·개발 용어 차단)
import { customerMessage } from "@/components/parent/customerMessage";

/**
 * 문의 «이어 쓰기» 입력칸 (2026-11-14 원장 결정표 c3).
 * 보내면 그 자리에서 대화에 붙는다(router.refresh). 실패하면 쓴 글은 그대로 두고 한 줄 안내만 보인다.
 */
export default function InquiryReplyForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit() {
    setError("");
    startTransition(async () => {
      try {
        const result = await sendInquiryFollowUp(requestId, body);
        if (!result.ok) {
          setError(customerMessage(result.error, "보내지 못했어요. 다시 시도해 주세요."));
          return;
        }
      } catch {
        // 통신 끊김·서버 오류 — 쓴 글은 지우지 않는다
        setError("보내지 못했어요. 다시 시도해 주세요.");
        return;
      }
      setBody("");
      router.refresh();
    });
  }

  return (
    <div className="academy-panel grid gap-2 p-3">
      <label htmlFor="inquiry-reply" className="text-xs font-medium text-[var(--color-academy-muted)]">이어서 쓰기</label>
      <textarea
        id="inquiry-reply"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        // 서버 한도(2,000자)와 같게 — 넘겨 쓰고 보냈다가 거절되는 일이 없게
        maxLength={INQUIRY_BODY_MAX}
        placeholder="더 전할 말을 적어 주세요"
        className="academy-input resize-none"
      />
      {/* 글자 수는 한도에 가까워질 때만 보인다(홈 문의 폼과 같은 기준) */}
      {body.length > INQUIRY_BODY_MAX - 200 && (
        <p className="text-right text-xs tabular-nums text-[var(--color-academy-faint)]" aria-live="polite">
          {body.length.toLocaleString("ko-KR")} / {INQUIRY_BODY_MAX.toLocaleString("ko-KR")}자
        </p>
      )}
      <button type="button" disabled={pending || !body.trim()} onClick={submit} className="academy-button-primary w-full">
        {pending ? "보내는 중..." : "보내기"}
      </button>
      {error && <p role="alert" className="text-xs font-semibold text-[var(--color-academy-danger)]">{error}</p>}
    </div>
  );
}
