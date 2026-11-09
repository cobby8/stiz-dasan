"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
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
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "미납", OVERDUE: "연체", PAID: "납부 완료", REFUNDED: "환불",
};

/** 온라인 결제가 안 될 때 안내할 학원 연락처(학원 설정값). 없으면 null */
export type PaymentContact = { phone: string | null; kakaoChannelUrl: string | null; bankAccount?: string | null };

export default function PaymentRequestClient({
  rows,
  payReady = false,
  contact = { phone: null, kakaoChannelUrl: null },
}: {
  rows: ParentPaymentRow[];
  /** 온라인 결제(토스 등) 설정이 끝났는가 — 결제 화면과 같은 판정(getPaymentProviderConfig) */
  payReady?: boolean;
  contact?: PaymentContact;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null); // 계좌번호를 복사한 청구 행 id
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
        setError(typeof data?.error === "string" ? data.error : "요청을 처리하지 못했어요. 입력 내용을 확인해 주세요.");
        return false;
      }
      if (data?.ok !== true) throw new Error("결과 확인 필요");
      return true;
    } catch {
      setUncertainSource(rows);
      setError("응답을 확인하지 못했어요. 다시 보내기 전에 «접수 결과 다시 확인»을 눌러 주세요.");
      return false;
    } finally {
      sending.current = false;
    }
  }

  function submitClaim(paymentId: string) {
    startTransition(async () => {
      if (!(await send({ paymentId, kind: "PAYMENT_CLAIM", method, paidOn, depositorName, note }))) return;
      setDone("입금 확인 요청을 보냈어요. 확인되면 알려 드려요.");
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
      setDone("영수증 요청을 보냈어요. 발급되면 알려 드려요.");
      setOpenId(null);
      setReceiptTarget("");
      setNote("");
      router.refresh();
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      setDone("요청을 취소했어요.");
      router.refresh();
    });
  }

  // «한 번에 결제» 진입(2026-11-09 묶음 결제) — 결제 담당 보호자의 미납 청구가 있을 때만.
  // 실제로 묶을 수 있는지(랠리즈 청구·입금 대기 등)는 그 화면이 서버 판정으로 줄마다 보여 준다.
  const bundleRows = rows.filter((row) => isUnpaidStatus(row.status) && row.canCheckout);
  const bundleTotal = bundleRows.reduce((sum, row) => sum + row.amount, 0);

  return (
    <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
      <div>
        <h1 className="text-xl font-black text-[var(--color-academy-ink)]">청구·영수증</h1>
        {/* 왜 바로 안 바뀌는지 먼저 알린다. 이걸 모르면 "입금했는데요" 문자가 계속 온다. — 한 줄로 줄였다 */}
        <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">계좌 입금은 학원 확인 뒤 완료돼요. «입금했어요»로 알려 주면 빨라요.</p>
      </div>

      {payReady && bundleRows.length > 0 && (
        <section aria-label="한 번에 결제" className="academy-panel flex items-center gap-3 p-3">
          <p className="min-w-0 flex-1 break-keep text-sm font-bold text-[var(--color-academy-ink)]">
            미납 <span className="tabular-nums">{bundleRows.length}</span>건
            <span className="mx-1 text-[var(--color-academy-muted)]">·</span>
            <span className="whitespace-nowrap tabular-nums">합계 {bundleTotal.toLocaleString("ko-KR")}원</span>
          </p>
          <Link href="/mypage/payments/checkout" className="academy-button-primary min-h-11 shrink-0 px-4 text-sm">한 번에 결제</Link>
        </section>
      )}

      {done && <p role="status" className="rounded-lg bg-[var(--color-academy-success-soft)] p-3 text-sm font-bold text-[var(--color-academy-success)]">{done}</p>}
      {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] p-3 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>}
      {uncertain && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="academy-button-secondary min-h-11 text-sm">
            {pending ? "확인 중..." : "접수 결과 다시 확인"}
          </button>
          {uncertainSource !== rows && (
            <button type="button" disabled={pending} onClick={() => { setUncertainSource(null); setError(""); }} className="academy-button-secondary min-h-11 text-sm">
              내역 확인했어요
            </button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="academy-panel p-4 text-center text-sm text-[var(--color-academy-muted)]">
          청구서가 없어요
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const unpaid = isUnpaidStatus(row.status);
            const claimPending = row.pending.find((item) => item.kind === "PAYMENT_CLAIM");
            const receiptPending = row.pending.find((item) => item.kind === "RECEIPT");
            const open = openId === row.paymentId;
            // 온라인 결제 버튼을 보여 줄 조건: 결제 설정 완료 + 청구서 있음 + 대표 보호자(마이페이지 홈과 같은 기준)
            const canPayOnline = payReady && Boolean(row.invoiceId) && row.canCheckout;
            return (
              <li key={row.paymentId} className="academy-panel p-3">
                {/* 청구 정보 한 덩어리: 항목·금액 / 아이·납기·상태 (청구서 번호는 결제 화면에서 본다) */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-keep font-black text-[var(--color-academy-ink)]">
                      {row.description || "수강료"}
                    </p>
                    <p className="text-xs text-[var(--color-academy-muted)]">
                      {row.studentName}
                      {row.dueDate ? ` · ${row.dueDate}까지` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-black tabular-nums text-[var(--color-academy-ink)]">{row.amount.toLocaleString()}원</p>
                    <p className={`text-xs font-bold ${unpaid ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-success)]"}`}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </p>
                  </div>
                </div>

                {/* 무통장입금 계좌(입금 대기·만료) — 대표 보호자에게만 온다. 묶음 계좌면 합계 금액이 보인다 */}
                {unpaid && row.virtualAccount && (
                  <div className="mt-2">
                    <VirtualAccountNotice compact account={row.virtualAccount} />
                    {row.virtualAccount.amount !== row.amount && (
                      <p className="mt-1 text-xs text-[var(--color-academy-muted)]">여러 청구를 묶은 계좌 · 합계 {row.virtualAccount.amount.toLocaleString("ko-KR")}원</p>
                    )}
                  </div>
                )}

                {row.resolved.map((item) => (
                  <p key={item.id} className="mt-2 rounded-lg bg-[var(--color-academy-soft)] p-2 text-xs text-[var(--color-academy-muted)]">
                    {PAYMENT_REQUEST_KIND_LABEL[item.kind as "PAYMENT_CLAIM" | "RECEIPT"] ?? item.kind} ·{" "}
                    {PAYMENT_REQUEST_STATUS_LABEL[item.status] ?? item.status}
                    {item.decisionNote ? ` · ${item.decisionNote}` : ""}
                  </p>
                ))}

                {(claimPending || receiptPending) && (
                  <div className="mt-2 space-y-2">
                    {[claimPending, receiptPending].filter(Boolean).map((item) => (
                      <div key={item!.id} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--color-academy-warning-soft)] py-1 pl-2 pr-1">
                        <p className="text-xs font-bold text-[var(--color-academy-ink)]">
                          {PAYMENT_REQUEST_KIND_LABEL[item!.kind as "PAYMENT_CLAIM" | "RECEIPT"]} 확인 중
                        </p>
                        {/* 터치 44px — 예전 36px(min-h-9)에서 올렸다 */}
                        <button
                          type="button"
                          disabled={pending || uncertain}
                          onClick={() => cancel(item!.id)}
                          className="academy-button-text min-h-11 shrink-0 px-3 text-xs"
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
                    className="academy-button-secondary mt-2 min-h-11 w-full text-sm"
                  >
                    영수증 보기
                  </a>
                )}

                {/* 미납 + 대표 보호자 + 결제 설정 완료 → 기존 결제 화면(/payments/[청구서])으로 보낸다.
                    결제 로직·금액(면세 포함)은 그 화면이 그대로 처리한다. 여기서는 길만 연결한다. */}
                {unpaid && !claimPending && canPayOnline && (
                  <Link
                    href={`/payments/${encodeURIComponent(row.invoiceId!)}`}
                    className="academy-button-primary mt-2 min-h-12 w-full font-black"
                  >
                    <span className="material-symbols-outlined text-xl leading-none" aria-hidden="true">credit_card</span>
                    결제하기
                  </Link>
                )}

                {/* 결제 버튼을 못 보여 줄 때는 눌리지 않는 버튼 대신 «왜·어떻게»를 알려 준다. */}
                {unpaid && !claimPending && !canPayOnline && (
                  <div className="mt-2 rounded-lg bg-[var(--color-academy-soft)] p-2.5 text-sm text-[var(--color-academy-ink)]">
                    <p className="flex items-center gap-1.5 font-bold">
                      <span className="material-symbols-outlined text-lg leading-none" aria-hidden="true">account_balance</span>
                      {!row.canCheckout ? "결제는 대표 보호자 계정에서 해요" : "지금은 온라인 결제를 쓸 수 없어요"}
                    </p>
                    {!contact.bankAccount && (
                      <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">입금 계좌는 학원에 문의해 주세요.</p>
                    )}
                    {contact.bankAccount && (
                      // 계좌 글과 복사 버튼을 한 줄에 — 버튼은 «복사»로 짧게(읽기 프로그램에는 «계좌번호 복사»)
                      <div className="mt-1 flex items-center gap-2">
                        <span className="min-w-0 flex-1 break-keep font-bold tabular-nums">{contact.bankAccount}</span>
                        <button
                          type="button"
                          aria-label="계좌번호 복사"
                          onClick={() => {
                            // 계좌번호만(숫자) 복사 — 은행 앱 붙여넣기용. 복사가 막힌 기기는 화면의 글자를 길게 눌러 복사.
                            const digits = (contact.bankAccount ?? "").replace(/[^0-9]/g, "");
                            const done = (mark: string) => {
                              setCopied(mark);
                              setTimeout(() => setCopied(null), 2500); // 잠시 뒤 원래 문구로
                            };
                            if (!navigator.clipboard) { done(`fail:${row.paymentId}`); return; }
                            navigator.clipboard.writeText(digits).then(() => done(row.paymentId)).catch(() => done(`fail:${row.paymentId}`));
                          }}
                          className="academy-button-secondary min-h-11 shrink-0 whitespace-nowrap px-3 text-xs"
                        >
                          <span className="material-symbols-outlined text-base leading-none" aria-hidden="true">content_copy</span>
                          {copied === row.paymentId ? "복사됨" : "복사"}
                        </button>
                      </div>
                    )}
                    {copied === `fail:${row.paymentId}` && (
                      <p role="status" className="mt-1 text-xs text-[var(--color-academy-muted)]">
                        복사가 안 됐어요. 계좌번호를 길게 눌러 복사해 주세요.
                      </p>
                    )}
                    {(contact.phone || contact.kakaoChannelUrl) && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {contact.phone && (
                          <a
                            href={`tel:${contact.phone.replace(/[^0-9+]/g, "")}`}
                            className="academy-button-secondary min-h-11 whitespace-nowrap px-3 text-xs"
                          >
                            <span className="material-symbols-outlined text-base leading-none" aria-hidden="true">call</span>
                            {contact.phone}
                          </a>
                        )}
                        {contact.kakaoChannelUrl && (
                          <a
                            href={contact.kakaoChannelUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="academy-button-secondary min-h-11 whitespace-nowrap px-3 text-xs"
                          >
                            <span className="material-symbols-outlined text-base leading-none" aria-hidden="true">chat</span>
                            카카오 채널로 문의
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 계좌로 따로 입금한 경우를 위한 기존 흐름 — 결제 버튼이 있으면 보조 버튼으로 내려 준다. */}
                {unpaid && !claimPending && (
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : row.paymentId)}
                    className={
                      canPayOnline
                        ? "academy-button-secondary mt-2 min-h-11 w-full text-sm"
                        : "academy-button-primary mt-2 min-h-12 w-full font-black"
                    }
                  >
                    {canPayOnline ? "이미 계좌로 입금했어요" : "입금했어요 알리기"}
                  </button>
                )}
                {row.status === "PAID" && !receiptPending && !row.receiptUrl && (
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : row.paymentId)}
                    className="academy-button-secondary mt-2 min-h-11 w-full text-sm"
                  >
                    영수증 요청하기
                  </button>
                )}

                {open && unpaid && (
                  <div className="mt-2 space-y-3 rounded-lg border border-[var(--color-academy-line)] p-3">
                    <div>
                      <p className="mb-1 text-xs font-bold text-[var(--color-academy-muted)]">어떻게 결제하셨나요?</p>
                      <div className="grid grid-cols-2 gap-1.5 min-[375px]:grid-cols-4">
                        {PAYMENT_METHODS.map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setMethod(value)}
                            className={`min-h-11 whitespace-nowrap rounded-lg border text-xs font-bold ${
                              method === value
                                ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                                : "border-[var(--color-academy-line)] text-[var(--color-academy-muted)]"
                            }`}
                          >
                            {PAYMENT_METHOD_LABEL[value]}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* 날짜·입금자명은 한 줄 두 칸(묶음 결제 화면과 같은 모양) */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label htmlFor={`paid-on-${row.paymentId}`} className="mb-1 block text-xs font-bold text-[var(--color-academy-muted)]">
                          입금한 날짜
                        </label>
                        <input
                          id={`paid-on-${row.paymentId}`}
                          type="date"
                          value={paidOn}
                          onChange={(event) => setPaidOn(event.target.value)}
                          className="min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] px-2 text-sm text-[var(--color-academy-ink)]"
                        />
                      </div>
                      <div>
                        <label htmlFor={`depositor-${row.paymentId}`} className="mb-1 block text-xs font-bold text-[var(--color-academy-muted)]">
                          입금자명 (선택)
                        </label>
                        {/* 통장에 찍힌 이름이 자녀 이름과 다르면 원장이 못 찾는다. */}
                        <input
                          id={`depositor-${row.paymentId}`}
                          value={depositorName}
                          onChange={(event) => setDepositorName(event.target.value)}
                          maxLength={60}
                          placeholder="자녀 이름과 다르면"
                          className="min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] px-2 text-sm text-[var(--color-academy-ink)]"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={pending || uncertain || !paidOn}
                      onClick={() => submitClaim(row.paymentId)}
                      className="academy-button-primary min-h-12 w-full font-black"
                    >
                      {pending ? "보내는 중..." : "확인 요청 보내기"}
                    </button>
                  </div>
                )}

                {open && row.status === "PAID" && (
                  <div className="mt-2 space-y-3 rounded-lg border border-[var(--color-academy-line)] p-3">
                    <div>
                      <p className="mb-1 text-xs font-bold text-[var(--color-academy-muted)]">영수증 종류</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {RECEIPT_TYPES.map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setReceiptType(value)}
                            className={`min-h-11 whitespace-nowrap rounded-lg border px-1 text-xs font-bold ${
                              receiptType === value
                                ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                                : "border-[var(--color-academy-line)] text-[var(--color-academy-muted)]"
                            }`}
                          >
                            {RECEIPT_TYPE_LABEL[value]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label htmlFor={`receipt-target-${row.paymentId}`} className="mb-1 block text-xs font-bold text-[var(--color-academy-muted)]">
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
                        className="min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] px-3 text-sm text-[var(--color-academy-ink)]"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={pending || uncertain || !receiptTarget.trim()}
                      onClick={() => submitReceipt(row.paymentId)}
                      className="academy-button-primary min-h-12 w-full font-black"
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
