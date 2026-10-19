"use client";

import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";

export function monthlyFeeLabel(month: string, period: StaffMonthlyFeeSummary["period"] = "MONTHLY", sourceLabel?: string) {
  // 청구 금액에는 셔틀비 등이 포함될 수 있어 순수 수강료와 구분합니다.
  const amountLabel = sourceLabel?.includes("청구 금액") ? "청구 금액" : "수강료";
  return period === "SEASONAL" ? `특강 전체 ${amountLabel}` : `${month.replace("-", "년 ")}월 ${amountLabel}`;
}

export function StaffMonthlyFeeSummaryCard({ month, summary }: { month: string; summary: StaffMonthlyFeeSummary }) {
  return <section aria-label="학생 수강료 요약" className="mb-4 rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] p-4">
    <p className="text-xs font-bold text-[var(--color-academy-muted)]">{monthlyFeeLabel(month, summary.period, summary.sourceLabel)}</p>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <p className="text-2xl font-black text-[var(--color-academy-ink)]">{summary.amount === null ? "금액 확인 필요" : `${summary.amount.toLocaleString("ko-KR")}원`}</p>
      <span className="rounded-full bg-[var(--color-academy-surface)] px-3 py-1 text-xs font-bold text-[var(--color-academy-ink)]">{summary.statusLabel}</span>
    </div>
    <p className="mt-2 text-xs font-bold text-[var(--color-academy-muted)]">금액 근거 · {summary.sourceLabel}</p>
    {summary.status === "UNISSUED" && <p className="mt-2 text-xs font-bold text-[var(--color-academy-warning)]">청구서 미발행 · 표시 금액은 수강 정보 기준이며, 실제 청구 금액은 발행 시 확인해 주세요.</p>}
    {summary.note && <p className="mt-2 text-xs leading-5 text-[var(--color-academy-muted)]">{summary.note}</p>}
  </section>;
}
