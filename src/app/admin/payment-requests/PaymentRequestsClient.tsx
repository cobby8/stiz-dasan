"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decidePaymentRequest } from "@/app/actions/payment-requests";
import { PAYMENT_REQUEST_STATUS_LABEL } from "@/lib/payments/parentRequestRules";
import type { AdminPaymentRequestRow } from "@/lib/payments/admin-payment-request";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

const FILTERS = [
  { value: "PENDING", label: "확인 중" },
  { value: "DONE", label: "처리 완료" },
  { value: "REJECTED", label: "확인 안 됨" },
  { value: "ALL", label: "전체" },
];

// 상태 배지 색 — 확인 중(주의) / 처리 완료(성공) / 확인 안 됨(위험)
function statusTone(status: string) {
  if (status === "PENDING") return "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]";
  if (status === "DONE") return "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]";
  return "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]";
}

export default function PaymentRequestsClient({
  rows,
  status,
}: {
  rows: AdminPaymentRequestRow[];
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  // 행 클릭 상세 패널 대상(요청 id) — 입력칸(영수증 링크·전할 말)과 처리 버튼은 패널에 있다
  const [detailId, setDetailId] = useState<string | null>(null);

  function decide(requestId: string, approve: boolean) {
    setError("");
    startTransition(async () => {
      const result = await decidePaymentRequest({
        requestId,
        approve,
        note: notes[requestId],
        receiptUrl: receipts[requestId],
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // 처리되면 그 요청의 패널은 닫는다(그사이 다른 행 패널을 열었으면 그대로)
      setDetailId((cur) => (cur === requestId ? null : cur));
      router.refresh();
    });
  }

  // ⚡·패널 작업 — 예전 카드의 «확인 안 됨»·«확인 · 납부 처리 / 발급 완료» 와 같은 decide 호출(확인창 없던 그대로)
  function buildActions(row: AdminPaymentRequestRow): AdminQuickAction[] {
    if (row.status !== "PENDING") return [];
    const id = row.id; // 대상 값을 미리 붙잡아 둔다
    return [
      { key: "approve", label: row.kind === "PAYMENT_CLAIM" ? "확인 · 납부 처리" : "발급 완료", icon: "check", tone: "primary", disabled: pending, onSelect: () => decide(id, true) },
      { key: "reject", label: "확인 안 됨", icon: "block", disabled: pending, onSelect: () => decide(id, false) },
    ];
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  const detail = detailId ? rows.find((row) => row.id === detailId) ?? null : null;

  return (
    <main className="mx-auto max-w-5xl space-y-3 p-4">
      <div>
        <h1 className="text-xl font-black text-[var(--color-academy-ink)]">입금 확인·영수증 요청</h1>
        {/* 승인이 곧 납부 처리라는 점을 먼저 알린다. */}
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
          입금 확인을 승인하면 <b>바로 납부 처리</b>됩니다. 통장·랠리즈에서 대조한 뒤 눌러 주세요.
        </p>
      </div>

      {/* 상태 필터 — 서버가 상태별로 읽어 주므로(다른 상태 건수는 모름) 건수 칩 대신 예전 버튼을 유지 */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={status === item.value}
            onClick={() => { setDetailId(null); router.push(`/admin/payment-requests?status=${item.value}`); }}
            className={`min-h-11 rounded-full border px-4 text-sm font-bold ${
              status === item.value
                ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
                : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && !detail && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
          해당하는 요청이 없습니다
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {/* 한 줄 행: 예전 «항목 · 금액 · 기한» / «입금일 · 방법 · 입금자» 를 칸별로 나눴다 */}
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
              <tr>
                <th className="admin-cell-num px-2 py-2">요청</th>
                <th className="px-2 py-2">원생</th>
                <th className="px-2 py-2">종류</th>
                <th className="hidden px-2 py-2 md:table-cell">항목</th>
                <th className="admin-cell-num px-2 py-2">금액</th>
                <th className="admin-cell-num hidden px-2 py-2 lg:table-cell">납부 기한</th>
                <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">입금일</th>
                <th className="hidden px-2 py-2 sm:table-cell">방법·종류</th>
                <th className="hidden px-2 py-2 md:table-cell">입금자·대상</th>
                <th className="px-2 py-2">상태</th>
                <th className="admin-cell-center px-2 py-2">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {rows.map((row) => {
                const actions = buildActions(row);
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    aria-label={`${row.studentName} ${row.kindLabel} 상세 보기`}
                    onClick={() => setDetailId(row.id)}
                    onKeyDown={(event) => handleRowKeyDown(event, row.id)}
                    className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                  >
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{row.createdAt}</td>
                    <td className="px-2 py-1.5 font-black text-[var(--color-academy-ink)]">
                      {row.studentName}
                      {/* 학부모 메모는 줄을 늘리지 않게 아이콘만, 내용은 상세 패널 */}
                      {row.note && <span className="material-symbols-outlined ml-1 align-middle text-base text-[var(--color-academy-muted)]" aria-label="메모 있음">chat</span>}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{row.kindLabel}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] md:table-cell">{row.description || "수강료"}</td>
                    <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{row.amount.toLocaleString()}원</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] lg:table-cell">{row.dueDate || "-"}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-ink)] sm:table-cell">{row.kind === "PAYMENT_CLAIM" ? row.paidOn || "-" : "-"}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] sm:table-cell">{(row.kind === "PAYMENT_CLAIM" ? row.methodLabel : row.receiptTypeLabel) || "-"}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] md:table-cell">{(row.kind === "PAYMENT_CLAIM" ? row.depositorName : row.receiptTarget) || "-"}</td>
                    <td className="px-2 py-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-black ${statusTone(row.status)}`}>
                        {PAYMENT_REQUEST_STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    </td>
                    {/* 관리: ⚡(처리). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                    <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                      {actions.length > 0 ? (
                        <AdminQuickActionMenu label={`${row.studentName} ${row.kindLabel} 빠른 작업`} actions={actions} />
                      ) : (
                        <span className="text-xs text-[var(--color-academy-muted)]">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 행 클릭 상세 패널 — 예전 카드의 내용·입력칸·버튼을 그대로 옮겼다(새 조회 없음) */}
      {detail && (() => {
        const row = detail;
        return (
          <ListDetailPanel onClose={() => setDetailId(null)} titleId="payment-request-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="payment-request-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{row.studentName}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-black ${statusTone(row.status)}`}>
                {PAYMENT_REQUEST_STATUS_LABEL[row.status] ?? row.status}
              </span>
              <button
                type="button"
                onClick={() => setDetailId(null)}
                aria-label="닫기"
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
              >
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="font-bold text-[var(--color-academy-muted)]">종류</dt>
              <dd className="text-[var(--color-academy-ink)]">{row.kindLabel}</dd>
              <dt className="font-bold text-[var(--color-academy-muted)]">항목</dt>
              <dd className="break-keep text-[var(--color-academy-ink)]">{row.description || "수강료"}</dd>
              <dt className="font-bold text-[var(--color-academy-muted)]">금액</dt>
              <dd className="tabular-nums font-bold text-[var(--color-academy-ink)]">{row.amount.toLocaleString()}원</dd>
              {row.dueDate && (
                <>
                  <dt className="font-bold text-[var(--color-academy-muted)]">납부 기한</dt>
                  <dd className="tabular-nums text-[var(--color-academy-ink)]">{row.dueDate}까지</dd>
                </>
              )}
              {/* 통장에서 대조할 단서 */}
              {row.kind === "PAYMENT_CLAIM" && (
                <>
                  <dt className="font-bold text-[var(--color-academy-muted)]">입금일</dt>
                  <dd className="tabular-nums text-[var(--color-academy-ink)]">{row.paidOn || "-"}</dd>
                  <dt className="font-bold text-[var(--color-academy-muted)]">방법</dt>
                  <dd className="text-[var(--color-academy-ink)]">{row.methodLabel || "-"}</dd>
                  <dt className="font-bold text-[var(--color-academy-muted)]">입금자</dt>
                  <dd className="text-[var(--color-academy-ink)]">{row.depositorName || "-"}</dd>
                </>
              )}
              {row.kind === "RECEIPT" && (
                <>
                  <dt className="font-bold text-[var(--color-academy-muted)]">영수증</dt>
                  <dd className="text-[var(--color-academy-ink)]">{row.receiptTypeLabel || "-"}</dd>
                  <dt className="font-bold text-[var(--color-academy-muted)]">발급 대상</dt>
                  <dd className="break-all text-[var(--color-academy-ink)]">{row.receiptTarget || "-"}</dd>
                </>
              )}
              {row.note && (
                <>
                  <dt className="font-bold text-[var(--color-academy-muted)]">메모</dt>
                  <dd className="whitespace-pre-wrap break-keep text-[var(--color-academy-ink)]">{row.note}</dd>
                </>
              )}
              <dt className="font-bold text-[var(--color-academy-muted)]">요청</dt>
              <dd className="tabular-nums text-[var(--color-academy-ink)]">{row.createdAt}</dd>
            </dl>

            {error && <p role="alert" className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>}

            {row.status === "PENDING" ? (
              <div className="mt-4 space-y-2">
                {row.kind === "RECEIPT" && (
                  <input
                    value={receipts[row.id] ?? ""}
                    onChange={(event) => setReceipts((prev) => ({ ...prev, [row.id]: event.target.value }))}
                    maxLength={500}
                    placeholder="영수증 링크 (있으면 붙여넣기 — 학부모 화면에 '영수증 보기'로 뜹니다)"
                    className="min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]"
                  />
                )}
                <input
                  value={notes[row.id] ?? ""}
                  onChange={(event) => setNotes((prev) => ({ ...prev, [row.id]: event.target.value }))}
                  maxLength={500}
                  placeholder="학부모에게 전할 말 (확인 안 됨으로 처리할 때 함께 전달됩니다)"
                  className="min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => decide(row.id, false)}
                    className="min-h-11 rounded-lg border border-[var(--color-academy-line)] font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)] disabled:opacity-50"
                  >
                    확인 안 됨
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => decide(row.id, true)}
                    className="min-h-11 rounded-lg bg-[var(--color-academy-primary)] font-black text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50"
                  >
                    {row.kind === "PAYMENT_CLAIM" ? "확인 · 납부 처리" : "발급 완료"}
                  </button>
                </div>
              </div>
            ) : (
              row.decisionNote && (
                <p className="mt-4 rounded-lg bg-[var(--color-academy-soft)] p-2 text-xs text-[var(--color-academy-ink)]">
                  메모: {row.decisionNote}
                </p>
              )
            )}
          </ListDetailPanel>
        );
      })()}
    </main>
  );
}
