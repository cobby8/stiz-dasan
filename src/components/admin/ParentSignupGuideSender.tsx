"use client";

/**
 * «학부모 가입 안내» 미리보기 → 원장 승인 → 대량 접수 부품 (문자 화면 «수동 발송» 탭).
 *
 * CustomerNoticeSender(1건 발송)와 순서·모양을 똑같이 맞췄다:
 *   ① «미리보기» → 서버가 받는 사람(재원생 미가입 학부모)을 직접 계산해 «N명»과 처음 몇 명(이름 가림)을 보여 줌. 아직 안 보냄.
 *   ② «N명에게 보내기» → 확인 창 → 서버가 받는 사람을 다시 계산해 미리보기와 같을 때만 대량 발송 큐에 접수.
 * 화면은 번호 목록을 서버로 보내지 않는다(받는 사람은 언제나 서버가 정한다).
 */

import { useState, useTransition } from "react";
import {
  prepareParentSignupGuide,
  sendParentSignupGuide,
  type ParentSignupGuidePreview,
} from "@/app/actions/customer-notice";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { formatKstDate } from "@/lib/datetime/kst";

export default function ParentSignupGuideSender() {
  // «다시 보내기» — 켜야만 이미 안내를 받은 번호도 넣는다(기본 꺼짐)
  const [resend, setResend] = useState(false);
  const [preview, setPreview] = useState<ParentSignupGuidePreview | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  function openPreview() {
    setMessage(null);
    setPreview(null);
    startTransition(async () => {
      try {
        const result = await prepareParentSignupGuide({ resend });
        if (!result.ok) return setMessage({ tone: "warn", text: result.message });
        setPreview(result);
      } catch {
        setMessage({ tone: "warn", text: "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    });
  }

  async function send() {
    if (!preview) return;
    const ok = await confirm({
      title: `학부모 ${preview.recipientCount}명에게 가입 안내 보내기`,
      description: `미리보기 문구 그대로 ${preview.recipientCount}명에게 문자를 보냅니다.${preview.resend ? "\n이미 받은 분께도 다시 보냅니다." : ""}\n보낸 뒤에는 취소할 수 없어요.`,
      confirmLabel: `${preview.recipientCount}명에게 보내기`,
      tone: "primary",
    });
    if (!ok) return;
    const target = preview;
    startTransition(async () => {
      try {
        // 미리보기를 만들 때의 «다시 보내기» 값을 그대로 쓴다(그 사이 체크를 바꿔도 다른 대상이 나가지 않게)
        const result = await sendParentSignupGuide({ approvalId: target.approvalId, resend: target.resend, approved: true });
        setMessage({ tone: result.ok ? "ok" : "warn", text: result.message });
      } catch {
        setMessage({ tone: "warn", text: "보낸 결과를 확인하지 못했습니다. «발송 이력» 탭을 먼저 확인하고, 다시 보내지 마세요." });
      } finally {
        // 보냈든 막혔든 미리보기는 닫는다(같은 미리보기로 두 번 누르지 않게)
        setPreview(null);
      }
    });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-academy-muted)]">
        재원생 학부모 중 아직 홈페이지 계정이 없는 분께 가입 링크를 보냅니다. 같은 번호는 한 번만 보내고, 이미 이 안내를 받은 분은 빠져요.
      </p>

      {/* 다시 보내기 — 터치 44px 줄 전체가 눌린다 */}
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-academy-ink)]">
        <input
          type="checkbox"
          checked={resend}
          onChange={(event) => { setResend(event.target.checked); setPreview(null); }}
          className="h-5 w-5 accent-[var(--color-academy-primary)]"
        />
        이미 받은 분께도 다시 보내기
      </label>

      {!preview && (
        <button type="button" disabled={pending} onClick={openPreview} className="academy-button-secondary inline-flex min-h-11 items-center gap-1 disabled:opacity-40">
          {pending ? "받는 사람 계산 중…" : "가입 안내 미리보기"}
        </button>
      )}

      {preview && (
        <section aria-label={`${preview.title} 미리보기`} className="space-y-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
          <p className="text-xs font-bold text-[var(--color-academy-ink)]">
            {preview.title} · 아직 보내지 않았어요
          </p>
          <p className="text-sm font-bold text-[var(--color-academy-ink)]">
            받는 사람 {preview.recipientCount}명
            <span className="ml-1 text-xs font-normal text-[var(--color-academy-muted)]">
              (번호 중복 제거{preview.resend ? " · 이미 받은 분 포함" : preview.alreadySentCount > 0 ? ` · 이미 받은 ${preview.alreadySentCount}명 제외` : ""}{preview.invalidPhoneCount > 0 ? ` · 휴대폰 번호 없는 ${preview.invalidPhoneCount}명 제외` : ""})
            </span>
          </p>
          <ul className="space-y-0.5 text-xs text-[var(--color-academy-muted)]">
            {preview.sample.map((line) => <li key={line}>{line}</li>)}
            {preview.recipientCount > preview.sample.length && <li>… 외 {preview.recipientCount - preview.sample.length}명</li>}
          </ul>
          <p className="text-xs text-[var(--color-academy-muted)]">
            {preview.messageType === "LMS" ? "장문 문자(LMS)" : "단문 문자(SMS)"} · {formatKstDate(preview.expiresAt, { hour: "2-digit", minute: "2-digit", hour12: false }, "-")}까지 보낼 수 있어요
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-academy-surface)] p-3 font-sans text-sm text-[var(--color-academy-ink)]">{preview.message}</pre>
          <div className="flex items-center gap-3">
            <button type="button" disabled={pending} onClick={() => setPreview(null)} className="academy-button-text min-h-11">닫기</button>
            <button type="button" disabled={pending} onClick={() => void send()} className="academy-button-primary ml-auto min-h-11 disabled:opacity-40">
              {pending ? "접수 중…" : `${preview.recipientCount}명에게 보내기`}
            </button>
          </div>
        </section>
      )}

      {message && (
        <p
          role={message.tone === "ok" ? "status" : "alert"}
          className={`rounded-lg px-3 py-2 text-xs font-bold ${message.tone === "ok"
            ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
            : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-ink)]"}`}
        >
          {message.text}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
