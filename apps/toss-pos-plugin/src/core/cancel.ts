// 결제 취소 흐름 — 사이트에서 «결제 취소»를 누른 요청을 받아 토스 POS 결제를 취소하고, 결과를 서버에 «참고용»으로 알린다.
// (2026-11-08 원장 지시 «사이트에서 결제 취소하면 POS 결제도 취소되게»)
// ⚠️ 사이트 청구서의 «환불»은 서버가 토스플레이스 웹훅(서명 검증) + Open API 재조회로만 한다.
//    여기서 보내는 보고는 기기 위 코드의 말이라 서버는 기록·안내(실패 시 «POS 에서 직접 취소»)에만 쓴다.
// 근거: SDK 0.0.31 payment.cancel({ id: orderId }, { id: paymentId }): Promise<void>
//       https://docs.tossplace.com/reference/plugin-sdk/pos/payment.html («CARD, CASH 타입의 결제 취소는 Toss POS 를 통해 처리»)
//   카드 취소 때 POS 에서 사람 확인이 필요한지는 실기기 시험에서 확인한다 — 확인 창이 떠 있는 동안 cancel 이 늦게 끝나거나
//   거절되면 실패로 보고되어 사이트가 «POS 에서 직접 취소해 주세요»를 띄운다(어느 쪽이든 견딘다).
// 요청 한도: 취소 1건당 SDK 호출 = http 2번(선점·보고) + 결제마다 3번(상태 확인·취소·다시 확인). 드문 작업이라 한도에 영향 적음.
import type { ServerApi } from "./api.ts";
import type { CancelClaim, CancelJob } from "./contract.ts";
import type { PosSdkLike } from "./pos-types.ts";

/** 이미 취소 끝으로 보는 결제 상태(SDK PluginPaymentState 는 CANCELLED, 철자 변형도 받는다) */
export const CANCELLED_STATES = new Set(["CANCELLED", "CANCELED", "REFUNDED"]);

/** 같은 취소 요청을 다시 해 보기까지의 간격 — 서버는 보고 없이 2분 지난 일을 다시 맡긴다 */
export const CANCEL_RETRY_MS = 3 * 60_000;

/** 이 기기가 방금 취소한 결제를 기억하는 시간 — 그 결제의 «취소» 신호로 안내가 두 번 뜨지 않게 */
export const OWN_CANCEL_MEMORY_MS = 10 * 60_000;

export type CancelOutcome =
  | { result: "cancelled"; cancelled: string[]; already: string[] } // 전부 취소(또는 이미 취소돼 있었음)
  | { result: "failed"; cancelled: string[]; already: string[]; failed: string[] } // 하나라도 못 함 → 사이트 «POS 에서 직접 취소»
  | { result: "claim_failed" } // 다른 POS 가 가져감·네트워크 등
  | { result: "skipped" }; // 이미 진행 중이거나 방금 처리함

export type CancelFlowDeps = {
  sdk: PosSdkLike;
  api: ServerApi;
  now?: () => number;
};

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m ? m.slice(0, 60) : "알 수 없는 오류";
}

export function createCancelFlow(deps: CancelFlowDeps) {
  const { sdk, api } = deps;
  const now = deps.now ?? (() => Date.now());
  // 같은 요청을 동시에 두 번 하지 않게(롱폴링 응답이 겹쳐 와도)
  const running = new Set<string>();
  // 요청 id → 마지막으로 처리한 시각(짧은 시간 안에 같은 일을 다시 하지 않게)
  const handledAt = new Map<string, number>();
  // 결제 id → 이 기기가 취소한 시각
  const ownCancels = new Map<string, number>();

  function forgetOld(): void {
    const t = now();
    for (const [id, at] of handledAt) if (t - at >= CANCEL_RETRY_MS) handledAt.delete(id);
    for (const [id, at] of ownCancels) if (t - at >= OWN_CANCEL_MEMORY_MS) ownCancels.delete(id);
  }

  /** 결제 하나: 상태 확인 → 이미 취소면 건너뜀, 다른 주문 결제면 손대지 않음, 아니면 취소 */
  async function cancelOne(claim: CancelClaim, paymentId: string): Promise<"cancelled" | "already" | string> {
    let state = "";
    try {
      const p = await sdk.payment.getPayment(paymentId);
      state = String(p.state ?? "").toUpperCase();
      // 서버가 준 주문과 다른 주문의 결제면 절대 취소하지 않는다(남의 매출 보호)
      if (p.orderId && String(p.orderId) !== claim.tossOrderId) return "다른 주문의 결제";
    } catch {
      // 상태를 못 읽어도 취소는 시도한다 — 이미 취소된 결제면 POS 가 거절하고, 그건 실패로 보고된다
    }
    if (CANCELLED_STATES.has(state)) return "already";
    try {
      await sdk.payment.cancel({ id: claim.tossOrderId }, { id: paymentId });
    } catch (e) {
      return errText(e);
    }
    ownCancels.set(paymentId, now());
    // 취소가 정말 됐는지 한 번 더 본다 — POS 확인 창에서 사람이 «아니오»를 눌렀는데 cancel 이 오류 없이 끝나는 경우 대비.
    // 여전히 «승인»으로 읽히면 실패로 보고해 사이트가 «POS 에서 직접 취소»를 안내하게 한다. 못 읽으면 취소된 것으로 본다(웹훅이 최종 확인).
    try {
      const after = await sdk.payment.getPayment(paymentId);
      if (String(after.state ?? "").toUpperCase() === "APPROVED") return "POS 에서 취소가 확인되지 않았어요";
    } catch {
      /* 못 읽음 — 토스 웹훅이 최종 확인한다 */
    }
    return "cancelled";
  }

  /** 취소할 일 1건 처리: 선점 → 결제마다 취소 → 서버에 결과 보고 → 안내 */
  async function run(job: CancelJob): Promise<CancelOutcome> {
    forgetOld();
    if (running.has(job.id) || handledAt.has(job.id)) return { result: "skipped" };
    running.add(job.id);
    try {
      const res = await api.cancelClaim(job.id);
      if (!res.ok) {
        // 다른 POS 가 가져갔거나(409) 잠깐 끊김 — 잠시 뒤 서버가 다시 맡기면 그때 다시 한다
        handledAt.set(job.id, now());
        return { result: "claim_failed" };
      }
      const claim = res.data;
      const cancelled: string[] = [];
      const already: string[] = [];
      const failed: string[] = [];
      for (const paymentId of claim.tossPaymentIds) {
        const r = await cancelOne(claim, paymentId);
        if (r === "cancelled") cancelled.push(paymentId);
        else if (r === "already") already.push(paymentId);
        else failed.push(`${paymentId}: ${r}`);
      }
      const ok = failed.length === 0;
      const message = ok
        ? `취소 ${cancelled.length}건${already.length ? ` · 이미 취소 ${already.length}건` : ""}`
        : `취소 실패 ${failed.join(" / ")}${cancelled.length ? ` · 취소됨 ${cancelled.length}건` : ""}`;
      try {
        await api.cancelReport(claim.id, { result: ok ? "done" : "failed", message: message.slice(0, 280) });
      } catch {
        /* 보고 실패는 무시 — 환불은 토스 웹훅으로 되고, 서버는 보고 없는 일을 2분 뒤 다시 맡긴다 */
      }
      handledAt.set(job.id, now());
      if (ok) {
        sdk.toast.success({ message: `${claim.shortCode} POS 결제를 취소했어요. 토스 확인 후 사이트 청구가 환불로 바뀌어요.` });
        return { result: "cancelled", cancelled, already };
      }
      sdk.toast.error({ message: `${claim.shortCode} 결제 취소를 못 했어요. POS 결제 내역에서 직접 취소해 주세요.` });
      return { result: "failed", cancelled, already, failed };
    } finally {
      running.delete(job.id);
    }
  }

  /** 이 기기가 방금 취소한 결제인가(그 결제의 «취소» 신호 안내를 한 번 더 띄우지 않게) */
  function wasCancelledHere(paymentId: string): boolean {
    forgetOld();
    return ownCancels.has(paymentId);
  }

  return { run, wasCancelledHere };
}

export type CancelFlow = ReturnType<typeof createCancelFlow>;
