import type { DismissJob, DismissReport } from "./contract.ts";
import { formatMemo } from "./order.ts";
import type { DraftOrderLike, OrderLike, PosSdkLike } from "./pos-types.ts";

type Line = { memo?: string; item?: { code?: string } };

function belongsTo(line: Line, marker: string): boolean {
  return (line.memo?.trim() === marker || line.item?.code?.trim() === marker)
    && [line.memo, line.item?.code].every((value) => !value?.trim().startsWith("STIZ:") || value.trim() === marker);
}

function allBelongTo(lines: Line[] | undefined, marker: string): boolean {
  return !!lines?.length && lines.every((line) => belongsTo(line, marker));
}

function orderTime(value: string | undefined): number {
  if (!value) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`);
}

function koreaDateTime(ms: number): string {
  // 토스 POS 조회 날짜는 yyyy-MM-ddTHH:mm:ss 한국 시각 형식을 사용한다.
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

/** A previously saved payment is never touched by the unpaid-request path. */
function hasPayment(order: OrderLike): boolean {
  return order.paymentPrice?.paymentPaidValue !== 0 || !Array.isArray(order.payments) || order.payments.length > 0;
}

export async function dismissUnpaidOrder(input: {
  sdk: PosSdkLike;
  job: DismissJob;
  recent?: { at: number; amount: number };
  stoppedBeforeCheckout: boolean;
  now: number;
}): Promise<DismissReport> {
  const { sdk, job, recent, stoppedBeforeCheckout, now } = input;
  const marker = formatMemo(job.shortCode);
  const local = (reason: string): DismissReport => ({ outcome: "NEEDS_LOCAL_CANCEL", reason });
  const ownsDraft = (draft: DraftOrderLike) => allBelongTo(draft.lineItems, marker);
  const firstDraft = await sdk.draftOrder.get();

  if (stoppedBeforeCheckout && !firstDraft.id) {
    if (ownsDraft(firstDraft)) await sdk.draftOrder.clear();
    const after = await sdk.draftOrder.get();
    return after.lineItems.some((line) => belongsTo(line, marker))
      ? local("POS_DRAFT_STILL_PRESENT")
      : { outcome: "DONE", reason: "CHECKOUT_NOT_STARTED" };
  }

  if (!recent || !Number.isFinite(recent.at) || !Number.isSafeInteger(recent.amount) || recent.amount <= 0) {
    return local("POS_REQUEST_NOT_REMEMBERED");
  }
  const start = recent.at - 10_000;
  const end = now + 10_000;
  const ownsOrder = (order: OrderLike) => {
    const createdAt = orderTime(order.createdAt);
    return createdAt >= start && createdAt <= end && allBelongTo(order.lineItems, marker)
      && order.chargePrice?.chargePriceValue === recent.amount;
  };
  let targetId = ownsDraft(firstDraft) ? firstDraft.id : undefined;
  if (!targetId && sdk.order.getOrders) {
    const matches = new Map<string, OrderLike>();
    for (let page = 1; page <= 3; page++) {
      const orders = await sdk.order.getOrders({ start: koreaDateTime(start), end: koreaDateTime(end), page, size: 50 });
      for (const order of orders) {
        if (ownsOrder(order)) matches.set(order.id, order);
      }
      if (orders.length < 50) break;
      if (page === 3) return local("POS_ORDER_LOOKUP_INCOMPLETE");
    }
    if (matches.size > 1) return local("POS_ORDER_NOT_UNIQUE");
    targetId = matches.keys().next().value;
  }

  if (!targetId) return local("POS_ORDER_NOT_IDENTIFIED");
  const order = await sdk.order.getOrder(targetId);
  if (order.id !== targetId || !ownsOrder(order)) return local("POS_ORDER_NOT_IDENTIFIED");
  if (hasPayment(order)) return local("POS_PAYMENT_PRESENT_OR_UNVERIFIED");

  if (order.orderState !== "CANCELLED") {
    if (order.orderState !== "OPENED" || order.paymentState !== "OPENED" || !sdk.order.cancel) return local("POS_ORDER_NOT_CANCELLABLE");
    await sdk.order.cancel(targetId);
    const canceled = await sdk.order.getOrder(targetId);
    if (canceled.id !== targetId || canceled.orderState !== "CANCELLED" || hasPayment(canceled)) return local("POS_ORDER_CANCEL_UNVERIFIED");
  }

  const currentDraft = await sdk.draftOrder.get();
  if (ownsDraft(currentDraft) && (!currentDraft.id || currentDraft.id === targetId)) await sdk.draftOrder.clear();
  const after = await sdk.draftOrder.get();
  return after.lineItems.some((line) => belongsTo(line, marker))
    ? local("POS_DRAFT_STILL_PRESENT")
    : { outcome: "DONE", reason: "POS_ORDER_CANCELLED" };
}
