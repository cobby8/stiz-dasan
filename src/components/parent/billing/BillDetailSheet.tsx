"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { attachSheetHistory } from "./sheetHistory";
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
// - 휴대폰 «뒤로가기»로도 닫힌다(기록 칸 관리 = ./sheetHistory)
// - 항목 줄: 항목 · 낼 금액 / 상태 · 납기 · 납부일 · 결제수단 / «원래 − 할인(사유) = 낼 금액» / 영수증
// - 결제 버튼·입금 알림·영수증 요청은 화면이 넘긴 부품 그대로(renderItemActions) — 결제 흐름은 각 화면의 기존 핸들러를 쓴다

export default function BillDetailSheet<T extends BillItemBase>({
  bill,
  onClose,
  renderItemActions,
  footer,
  navigate,
}: {
  bill: MonthBill<T>;
  onClose: () => void;
  /** 항목마다 아래에 붙일 버튼·안내(결제하기·입금했어요·영수증 요청 등) */
  renderItemActions?: (item: T) => ReactNode;
  /** 시트 맨 아래 칸(안내·버튼) */
  footer?: ReactNode;
  /** 시트 안 내부 링크로 이동하는 방법(청구 탭 = router.push). 없으면 주소 이동 */
  navigate?: (href: string) => void;
}) {
  const titleId = `bill-sheet-${bill.ym || "none"}`;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  // 뒤로가기 = 닫기. 기록 칸 관리는 sheetHistory(어떤 길로 닫히든 넣은 칸을 정확히 한 번 되돌린다)
  const sheetHistory = useRef<ReturnType<typeof attachSheetHistory> | null>(null);
  useEffect(() => {
    const controller = attachSheetHistory(window, {
      onClose: () => onCloseRef.current(),
      // popstate 처리(라우터 복원)가 끝난 다음 순간에 이동
      navigate: (href) => window.setTimeout(() => (navigateRef.current ?? ((to: string) => window.location.assign(to)))(href), 0),
    });
    sheetHistory.current = controller;
    return () => {
      sheetHistory.current = null;
      controller.detach();
    };
  }, []);

  // 닫기 버튼·Esc·바깥 누르기
  function requestClose() {
    if (sheetHistory.current) sheetHistory.current.requestClose();
    else onCloseRef.current();
  }

  // 시트 안 같은 사이트 링크(결제하기·청구 탭에서 결제 등) — 넣어 둔 기록 칸을 먼저 되돌리고 이동한다.
  // 그래야 결제 화면에서 돌아왔을 때 «뒤로가기 한 번이 헛걸음»이 되지 않는다. 새 창·전화·바깥 링크는 그대로 둔다.
  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || !sheetHistory.current) return;
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) return;
    event.preventDefault(); // Next Link 는 막힌 클릭이면 스스로 이동하지 않는다
    sheetHistory.current.leaveTo(href);
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

      <div className="space-y-3 px-4 py-2" onClickCapture={onClickCapture}>
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
            <span key={d.label} className="text-[var(--color-academy-muted)]"> − {d.label} {wonText(d.amount)}</span>
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
