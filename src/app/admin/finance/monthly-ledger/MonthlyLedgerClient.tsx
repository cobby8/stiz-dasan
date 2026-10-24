"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { MonthlyClassLedgerResult } from "@/lib/billing/monthly-class-ledger";

const PAGE_SIZE = 50;
const money = (value: number | null) => value === null ? "기록 없음" : `${value.toLocaleString("ko-KR")}원`;
const types: Record<string, string> = { MONTHLY: "수강료", SHUTTLE: "셔틀", UNIFORM: "유니폼", OTHER: "기타" };
const statuses: Record<string, string> = {
  PAID: "납부", PENDING: "납부 대기", OVERDUE: "미납", CANCELED: "취소", CANCELLED: "취소", REFUNDED: "환불",
};

export default function MonthlyLedgerClient({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<MonthlyClassLedgerResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    setPage(0);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/finance/monthly-ledger?month=${encodeURIComponent(month)}`, {
          cache: "no-store", signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "조회하지 못했습니다.");
        if (!controller.signal.aborted) setData(result);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "조회하지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [month, attempt]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.rows ?? []).filter((row) =>
      `${row.studentName} ${row.className ?? "반 미연결"} ${row.studentId}`.toLocaleLowerCase().includes(query));
  }, [data, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section className="space-y-5">
      <Link href="/admin/finance" className="underline">수납/청구로 돌아가기</Link>
      <header>
        <h1 className="text-2xl font-bold">월별·반별 장부 점검</h1>
        <p className="mt-2">저장된 청구·납부 기록을 학생과 반별로 나눠 확인합니다. 조회만 하며 청구서나 문자를 만들지 않습니다.</p>
      </header>
      <div className="rounded-lg border border-[var(--color-brand-orange-500)] p-4 text-sm">
        현재 수강 목록은 조회 월의 확정 명부가 아닙니다. 할인·이월·일할계산을 추측하지 않으며, 이 화면만으로 시트를 중단하거나 청구 금액을 확정할 수 없습니다.
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">조회 월
          <input type="month" min="2020-01" max="2100-12" value={month}
            onChange={(event) => { setData(null); setMonth(event.target.value); }} className="rounded border p-2" />
        </label>
        <label className="grid gap-1">학생·반 검색
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }}
            placeholder="학생명, 반 또는 학생 ID" className="rounded border p-2" />
        </label>
        <button type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}
          className="rounded border px-4 py-2 disabled:opacity-50">다시 조회</button>
      </div>
      {loading && <p role="status">월별 기록을 확인하고 있습니다.</p>}
      {error && <p role="alert">{error}</p>}
      {data && !loading && (
        <>
          <div className="rounded-lg border p-4" aria-live="polite">
            <p className="font-bold">{data.year}년 {data.month}월 · 저장 기록 기준</p>
            <p>학생 {data.summary.studentCount}명 · 반별 행 {data.summary.classRowCount}건 · 반 미연결 청구 {data.summary.unassignedPaymentCount}건</p>
            <p>기록상 납부 {money(data.summary.knownPaidAmount)} · 기록상 납부 대기 {money(data.summary.knownOutstandingAmount)}</p>
            <p className="text-sm">확인 필요 {data.summary.reviewRowCount}행 · 합산 제외 {data.summary.excludedPaymentCount}건. 납부/대기 합계는 수강료 외 항목도 포함하며, 실제 입금 대조나 최종 월 청구액이 아닙니다.</p>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[850px] text-left text-sm">
              <caption className="p-3 text-left">검색 결과 {filtered.length}행 · 각 행은 학생 ID·조회 월·반 ID로 구분합니다.</caption>
              <thead><tr>
                {["학생 / 반", "수강료 기록", "셔틀 기록", "기타 기록", "납부 / 대기", "확인할 내용"].map((label) => <th key={label} className="border-b p-3">{label}</th>)}
              </tr></thead>
              <tbody>
                {visible.map((row) => <tr key={row.rowKey} className="align-top">
                  <td className="border-b p-3">
                    <Link className="font-bold underline" href={`/admin/students/${encodeURIComponent(row.studentId)}`}>{row.studentName}</Link>
                    <p>{row.className ?? (row.classId ? "반 이름 확인 필요" : "반 미연결 — 임의 배분 안 함")}</p>
                    <p className="text-xs">현재 상태: {row.enrollmentStatus === "ACTIVE" ? "수강" : row.enrollmentStatus === "PAUSED" ? "휴원" : "현재 수강 목록에 없음"}</p>
                    <Link className="mt-2 inline-block underline" href={`/admin/finance/monthly-register?studentId=${encodeURIComponent(row.studentId)}&month=${encodeURIComponent(month)}`}>월 운영 장부 작성·확인</Link>
                  </td>
                  <td className="border-b p-3">{money(row.breakdown.MONTHLY.billedAmount)}</td>
                  <td className="border-b p-3">{money(row.breakdown.SHUTTLE.billedAmount)}</td>
                  <td className="border-b p-3">{money(row.breakdown.OTHER.billedAmount)}<p>{row.breakdown.OTHER.paymentTypes.map((type) => types[type] ?? type).join(", ")}</p></td>
                  <td className="border-b p-3">{money(row.paidAmount)} / {money(row.outstandingAmount)}</td>
                  <td className="max-w-sm border-b p-3">
                    {row.reviewReasons.map((reason) => <p key={reason}>{reason}</p>)}
                    {row.payments.length > 0 && <details className="mt-2"><summary className="cursor-pointer">청구 기록 {row.payments.length}건</summary>
                      <ul>{row.payments.map((payment) => <li key={payment.id} className="mt-2">
                        {types[payment.type] ?? payment.type} · {statuses[payment.status] ?? payment.status} · {money(payment.amount)}
                        {!payment.includedInTotals && " (합산 제외)"}
                        <p className="break-all text-xs">기록 ID: {payment.id}</p>
                      </li>)}</ul>
                    </details>}
                  </td>
                </tr>)}
                {visible.length === 0 && <tr><td colSpan={6} className="p-6 text-center">해당하는 기록이 없습니다. 월 수강·납부가 모두 완료됐다는 뜻은 아닙니다.</td></tr>}
              </tbody>
            </table>
          </div>
          <nav aria-label="장부 페이지" className="flex items-center gap-3">
            <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} className="rounded border px-3 py-2 disabled:opacity-50">이전</button>
            <span>{page + 1} / {pageCount}</span>
            <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)} className="rounded border px-3 py-2 disabled:opacity-50">다음</button>
          </nav>
        </>
      )}
    </section>
  );
}
