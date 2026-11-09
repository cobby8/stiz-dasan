"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";
import type { PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import { BUNDLE_BLOCK_MESSAGE, type BundleBlockCode } from "@/lib/payments/checkoutBundle";

// 묶음 결제 결과 — 성공 / 입금 대기(무통장 계좌 발급) / 확인 중 / 실패 네 가지만 보여 준다.
// 토스에서 돌아오면(paymentKey 있음) 승인을 요청하고, 새로고침·다시 열기(orderId 만)면 주문 상태만 읽는다.
// 승인은 같은 주문을 여러 번 불러도 안전하다(서버가 이미 끝난 주문이면 그대로 «완료»를 돌려준다).

type OrderItem = { paymentId: string; invoiceId: string; studentName: string; title: string; amount: number; position: number; paymentStatus: string };
type Order = {
    orderId: string;
    status: string;
    amount: number;
    receiptUrl: string | null;
    virtualAccount: PublicVirtualAccountView | null;
    items: OrderItem[];
};
type DoneState = "loading" | "success" | "deposit" | "pending" | "error";

const MAX_CONFIRM_RETRIES = 4;
const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;
// 승인 단계에서 서버가 막은 이유 중 «새로 결제하지 말고 납부 내역을 먼저 확인»해야 하는 것들(보안 수정 489c884b)
const CHECK_HISTORY_BLOCKS = new Set(["CONFIRM_IN_PROGRESS", "OPEN_DEPOSIT_EXISTS", "NOT_UNPAID"]);
const ITEM_STATUS: Record<string, string> = { PAID: "납부 완료", PENDING: "미납", OVERDUE: "미납", REFUNDED: "환불", CANCELED: "취소" };

/** 주문 상태 + 승인 결과로 화면 상태를 정한다(장부가 정본 — 주문이 DONE 이면 승인 응답과 무관하게 완료) */
export function decideDoneState(input: { ok: boolean; retryable: boolean; order: Order | null }): DoneState {
    const order = input.order;
    if (order?.status === "DONE" || (order && order.items.length > 0 && order.items.every((item) => item.paymentStatus === "PAID"))) return "success";
    if (order?.status === "WAITING_FOR_DEPOSIT" && order.virtualAccount && !order.virtualAccount.expired) return "deposit";
    if (input.retryable) return "pending";
    if (!input.ok) return "error";
    return order ? (order.status === "READY" || order.status === "IN_PROGRESS" ? "pending" : "error") : "success";
}

export default function BundleDoneClient({ paymentKey, orderId, amount }: { paymentKey: string; orderId: string; amount: number }) {
    const [state, setState] = useState<DoneState>("loading");
    const [message, setMessage] = useState("");
    const [order, setOrder] = useState<Order | null>(null);
    const [blocked, setBlocked] = useState("");
    const canceled = useRef(false);
    const canConfirm = Boolean(paymentKey && orderId && amount > 0);

    const run = useCallback(async (attempt = 0) => {
        if (!orderId) {
            setState("error");
            setMessage("결제 정보가 없어요.");
            return;
        }
        setState("loading");
        try {
            const response = canConfirm
                ? await fetch("/api/mypage/payments/confirm", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ paymentKey, orderId, amount }),
                })
                : await fetch(`/api/mypage/payments/confirm?orderId=${encodeURIComponent(orderId)}`);
            const data = await response.json().catch(() => ({}));
            if (canceled.current) return;
            const retryable = data?.retryable === true;
            // 승인 확인이 늦어지면 잠시 뒤 다시 묻는다(같은 주문이라 중복 결제는 생기지 않는다)
            if (retryable && attempt < MAX_CONFIRM_RETRIES) {
                window.setTimeout(() => { if (!canceled.current) void run(attempt + 1); }, 2500);
                return;
            }
            const nextOrder: Order | null = data?.order ?? null;
            setOrder(nextOrder);
            const ok = response.ok && data?.ok === true;
            setState(decideDoneState({ ok, retryable, order: nextOrder }));
            const code = typeof data?.blocked === "string" ? data.blocked : "";
            setBlocked(code);
            // 막힌 이유는 공용 문구(BUNDLE_BLOCK_MESSAGE)로 — 없으면 서버 문장
            setMessage(code && code in BUNDLE_BLOCK_MESSAGE ? BUNDLE_BLOCK_MESSAGE[code as BundleBlockCode] : typeof data?.error === "string" ? data.error : "");
        } catch {
            if (canceled.current) return;
            setState("pending");
            setMessage("결과를 확인하지 못했어요. 새 결제를 하기 전에 «다시 확인»을 눌러 주세요.");
        }
    }, [amount, canConfirm, orderId, paymentKey]);

    useEffect(() => {
        canceled.current = false;
        void run();
        return () => { canceled.current = true; };
    }, [run]);

    const heading = state === "loading" ? "결제 결과를 확인하고 있어요"
        : state === "success" ? "납부가 완료됐어요"
        : state === "deposit" ? "입금 계좌가 발급됐어요"
        : state === "pending" ? "결제 확인 중이에요"
        : "결제가 완료되지 않았어요";
    const icon = state === "success" ? "check_circle" : state === "deposit" ? "savings" : state === "error" ? "error" : "hourglass_top";
    const tone = state === "success" ? "text-[var(--color-academy-success)]" : state === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-primary)]";

    return (
        <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
            <section aria-live="polite" className="academy-panel p-4">
                <div className="flex items-center gap-3">
                    <span className={`material-symbols-outlined text-3xl leading-none ${tone}`} aria-hidden="true">{icon}</span>
                    <div className="min-w-0">
                        <h1 className="text-lg font-black text-[var(--color-academy-ink)]">{heading}</h1>
                        {/* 보조 문장은 할 일이 있을 때만(확인 중·실패). 완료·입금 안내는 아래 목록·계좌 안내가 대신한다 */}
                        {(state === "pending" || state === "error") && (
                            <p className="text-xs text-[var(--color-academy-muted)]">
                                {state === "pending"
                                    ? (message || "새로 결제하기 전에 «다시 확인»을 눌러 주세요.")
                                    : (message || "돈이 빠져나갔다면 학원에 문의해 주세요.")}
                            </p>
                        )}
                    </div>
                </div>
                {state === "deposit" && order?.virtualAccount && (
                    <div className="mt-3">
                        <VirtualAccountNotice account={order.virtualAccount} />
                    </div>
                )}
            </section>

            {order && order.items.length > 0 && (
                <section aria-labelledby="done-items-heading" className="academy-panel overflow-hidden">
                    <h2 id="done-items-heading" className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]">
                        <span>묶은 청구 <span className="tabular-nums text-[var(--color-academy-muted)]">{order.items.length}</span></span>
                        <span className="tabular-nums">합계 {won(order.amount)}</span>
                    </h2>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {order.items.map((item) => (
                            <li key={item.paymentId} className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm">
                                <span className="min-w-0 flex-1 break-keep font-bold text-[var(--color-academy-ink)]">
                                    <span className="mr-1 text-[var(--color-academy-primary)]">{item.studentName}</span>
                                    {item.title}
                                </span>
                                <span className="shrink-0 text-right tabular-nums">
                                    {won(item.amount)}
                                    <span className={`block text-xs font-bold ${item.paymentStatus === "PAID" ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-muted)]"}`}>
                                        {ITEM_STATUS[item.paymentStatus] ?? item.paymentStatus}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <div className="grid grid-cols-2 gap-2">
                {state === "success" && order?.receiptUrl ? (
                    <a href={order.receiptUrl} target="_blank" rel="noopener noreferrer" className="academy-button-secondary min-h-11 text-sm">영수증 보기</a>
                ) : state === "pending" || state === "error" ? (
                    <button type="button" onClick={() => void run()} className="academy-button-secondary min-h-11 text-sm">다시 확인</button>
                ) : (
                    <Link href="/mypage" className="academy-button-secondary min-h-11 text-sm">홈으로</Link>
                )}
                {state === "error" && !CHECK_HISTORY_BLOCKS.has(blocked) ? (
                    <Link href="/mypage/payments/checkout" className="academy-button-primary min-h-11 text-sm">다시 결제하기</Link>
                ) : (
                    <Link href="/mypage/payments" className="academy-button-primary min-h-11 text-sm">청구 목록</Link>
                )}
            </div>
        </main>
    );
}
