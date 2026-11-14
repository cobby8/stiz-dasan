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
// 2026-11-14 원장 지시: 청구는 «한 달 = 카드 한 줄»(청구월·합계·상태), 누르면 세부 시트 — 아이 기록 화면과 같은 부품
import MonthBillCard, { MonthBillList } from "@/components/parent/billing/MonthBillCard";
import BillDetailSheet from "@/components/parent/billing/BillDetailSheet";
import { groupBillsByMonth, type BillItemBase } from "@/lib/payments/monthBills";
import { todayKst } from "@/lib/datetime/kst";
// 환불 문의(2026-11-14 원장 결정표 c11) — 납부 완료 항목에서 그 청구를 가리키는 문의를 만든다(«문의 접수»까지, 실제 환불은 학원이 처리)
import { sendRefundInquiry } from "@/app/actions/parent-inquiry";
import { customerMessage } from "@/components/parent/customerMessage";

/** 온라인 결제가 안 될 때 안내할 학원 연락처(학원 설정값). 없으면 null */
export type PaymentContact = { phone: string | null; kakaoChannelUrl: string | null; bankAccount?: string | null };

/** 월 카드·세부 시트가 읽는 한 건 + 결제 흐름에 쓰는 원래 행 */
type BillRow = BillItemBase & { row: ParentPaymentRow };

export default function PaymentRequestClient({
  rows,
  payReady = false,
  contact = { phone: null, kakaoChannelUrl: null },
  initialOpenYm = null,
}: {
  rows: ParentPaymentRow[];
  /** 온라인 결제(토스 등) 설정이 끝났는가 — 결제 화면과 같은 판정(getPaymentProviderConfig) */
  payReady?: boolean;
  contact?: PaymentContact;
  /** 처음부터 열어 둘 청구 달 "YYYY-MM"(없으면 닫힌 채) */
  initialOpenYm?: string | null;
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
  // 환불 문의 — 사유 칸을 연 청구·쓴 사유·보낸 결과(청구 id → 문의 id)·오류. 결제 흐름의 상태(openId 등)와 섞지 않는다
  const [refundOpenId, setRefundOpenId] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundSent, setRefundSent] = useState<Record<string, { id: string; notice?: string }>>({});
  const [refundError, setRefundError] = useState("");
  // 열려 있는 세부 시트의 청구 달
  const [openYm, setOpenYm] = useState<string | null>(initialOpenYm);

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

  // 환불 문의 보내기 — 내 아이의 납부 완료 청구인지는 서버가 다시 확인한다. 실패하면 쓴 사유는 그대로 둔다
  function submitRefund(paymentId: string) {
    setRefundError("");
    startTransition(async () => {
      try {
        const result = await sendRefundInquiry(paymentId, refundReason);
        if (!result.ok) {
          setRefundError(customerMessage(result.error, "보내지 못했어요. 다시 시도해 주세요."));
          return;
        }
        setRefundSent((prev) => ({ ...prev, [paymentId]: { id: result.requestId, notice: result.notice } }));
        setRefundOpenId(null);
        setRefundReason("");
      } catch {
        setRefundError("보내지 못했어요. 다시 시도해 주세요.");
      }
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

  // ── 2026-11-14 원장 결정 w3: 맨 위 요약 줄 · 형제 칩 ──
  // 형제면 아이 칩(«전체» + 이름) — 목록만 거른다. «한 번에 결제» 묶음은 아이와 상관없이 그대로
  const [childFilter, setChildFilter] = useState<string | null>(null);
  const childChips = [...new Map(rows.map((row) => [row.studentId, row.studentName])).entries()];
  const shownRows = childFilter ? rows.filter((row) => row.studentId === childFilter) : rows;
  // 올해 납부 = 납기일이 올해(KST)인 납부 완료 합계 · 미납 = 미납·연체 건수(이 목록 기준 — 최근 60건)
  const thisYear = todayKst().slice(0, 4);
  const paidThisYear = shownRows
    .filter((row) => row.status === "PAID" && (row.dueDate ?? row.paidDate ?? "").startsWith(thisYear))
    .reduce((sum, row) => sum + row.amount, 0);
  const unpaidCount = shownRows.filter((row) => isUnpaidStatus(row.status)).length;
  const recordChild = childFilter ?? rows[0]?.studentId ?? null;
  const recordHref = recordChild ? `/mypage/record?child=${encodeURIComponent(recordChild)}` : "/mypage/record";

  // 청구 달(청구 대상 연·월, 없으면 납기일 KST 달) 하나에 카드 하나 — 형제·종류가 섞여도 한 카드(합계는 환불 제외)
  const monthBills = groupBillsByMonth<BillRow>(
    shownRows.map((row) => ({
      id: row.paymentId,
      studentId: row.studentId,
      studentName: row.studentName,
      type: row.type ?? null,
      status: row.status,
      amount: row.amount,
      year: row.year ?? null,
      month: row.month ?? null,
      dueYmd: row.dueDate,
      paidYmd: row.paidDate,
      description: row.description,
      receiptUrl: row.receiptUrl,
      method: row.method ?? null,
      paidProvider: row.paidProvider ?? null,
      row,
    })),
    thisYear,
  );
  const openBill = openYm === null ? null : monthBills.find((bill) => bill.ym === openYm) ?? null;

  // 영수증 요청 폼(종류·번호) — 세부 시트의 납부 완료 항목이 쓴다(폼 한 벌)
  function receiptForm(row: ParentPaymentRow) {
    return (
      <div className="mt-2 space-y-3 rounded-lg border border-[var(--color-academy-line)] p-3">
        <div>
          <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">영수증 종류</p>
          <div className="grid grid-cols-2 gap-1.5">
            {RECEIPT_TYPES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={receiptType === value}
                onClick={() => setReceiptType(value)}
                className={`min-h-11 whitespace-nowrap rounded-md border px-1 text-xs ${
                  receiptType === value
                    ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)]"
                    : "border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] font-medium text-[var(--color-academy-ink)]"
                }`}
              >
                {RECEIPT_TYPE_LABEL[value]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor={`receipt-target-${row.paymentId}`} className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
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
            className="academy-input"
          />
        </div>
        <button
          type="button"
          disabled={pending || uncertain || !receiptTarget.trim()}
          onClick={() => submitReceipt(row.paymentId)}
          className="academy-button-primary w-full"
        >
          {pending ? "보내는 중..." : "영수증 요청 보내기"}
        </button>
      </div>

    );
  }

  /**
   * 세부 시트 항목 아래 붙는 결제 흐름 — 예전 미납 카드·납부 완료 행의 버튼·안내를 그대로 옮겼다(같은 핸들러·같은 링크).
   * 항목 이름·금액·상태·할인·영수증 보기는 시트(BillDetailSheet)가 그린다.
   */
  function itemActions(row: ParentPaymentRow) {
    const unpaid = isUnpaidStatus(row.status);
    const claimPending = row.pending.find((item) => item.kind === "PAYMENT_CLAIM");
    const receiptPending = row.pending.find((item) => item.kind === "RECEIPT");
    const open = openId === row.paymentId;
    // 온라인 결제 버튼을 보여 줄 조건: 결제 설정 완료 + 청구서 있음 + 대표 보호자(마이페이지 홈과 같은 기준)
    const canPayOnline = payReady && Boolean(row.invoiceId) && row.canCheckout;
    return (
      <>
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
            {PAYMENT_REQUEST_KIND_LABEL[item.kind as "PAYMENT_CLAIM" | "RECEIPT"] ?? "요청"} ·{" "}
            {PAYMENT_REQUEST_STATUS_LABEL[item.status] ?? "처리 중"}
            {item.decisionNote ? ` · ${item.decisionNote}` : ""}
          </p>
        ))}

        {(claimPending || receiptPending) && (
          <div className="mt-2 space-y-2">
            {[claimPending, receiptPending].filter(Boolean).map((item) => (
              // «확인 중» = 정보(info) — 입금 확인 중 규칙과 같게(PM 결정 11-09)
              <div key={item!.id} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--color-academy-info-soft)] py-1 pl-2 pr-1">
                <p className="text-xs font-medium text-[var(--color-academy-ink)]">
                  {PAYMENT_REQUEST_KIND_LABEL[item!.kind as "PAYMENT_CLAIM" | "RECEIPT"]} 확인 중
                </p>
                {/* 터치 44px — 예전 36px(min-h-9)에서 올렸다 */}
                <button
                  type="button"
                  disabled={pending || uncertain}
                  onClick={() => cancel(item!.id)}
                  className="academy-button-text shrink-0"
                >
                  취소
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 미납 + 대표 보호자 + 결제 설정 완료 → 기존 결제 화면(/payments/[청구서])으로 보낸다.
            결제 로직·금액(면세 포함)은 그 화면이 그대로 처리한다. 여기서는 길만 연결한다. */}
        {unpaid && !claimPending && canPayOnline && (
          <Link
            href={`/payments/${encodeURIComponent(row.invoiceId!)}`}
            className="academy-button-primary mt-2 w-full"
          >
            결제하기
          </Link>
        )}

        {/* 결제 버튼을 못 보여 줄 때는 눌리지 않는 버튼 대신 «왜·어떻게»를 알려 준다. */}
        {unpaid && !claimPending && !canPayOnline && (
          <div className="mt-2 rounded-lg bg-[var(--color-academy-soft)] p-2.5 text-sm text-[var(--color-academy-ink)]">
            <p className="font-semibold">
              {!row.canCheckout ? "결제는 대표 보호자 계정에서 해요" : "지금은 온라인 결제를 쓸 수 없어요"}
            </p>
            {!contact.bankAccount && (
              <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">
                입금 계좌는 <Link href="/mypage#parent-request-form" className="inline-flex min-h-11 items-center underline">문의</Link>로 알려 드려요.
              </p>
            )}
            {contact.bankAccount && (
              // 계좌 글과 복사 버튼을 한 줄에 — 버튼은 «복사»로 짧게(읽기 프로그램에는 «계좌번호 복사»)
              <div className="mt-1 flex items-center gap-2">
                <span className="min-w-0 flex-1 break-keep font-semibold tabular-nums">{contact.bankAccount}</span>
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
                  className="academy-button-secondary shrink-0 whitespace-nowrap"
                >
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
                    className="academy-button-secondary whitespace-nowrap tabular-nums"
                  >
                    전화 {contact.phone}
                  </a>
                )}
                {contact.kakaoChannelUrl && (
                  <a
                    href={contact.kakaoChannelUrl} data-outside-link
                    target="_blank"
                    rel="noopener noreferrer"
                    className="academy-button-secondary whitespace-nowrap"
                  >
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
            aria-expanded={open}
            className={
              canPayOnline
                ? "academy-button-secondary mt-2 min-h-11 w-full text-sm"
                : "academy-button-primary mt-2 w-full"
            }
          >
            {canPayOnline ? "이미 계좌로 입금했어요" : "입금했어요 알리기"}
          </button>
        )}
        {/* 납부 완료인데 영수증이 없으면 요청(영수증이 있으면 시트가 «영수증 보기»를 그린다) */}
        {row.status === "PAID" && !receiptPending && !row.receiptUrl && (
          <button
            type="button"
            onClick={() => setOpenId(open ? null : row.paymentId)}
            aria-expanded={open}
            className="academy-button-text -ml-2 whitespace-nowrap"
          >
            영수증 요청
          </button>
        )}

        {open && unpaid && (
          <div className="mt-2 space-y-3 rounded-lg border border-[var(--color-academy-line)] p-3">
            <div>
              <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">어떻게 결제하셨나요?</p>
              {/* 선택지 3개(계좌이체·카드·현금) — 랠리즈는 2026-11-14 은퇴로 뺐다 */}
              <div className="grid grid-cols-3 gap-1.5">
                {PAYMENT_METHODS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={method === value}
                    onClick={() => setMethod(value)}
                    className={`min-h-11 whitespace-nowrap rounded-md border text-xs ${
                      method === value
                        ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)]"
                        : "border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] font-medium text-[var(--color-academy-ink)]"
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
                <label htmlFor={`paid-on-${row.paymentId}`} className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                  입금한 날짜
                </label>
                <input
                  id={`paid-on-${row.paymentId}`}
                  type="date"
                  value={paidOn}
                  onChange={(event) => setPaidOn(event.target.value)}
                  className="academy-input"
                />
              </div>
              <div>
                <label htmlFor={`depositor-${row.paymentId}`} className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
                  입금자명 (선택)
                </label>
                {/* 통장에 찍힌 이름이 자녀 이름과 다르면 원장이 못 찾는다. */}
                <input
                  id={`depositor-${row.paymentId}`}
                  value={depositorName}
                  onChange={(event) => setDepositorName(event.target.value)}
                  maxLength={60}
                  placeholder="자녀 이름과 다르면"
                  className="academy-input"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={pending || uncertain || !paidOn}
              onClick={() => submitClaim(row.paymentId)}
              className="academy-button-primary w-full"
            >
              {pending ? "보내는 중..." : "확인 요청 보내기"}
            </button>
          </div>
        )}

        {open && row.status === "PAID" && receiptForm(row)}

        {/* 환불 문의(납부 완료 항목만) — 보내면 «보낸 문의»의 대화로 이어진다. 결제·입금 알림·영수증 흐름과는 따로 논다 */}
        {row.status === "PAID" && (refundSent[row.paymentId] ? (
          <p role="status" className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] p-2 text-xs font-medium text-[var(--color-academy-success)]">
            {/* 이미 열린 환불 문의가 있었으면 그 안내(«이미 보낸 환불 문의에 덧붙였어요» 등)를 보인다 */}
            {refundSent[row.paymentId].notice ?? "환불 문의를 보냈어요."}{" "}
            <Link href={`/mypage/requests/${refundSent[row.paymentId].id}`} className="inline-flex min-h-11 items-center underline">보낸 문의에서 보기</Link>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => {
              setRefundOpenId(refundOpenId === row.paymentId ? null : row.paymentId);
              setRefundError("");
            }}
            aria-expanded={refundOpenId === row.paymentId}
            className="academy-button-text -ml-2 whitespace-nowrap"
          >
            환불 문의
          </button>
        ))}
        {refundOpenId === row.paymentId && row.status === "PAID" && !refundSent[row.paymentId] && (
          <div className="mt-2 space-y-2 rounded-lg border border-[var(--color-academy-line)] p-3">
            <label htmlFor={`refund-reason-${row.paymentId}`} className="block text-xs font-medium text-[var(--color-academy-muted)]">환불 사유(선택)</label>
            <textarea
              id={`refund-reason-${row.paymentId}`}
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="사유를 적어 주시면 더 빨리 확인해 드려요"
              className="academy-input resize-none"
            />
            <button type="button" disabled={pending} onClick={() => submitRefund(row.paymentId)} className="academy-button-primary w-full">
              {pending ? "보내는 중..." : "환불 문의 보내기"}
            </button>
            {refundError && <p role="alert" className="text-xs font-semibold text-[var(--color-academy-danger)]">{refundError}</p>}
          </div>
        )}
      </>
    );
  }

  // 처리 결과·오류 안내 — 시트가 열려 있으면 시트 안에, 아니면 화면에(가려진 곳에 뜨지 않게)
  const messages = (
    <>
      {done && <p role="status" className="rounded-lg bg-[var(--color-academy-success-soft)] p-3 text-sm font-medium text-[var(--color-academy-success)]">{done}</p>}
      {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
      {uncertain && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="academy-button-secondary">
            {pending ? "확인 중..." : "접수 결과 다시 확인"}
          </button>
          {uncertainSource !== rows && (
            <button type="button" disabled={pending} onClick={() => { setUncertainSource(null); setError(""); }} className="academy-button-secondary">
              내역 확인했어요
            </button>
          )}
        </div>
      )}
    </>
  );

  return (
    <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
      <div>
        <h1 className="academy-heading">청구·영수증</h1>
        {/* 왜 바로 안 바뀌는지 먼저 알린다. 이걸 모르면 "입금했는데요" 문자가 계속 온다. — 한 줄로 줄였다 */}
        <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">계좌 입금은 학원 확인 뒤 완료돼요. «입금했어요»로 알려 주면 빨라요.</p>
      </div>

      {/* 요약 한 줄 «올해 납부 · 미납 n건 · 연도별 보기 ▸» — 연도별 전체는 «아이 기록» 화면 */}
      {rows.length > 0 && (
        <Link
          href={recordHref}
          className="flex min-h-11 items-center gap-2 rounded-xl bg-[var(--color-academy-surface)] px-3 py-1.5 text-sm ring-1 ring-inset ring-[var(--color-academy-line)] hover:bg-[var(--color-academy-soft)]"
        >
          <span className="min-w-0 flex-1 break-keep tabular-nums text-[var(--color-academy-ink)]">
            올해 납부 <b className="font-semibold">{paidThisYear.toLocaleString("ko-KR")}원</b>
            <span className="mx-1 text-[var(--color-academy-muted)]">·</span>
            <span className={unpaidCount > 0 ? "font-semibold text-[var(--color-academy-warning)]" : ""}>미납 {unpaidCount}건</span>
          </span>
          <span className="shrink-0 whitespace-nowrap font-medium text-[var(--color-academy-secondary-ink)]">연도별 보기 ▸</span>
        </Link>
      )}

      {/* 형제면 아이 칩 — 목록만 거른다 */}
      {childChips.length > 1 && (
        <div role="group" aria-label="자녀 선택" className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={childFilter === null} onClick={() => setChildFilter(null)} className="academy-choice">전체</button>
          {childChips.map(([id, name]) => (
            <button key={id} type="button" aria-pressed={childFilter === id} onClick={() => setChildFilter(id)} className="academy-choice">
              {name}
            </button>
          ))}
        </div>
      )}

      {payReady && bundleRows.length > 0 && (
        <section aria-label="한 번에 결제" className="academy-panel flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
          <p className="min-w-0 flex-1 break-keep text-sm font-semibold text-[var(--color-academy-ink)]">
            미납 <span className="tabular-nums">{bundleRows.length}</span>건
            <span className="mx-1 text-[var(--color-academy-muted)]">·</span>
            <span className="whitespace-nowrap tabular-nums">합계 {bundleTotal.toLocaleString("ko-KR")}원</span>
          </p>
          <Link href="/mypage/payments/checkout" className="academy-button-primary shrink-0">한 번에 결제</Link>
        </section>
      )}

      {!openBill && messages}

      {rows.length === 0 ? (
        <p className="academy-panel p-4 text-center text-sm text-[var(--color-academy-muted)]">
          청구서가 없어요
        </p>
      ) : (
        // 한 달 = 한 줄(청구월 · 합계 · 상태) — 누르면 세부 시트
        <MonthBillList label="월별 청구">
          {monthBills.map((bill) => (
            <MonthBillCard key={bill.ym || "none"} bill={bill} onOpen={(ym) => { setOpenId(null); setOpenYm(ym); }} />
          ))}
        </MonthBillList>
      )}

      {openBill && (
        <BillDetailSheet
          bill={openBill}
          onClose={() => { setOpenYm(null); setOpenId(null); }}
          renderItemActions={(item) => itemActions(item.row)}
          // 시트 안 링크(결제하기)는 기록 칸을 되돌린 뒤 같은 화면 이동(router.push)으로
          navigate={(href) => router.push(href)}
          // 처리 결과·오류 안내만. «한 번에 결제»는 모든 달 미납을 묶으므로 화면 위쪽 칸 하나만 둔다(검수 11-14)
          footer={messages}
        />
      )}
    </main>
  );
}
