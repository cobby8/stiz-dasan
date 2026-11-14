"use client";

/**
 * 신청함 «부상 결석(기간)» 상세의 «복귀 정산» 칸 (3단계, 2026-11-15 원장 결정)
 *
 * 왜: 기간 결석은 승인 때 금액을 정하지 않는다. 복귀가 확정되면 빠진 수업을 달별로 세어 이월 금액을 «한 번» 계산한다.
 * - 결석 중(복귀 미정): «지금까지 예상 이월 ○원» 한 줄(원장만). [정산하기]를 누르면 복귀일을 받아 표를 연다.
 * - 정산 표: 달·반마다 한 줄 — 빠진 날짜 칩(누르면 빼기/넣기) · 한 번 값 · 소계. 뺀 날은 이유와 함께 흐리게.
 * - 합계 + 낸 돈이 없는 달 안내 + [이월 확정] 한 번(확인 창). 확정하면 발행 보류가 풀리고 청구 준비에 이월 차감이 제안된다.
 * - 확정 뒤: 그때의 표 사본 + «청구 준비로 이동» + [확정 취소](이월이 쓰이기 전에만).
 * 금액은 서버가 계산한다 — 화면은 날짜를 빼고 넣는 것만 보내고, 숫자는 받은 그대로 보인다. 부원장 응답에는 금액이 없다.
 * - 퇴원 정산(refund, 4단계): 부상 결석 중에 퇴원했으면 같은 표로 «환불 검토 금액»을 보이고 버튼이 [환불 검토로 넘기기]가 된다.
 *   이월을 만들지 않고 돈도 움직이지 않는다 — 넘긴 뒤 화면은 IllnessPeriodRefundBox 가 그린다(수납 관리 링크 · 환불 처리함).
 * 아이콘 없이 글자, 굵기 400/500/600, 색은 토큰만, 누르는 것은 44px.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { todayKst } from "@/lib/datetime/kst";
import {
  cancelIllnessPeriodSettlementAction, loadIllnessPeriodSettlement, settleIllnessPeriodAction, type IllnessPeriodSettlementView,
} from "@/app/actions/illness-period-admin";
import { loadIllnessPeriodRefund, sendIllnessPeriodRefundReviewAction } from "@/app/actions/illness-period-refund";

type Props = {
  periodId: string;
  studentName: string;
  /** APPROVED | SETTLED */
  carryState: string;
  onChanged: () => void | Promise<void>;
  /** 위 «발행 보류» 칸으로 옮겨 가기(미납 청구가 남아 확정이 막혔을 때) — 상세 화면이 그 칸을 다시 읽고 보여 준다 */
  onGoHold?: () => void | Promise<void>;
  /** 퇴원 정산 길(대상 반이 모두 수강 종료) — 복귀일을 받지 않고, 이월 확정 대신 «환불 검토로 넘기기» */
  refund?: boolean;
};

const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;
/** «2026-11-09» → «11/9» (글자만 자른다 — 시간대 계산 없음) */
const monthDay = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`;
const EVIDENCE_LABEL: Record<string, string> = {
  WORKBENCH_ISSUED: "발행·납부", PAID_PAYMENT: "납부 청구", UNPAID: "낸 돈 없음", BLOCKED: "확인 필요",
};

export default function IllnessPeriodSettlementBox({ periodId, studentName, carryState, onChanged, onGoHold, refund = false }: Props) {
  const [view, setView] = useState<IllnessPeriodSettlementView | null>(null);
  const [error, setError] = useState("");
  // 원장이 뺀 날(결석 id) — 서버가 이 목록으로 다시 계산한다
  const [omit, setOmit] = useState<string[]>([]);
  // 진행 중인 기간: 원장이 넣는 복귀일(다시 나오는 날)
  const [returnDate, setReturnDate] = useState("");
  // 표를 펼쳤는가(결석 중에는 «예상» 한 줄만 보이다가 [정산하기]로 연다)
  const [open, setOpen] = useState(carryState === "SETTLED");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  const load = useCallback(async (nextOmit: string[], nextReturn: string) => {
    // 퇴원 정산은 복귀일이 없다(오늘까지 빠진 수업) — 같은 표 모양을 내려 주는 다른 읽기 함수를 쓴다
    const result = await (refund
      ? loadIllnessPeriodRefund({ periodId, omitAbsenceIds: nextOmit })
      : loadIllnessPeriodSettlement({ periodId, omitAbsenceIds: nextOmit, returnDate: nextReturn || null }))
      .catch(() => ({ ok: false as const, message: "정산 내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요." }));
    if (result.ok) { setView(result.settlement); setError(""); } else setError(result.message);
    return result.ok;
  }, [periodId, refund]);

  // 칸을 열 때 한 번(그 뒤로는 날짜를 빼고 넣을 때·복귀일을 바꿀 때 다시 읽는다)
  useEffect(() => { void load([], ""); }, [load]);

  if (error && !view) return <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{error}</p>;
  if (!view) return <p className="text-sm text-[var(--color-academy-muted)]">정산 내용을 불러오는 중…</p>;

  const settled = view.state === "SETTLED";
  const includedCount = view.rows.reduce((sum, row) => sum + row.dates.length, 0);
  const canConfirm = view.state === "READY" && view.blockers.length === 0 && view.canSettle && view.writesEnabled && includedCount > 0;

  function toggle(absenceId: string) {
    const next = omit.includes(absenceId) ? omit.filter((id) => id !== absenceId) : [...omit, absenceId];
    setOmit(next);
    startTransition(async () => { await load(next, returnDate); });
  }

  function applyReturnDate(value: string) {
    setReturnDate(value);
    startTransition(async () => { await load(omit, value); });
  }

  async function settle() {
    if (!view || !canConfirm || !view.fingerprint) return;
    const ok = await confirm({
      title: `${studentName} · 이월 ${won(view.carryTotal ?? 0)} 확정`,
      description: [
        `결석 ${includedCount}회를 정산합니다.`,
        view.canSetReturnDate && view.returnDate ? `복귀일 ${monthDay(view.returnDate)}로 복귀 처리도 함께 합니다(그날 이후 결석은 취소).` : "",
        view.availableMonth ? `이월은 ${monthLabel(view.availableMonth)} 청구부터 자동으로 차감이 제안되고, 남으면 다음 달로 넘어갑니다.` : "",
        "발행 보류가 풀립니다. 청구는 자동으로 나가지 않으니 청구 준비에서 금액을 확인하고 발행해 주세요.",
        "학부모에게 앱 알림이 한 번 갑니다.",
      ].filter(Boolean).join(" "),
      confirmLabel: "이월 확정",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await settleIllnessPeriodAction({
        periodId, omitAbsenceIds: omit, expectedFingerprint: view.fingerprint ?? "", returnDate: view.canSetReturnDate ? view.returnDate : null,
      }).catch(() => ({ ok: false as const, message: "이월을 확정하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      // 성공하면 확정된 표 사본으로, 실패하면(내용이 바뀜 등) 최신 미리보기로 다시 읽는다
      await load(result.ok ? [] : omit, result.ok ? "" : returnDate);
      if (result.ok) { setOmit([]); setOpen(true); await onChanged(); }
    });
  }

  // 퇴원 정산: 환불 검토로 넘긴다 — 이월을 만들지 않고 돈도 움직이지 않는다(환불은 원장이 수납 관리에서 직접)
  async function sendRefundReview() {
    if (!view || !canConfirm || !view.fingerprint) return;
    const ok = await confirm({
      title: `${studentName} · 환불 검토 ${won(view.carryTotal ?? 0)}로 넘기기`,
      description: [
        `결석 ${includedCount}회를 정산표로 확정해 «환불 검토»로 올립니다.`,
        "여기서 환불이 실행되지는 않습니다. 수납 관리에서 직접 환불한 뒤 ‹환불 처리함›을 눌러 닫아 주세요.",
        "이 결석으로는 보강권·이월이 다시 나가지 않습니다.",
        "학부모에게 앱 알림이 한 번 갑니다.",
      ].join(" "),
      confirmLabel: "환불 검토로 넘기기",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await sendIllnessPeriodRefundReviewAction({ periodId, omitAbsenceIds: omit, expectedFingerprint: view.fingerprint ?? "" })
        .catch(() => ({ ok: false as const, message: "환불 검토로 넘기지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      // 성공하면 상세 화면이 «환불 검토» 칸으로 바꿔 그린다. 실패하면(내용이 바뀜 등) 최신 미리보기로 다시 읽는다
      if (result.ok) { setOmit([]); await onChanged(); } else await load(omit, "");
    });
  }

  async function cancelSettlement() {
    const ok = await confirm({
      title: `${studentName} · 이월 확정 취소`,
      description: "이 기간으로 적립한 이월과 정산 기록을 지우고 «정산 필요»로 되돌립니다. 그 아이의 청구 발행이 다시 보류됩니다. 지운 내용의 사본은 감사 기록에 남습니다.",
      confirmLabel: "확정 취소",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await cancelIllnessPeriodSettlementAction({ periodId })
        .catch(() => ({ ok: false as const, message: "확정을 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }));
      setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await load([], "");
      if (result.ok) await onChanged();
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm" aria-label="복귀 정산">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 font-semibold text-[var(--color-academy-ink)]">
          {refund ? "퇴원 정산 · 환불 검토 금액" : settled ? "이월 확정" : view.state === "READY" ? "복귀 정산" : "지금까지 예상 이월"}
          {/* 금액은 원장에게만 내려온다 */}
          {view.carryTotal !== null && <span className="ml-2 tabular-nums">{won(view.carryTotal)}</span>}
        </p>
        {!settled && !open && (
          <button type="button" disabled={pending} onClick={() => { setOpen(true); if (view.canSetReturnDate && !returnDate) applyReturnDate(view.storedReturnDate ?? todayKst()); }} className="academy-button-primary">
            정산하기
          </button>
        )}
      </div>
      {!settled && !open && (
        <p className="text-xs text-[var(--color-academy-muted)]">
          {refund ? "수강을 종료했어요. 오늘까지 빠진 수업 기준으로 표를 확인하고 환불 검토로 넘겨 주세요."
            : view.state === "ESTIMATE" ? "오늘까지 빠진 수업 기준이에요. 금액은 복귀한 뒤 한 번 확정합니다." : "복귀했어요. 표를 확인하고 이월을 확정해 주세요."}
          {!view.canSeeMoney && " 금액은 원장만 볼 수 있습니다."}
        </p>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm font-medium ${message.tone === "ok"
          ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
          : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
      )}
      {error && <p role="alert" className="text-sm text-[var(--color-academy-danger)]">{error}</p>}

      {open && (
        <>
          {/* 진행 중인 학원 등록 기간 — 복귀일을 여기서 받는다(확정 때 복귀 처리도 함께 한다) */}
          {!settled && view.canSetReturnDate && (
            <label className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-[var(--color-academy-ink)]">
              <span className="shrink-0 font-medium">복귀일(다시 나오는 날)</span>
              <input type="date" value={returnDate || view.returnDate || ""} disabled={pending} onChange={(event) => applyReturnDate(event.target.value)} className="academy-input min-w-0 flex-1" />
            </label>
          )}
          {!settled && !refund && !view.canSetReturnDate && view.returnDate && (
            <p className="text-xs text-[var(--color-academy-muted)]">복귀일 {monthDay(view.returnDate)} 기준</p>
          )}
          {refund && <p className="text-xs text-[var(--color-academy-muted)]">오늘까지 빠진 수업 기준 · 낸 돈이 있는 달만 환불 검토 금액에 들어가요</p>}

          {view.rows.length === 0 ? (
            <p className="text-sm text-[var(--color-academy-muted)]">정산할 결석이 없습니다.</p>
          ) : (
            <ul aria-label="달별 정산 표" className="divide-y divide-[var(--color-academy-line)] border-y border-[var(--color-academy-line)]">
              {view.rows.map((row) => (
                <li key={row.key} className="space-y-1 py-2">
                  {/* 한 줄: 달·반(왼쪽) · 한 번 값 × 횟수 · 소계(오른쪽) */}
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <p className="min-w-0 flex-1 break-keep font-medium text-[var(--color-academy-ink)]">
                      {monthLabel(row.month)} {row.className}
                      <span className="ml-1.5 text-xs font-normal text-[var(--color-academy-muted)]">{EVIDENCE_LABEL[row.evidence] ?? row.evidence} · 수업 {row.sessions}회</span>
                    </p>
                    {row.unit !== null && (
                      <span className="whitespace-nowrap text-xs tabular-nums text-[var(--color-academy-muted)]">한 번 {won(row.unit)} × {row.dates.length}회</span>
                    )}
                    {row.subtotal !== null && <span className="whitespace-nowrap font-medium tabular-nums text-[var(--color-academy-ink)]">{won(row.subtotal)}</span>}
                    {row.evidence === "UNPAID" && <span className="whitespace-nowrap text-xs text-[var(--color-academy-muted)]">{refund ? "낸 돈 없음 · 청구 없음" : "이월 없음 · 다닌 만큼만 청구"}</span>}
                  </div>
                  {/* 빠진 날짜 칩 — 누르면 빼기, 뺀 날을 누르면 다시 넣기. 다른 이유로 빠진 날은 누를 수 없고 이유를 함께 보인다 */}
                  <ul className="flex flex-wrap gap-1.5">
                    {row.dates.map((item) => (
                      <li key={item.absenceId}>
                        <button
                          type="button" disabled={settled || pending} aria-pressed={true} onClick={() => toggle(item.absenceId)}
                          aria-label={`${monthDay(item.date)} 결석 — 정산에 넣음. 누르면 뺍니다`}
                          className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-academy-secondary)] bg-[var(--color-academy-secondary-soft)] px-3 text-sm font-medium tabular-nums text-[var(--color-academy-secondary-ink)] disabled:opacity-100"
                        >
                          {monthDay(item.date)}
                        </button>
                      </li>
                    ))}
                    {row.excluded.map((item) => (
                      <li key={item.absenceId}>
                        {item.code === "OMITTED" && !settled ? (
                          <button
                            type="button" disabled={pending} aria-pressed={false} onClick={() => toggle(item.absenceId)}
                            aria-label={`${monthDay(item.date)} 결석 — 뺀 날. 누르면 다시 넣습니다`}
                            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-dashed border-[var(--color-academy-line-input)] px-3 text-sm tabular-nums text-[var(--color-academy-muted)]"
                          >
                            <span className="line-through">{monthDay(item.date)}</span>
                            <span className="text-xs">뺀 날</span>
                          </button>
                        ) : (
                          <span className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-dashed border-[var(--color-academy-line)] px-3 text-sm tabular-nums text-[var(--color-academy-faint)]">
                            <span className="line-through">{monthDay(item.date)}</span>
                            <span className="text-xs">{item.why}</span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {row.blockedReason && <p className="text-xs text-[var(--color-academy-danger)]">{row.blockedReason}</p>}
                  {row.warnings.map((warning) => <p key={warning} className="text-xs text-[var(--color-academy-warning)]">{warning}</p>)}
                </li>
              ))}
            </ul>
          )}

          {/* 합계 — 분수로 더해 한 번만 반올림한 값(소계의 합과 1원쯤 다를 수 있다) */}
          {view.carryTotal !== null && (
            <p className="flex items-baseline justify-between gap-2 font-semibold text-[var(--color-academy-ink)]">
              <span>{refund ? "환불 검토 금액" : "이월 합계"}{view.availableMonth ? <span className="ml-1.5 text-xs font-normal text-[var(--color-academy-muted)]">{monthLabel(view.availableMonth)} 청구부터 차감</span> : null}</span>
              <span className="tabular-nums">{won(view.carryTotal)}</span>
            </p>
          )}
          {!refund && <>{!view.canSeeMoney && <p className="text-xs text-[var(--color-academy-muted)]">금액과 이월 확정은 원장만 볼 수 있습니다.</p>}</>}
          {refund && !view.canSeeMoney && <p className="text-xs text-[var(--color-academy-muted)]">금액과 환불 검토로 넘기기는 원장만 볼 수 있습니다.</p>}

          {/* 낸 돈이 없는 달 — 이월이 아니라 다닌 만큼만 청구 */}
          {view.unpaid.length > 0 && (
            <ul aria-label="낸 돈이 없는 달" className="space-y-0.5 rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-xs text-[var(--color-academy-ink)]">
              {view.unpaid.map((line) => <li key={line} className="break-keep">{line}</li>)}
            </ul>
          )}

          {!settled && view.blockers.map((line) => (
            <p key={line} className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">{line}</p>
          ))}
          {/* 낸 돈이 없는 달의 미납 청구가 남아 있으면 확정할 수 없다 — 글만 두지 않고 보류 칸으로 바로 간다(돌린 뒤 이 표를 다시 읽는다) */}
          {!settled && view.needsHold && onGoHold && (
            <div className="flex justify-end">
              <button type="button" disabled={pending} onClick={() => void onGoHold()} className="academy-button-secondary">발행 보류로 돌리기로 이동</button>
            </div>
          )}
          {!settled && view.canSettle && !view.writesEnabled && (
            <p className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">청구 준비 저장이 꺼져 있어 지금은 {refund ? "넘길" : "확정할"} 수 없습니다.</p>
          )}

          {settled ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {view.used && <p className="min-w-0 flex-1 text-xs text-[var(--color-academy-muted)]">이월이 이미 청구에서 차감돼 확정 취소는 할 수 없습니다.</p>}
              {view.canSettle && !view.used && view.writesEnabled && (
                <button type="button" disabled={pending} onClick={() => void cancelSettlement()} className="academy-button-danger">확정 취소</button>
              )}
              {/* 발행은 원장이 청구 준비에서 직접 — 자동 발행하지 않는다 */}
              <Link href="/admin/finance/prepare" className="academy-button-primary">청구 준비로 이동</Link>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => setOpen(false)} className="academy-button-text">접기</button>
              {view.canSettle && (
                <button type="button" disabled={pending || !canConfirm} onClick={() => void (refund ? sendRefundReview() : settle())} className="academy-button-primary">
                  {pending ? "처리 중…" : refund ? "환불 검토로 넘기기" : "이월 확정"}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {confirmDialog}
    </div>
  );
}
