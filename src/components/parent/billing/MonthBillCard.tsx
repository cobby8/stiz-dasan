"use client";

import type { ReactNode } from "react";
import { TONE_TEXT_CLASS } from "@/lib/ui/statusTones";
import {
  MONTH_BILL_STATUS_LABEL,
  MONTH_BILL_STATUS_TONE,
  wonText,
  type BillItemBase,
  type MonthBill,
} from "@/lib/payments/monthBills";

// 학부모 청구 «월 카드» 한 줄 (2026-11-14 원장 지시 — 청구월·금액·상태만, 누르면 세부 시트)
// 청구 탭·아이 기록이 이 부품 하나를 같이 쓴다(한쪽만 바뀌지 않게). 높이 52px · 아이콘 없이 글자.
// 미납이 있는 달은 주의 색 바탕으로 눈에 띄게(토큰 색만).

export default function MonthBillCard<T extends BillItemBase>({
  bill,
  onOpen,
}: {
  bill: MonthBill<T>;
  /** 누르면 세부 시트를 연다 */
  onOpen: (ym: string) => void;
}) {
  const tone = MONTH_BILL_STATUS_TONE[bill.status];
  const attention = bill.unpaidCount > 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(bill.ym)}
        aria-haspopup="dialog"
        data-month-bill={bill.ym || "none"}
        className={`flex min-h-[52px] w-full items-center gap-2 px-3 py-1.5 text-left ${
          attention
            ? "bg-[var(--color-academy-warning-soft)] hover:brightness-95"
            : "bg-[var(--color-academy-surface)] hover:bg-[var(--color-academy-soft)]"
        }`}
      >
        {/* 청구월 */}
        <span className="min-w-0 flex-1 break-keep text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">{bill.label}</span>
        {/* 합계(환불 제외) — 금액을 볼 수 없는 보호자에게는 안 보인다 */}
        {bill.total !== null && (
          <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">{wonText(bill.total)}</span>
        )}
        {/* 상태 한 단어 */}
        <span className={`w-16 shrink-0 whitespace-nowrap text-right text-xs font-semibold ${TONE_TEXT_CLASS[tone]}`}>{MONTH_BILL_STATUS_LABEL[bill.status]}</span>
        <span aria-hidden="true" className="shrink-0 text-xs text-[var(--color-academy-muted)]">▸</span>
      </button>
    </li>
  );
}

/** 월 카드 목록(한 판에 한 줄씩) — 화면마다 같은 껍데기 */
export function MonthBillList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
      {children}
    </ul>
  );
}
