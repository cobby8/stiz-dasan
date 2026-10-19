"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_REQUEST_KIND_LABEL,
  PAYMENT_REQUEST_STATUS_LABEL,
  RECEIPT_TYPES,
  RECEIPT_TYPE_LABEL,
  isUnpaidStatus,
  type PaymentMethodKind,
  type ReceiptType,
} from "@/lib/payments/parentRequestRules";
import type { ParentPaymentRow } from "@/lib/payments/parent-payment-request";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "미납", OVERDUE: "연체", PAID: "납부 완료", REFUNDED: "환불",
};

export default function PaymentRequestClient({ rows }: { rows: ParentPaymentRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethodKind>("TRANSFER");
  const [paidOn, setPaidOn] = useState("");
  const [depositorName, setDepositorName] = useState("");
  const [receiptType, setReceiptType] = useState<ReceiptType>("CASH_RECEIPT");
  const [receiptTarget, setReceiptTarget] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const sending = useRef(false);
  const [uncertainSource, setUncertainSource] = useState<ParentPaymentRow[] | null>(null);
  const uncertain = uncertainSource !== null;

  async function send(body: Record<string, unknown>) {
    if (sending.current || uncertain) return false;
    sending.current = true;
    setError("");
    setDone("");
    try {
      const response = await fetch("/api/mypage/payment-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 서버가 처리한 뒤 응답만 잃었을 수 있어 곧바로 재전송하지 않습니다.
      if (response.status >= 500) throw new Error("결과 확인 필요");
      const data = await response.json();
      if (!response.ok) {
        setError(typeof data?.error === "string" ? data.error : "요청을 처리할 수 없습니다. 입력 내용을 확인해 주세요.");
        return false;
      }
      if (data?.ok !== true) throw new Error("결과 확인 필요");
      return true;
    } catch {
      setUncertainSource(rows);
      setError("응답을 확인하지 못해 접수·취소 여부를 알 수 없습니다. 입력 내용은 유지했습니다. 다시 보내기 전에 목록의 확인 중·처리 결과를 확인해 주세요.");
      return false;
    } finally {
      sending.current = false;
    }
  }

  function submitClaim(paymentId: string) {
    startTransition(async () => {
      if (!(await send({ paymentId, kind: "PAYMENT_CLAIM", method, paidOn, depositorName, note }))) return;
      setDone("입금 확인 요청을 보냈습니다. 학원에서 확인 후 알려드립니다.");
      setOpenId(null);
      setPaidOn("");
      setDepositorName("");
      setNote("");
      router.refresh();
    });
  }

  function submitReceipt(paymentId: string) {
    startTransition(async () => {
      if (!(await send({ paymentId, kind: "RECEIPT", receiptType, receiptTarget, note }))) return;
      setDone("영수증 요청을 보냈습니다. 발급되면 알려드립니다.");
      setOpenId(null);
      setReceiptTarget("");
      setNote("");
      router.refresh();
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      setDone("요청을 취소했습니다.");
      router.refresh();
    });
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-black text-brand-navy-900 dark:text-white">청구서와 영수증</h1>
        {/* 왜 바로 안 바뀌는지 먼저 알린다. 이걸 모르면 "입금했는데요" 문자가 계속 온다. */}
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          입금하셔도 학원에서 확인하기 전까지는 <b>미납</b>으로 보입니다. 아래에서 알려주시면 더 빨리 처리됩니다.
        </p>
      </div>

      {done && <p className="rounded-xl bg-green-50 p-3 text-sm font-bold text-green-800">{done}</p>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
      {uncertain && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm font-bold disabled:opacity-50">
            {pending ? "확인 중..." : "접수 결과 다시 확인"}
          </button>
          {uncertainSource !== rows && (
            <button type="button" disabled={pending} onClick={() => { setUncertainSource(null); setError(""); }} className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm font-bold disabled:opacity-50">
              내역 확인했어요
            </button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-sm text-gray-400 shadow-sm dark:bg-gray-900">
          청구서가 없습니다
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const unpaid = isUnpaidStatus(row.status);
            const claimPending = row.pending.find((item) => item.kind === "PAYMENT_CLAIM");
            const receiptPending = row.pending.find((item) => item.kind === "RECEIPT");
            const open = openId === row.paymentId;
            return (
              <li key={row.paymentId} className="rounded-2xl bg-white p-4 shadow-sm dark:bg-gray-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-black text-brand-navy-900 dark:text-white">
                      {row.description || "수강료"}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {row.studentName}
                      {row.dueDate ? ` · ${row.dueDate}까지` : ""}
                      {row.invoiceNo ? ` · ${row.invoiceNo}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-black text-brand-navy-900 dark:text-white">{row.amount.toLocaleString()}원</p>
                    <p className={`text-xs font-bold ${unpaid ? "text-amber-700" : "text-green-700"}`}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </p>
                  </div>
                </div>

                {row.resolved.map((item) => (
                  <p key={item.id} className="mt-2 rounded-xl bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                    {PAYMENT_REQUEST_KIND_LABEL[item.kind as "PAYMENT_CLAIM" | "RECEIPT"] ?? item.kind} ·{" "}
                    {PAYMENT_REQUEST_STATUS_LABEL[item.status] ?? item.status}
                    {item.decisionNote ? ` · ${item.decisionNote}` : ""}
                  </p>
                ))}

                {(claimPending || receiptPending) && (
                  <div className="mt-2 space-y-2">
                    {[claimPending, receiptPending].filter(Boolean).map((item) => (
                      <div key={item!.id} className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 p-2 dark:bg-amber-950/30">
                        <p className="text-xs font-bold text-amber-900 dark:text-amber-200">
                          {PAYMENT_REQUEST_KIND_LABEL[item!.kind as "PAYMENT_CLAIM" | "RECEIPT"]} 확인 중
                        </p>
                        <button
                          type="button"
                          disabled={pending || uncertain}
                          onClick={() => cancel(item!.id)}
                          className="min-h-9 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-bold text-amber-900 disabled:opacity-50 dark:border-amber-800 dark:text-amber-200"
                        >
                          취소
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {row.receiptUrl && (
                  <a
                    href={row.receiptUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 flex min-h-11 items-center justify-center rounded-xl border border-gray-200 text-sm font-bold text-gray-700 dark:border-gray-700 dark:text-gray-200"
                  >
                    영수증 보기
                  </a>
                )}

                {/* 미납이면 입금 확인, 납부 완료면 영수증 — 상황에 맞는 버튼 하나만 보여준다. */}
                {unpaid && !claimPending && (
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : row.paymentId)}
                    className="mt-3 min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)]"
                  >
                    입금했어요 알리기
                  </button>
                )}
                {row.status === "PAID" && !receiptPending && !row.receiptUrl && (
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : row.paymentId)}
                    className="mt-3 min-h-12 w-full rounded-xl border border-gray-300 font-bold text-gray-700 dark:border-gray-600 dark:text-gray-200"
                  >
                    영수증 요청하기
                  </button>
                )}

                {open && unpaid && (
                  <div className="mt-3 space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                    <div>
                      <p className="mb-1 text-xs font-bold text-gray-500 dark:text-gray-400">어떻게 결제하셨나요?</p>
                      <div className="grid grid-cols-4 gap-1.5">
                        {PAYMENT_METHODS.map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setMethod(value)}
                            className={`min-h-11 rounded-lg border text-xs font-bold ${
                              method === value
                                ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                                : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {PAYMENT_METHOD_LABEL[value]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label htmlFor={`paid-on-${row.paymentId}`} className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                        입금하신 날짜
                      </label>
                      <input
                        id={`paid-on-${row.paymentId}`}
                        type="date"
                        value={paidOn}
                        onChange={(event) => setPaidOn(event.target.value)}
                        className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900"
                      />
                    </div>
                    <div>
                      <label htmlFor={`depositor-${row.paymentId}`} className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                        입금자명 (선택)
                      </label>
                      {/* 통장에 찍힌 이름이 자녀 이름과 다르면 원장이 못 찾는다. */}
                      <input
                        id={`depositor-${row.paymentId}`}
                        value={depositorName}
                        onChange={(event) => setDepositorName(event.target.value)}
                        maxLength={60}
                        placeholder="통장에 찍힌 이름이 자녀와 다르면 적어주세요"
                        className="min-h-11 w-full rounded-xl border border-gray-200 px-3 text-sm dark:border-gray-700 dark:bg-gray-900"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={pending || uncertain || !paidOn}
                      onClick={() => submitClaim(row.paymentId)}
                      className="min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)] disabled:opacity-50"
                    >
                      {pending ? "보내는 중..." : "확인 요청 보내기"}
                    </button>
                  </div>
                )}

                {open && row.status === "PAID" && (
                  <div className="mt-3 space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                    <div>
                      <p className="mb-1 text-xs font-bold text-gray-500 dark:text-gray-400">영수증 종류</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {RECEIPT_TYPES.map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setReceiptType(value)}
                            className={`min-h-11 rounded-lg border px-2 text-xs font-bold ${
                              receiptType === value
                                ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                                : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {RECEIPT_TYPE_LABEL[value]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label htmlFor={`receipt-target-${row.paymentId}`} className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                        {receiptType === "CASH_RECEIPT" ? "휴대폰 번호" : "사업자등록번호"}
                      </label>
                      {/* 번호를 안 받으면 원장이 발급을 못 해 다시 물어봐야 한다. */}
                      <input
                        id={`receipt-target-${row.paymentId}`}
                        value={receiptTarget}
                        onChange={(event) => setReceiptTarget(event.target.value)}
                        inputMode="numeric"
                        maxLength={60}
                        placeholder={receiptType === "CASH_RECEIPT" ? "010-0000-0000" : "000-00-00000"}
                        className="min-h-11 w-full rounded-xl border border-gray-200 px-3 text-sm dark:border-gray-700 dark:bg-gray-900"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={pending || uncertain || !receiptTarget.trim()}
                      onClick={() => submitReceipt(row.paymentId)}
                      className="min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)] disabled:opacity-50"
                    >
                      {pending ? "보내는 중..." : "영수증 요청 보내기"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
