// 알림 고르기 — 폴링할 때마다 같은 요청을 계속 띄우지 않도록 «언제 몇 번 알렸는지»를 기록한다.
import type { ChargeRequest } from "./contract.ts";
import { isExpired } from "./order.ts";

/** 아직 PENDING 이면 5분마다 다시 알린다(토스트를 놓쳤을 때 대비), 요청 하나당 최대 3번 */
export const RENOTIFY_MS = 5 * 60_000;
export const MAX_NOTIFY = 3;

export type NotifyLog = Map<string, { count: number; lastAt: number }>;

/**
 * 이번 폴링에서 알림을 띄울 요청만 골라낸다(log 도 함께 갱신).
 * - PENDING 이 아니거나 만료된 요청은 제외
 * - 목록에서 사라진 요청은 log 에서 지워 메모리가 쌓이지 않게 한다
 */
export function pickNotifications(requests: ChargeRequest[], log: NotifyLog, nowMs: number): ChargeRequest[] {
  const out: ChargeRequest[] = [];
  const alive = new Set<string>();
  for (const r of requests) {
    alive.add(r.id);
    if (r.status !== "PENDING" || isExpired(r, nowMs)) continue;
    const prev = log.get(r.id);
    if (!prev) {
      log.set(r.id, { count: 1, lastAt: nowMs });
      out.push(r);
    } else if (prev.count < MAX_NOTIFY && nowMs - prev.lastAt >= RENOTIFY_MS) {
      log.set(r.id, { count: prev.count + 1, lastAt: nowMs });
      out.push(r);
    }
  }
  for (const id of [...log.keys()]) if (!alive.has(id)) log.delete(id);
  return out;
}

/** 처음 받은 요청인지(처음이면 버튼을 기다리지 않고 바로 결제창을 연다 — 2026-11-08 원장 요청) */
export function isFirstNotice(log: NotifyLog, id: string): boolean {
  return log.get(id)?.count === 1;
}

/**
 * 자동으로 결제창을 열지 못했을 때 «결제하기» 버튼 알림을 남겨야 하는지.
 * - busy(다른 결제 준비 중)·draft_not_empty(결제 화면에 다른 주문)·error(POS 오류) → 나중에 사람이 누를 수 있게 남긴다
 * - started(열림)·claim_failed(다른 POS 가 가져감·만료)·invalid(금액 검사 실패) → 남기지 않는다
 */
export function needsManualFallback(result: string): boolean {
  return result === "busy" || result === "draft_not_empty" || result === "error";
}
