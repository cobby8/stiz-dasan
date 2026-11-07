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
