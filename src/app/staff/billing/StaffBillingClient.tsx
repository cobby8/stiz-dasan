"use client";

import { useCallback, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { requestStaffPaymentConfirmation } from "@/app/actions/staff-billing";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { formatKstDate } from "@/lib/datetime/kst";
import type { StaffBillingListItem } from "@/lib/staff-portal-queries";

const labels: Record<string, string> = { PENDING: "납부 전", OVERDUE: "기한 지남", PAID: "납부 완료", REFUNDED: "환불", CANCELLED: "취소", CANCELED: "취소" };
// 목록에 없는 상태값은 영어 원문(예: PARTIAL) 대신 «확인 필요»로 보여 준다
const statusLabel = (status: string) => labels[status] ?? "확인 필요";
// 미납(OPEN) = 납부 전 + 기한 지남. 기본 보기이자 칩을 다시 눌렀을 때 돌아가는 값
type BillFilter = "OPEN" | "ALL" | "OVERDUE" | "PAID" | "REFUNDED";
const OPEN_STATUSES = ["PENDING", "OVERDUE"];

function matchesFilter(bill: StaffBillingListItem, filter: BillFilter) {
  if (filter === "ALL") return true;
  if (filter === "OPEN") return OPEN_STATUSES.includes(bill.status);
  return bill.status === filter;
}

export default function StaffBillingClient({ bills }: { bills: StaffBillingListItem[] }) {
  const [filter, setFilter] = useState<BillFilter>("OPEN");
  // 행을 누르면 여는 상세 시트(금액 불일치·납부 기한·막힌 사유는 여기서 전부)
  const [detailId, setDetailId] = useState<string | null>(null);
  const [target, setTarget] = useState<StaffBillingListItem | null>(null);
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeDialog = useCallback(() => setTarget(null), []);
  useStaffDialog(Boolean(target), dialogRef, closeDialog, !pending);
  const visible = bills.filter((bill) => matchesFilter(bill, filter));
  const detail = detailId ? bills.find((bill) => bill.id === detailId) ?? null : null;
  // 칩 건수 = 같은 필터 규칙으로 센 값(칩과 목록이 항상 같은 기준)
  const chipItems = ([["OPEN", "미납"], ["OVERDUE", "기한 지남"], ["PAID", "납부 완료"], ["REFUNDED", "환불"], ["ALL", "전체"]] as const)
    .map(([value, label]) => ({ value, label, count: bills.filter((bill) => matchesFilter(bill, value)).length }));

  // 납부 확인 요청을 열 수 있는 청구인지(기존 카드의 버튼 조건 그대로)
  function canRequest(bill: StaffBillingListItem) {
    return bill.confirmationStatus !== "PENDING" && OPEN_STATUSES.includes(bill.status) && bill.confirmable;
  }

  function openRequest(bill: StaffBillingListItem) {
    setDetailId(null);
    setTarget(bill);
    setMessage("");
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLLIElement>, id: string) {
    // 행 안의 «요청» 버튼에서 누른 Enter 를 행이 가로채지 않게
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  function submit() {
    if (!target || pending) return;
    setMessage("");
    startTransition(async () => {
      try {
        const result = await requestStaffPaymentConfirmation({
          paymentId: target.id,
          method,
          receivedAt: new Date().toISOString(),
          note,
        });
        setMessage(result.message);
        if (result.ok) {
          setTarget(null);
          window.location.reload();
        }
      } catch {
        setMessage("요청을 보내지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.");
      }
    });
  }

  return (
    <main className="mx-auto max-w-lg space-y-3 px-4 py-5">
      <header>
        <p className="text-sm text-[var(--color-academy-muted)]">담당 수업 전용</p>
        <h1 className="academy-heading mt-1">청구 확인</h1>
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">현금·계좌이체 수납은 관리자 승인 후 납부 완료됩니다.</p>
      </header>
      {/* 미납/전체 탭 대신 상태 건수 칩 — 같은 filter 상태를 쓰고, 다시 누르면 기본(미납)으로 */}
      <StatusCountChips items={chipItems} selected={filter} onSelect={(value) => setFilter(value as BillFilter)} allValue="OPEN" ariaLabel="청구 상태" />
      {message && <p role="status" className="rounded-xl bg-[var(--color-academy-info-soft)] p-3 text-sm font-medium text-[var(--color-academy-info)]">{message}</p>}
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-5 text-center text-[var(--color-academy-muted)]">표시할 담당 수업 청구가 없습니다.</p>
      ) : (
        // 한 청구 = 한 줄 행: 학생·제목 | 상태 | 금액(오른쪽) | 요청 버튼
        <ul aria-label="청구 목록" className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {visible.map((bill) => {
            const waiting = bill.confirmationStatus === "PENDING";
            const blocked = !waiting && OPEN_STATUSES.includes(bill.status) && !bill.confirmable;
            return (
              <li
                key={bill.id}
                role="button"
                tabIndex={0}
                aria-label={`${bill.studentName} ${bill.title} 청구 상세`}
                onClick={() => setDetailId(bill.id)}
                onKeyDown={(event) => handleRowKeyDown(event, bill.id)}
                className="flex min-h-14 cursor-pointer items-center gap-2 border-b border-[var(--color-academy-line)] px-3 py-1.5 last:border-b-0 hover:bg-[var(--color-academy-soft)]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-[var(--color-academy-ink)]">{bill.studentName}</span>
                  <span className="block break-keep text-xs text-[var(--color-academy-muted)]">{bill.title}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${waiting ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" : bill.status === "OVERDUE" ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>
                  {waiting ? "확인 대기" : statusLabel(bill.status)}
                </span>
                <span className="shrink-0 text-right font-semibold tabular-nums text-[var(--color-academy-ink)]">
                  {bill.amount.toLocaleString("ko-KR")}원
                  {(bill.amountMismatch || blocked) && <span role="img" className="material-symbols-outlined ml-0.5 align-middle text-base text-[var(--color-academy-warning)]" aria-label={blocked ? "수납 확인 불가 — 상세에서 사유 확인" : "청구서 금액 다름"}>warning</span>}
                </span>
                {/* 게슈탈트 T-09: 행마다 반복되는 작은 작업은 옅은 tonal(꽉 찬 색은 화면의 주인공 하나만) */}
                {canRequest(bill) && (
                  <button type="button" onClick={(event) => { event.stopPropagation(); openRequest(bill); }} aria-label={`${bill.studentName} 납부 확인 요청`} className="academy-button-tonal academy-button-sm shrink-0">
                    요청
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {detail && (
        <ListDetailPanel onClose={() => setDetailId(null)} titleId="staff-bill-detail-title">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--color-academy-line)] px-4 py-3">
            <div className="min-w-0">
              <h2 id="staff-bill-detail-title" className="text-lg font-bold text-[var(--color-academy-ink)]">{detail.studentName}</h2>
              <p className="text-sm text-[var(--color-academy-muted)]">{detail.className}</p>
            </div>
            <button type="button" aria-label="닫기" onClick={() => setDetailId(null)} className="grid size-11 shrink-0 place-items-center rounded-full">
              <span aria-hidden="true" className="material-symbols-outlined">close</span>
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <dt className="text-[var(--color-academy-muted)]">청구</dt><dd className="font-medium">{detail.title}</dd>
            <dt className="text-[var(--color-academy-muted)]">상태</dt><dd className="font-medium">{detail.confirmationStatus === "PENDING" ? "관리자 확인 대기" : statusLabel(detail.status)}</dd>
            <dt className="text-[var(--color-academy-muted)]">금액</dt><dd className="font-semibold tabular-nums">{detail.amount.toLocaleString("ko-KR")}원</dd>
            <dt className="text-[var(--color-academy-muted)]">납부 기한</dt><dd className="tabular-nums">{formatKstDate(detail.dueDate, undefined, "-")}</dd>
          </dl>
          <div className="space-y-2 px-4 pb-4">
            {detail.amountMismatch && <p className="text-xs font-medium tabular-nums text-[var(--color-academy-warning)]">청구서에는 {detail.invoiceAmount.toLocaleString("ko-KR")}원으로 되어 있습니다.</p>}
            {/* 문제가 있는 청구도 목록에서는 보여 주고, 수납 확인 버튼만 사유와 함께 막습니다. */}
            {detail.confirmationStatus === "PENDING" ? <p className="rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm font-medium text-[var(--color-academy-warning)]">관리자 확인 대기 중</p> : OPEN_STATUSES.includes(detail.status) && (detail.confirmable ? <button type="button" onClick={() => openRequest(detail)} className="academy-button-primary min-h-12! w-full">납부 확인 요청</button> : <p className="rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm font-medium text-[var(--color-academy-warning)]">{detail.blockReason}</p>)}
          </div>
        </ListDetailPanel>
      )}
      {target && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/50 p-4 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) setTarget(null); }}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="payment-dialog-title" aria-describedby="payment-dialog-description" className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <h2 id="payment-dialog-title" className="text-xl font-bold">납부 확인 요청</h2>
            <p id="payment-dialog-description" className="mt-1 text-sm tabular-nums text-[var(--color-academy-muted)]">{target.studentName} · {target.amount.toLocaleString("ko-KR")}원</p>
            <label className="mt-4 block text-sm font-medium" htmlFor="payment-method">납부 방법</label>
            <select id="payment-method" value={method} onChange={(event) => setMethod(event.target.value)} className="academy-input mt-2"><option value="BANK_TRANSFER">계좌이체</option><option value="CASH">현금</option></select>
            <label className="mt-3 block text-sm font-medium" htmlFor="payment-note">수납 메모</label>
            <textarea id="payment-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} placeholder="필요한 내용을 남겨 주세요" className="academy-input mt-2" />
            <div className="mt-4 grid grid-cols-2 gap-2 pb-[env(safe-area-inset-bottom)]"><button data-dialog-initial-focus type="button" disabled={pending} onClick={closeDialog} className="academy-button-secondary">취소</button><button type="button" disabled={pending} onClick={submit} className="academy-button-primary">{pending ? "요청 중…" : "확인 요청"}</button></div>
          </div>
        </div>
      )}
    </main>
  );
}
