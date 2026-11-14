"use client";

/**
 * 신청함 «부상 결석(기간)» 상세의 «환불 검토» 칸 (4단계 퇴원 정산, 2026-11-15 원장 결정)
 *
 * 왜: 부상 결석 중에 복귀하지 않고 퇴원하면 다음 수강료에서 뺄 수 없다 — 정산표 금액을 «환불 검토 ○원»으로 올려 두고,
 * 환불은 원장이 수납 관리의 «환불»로 직접 한다. 이 칸은 돈을 움직이지 않는다(할 일을 알려 주고, 끝났다는 기록만 받는다).
 * - 환불 검토 중: «환불 검토 ○원 · 수납 관리에서 환불한 뒤 ‹환불 처리함›을 눌러 주세요» + 수납 관리 링크
 *   + 메모 입력 → [환불 처리함](확인 창) + [환불 검토 취소](위험 작업 — 확인 창).
 * - 환불 처리함: 메모와 그때의 표 사본만 보인다(되돌리기 없음).
 * 표는 넘길 때의 사본이다(다시 계산하지 않는다). 금액은 서버가 원장에게만 내려보낸다 — 부원장 화면에는 숫자가 없다.
 * 아이콘 없이 글자, 굵기 400/500/600, 색은 토큰만, 누르는 것은 44px.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import {
  cancelIllnessPeriodRefundReviewAction, loadIllnessPeriodRefund, markIllnessPeriodRefundDoneAction,
} from "@/app/actions/illness-period-refund";
import type { IllnessPeriodRefundView } from "@/lib/regular/illnessPeriodRefundView";
import { REFUND_MEMO_MAX } from "@/lib/regular/illnessPeriodRules";

type Props = { periodId: string; studentName: string; onChanged: () => void | Promise<void> };

const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;
/** «2026-11-09» → «11/9» (글자만 자른다 — 시간대 계산 없음) */
const monthDay = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`;

export default function IllnessPeriodRefundBox({ periodId, studentName, onChanged }: Props) {
  const [view, setView] = useState<IllnessPeriodRefundView | null>(null);
  const [error, setError] = useState("");
  // 환불 처리 메모(환불한 날·방법·금액) — 적어야 [환불 처리함]이 켜진다
  const [memo, setMemo] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  const read = useCallback(() => loadIllnessPeriodRefund({ periodId })
    .catch(() => ({ ok: false as const, message: "정산 내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요." })), [periodId]);
  // 처리 뒤 다시 읽을 때
  const load = async () => {
    const result = await read();
    if (result.ok) { setView(result.settlement); setError(""); } else setError(result.message);
  };

  // 칸을 열 때 한 번 — 응답이 온 뒤에만 상태를 바꾼다(그 사이 칸이 닫혔으면 버린다)
  useEffect(() => {
    let alive = true;
    void read().then((result) => {
      if (!alive) return;
      if (result.ok) { setView(result.settlement); setError(""); } else setError(result.message);
    });
    return () => { alive = false; };
  }, [read]);

  if (error && !view) return <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{error}</p>;
  if (!view) return <p className="text-sm text-[var(--color-academy-muted)]">정산 내용을 불러오는 중…</p>;

  const done = view.refund.stage === "DONE";
  const memoReady = memo.trim().length > 0;

  async function markDone() {
    if (!view || !view.canSettle || !memoReady) return;
    const ok = await confirm({
      title: `${studentName} · 환불 처리함으로 닫기`,
      description: [
        view.carryTotal !== null ? `환불 검토 ${won(view.carryTotal)}을 수납 관리에서 환불했다고 기록합니다.` : "수납 관리에서 환불했다고 기록합니다.",
        "여기서 환불이 실행되지는 않습니다. 닫은 뒤에는 되돌릴 수 없습니다.",
        "학부모에게 앱 알림이 한 번 갑니다.",
      ].join(" "),
      confirmLabel: "환불 처리함",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await markIllnessPeriodRefundDoneAction({ periodId, memo: memo.trim() })
        .catch(() => ({ ok: false as const, message: "환불 처리함으로 닫지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await load();
      if (result.ok) { setMemo(""); await onChanged(); }
    });
  }

  async function cancelReview() {
    const ok = await confirm({
      title: `${studentName} · 환불 검토 취소`,
      description: "환불 검토로 넘긴 정산표와 정산 기록을 지우고 «정산 필요 · 퇴원»으로 되돌립니다. 지운 내용의 사본은 감사 기록에 남습니다. 이미 수납 관리에서 환불했다면 취소하지 말고 ‹환불 처리함›으로 닫아 주세요.",
      confirmLabel: "환불 검토 취소",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await cancelIllnessPeriodRefundReviewAction({ periodId })
        .catch(() => ({ ok: false as const, message: "환불 검토를 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      // 성공하면 상세 화면이 «정산 필요 · 퇴원» 칸으로 바꿔 그린다
      if (result.ok) await onChanged(); else await load();
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm" aria-label="환불 검토">
      <p className="font-semibold text-[var(--color-academy-ink)]">
        {done ? "환불 처리함" : "환불 검토"}
        {/* 금액은 원장에게만 내려온다 */}
        {view.carryTotal !== null && <span className="ml-2 tabular-nums">{won(view.carryTotal)}</span>}
      </p>
      {/* 할 일을 그대로 말한다 — 이 칸은 환불을 실행하지 않는다 */}
      {!done && <p className="text-xs text-[var(--color-academy-muted)]">수납 관리에서 환불한 뒤 ‹환불 처리함›을 눌러 주세요. 이 칸에서는 환불이 실행되지 않습니다.</p>}
      {done && view.refund.memo && (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm text-[var(--color-academy-success)]">처리 메모 · {view.refund.memo}</p>
      )}
      {!view.canSeeMoney && <p className="text-xs text-[var(--color-academy-muted)]">{done ? "환불 처리 완료 · 메모는 원장만 볼 수 있어요" : "금액과 환불 처리는 원장만 볼 수 있습니다."}</p>}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm font-medium ${message.tone === "ok"
          ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
          : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
      )}
      {error && <p role="alert" className="text-sm text-[var(--color-academy-danger)]">{error}</p>}

      {/* 넘길 때의 정산표 사본 — 한 줄 행: 달·반 · 빠진 날 · 소계(원장만) */}
      {view.rows.some((row) => row.dates.length > 0) && (
        <ul aria-label="환불 검토 정산표" className="divide-y divide-[var(--color-academy-line)] border-y border-[var(--color-academy-line)]">
          {view.rows.filter((row) => row.dates.length > 0).map((row) => (
            <li key={row.key} className="flex min-h-11 flex-wrap items-baseline gap-x-2 py-2">
              <p className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                <span className="font-medium">{monthLabel(row.month)} {row.className}</span>
                <span className="ml-1.5 text-xs text-[var(--color-academy-muted)]">결석 {row.dates.length}회({row.dates.map((item) => monthDay(item.date)).join(", ")}) · 수업 {row.sessions}회</span>
              </p>
              {row.subtotal !== null && <span className="whitespace-nowrap font-medium tabular-nums text-[var(--color-academy-ink)]">{won(row.subtotal)}</span>}
              {row.evidence === "UNPAID" && <span className="whitespace-nowrap text-xs text-[var(--color-academy-muted)]">낸 돈 없음 · 청구 없음</span>}
            </li>
          ))}
        </ul>
      )}
      {view.unpaid.length > 0 && (
        <ul aria-label="낸 돈이 없는 달" className="space-y-0.5 rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-xs text-[var(--color-academy-ink)]">
          {view.unpaid.map((line) => <li key={line} className="break-keep">{line}</li>)}
        </ul>
      )}

      {!done && view.canSettle && (
        <>
          {/* 수납 관리 — 그 학생의 납부 청구가 보이는 기존 화면(환불은 거기서 원장이 직접) */}
          <div className="flex justify-end">
            <Link href={view.refund.financeHref} className="academy-button-secondary">수납 관리에서 환불하기</Link>
          </div>
          <label className="block text-sm text-[var(--color-academy-ink)]">
            <span className="font-medium">환불 처리 메모</span>
            <span className="ml-1.5 text-xs text-[var(--color-academy-muted)]">환불한 날 · 방법 · 금액</span>
            <textarea
              className="academy-input mt-1 w-full" rows={2} value={memo} maxLength={REFUND_MEMO_MAX} disabled={pending}
              onChange={(event) => setMemo(event.target.value)} placeholder="예: 11/20 카드 취소 84,000원"
            />
          </label>
          {!view.writesEnabled && (
            <p className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">청구 준비 저장이 꺼져 있어 지금은 환불 검토를 취소할 수 없습니다.</p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* 위험 작업(되돌리기)은 위험 등급 버튼 + 확인 창 */}
            {view.writesEnabled && (
              <button type="button" disabled={pending} onClick={() => void cancelReview()} className="academy-button-danger">환불 검토 취소</button>
            )}
            <button type="button" disabled={pending || !memoReady} onClick={() => void markDone()} className="academy-button-primary">
              {pending ? "처리 중…" : "환불 처리함"}
            </button>
          </div>
        </>
      )}
      {confirmDialog}
    </div>
  );
}
