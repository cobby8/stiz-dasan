"use client";

/**
 * «학부모 공지 보내기» — 재원생 학부모 전체에게 공지(문자 화면 «수동 발송» 탭, 2026-11-09).
 *
 * ① 종류 고르기: 자유 공지 / 카톡 틀(학원 휴무·행사·월 안내)
 *    - 카톡 틀은 변수 칸만 채운다. 학생 이름·학원 전화는 서버가 사람마다 자동으로 넣는다.
 *    - 자유 공지는 본문을 직접 쓴다(브랜드 메시지 스위치가 켜져 있으면 카톡 브랜드 메시지, 아니면 문자).
 * ② «미리보기» → 서버가 받는 사람·채널·첫 번째 문구를 계산해 보여 줌(아직 안 보냄)
 * ③ «N명에게 보내기» → 확인 창 → 서버가 다시 계산해 미리보기와 같을 때만 대량 발송 큐에 접수
 * 화면은 번호 목록을 서버로 보내지 않는다(받는 사람은 언제나 서버가 정한다).
 */

import { useEffect, useState, useTransition } from "react";
import {
  getParentNoticeBrandResults,
  getParentNoticeOptions,
  prepareParentNotice,
  prepareParentNoticeSmsResend,
  sendParentNotice,
  sendParentNoticeSmsResend,
  type ParentNoticeBrandResult,
  type ParentNoticeOptions,
  type ParentNoticePreview,
  type ParentNoticeResendPreview,
} from "@/app/actions/parent-notice";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { formatKstDate } from "@/lib/datetime/kst";
import { NOTICE_FIELDS, NOTICE_KIND_LABEL, type ParentNoticeKind } from "@/lib/messaging/parent-notice";
import { PARENT_MESSAGE_PREFIX } from "@/lib/messaging/parent-alimtalk-templates";

const KINDS: ParentNoticeKind[] = ["FREE", "NOTICE_CLOSURE", "NOTICE_EVENT", "NOTICE_MONTHLY"];

const CHANNEL_TEXT: Record<ParentNoticePreview["messageType"], string> = {
  ALIMTALK: "카카오 알림톡",
  BMS: "카카오 브랜드 메시지",
  SMS: "단문 문자(SMS)",
  LMS: "장문 문자(LMS)",
};

export default function ParentNoticeSender() {
  const [kind, setKind] = useState<ParentNoticeKind>("FREE");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [noticeId, setNoticeId] = useState("");
  const [options, setOptions] = useState<ParentNoticeOptions | null>(null);
  const [preview, setPreview] = useState<ParentNoticePreview | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  useEffect(() => {
    let ignore = false;
    getParentNoticeOptions()
      .then((result) => {
        if (ignore) return;
        if (result.ok) setOptions(result);
        else setStatus({ tone: "warn", text: result.message });
      })
      .catch(() => { if (!ignore) setStatus({ tone: "warn", text: "공지 보내기 화면을 준비하지 못했습니다." }); });
    return () => { ignore = true; };
  }, []);

  // 무엇이든 바꾸면 미리보기는 닫는다(바뀐 내용으로 다시 확인하게)
  function changed() {
    setPreview(null);
    setStatus(null);
  }

  const fieldList = kind === "FREE" ? [] : NOTICE_FIELDS[kind];
  const brandBlocked = kind === "FREE" && options?.brandMessageEnabled === true && !options.brandWindowOpen;
  const channelHint = !options ? "" : kind === "FREE"
    ? options.brandMessageEnabled
      ? `카카오 브랜드 메시지로 보내요(광고 표시·수신거부 안내가 자동으로 붙음, ${options.brandWindowLabel}). 채널 친구가 아니면 받지 못해요 — 보낸 뒤 아래 결과에서 그분들께만 광고 표시 없는 문자로 다시 보낼 수 있어요.`
      : `문자로 보내요. 앞에 ${PARENT_MESSAGE_PREFIX} 가 자동으로 붙어요.`
    : options.alimtalkReady[kind]
      ? "카카오 알림톡으로 보내요. 학생 이름·학원 전화는 자동으로 들어가요. 실패하면 같은 내용을 문자로 보내요."
      : "알림톡 템플릿이 아직 등록되지 않아 같은 내용을 문자로 보내요. 학생 이름·학원 전화는 자동으로 들어가요.";

  function openPreview() {
    setStatus(null);
    setPreview(null);
    startTransition(async () => {
      try {
        const result = await prepareParentNotice({
          kind,
          fields: kind === "FREE" ? undefined : fields,
          message: kind === "FREE" ? message : undefined,
          noticeId: kind === "FREE" ? null : noticeId || null,
        });
        if (!result.ok) return setStatus({ tone: "warn", text: result.message });
        setPreview(result);
      } catch {
        setStatus({ tone: "warn", text: "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    });
  }

  async function send() {
    if (!preview) return;
    const ok = await confirm({
      title: `학부모 ${preview.recipientCount}명에게 ${preview.title} 보내기`,
      description: `미리보기 문구로 ${preview.recipientCount}명에게 보냅니다(${preview.channelNote}).\n학생 이름은 받는 분마다 바뀌어 들어가요.\n보낸 뒤에는 취소할 수 없어요.`,
      confirmLabel: `${preview.recipientCount}명에게 보내기`,
      tone: "primary",
    });
    if (!ok) return;
    const target = preview;
    startTransition(async () => {
      try {
        const result = await sendParentNotice({ approvalId: target.approvalId, approved: true });
        setStatus({ tone: result.ok ? "ok" : "warn", text: result.message });
      } catch {
        setStatus({ tone: "warn", text: "보낸 결과를 확인하지 못했습니다. «발송 이력» 탭을 먼저 확인하고, 다시 보내지 마세요." });
      } finally {
        setPreview(null);
      }
    });
  }

  const inputClass = "w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-sm text-[var(--color-academy-ink)]";

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--color-academy-muted)]">
        재원생 학부모 전체에게 보냅니다. 같은 번호는 한 번만(형제는 이름을 모아서) 보내요.
      </p>

      {/* 종류 고르기 — 터치 44px */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="공지 종류">
        {KINDS.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={kind === item}
            disabled={pending}
            onClick={() => { setKind(item); changed(); }}
            className={`min-h-11 rounded-xl px-2 text-sm font-bold disabled:opacity-40 ${kind === item
              ? "bg-[var(--color-academy-primary)] text-white"
              : "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"}`}
          >
            {item === "FREE" ? NOTICE_KIND_LABEL[item] : `카톡 틀 · ${NOTICE_KIND_LABEL[item]}`}
          </button>
        ))}
      </div>

      {channelHint && <p className="text-xs text-[var(--color-academy-muted)]">{channelHint}</p>}

      {kind === "FREE" ? (
        <label className="block space-y-1">
          <span className="text-xs font-bold text-[var(--color-academy-ink)]">내용</span>
          <textarea
            value={message}
            disabled={pending}
            onChange={(event) => { setMessage(event.target.value); changed(); }}
            rows={6}
            maxLength={1000}
            placeholder="학부모님께 보낼 공지를 입력하세요."
            className={`${inputClass} resize-none`}
          />
        </label>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {fieldList.map((field) => (
            <label key={`${kind}-${field.key}`} className={`block space-y-1 ${field.multiline ? "sm:col-span-2" : ""}`}>
              <span className="text-xs font-bold text-[var(--color-academy-ink)]">{field.label}</span>
              {field.multiline ? (
                <textarea
                  value={fields[field.key] ?? ""}
                  disabled={pending}
                  maxLength={field.maxLength}
                  rows={3}
                  placeholder={field.placeholder}
                  onChange={(event) => { setFields((current) => ({ ...current, [field.key]: event.target.value })); changed(); }}
                  className={`${inputClass} resize-none`}
                />
              ) : (
                <input
                  value={fields[field.key] ?? ""}
                  disabled={pending}
                  maxLength={field.maxLength}
                  inputMode={field.key === "month" ? "numeric" : undefined}
                  placeholder={field.placeholder}
                  onChange={(event) => { setFields((current) => ({ ...current, [field.key]: event.target.value })); changed(); }}
                  className={`${inputClass} min-h-11`}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {/* 카톡 틀의 «공지 자세히 보기» 버튼이 열 공지(자유 공지에는 버튼이 없다) */}
      {kind !== "FREE" && (
        <label className="block space-y-1">
          <span className="text-xs font-bold text-[var(--color-academy-ink)]">«공지 자세히 보기» 버튼이 열 공지</span>
          <select
            value={noticeId}
            disabled={pending}
            onChange={(event) => { setNoticeId(event.target.value); changed(); }}
            className={`${inputClass} min-h-11`}
          >
            <option value="">공지 목록(선택 안 함)</option>
            {(options?.notices ?? []).map((notice) => <option key={notice.id} value={notice.id}>{notice.title}</option>)}
          </select>
        </label>
      )}

      {brandBlocked && (
        <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs font-bold text-[var(--color-academy-ink)]">
          브랜드 메시지(광고성)는 {options?.brandWindowLabel}에만 보낼 수 있어요. 내일 오전 8시 이후 다시 보내 주세요.
        </p>
      )}

      {!preview && (
        <button
          type="button"
          disabled={pending || !options || brandBlocked || (kind === "FREE" && !message.trim())}
          onClick={openPreview}
          className="academy-button-secondary inline-flex min-h-11 items-center gap-1 disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">preview</span>
          {pending ? "받는 사람 계산 중…" : "공지 미리보기"}
        </button>
      )}

      {preview && (
        <section aria-label={`${preview.title} 미리보기`} className="space-y-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
          <p className="text-xs font-bold text-[var(--color-academy-ink)]">{preview.title} · 아직 보내지 않았어요</p>
          <p className="text-sm font-bold text-[var(--color-academy-ink)]">
            받는 사람 {preview.recipientCount}명
            <span className="ml-1 text-xs font-normal text-[var(--color-academy-muted)]">
              (번호 중복 제거{preview.invalidPhoneCount > 0 ? ` · 휴대폰 번호 없는 ${preview.invalidPhoneCount}명 제외` : ""}{preview.noNameCount > 0 ? ` · 학생 이름이 비어 있는 ${preview.noNameCount}명 제외` : ""})
            </span>
          </p>
          <ul className="space-y-0.5 text-xs text-[var(--color-academy-muted)]">
            {preview.sample.map((line) => <li key={line}>{line}</li>)}
            {preview.recipientCount > preview.sample.length && <li>… 외 {preview.recipientCount - preview.sample.length}명</li>}
          </ul>
          <p className="text-xs text-[var(--color-academy-muted)]">
            {CHANNEL_TEXT[preview.messageType]} · {preview.channelNote} · {formatKstDate(preview.expiresAt, { hour: "2-digit", minute: "2-digit", hour12: false }, "-")}까지 보낼 수 있어요
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

      {status && (
        <p
          role={status.tone === "ok" ? "status" : "alert"}
          className={`rounded-lg px-3 py-2 text-xs font-bold ${status.tone === "ok"
            ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
            : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-ink)]"}`}
        >
          {status.text}
        </p>
      )}
      {/* 브랜드 메시지를 못 받은 학부모 → 광고 표시 없는 정보성 문자로 다시 보내기(별도 미리보기·승인) */}
      {options && options.brandResults.length > 0 && (
        <BrandResendSection initial={options.brandResults} confirm={confirm} />
      )}
      {confirmDialog}
    </div>
  );
}

type ConfirmFn = ReturnType<typeof useAdminConfirm>["confirm"];

/**
 * 최근 브랜드 메시지 공지 결과 — «카톡 친구가 아니어서 못 받은 학부모 N명».
 * 브랜드 메시지는 광고성이라 문자로 자동 대체하지 않는다. 원장이 누를 때만 같은 내용을
 * «[스티즈농구교실] 내용» 일반 문자로(광고 표시 없음) 다시 보낸다 — 한 공지당 한 번.
 */
function BrandResendSection({ initial, confirm }: { initial: ParentNoticeBrandResult[]; confirm: ConfirmFn }) {
  const [results, setResults] = useState(initial);
  const [preview, setPreview] = useState<ParentNoticeResendPreview | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function refresh() {
    setStatus(null);
    startTransition(async () => {
      const result = await getParentNoticeBrandResults().catch(() => null);
      if (result?.ok) setResults(result.brandResults);
      else setStatus({ tone: "warn", text: "결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
    });
  }

  function openPreview(batchId: string) {
    setStatus(null);
    setPreview(null);
    startTransition(async () => {
      try {
        const result = await prepareParentNoticeSmsResend({ batchId });
        if (!result.ok) return setStatus({ tone: "warn", text: result.message });
        setPreview(result);
      } catch {
        setStatus({ tone: "warn", text: "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    });
  }

  async function send() {
    if (!preview) return;
    const ok = await confirm({
      title: `${preview.recipientCount}명에게 정보성 문자로 다시 보내기`,
      description: `카톡으로 공지를 못 받은 학부모 ${preview.recipientCount}명에게 같은 내용을 광고 표시 없는 일반 문자로 보냅니다.\n이 공지는 한 번만 다시 보낼 수 있어요. 보낸 뒤에는 취소할 수 없어요.`,
      confirmLabel: `${preview.recipientCount}명에게 문자 보내기`,
      tone: "primary",
    });
    if (!ok) return;
    const target = preview;
    startTransition(async () => {
      try {
        const result = await sendParentNoticeSmsResend({ approvalId: target.approvalId, approved: true });
        setStatus({ tone: result.ok ? "ok" : "warn", text: result.message });
        const fresh = await getParentNoticeBrandResults().catch(() => null);
        if (fresh?.ok) setResults(fresh.brandResults);
      } catch {
        setStatus({ tone: "warn", text: "보낸 결과를 확인하지 못했습니다. «발송 이력» 탭을 먼저 확인하고, 다시 보내지 마세요." });
      } finally {
        setPreview(null);
      }
    });
  }

  return (
    <section aria-label="브랜드 메시지 결과" className="space-y-2 rounded-xl border border-[var(--color-academy-line)] p-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-bold text-[var(--color-academy-ink)]">최근 브랜드 메시지 공지 결과</p>
        <button type="button" disabled={pending} onClick={refresh} className="academy-button-text ml-auto min-h-11 text-xs disabled:opacity-40">결과 다시 확인</button>
      </div>
      <ul className="space-y-1">
        {results.map((item) => (
          <li key={item.batchId} className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-academy-ink)]">
            <span className="text-[var(--color-academy-muted)]">{formatKstDate(item.createdAt, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }, "-")}</span>
            <span>{item.total}명 중</span>
            {item.pending > 0 && <span>확인 중 {item.pending}명</span>}
            {item.notDelivered > 0
              ? <strong>카톡 친구가 아니어서 못 받은 학부모 {item.notDelivered}명</strong>
              : item.pending === 0 && <span>모두 카톡으로 받음</span>}
            {item.resent && <span className="text-[var(--color-academy-muted)]">· 정보성 문자로 다시 보냄</span>}
            {item.notDelivered > 0 && !item.resent && item.pending === 0 && (
              <button type="button" disabled={pending} onClick={() => openPreview(item.batchId)} className="academy-button-secondary ml-auto min-h-11 text-xs disabled:opacity-40">
                이분들께는 정보성 문자로 다시 보낼까요?
              </button>
            )}
          </li>
        ))}
      </ul>

      {preview && (
        <div className="space-y-2 rounded-lg bg-[var(--color-academy-soft)] p-3">
          <p className="text-xs font-bold text-[var(--color-academy-ink)]">
            정보성 문자 다시 보내기 · 받는 사람 {preview.recipientCount}명 · 아직 보내지 않았어요
            {preview.droppedCount > 0 && <span className="ml-1 font-normal text-[var(--color-academy-muted)]">(퇴원·번호 변경 {preview.droppedCount}명 제외)</span>}
          </p>
          <ul className="space-y-0.5 text-xs text-[var(--color-academy-muted)]">
            {preview.sample.map((line) => <li key={line}>{line}</li>)}
            {preview.recipientCount > preview.sample.length && <li>… 외 {preview.recipientCount - preview.sample.length}명</li>}
          </ul>
          <p className="text-xs text-[var(--color-academy-muted)]">
            {CHANNEL_TEXT[preview.messageType]} · 광고 표시 없음 · {formatKstDate(preview.expiresAt, { hour: "2-digit", minute: "2-digit", hour12: false }, "-")}까지 보낼 수 있어요
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-academy-surface)] p-3 font-sans text-sm text-[var(--color-academy-ink)]">{preview.message}</pre>
          <div className="flex items-center gap-3">
            <button type="button" disabled={pending} onClick={() => setPreview(null)} className="academy-button-text min-h-11">닫기</button>
            <button type="button" disabled={pending} onClick={() => void send()} className="academy-button-primary ml-auto min-h-11 disabled:opacity-40">
              {pending ? "접수 중…" : `${preview.recipientCount}명에게 문자 보내기`}
            </button>
          </div>
        </div>
      )}

      {status && (
        <p role={status.tone === "ok" ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-xs font-bold ${status.tone === "ok"
          ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
          : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-ink)]"}`}>
          {status.text}
        </p>
      )}
    </section>
  );
}
