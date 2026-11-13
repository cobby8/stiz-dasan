"use client";

import { useEffect, useRef, type ReactNode } from "react";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { PAYMENT_TONE, TONE_TEXT_CLASS, toneFor } from "@/lib/ui/statusTones";
import {
  billItemLabel,
  billItemStatusLabel,
  billMethodLabel,
  isBillUnpaid,
  parseBillBreakdown,
  shortYmd,
  wonText,
  type BillItemBase,
  type MonthBill,
} from "@/lib/payments/monthBills";

// 학부모 청구 «세부 시트» (2026-11-14 원장 지시 — 월 카드를 누르면 세부 내역을 모달로 깔끔하게)
// - 휴대폰: 아래에서 올라오는 시트 · PC: 오른쪽 패널 (ListDetailPanel → AdminModal: Esc·바깥 누르기·포커스 가두기·닫으면 카드로 포커스 복귀)
// - 휴대폰 «뒤로가기»로도 닫힌다(열 때 같은 주소로 기록 한 칸을 넣고, 닫기 버튼은 그 칸을 되돌린다)
// - 항목 줄: 항목 · 낼 금액 / 상태 · 납기 · 납부일 · 결제수단 / «원래 − 할인(사유) = 낼 금액» / 영수증
// - 결제 버튼·입금 알림·영수증 요청은 화면이 넘긴 부품 그대로(renderItemActions) — 결제 흐름은 각 화면의 기존 핸들러를 쓴다

export default function BillDetailSheet<T extends BillItemBase>({
  bill,
  onClose,
  renderItemActions,
  footer,
}: {
  bill: MonthBill<T>;
  onClose: () => void;
  /** 항목마다 아래에 붙일 버튼·안내(결제하기·입금했어요·영수증 요청 등) */
  renderItemActions?: (item: T) => ReactNode;
  /** 시트 맨 아래(예: 미납 2건 이상이면 «한 번에 결제») */
  footer?: ReactNode;
}) {
  const titleId = `bill-sheet-${bill.ym || "none"}`;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // 뒤로가기 = 닫기. 기존 기록 상태(Next 라우터 값)를 그대로 품은 채 같은 주소로 한 칸만 더한다.
  const pushed = useRef(false);
  useEffect(() => {
    const state = typeof history.state === "object" && history.state ? history.state : {};
    history.pushState({ ...state, billSheet: true }, "", window.location.href);
    pushed.current = true;
    const onPop = () => {
      pushed.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 닫기 버튼·Esc·바깥 누르기 — 넣어 둔 기록 칸이 남아 있으면 그 칸을 되돌려(→ popstate 에서 닫힘) 뒤로가기가 두 번 필요하지 않게
  function requestClose() {
    if (pushed.current && history.state?.billSheet) history.back();
    else onCloseRef.current();
  }

  // 형제면 아이별로 나눠 보인다(한 아이면 이름 머리줄 없음)
  const byStudent = new Map<string, T[]>();
  for (const item of bill.items) byStudent.set(item.studentId, [...(byStudent.get(item.studentId) ?? []), item]);
  const showNames = byStudent.size > 1;

  return (
    <ListDetailPanel onClose={requestClose} titleId={titleId}>
      {/* 머리: 청구월 · 합계 · 할인 · 미납 — 닫기는 글자 버튼(아이콘 없음) */}
      <div className="sticky top-0 z-10 flex items-start gap-2 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-bold text-[var(--color-academy-ink)]">{bill.label} 청구</h2>
          {bill.total !== null && (
            <p className="break-keep text-xs tabular-nums text-[var(--color-academy-muted)]">
              합계 <b className="font-semibold text-[var(--color-academy-ink)]">{wonText(bill.total)}</b>
              {bill.discountTotal > 0 && <> · 할인 {wonText(bill.discountTotal)}</>}
              {bill.unpaidCount > 0 && (
                <span className="font-semibold text-[var(--color-academy-warning)]"> · 미납 {bill.unpaidCount}건{bill.unpaidTotal !== null ? ` ${wonText(bill.unpaidTotal)}` : ""}</span>
              )}
            </p>
          )}
        </div>
        <button type="button" onClick={requestClose} className="academy-button-text shrink-0">
          닫기
        </button>
      </div>

      <div className="space-y-3 px-4 py-2">
        {[...byStudent.entries()].map(([studentId, items]) => (
          <section key={studentId} aria-label={`${items[0].studentName} 청구`}>
            {showNames && (
              <h3 className="mb-0.5 text-xs font-semibold text-[var(--color-academy-muted)]">{items[0].studentName}</h3>
            )}
            <ul className="divide-y divide-[var(--color-academy-line)]">
              {items.map((item) => (
                <BillItemRow key={item.id} item={item} actions={renderItemActions?.(item)} />
              ))}
            </ul>
          </section>
        ))}
        {footer}
      </div>
    </ListDetailPanel>
  );
}

/** 세부 시트의 항목 한 줄 */
function BillItemRow<T extends BillItemBase>({ item, actions }: { item: T; actions?: ReactNode }) {
  const unpaid = isBillUnpaid(item.status);
  const tone = toneFor(PAYMENT_TONE, item.status, unpaid ? "warning" : "neutral");
  // 할인 해석 — 실제 금액과 맞을 때만 나온다(틀린 숫자는 안 보인다)
  const breakdown = parseBillBreakdown(item.description, item.amount);
  const method = item.status === "PAID" ? billMethodLabel(item.method, item.paidProvider) : null;
  const meta = [
    item.dueYmd ? `납기 ${shortYmd(item.dueYmd)}` : null,
    item.status === "PAID" && item.paidYmd ? `납부 ${shortYmd(item.paidYmd)}` : null,
    method,
  ].filter(Boolean);
  return (
    <li className="py-2" data-bill-item={item.id}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-ink)]">{billItemLabel(item)}</p>
        {item.amount !== null && (
          <p className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">{wonText(item.amount)}</p>
        )}
      </div>
      <p className="text-xs tabular-nums text-[var(--color-academy-muted)]">
        <span className={`font-semibold ${TONE_TEXT_CLASS[tone]}`}>{billItemStatusLabel(item.status)}</span>
        {meta.length > 0 && ` · ${meta.join(" · ")}`}
      </p>
      {/* 원래 금액 − 할인(사유) = 낼 금액 */}
      {breakdown && (
        <p className="mt-0.5 break-keep text-xs tabular-nums text-[var(--color-academy-ink)]" data-bill-discount>
          원래 {wonText(breakdown.original)}
          {breakdown.deductions.map((d) => (
            <span key={d.label} className="text-[var(--color-academy-success)]"> − {d.label} {wonText(d.amount)}</span>
          ))}
          {" "}= <b className="font-semibold">{wonText(breakdown.payable)}</b>
        </p>
      )}
      {item.receiptUrl && (
        <a
          href={item.receiptUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-outside-link
          className="academy-button-text -ml-2 whitespace-nowrap"
        >
          영수증 보기
        </a>
      )}
      {actions}
    </li>
  );
}
