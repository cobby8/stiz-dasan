// 자동 시작 재시도 — 새 요청이 왔을 때 POS 가 바빠서(직전 결제 마무리 중·결제 화면에 다른 주문) 결제창을 못 열었으면,
// 요청이 아직 대기(PENDING) 중인 동안 POS 가 비는 순간 다시 연다(2026-11-17).
// 왜: 예전엔 «처음 본 순간» 한 번만 시도하고 못 열면 [결제하기] 토스트만 남겼다. 직전 결제 15초 뒤 보낸 요청이
//     POS 에 안 열려 직원이 사이트에서 취소하고 다시 보내야 했다(S-847921). DB 를 보면 «1초 안에 열리거나 아예 안 열림»이 반복됐다.
// 이 파일은 순수 로직(시계만 주입) — 워커가 2.5초마다 next() 로 꺼내 시도한다.
import type { ChargeRequest } from "./contract.ts";
import { isExpired } from "./order.ts";

/** 재시도 간격 — 못 연 요청마다 SDK 호출 1번(주문 비었나 확인)이라 60초 24번. 롱폴링(60초 3번)과 합쳐도 한도(60초 100번) 안 */
export const AUTO_RETRY_GAP_MS = 2_500;
/** 처음 못 연 뒤 이만큼 지나면 자동 재시도를 그만둔다(그 뒤는 [결제하기] 토스트·STIZ 탭으로) */
export const AUTO_RETRY_WINDOW_MS = 120_000;

export type NotReadyReason = "busy" | "draft_not_empty";

type Entry = { req: ChargeRequest; until: number; reported: Set<NotReadyReason> };

export function createAutoRetryQueue(now: () => number = () => Date.now()) {
  const entries = new Map<string, Entry>();

  /** 못 연 요청을 넣는다. 이미 있으면 기한을 늘리지 않는다(무한 재시도 방지) */
  function add(req: ChargeRequest): void {
    if (entries.has(req.id)) return;
    entries.set(req.id, { req, until: now() + AUTO_RETRY_WINDOW_MS, reported: new Set() });
  }

  function remove(id: string): void {
    entries.delete(id);
  }

  /** 롱폴링 응답의 대기(PENDING) 요청 id — 여기 없는 것(결제·취소·만료·다른 POS 가 가져감)은 뺀다 */
  function sync(pendingIds: Iterable<string>): void {
    const alive = new Set(pendingIds);
    for (const id of [...entries.keys()]) if (!alive.has(id)) entries.delete(id);
  }

  /** 지금 시도할 요청(먼저 들어온 것부터). 기한·요청 만료가 지난 것은 버린다 */
  function next(): ChargeRequest | null {
    const t = now();
    for (const [id, e] of entries) {
      if (t > e.until || isExpired(e.req, t)) {
        entries.delete(id);
        continue;
      }
      return e.req;
    }
    return null;
  }

  /** 이 사유로 서버에 처음 알리는 것이면 true(같은 요청·같은 사유는 한 번만 보고) */
  function shouldReport(id: string, reason: NotReadyReason): boolean {
    const e = entries.get(id);
    if (!e || e.reported.has(reason)) return false;
    e.reported.add(reason);
    return true;
  }

  return { add, remove, sync, next, shouldReport, has: (id: string) => entries.has(id), size: () => entries.size };
}

export type AutoRetryQueue = ReturnType<typeof createAutoRetryQueue>;

/** 시작 결과가 «POS 가 아직 안 비었음»이라 다시 시도할 만한지 */
export function isNotReady(result: string): result is NotReadyReason {
  return result === "busy" || result === "draft_not_empty";
}
