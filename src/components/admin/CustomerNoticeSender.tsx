"use client";

/**
 * «고객 안내 문자 미리보기 → 원장 승인 → 보내기» 공용 부품.
 *
 * 한 벌로 세 곳이 같이 쓴다(레고 블록처럼 끼워 쓰기):
 *   - 카카오 접수함: 처리 결과 안내   <CustomerNoticeSender kind="KAKAO_INTAKE_RESULT" intakeId=… />
 *   - 학생 상세:     카카오채널 링크   <CustomerNoticeSender kind="KAKAO_CHANNEL_INVITE" studentId=… />
 *   - 문자 화면 등:  대관 안내        <CustomerNoticeSender kind="RENTAL_GUIDE" initialPhone=… />
 *     (나중에 대관 관리 화면에서도 initialPhone 에 신청자 번호를 넣어 그대로 쓰면 된다)
 *
 * 순서: ① «미리보기» 버튼 → 서버가 문구·받는 사람(끝 4자리)을 만들어 보여 줌(아직 안 보냄)
 *       ② «보내기» → 확인 창 → 서버가 다시 한 번 대조한 뒤 1건만 발송.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import {
  prepareCustomerNotice,
  sendCustomerNotice,
  type CustomerNoticePreview,
  type CustomerNoticeRequest,
} from "@/app/actions/customer-notice";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { CUSTOMER_NOTICE_EXTRA_LINE_MAX } from "@/lib/customer-notice/templates";
import { formatKstDate } from "@/lib/datetime/kst";

type CommonProps = {
  buttonLabel?: string;
  hint?: string;
  /** true 면 화면에 나타나자마자 미리보기를 연다(예: 접수 처리 직후). 보내기는 여전히 원장이 눌러야 한다 */
  autoOpen?: boolean;
};

type Props = CommonProps & (
  | { kind: "KAKAO_INTAKE_RESULT"; intakeId: string }
  | { kind: "KAKAO_CHANNEL_INVITE"; studentId: string }
  | { kind: "RENTAL_GUIDE"; initialPhone?: string }
);

const DEFAULT_BUTTON: Record<Props["kind"], string> = {
  KAKAO_INTAKE_RESULT: "결과 문자 미리보기",
  KAKAO_CHANNEL_INVITE: "카카오채널 링크 보내기",
  RENTAL_GUIDE: "대관 안내 미리보기",
};

export default function CustomerNoticeSender(props: Props) {
  const [phone, setPhone] = useState(props.kind === "RENTAL_GUIDE" ? props.initialPhone ?? "" : "");
  const [extraLine, setExtraLine] = useState("");
  const [preview, setPreview] = useState<CustomerNoticePreview | null>(null);
  // 미리보기를 만들 때 쓴 요청을 그대로 붙잡아 둔다 — 보낸 뒤 입력칸을 바꿔도 다른 내용이 나가지 않게
  const [previewRequest, setPreviewRequest] = useState<CustomerNoticeRequest | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  function currentRequest(): CustomerNoticeRequest {
    if (props.kind === "KAKAO_INTAKE_RESULT") return { kind: props.kind, intakeId: props.intakeId, extraLine };
    if (props.kind === "KAKAO_CHANNEL_INVITE") return { kind: props.kind, studentId: props.studentId };
    return { kind: props.kind, phone };
  }

  function openPreview() {
    const request = currentRequest();
    setMessage(null);
    setPreview(null);
    startTransition(async () => {
      try {
        const result = await prepareCustomerNotice(request);
        if (!result.ok) return setMessage({ tone: "warn", text: result.message });
        setPreview(result);
        setPreviewRequest(request);
      } catch {
        setMessage({ tone: "warn", text: "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    });
  }

  // 자동 열기는 «미리보기»까지만, 한 번만 한다(발송은 절대 자동으로 하지 않는다)
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!props.autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    openPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.autoOpen]);

  async function send() {
    if (!preview || !previewRequest) return;
    const ok = await confirm({
      title: `${preview.recipientLabel}에게 문자 1건 보내기`,
      description: `받는 번호 ${preview.maskedRecipient}\n미리보기 문구 그대로 보냅니다. 보낸 뒤에는 취소할 수 없어요.`,
      confirmLabel: "보내기",
      tone: "primary",
    });
    if (!ok) return;
    const target = preview;
    startTransition(async () => {
      try {
        const result = await sendCustomerNotice({ approvalId: target.approvalId, request: previewRequest, approved: true });
        setMessage({ tone: result.ok ? "ok" : "warn", text: result.message });
        // 보냈거나 막혔으면 미리보기는 닫는다(같은 미리보기로 두 번 누르지 않게)
        setPreview(null);
        setPreviewRequest(null);
        if (result.ok) setExtraLine("");
      } catch {
        setPreview(null);
        setPreviewRequest(null);
        setMessage({ tone: "warn", text: "보낸 결과를 확인하지 못했습니다. 문자 발송 이력을 먼저 확인하고, 다시 보내지 마세요." });
      }
    });
  }

  return (
    <div className="space-y-2">
      {props.hint && <p className="text-xs text-[var(--color-academy-muted)]">{props.hint}</p>}

      {/* 대관 안내: 번호 직접 입력(또는 넘겨받은 기존 연락처) */}
      {props.kind === "RENTAL_GUIDE" && (
        <label className="block text-xs font-bold text-[var(--color-academy-ink)]">
          받는 휴대폰 번호
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            placeholder="010-1234-5678"
            onChange={(event) => { setPhone(event.target.value); setPreview(null); }}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-normal"
          />
        </label>
      )}

      {/* 접수 결과: 학부모께 전할 한 줄(선택) — 내부 검토 메모는 문자에 넣지 않는다 */}
      {props.kind === "KAKAO_INTAKE_RESULT" && (
        <label className="block text-xs font-bold text-[var(--color-academy-ink)]">
          학부모께 덧붙일 한 줄 (선택)
          <input
            type="text"
            value={extraLine}
            maxLength={CUSTOMER_NOTICE_EXTRA_LINE_MAX}
            placeholder="예: 다음 달부터 반영됩니다"
            onChange={(event) => { setExtraLine(event.target.value); setPreview(null); }}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-normal"
          />
        </label>
      )}

      {!preview && (
        <button type="button" disabled={pending} onClick={openPreview} className="academy-button-secondary min-h-11 disabled:opacity-40">
          {pending ? "준비 중…" : props.buttonLabel ?? DEFAULT_BUTTON[props.kind]}
        </button>
      )}

      {preview && (
        <section aria-label={`${preview.title} 미리보기`} className="space-y-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
          <p className="text-xs font-bold text-[var(--color-academy-ink)]">
            {preview.title} · 아직 보내지 않았어요
          </p>
          <p className="text-xs text-[var(--color-academy-muted)]">
            받는 사람 {preview.recipientLabel} · {preview.maskedRecipient} · 문자 1건 · {formatKstDate(preview.expiresAt, { hour: "2-digit", minute: "2-digit", hour12: false }, "-")}까지 보낼 수 있어요
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-academy-surface)] p-3 font-sans text-sm text-[var(--color-academy-ink)]">{preview.message}</pre>
          <div className="flex items-center gap-3">
            <button type="button" disabled={pending} onClick={() => { setPreview(null); setPreviewRequest(null); }} className="academy-button-text">닫기</button>
            <button type="button" disabled={pending} onClick={() => void send()} className="academy-button-primary ml-auto min-h-11 disabled:opacity-40">
              {pending ? "보내는 중…" : "이대로 보내기"}
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
