"use client";

import { useCallback, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { requestStaffPaymentConfirmation } from "@/app/actions/staff-billing";
import { billingMonthLabel, countBillingLookup, matchesBillingLookup, shiftBillingMonth } from "@/lib/staff-billing-lookup";
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

type StaffBillingClientProps = {
  bills: StaffBillingListItem[];
  /** 지금 보고 있는 달 "YYYY-MM" (서버가 검사해 내려 준 값) */
  month: string;
  /** 이번 달(KST) "YYYY-MM" — «초기화»가 돌아가는 달 */
  currentMonth: string;
  /** 원장·부원장이면 true(전체 반), 선생님이면 false(담당 반만) */
  seesAllClasses: boolean;
};

export default function StaffBillingClient({ bills, month, currentMonth, seesAllClasses }: StaffBillingClientProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<BillFilter>("OPEN");
  // «조회» 조건 — 달은 주소(서버 재조회), 반·이름은 받은 목록을 화면에서 거른다
  const [lookupOpen, setLookupOpen] = useState(false);
  const [classId, setClassId] = useState("");
  const [name, setName] = useState("");
  // 모달 안에서 고르는 중인 값(«적용»을 눌러야 반영된다)
  const [draftMonth, setDraftMonth] = useState(month);
  const [draftClassId, setDraftClassId] = useState("");
  const [draftName, setDraftName] = useState("");
  const lookupRef = useRef<HTMLDivElement>(null);
  const closeLookup = useCallback(() => setLookupOpen(false), []);
  useStaffDialog(lookupOpen, lookupRef, closeLookup);
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
  // 받은 목록에 나온 반(이름순). 2개 이상일 때만 반 고르기를 보인다
  const classOptions = [...new Map(bills.map((bill) => [bill.classId, bill.className])).entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  // 달을 옮겨 그 반이 목록에서 사라졌으면 반 조건은 없는 것으로 본다(빈 화면에 갇히지 않게)
  const activeClassId = classOptions.some((option) => option.id === classId) ? classId : "";
  const lookup = { classId: activeClassId, name };
  const lookupCount = countBillingLookup(month, currentMonth, lookup);
  // 조회 조건(반·이름)을 먼저 거르고, 그 안에서 상태 칩을 센다
  const scoped = bills.filter((bill) => matchesBillingLookup(bill, lookup));
  const visible = scoped.filter((bill) => matchesFilter(bill, filter));
  const detail = detailId ? bills.find((bill) => bill.id === detailId) ?? null : null;
  // 칩 건수 = 같은 필터 규칙으로 센 값(칩과 목록이 항상 같은 기준)
  const chipItems = ([["OPEN", "미납"], ["OVERDUE", "기한 지남"], ["PAID", "납부 완료"], ["REFUNDED", "환불"], ["ALL", "전체"]] as const)
    .map(([value, label]) => ({ value, label, count: scoped.filter((bill) => matchesFilter(bill, value)).length }));
  const prevMonth = shiftBillingMonth(draftMonth, -1, currentMonth);
  const nextMonth = shiftBillingMonth(draftMonth, 1, currentMonth);

  function openLookup() {
    // 열 때마다 지금 적용된 값에서 시작한다
    setDraftMonth(month);
    setDraftClassId(activeClassId);
    setDraftName(name);
    setLookupOpen(true);
  }

  function resetLookup() {
    // 이번 달·전체 반·이름 없음으로 되돌린다(«적용»을 눌러야 반영)
    setDraftMonth(currentMonth);
    setDraftClassId("");
    setDraftName("");
  }

  function applyLookup() {
    setClassId(draftClassId);
    setName(draftName.trim());
    setLookupOpen(false);
    // 달이 바뀌었을 때만 서버에서 다시 받아 온다(이번 달은 주소를 깨끗하게)
    // 미납은 달과 상관없이 늘 보여서, 달만 바꾸면 «미납» 칩 화면이 그대로다 — 달을 바꾸면 «전체»로 옮겨 그 달 납부·환불까지 보이게(2026-11-14 검수)
    if (draftMonth !== month) setFilter("ALL");
    if (draftMonth !== month) router.push(draftMonth === currentMonth ? "/staff/billing" : `/staff/billing?month=${draftMonth}`);
  }

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
        {/* 지금 무엇을 보고 있는지: 원장·부원장 = 전체 반, 선생님 = 내가 맡은 반만 */}
        <p className="text-sm text-[var(--color-academy-muted)]">{seesAllClasses ? "전체 반 보기(원장·부원장)" : "내가 맡은 반의 청구만 보입니다"}</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h1 className="academy-heading">청구 확인</h1>
          {/* 조회 조건은 버튼 하나 + 모달(휴대폰은 하단 시트). 적용한 조건 수를 버튼에 보인다 */}
          <button type="button" onClick={openLookup} aria-haspopup="dialog" className="academy-button-secondary shrink-0">
            {lookupCount > 0 ? `조회 ${lookupCount}` : "조회"}
          </button>
        </div>
        <p className="mt-1 text-sm font-medium tabular-nums text-[var(--color-academy-ink)]">{billingMonthLabel(month)} · 지난 미납 포함</p>
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">현금·계좌이체 수납은 관리자 승인 후 납부 완료됩니다.</p>
      </header>
      {/* 미납/전체 탭 대신 상태 건수 칩 — 같은 filter 상태를 쓰고, 다시 누르면 기본(미납)으로 */}
      <StatusCountChips items={chipItems} selected={filter} onSelect={(value) => setFilter(value as BillFilter)} allValue="OPEN" ariaLabel="청구 상태" />
      {message && <p role="status" className="rounded-xl bg-[var(--color-academy-info-soft)] p-3 text-sm font-medium text-[var(--color-academy-info)]">{message}</p>}
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-5 text-center text-[var(--color-academy-muted)]">{lookup.classId || lookup.name ? "조회 조건에 맞는 청구가 없습니다." : "표시할 담당 수업 청구가 없습니다."}</p>
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
                  {/* 어느 반 청구인지 같은 줄에 덧붙인다(이 목록은 글자를 자르지 않는다 — 길면 줄바꿈) */}
                  <span className="block break-keep text-xs text-[var(--color-academy-muted)]">{bill.className} · {bill.title}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${waiting ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" : bill.status === "OVERDUE" ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>
                  {waiting ? "확인 대기" : statusLabel(bill.status)}
                </span>
                <span className="shrink-0 text-right font-semibold tabular-nums text-[var(--color-academy-ink)]">
                  {bill.amount.toLocaleString("ko-KR")}원
                  {(bill.amountMismatch || blocked) && <span className="ml-1 text-xs font-normal text-[var(--color-academy-warning)]" title={blocked ? "수납 확인 불가 — 상세에서 사유 확인" : "청구서 금액 다름"}>{blocked ? "확인 불가" : "금액 다름"}</span>}
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
            <button type="button" aria-label="닫기" onClick={() => setDetailId(null)} className="academy-button-text academy-button-sm shrink-0">닫기</button>
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
      {lookupOpen && (
        // 조회 모달: 휴대폰은 아래에서 올라오는 시트(items-end), 넓은 화면은 가운데
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/50 p-4 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLookup(); }}>
          <div ref={lookupRef} role="dialog" aria-modal="true" aria-labelledby="billing-lookup-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-[var(--color-academy-surface)] p-5 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <h2 id="billing-lookup-title" className="text-xl font-bold text-[var(--color-academy-ink)]">청구 조회</h2>
              <button type="button" onClick={closeLookup} className="academy-button-text shrink-0">닫기</button>
            </div>
            <p className="mt-4 text-sm font-medium">청구 달</p>
            {/* 달 이동: 글자 버튼 «이전»·«다음» + 가운데 지금 고른 달. 볼 수 없는 범위는 잠근다 */}
            <div className="mt-2 flex items-center gap-2">
              <button type="button" disabled={!prevMonth} onClick={() => prevMonth && setDraftMonth(prevMonth)} className="academy-button-secondary shrink-0">이전</button>
              <p aria-live="polite" className="min-w-0 flex-1 text-center font-semibold tabular-nums text-[var(--color-academy-ink)]">{billingMonthLabel(draftMonth)}</p>
              <button type="button" disabled={!nextMonth} onClick={() => nextMonth && setDraftMonth(nextMonth)} className="academy-button-secondary shrink-0">다음</button>
            </div>
            <p className="mt-2 text-xs text-[var(--color-academy-muted)]">미납 청구는 어느 달을 골라도 함께 보입니다.</p>
            {classOptions.length >= 2 && (
              <>
                <label className="mt-4 block text-sm font-medium" htmlFor="billing-lookup-class">반</label>
                <select id="billing-lookup-class" value={draftClassId} onChange={(event) => setDraftClassId(event.target.value)} className="academy-input mt-2">
                  <option value="">전체 반</option>
                  {classOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </>
            )}
            <label className="mt-4 block text-sm font-medium" htmlFor="billing-lookup-name">학생 이름</label>
            <input id="billing-lookup-name" data-dialog-initial-focus type="search" value={draftName} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) applyLookup(); }} maxLength={30} placeholder="이름 일부만 적어도 됩니다" className="academy-input mt-2" />
            <div className="mt-5 grid grid-cols-2 gap-2 pb-[env(safe-area-inset-bottom)]">
              <button type="button" onClick={resetLookup} className="academy-button-secondary">초기화</button>
              <button type="button" onClick={applyLookup} className="academy-button-primary">적용</button>
            </div>
          </div>
        </div>
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
