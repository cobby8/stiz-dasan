"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { loadStaffAttendanceBilling, loadStaffClassBilling, requestStaffPaymentConfirmation, type SerializedStaffClassBillingItem } from "@/app/actions/staff-billing";
import { useStaffDialog } from "./useStaffDialog";
import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";
import { StaffMonthlyFeeSummaryCard } from "./StaffMonthlyFeeSummary";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

type BillingResult = { items: SerializedStaffClassBillingItem[]; month?: string; summary?: StaffMonthlyFeeSummary };
const billingRequests = new Map<string, Promise<BillingResult>>();
type Filter = "OPEN" | "PENDING" | "PAID" | "ALL";

export function ClassBillingSheet({ open, classId, className, student, attendanceContext, onSummaryLoaded, onUpdated, onClose }: {
  open: boolean; classId: string; className: string;
  student?: { id: string; name: string } | null;
  attendanceContext?: { sessionId: string; rosterId: string };
  onSummaryLoaded?: (month: string, summary: StaffMonthlyFeeSummary) => void;
  onUpdated?: () => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const attendanceSessionId = attendanceContext?.sessionId;
  const attendanceRosterId = attendanceContext?.rosterId;
  const cacheKey = attendanceContext ? `attendance:${attendanceSessionId}:${attendanceRosterId}` : `${classId}:${student?.id || "all"}`;
  const [summary, setSummary] = useState<StaffMonthlyFeeSummary | null>(null);
  const [month, setMonth] = useState("");
  const [reload, setReload] = useState(0);
  const [items, setItems] = useState<SerializedStaffClassBillingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [requestTarget, setRequestTarget] = useState<SerializedStaffClassBillingItem | null>(null);
  const [referenceTime] = useState(() => Date.now());
  // 하위 납부 확인 창이 열리면 스크롤 잠금은 유지하고 키보드 제어만 넘깁니다.
  useStaffDialog(open, sheetRef, onClose, !requestTarget, !requestTarget);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => { if (active) { setItems([]); setSummary(null); setMonth(""); setLoading(true); setError(""); setNotice(""); setRequestTarget(null); setFilter(attendanceRosterId ? "ALL" : "OPEN"); } });
    const request = billingRequests.get(cacheKey) ?? (attendanceSessionId && attendanceRosterId
      ? loadStaffAttendanceBilling({ sessionId: attendanceSessionId, rosterId: attendanceRosterId })
      : loadStaffClassBilling({ classId, studentId: student?.id }));
    billingRequests.set(cacheKey, request);
    void request.then((result: BillingResult) => { if (active) { setItems(result.items); setSummary(result.summary ?? null); setMonth(result.month ?? ""); if (result.month && result.summary) onSummaryLoaded?.(result.month, result.summary); } }).catch((reason: unknown) => { if (active) setError(userErrorMessage(reason, "청구 내역을 불러오지 못했습니다.")); }).finally(() => { if (billingRequests.get(cacheKey) === request) billingRequests.delete(cacheKey); if (active) setLoading(false); });
    return () => { active = false; };
  }, [attendanceRosterId, attendanceSessionId, cacheKey, classId, onSummaryLoaded, open, reload, student?.id]);

  const counts = useMemo(() => ({ open: items.filter((item) => item.status === "UNPAID").length, pending: items.filter((item) => item.status === "PENDING_CONFIRMATION").length }), [items]);
  const visible = items.filter((item) => filter === "ALL" || (filter === "OPEN" && item.status === "UNPAID") || (filter === "PENDING" && item.status === "PENDING_CONFIRMATION") || (filter === "PAID" && item.status === "PAID"));
  if (!open) return null;
  return <><div className="fixed inset-0 z-[70] flex items-end bg-black/55 sm:items-center sm:justify-center" role="dialog" aria-modal={requestTarget ? undefined : "true"} aria-hidden={requestTarget ? "true" : undefined} aria-labelledby="class-billing-title">
    <button type="button" aria-label="청구 확인 닫기" className="absolute inset-0 cursor-default" onClick={onClose} />
    <section ref={sheetRef} className="relative flex max-h-[92dvh] w-full flex-col max-w-lg overflow-hidden rounded-t-3xl bg-white shadow-2xl dark:bg-gray-900 sm:rounded-3xl">
      <header className="shrink-0 border-b border-gray-100 px-5 pb-4 pt-3 dark:border-gray-800"><div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" /><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-[var(--brand-accent)]">{className}</p><h2 id="class-billing-title" className="mt-0.5 text-xl font-black dark:text-white">{student ? `${student.name} 청구` : "수업 청구 확인"}</h2><p className="mt-1 text-xs text-gray-500">{loading ? "청구 내역 확인 중…" : error ? "청구 조회 실패" : `미납 ${counts.open}건 · 확인 대기 ${counts.pending}건`}</p></div><button type="button" data-dialog-initial-focus onClick={onClose} aria-label="닫기" className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800"><span className="material-symbols-outlined">close</span></button></div>
        <div className="mt-4 flex gap-2 overflow-x-auto" role="tablist" aria-label="청구 상태 필터">{(["OPEN", "PENDING", "PAID", "ALL"] as Filter[]).map((value) => <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)} className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-black ${filter === value ? "bg-brand-navy-900 text-white" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>{({ OPEN: loading || error ? "미납" : `미납 ${counts.open}`, PENDING: loading || error ? "확인 대기" : `확인 대기 ${counts.pending}`, PAID: "납부 완료", ALL: "전체" } as const)[value]}</button>)}</div></header>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">{loading && items.length === 0 && <BillingMessage icon="progress_activity" text="청구 내역을 불러오는 중입니다." spin />}{error && <div role="alert"><BillingMessage icon="error" text={error} /><button type="button" onClick={() => setReload((value) => value + 1)} className="mb-4 min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] px-4 text-sm font-bold text-[var(--brand-accent)]">청구 내역 다시 불러오기</button></div>}{summary && <StaffMonthlyFeeSummaryCard month={month} summary={summary} />}{notice && <p aria-live="polite" className="mb-3 rounded-xl bg-green-50 p-3 text-sm font-bold text-green-700">{notice}</p>}{!loading && !error && visible.length === 0 && <BillingMessage icon="receipt_long" text={summary && items.length === 0 ? "연결된 청구서가 없습니다. 위 수강료·납부 상태와 금액 근거를 확인해 주세요." : "해당하는 청구 내역이 없습니다."} />}<div className="space-y-3">{visible.map((item) => <BillingCard key={item.id} item={item} referenceTime={referenceTime} onRequest={() => setRequestTarget(item)} />)}</div></div>
    </section>
  </div>{requestTarget && <PaymentRequestDialog item={requestTarget} onClose={() => setRequestTarget(null)} onCompleted={(message) => { setSummary((current) => current && current.paymentIds.includes(requestTarget.id) ? { ...current, status: "PENDING_CONFIRMATION", statusLabel: "관리자 확인 대기" } : current); onUpdated?.(); setItems((current) => current.map((item) => item.id === requestTarget.id ? { ...item, status: "PENDING_CONFIRMATION" as const, confirmationStatus: "PENDING" } : item)); setRequestTarget(null); setNotice(message); }} />}</>;
}

function BillingCard({ item, referenceTime, onRequest }: { item: SerializedStaffClassBillingItem; referenceTime: number; onRequest: () => void }) {
  const overdue = item.status === "UNPAID" && new Date(item.dueDate).getTime() < referenceTime;
  const status = item.status === "UNPAID" ? (overdue ? "기한 지남" : "미납") : item.status === "PENDING_CONFIRMATION" ? "관리자 확인 대기" : "납부 완료";
  const statusClass = item.status === "UNPAID" ? "bg-red-50 text-red-700" : item.status === "PENDING_CONFIRMATION" ? "bg-amber-50 text-amber-700" : "bg-green-50 text-green-700";
  // 금액이 어긋난 청구는 숨기지 않고 보여 주되, 잘못된 금액으로 수납되지 않도록 버튼만 막습니다.
  return <article className={`rounded-2xl border bg-white p-4 dark:bg-gray-900 ${item.status === "UNPAID" ? "border-red-200 dark:border-red-900" : "border-gray-200 dark:border-gray-800"}`}><div className="flex justify-between gap-3"><div><h3 className="font-black dark:text-white">{item.studentName}</h3><p className="mt-0.5 text-sm text-gray-500">{item.title}</p></div><span className={`h-fit shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-black ${statusClass}`}>{status}</span></div><div className="mt-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-1"><p className="shrink-0 whitespace-nowrap text-2xl font-black dark:text-white">{item.amount.toLocaleString("ko-KR")}원</p><p className={`text-xs font-bold ${overdue ? "text-red-700" : "text-gray-500"}`}>납부 기한 {new Intl.DateTimeFormat("ko-KR").format(new Date(item.dueDate))}</p></div>{item.amountMismatch && <p className="mt-2 text-xs font-bold text-amber-700 dark:text-amber-300">청구서에는 {item.invoiceAmount.toLocaleString("ko-KR")}원으로 되어 있습니다.</p>}{item.status === "UNPAID" && (item.confirmable ? <button type="button" onClick={onRequest} className="mt-4 min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)]">납부 확인 요청</button> : <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-200"><span className="material-symbols-outlined shrink-0 text-lg" aria-hidden="true">warning</span>{item.blockReason}</p>)}{item.status === "PENDING_CONFIRMATION" && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-200">요청이 접수되었습니다. 관리자가 확인하면 납부 완료로 변경됩니다.</p>}</article>;
}

function PaymentRequestDialog({ item, onClose, onCompleted }: { item: SerializedStaffClassBillingItem; onClose: () => void; onCompleted: (message: string) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [method, setMethod] = useState("BANK_TRANSFER"); const [note, setNote] = useState(""); const [message, setMessage] = useState(""); const [pending, startTransition] = useTransition();
  useStaffDialog(true, dialogRef, onClose, !pending);
  function submit() { startTransition(async () => { try { const result = await requestStaffPaymentConfirmation({ paymentId: item.id, method, receivedAt: new Date().toISOString(), note }); if (result.ok) onCompleted(result.message); else setMessage(result.message); } catch { setMessage("네트워크 연결을 확인한 뒤 다시 요청해 주세요."); } }); }
  return <div className="fixed inset-0 z-[80] flex items-end bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="payment-request-title"><div ref={dialogRef} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl dark:bg-gray-900"><p className="text-xs font-black text-[var(--brand-accent)]">납부 정보 확인</p><h3 id="payment-request-title" className="mt-1 text-xl font-black dark:text-white">납부 확인 요청</h3><div className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-gray-800"><p className="font-black">{item.studentName}</p><p className="text-sm text-gray-500">{item.title}</p><p className="mt-1 text-lg font-black">{item.amount.toLocaleString("ko-KR")}원</p></div><label className="mt-4 block text-sm font-bold">납부 방법<select data-dialog-initial-focus value={method} onChange={(event) => setMethod(event.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-gray-200 bg-white px-3 dark:border-gray-700 dark:bg-gray-800"><option value="BANK_TRANSFER">계좌이체</option><option value="CASH">현금</option></select></label><label className="mt-3 block text-sm font-bold">인계 메모 <span className="font-normal text-gray-400">(선택)</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} className="mt-2 w-full rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800" /></label>{message && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{message}</p>}<div className="mt-4 grid grid-cols-2 gap-2"><button type="button" disabled={pending} onClick={onClose} className="min-h-12 rounded-xl border border-gray-200 font-bold dark:border-gray-700">취소</button><button type="button" disabled={pending} onClick={submit} className="min-h-12 rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)] disabled:opacity-50">{pending ? "요청 중…" : "내용 확인 · 요청"}</button></div></div></div>;
}
function BillingMessage({ icon, text, spin = false }: { icon: string; text: string; spin?: boolean }) { return <div className="py-12 text-center text-sm font-bold text-gray-500"><span className={`material-symbols-outlined mb-2 block text-4xl ${spin ? "animate-spin" : ""}`}>{icon}</span>{text}</div>; }
