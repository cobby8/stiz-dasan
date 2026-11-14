"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { sendInquiryFollowUp } from "@/app/actions/parent-inquiry";
import { INQUIRY_BODY_MAX, OPEN_REFUND_EXISTS_PARENT } from "@/lib/requests/inquiryThreadRules";
// 서버 안내를 그대로 띄우지 않고 고객용 문장인지 한 번 거른다(오류 원문·개발 용어 차단)
import { customerMessage } from "@/components/parent/customerMessage";
import { academyTel } from "@/lib/academyPhoneRules";

/**
 * 문의 «이어 쓰기» 입력칸 (2026-11-14 원장 결정표 c3).
 * 보내면 그 자리에서 대화에 붙는다(router.refresh). 실패하면 쓴 글은 그대로 두고 한 줄 안내만 보인다.
 */
export default function InquiryReplyForm({ requestId, academyPhone = null }: { requestId: string; /** 학원 대표 번호(걸 수 있는 값만) — 연속 글 한도 안내의 전화 버튼 */ academyPhone?: string | null }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  // 학원 답을 기다리는 동안 연달아 쓴 글이 한도(5개)에 닿았는가 — 안내 + 전화 버튼을 보인다
  const [waitingLimit, setWaitingLimit] = useState(false);
  const tel = academyTel(academyPhone);
  // 글은 붙었지만 이 문의는 다시 열리지 않았다 — 같은 청구에 열려 있는 다른 환불 문의로 안내한다
  const [openRefundId, setOpenRefundId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError("");
    setWaitingLimit(false);
    startTransition(async () => {
      try {
        const result = await sendInquiryFollowUp(requestId, body);
        if (!result.ok) {
          if (result.waitingLimit) setWaitingLimit(true);
          setError(customerMessage(result.error, "보내지 못했어요. 다시 시도해 주세요."));
          return;
        }
        setOpenRefundId(result.openRefundRequestId ?? null);
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
      {openRefundId && (
        <p role="status" className="text-xs text-[var(--color-academy-muted)]">
          {OPEN_REFUND_EXISTS_PARENT}{" "}
          <Link href={`/mypage/requests/${openRefundId}`} className="inline-flex min-h-11 items-center underline">그 문의 보기</Link>
        </p>
      )}
      {/* 한도 안내는 막다른 곳으로 두지 않는다 — 급하면 그 자리에서 전화 */}
      {waitingLimit && tel && (
        <a href={`tel:${tel}`} className="academy-button-secondary w-full tabular-nums">학원에 전화 {academyPhone}</a>
      )}
    </div>
  );
}
