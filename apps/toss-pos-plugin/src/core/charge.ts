// 현장 결제 흐름 — 요청을 POS 결제 화면으로 넘기고, 결제/취소 신호를 서버에 «참고용»으로 알린다.
// ⚠️ 납부완료 처리는 서버가 토스플레이스 웹훅(서명 검증) + Open API 재조회로만 한다.
//    여기서 보내는 보고는 기기 위 코드가 보내는 말이라 위조될 수 있으므로, 서버는 기록용으로만 쓴다.
import type { ServerApi, ApiResult } from "./api.ts";
import { kindMessage } from "./api.ts";
import type { ChargeRequest } from "./contract.ts";
import { buildLineItem, findShortCodeInOrder, formatWon, validateForPos } from "./order.ts";
import type { PosSdkLike } from "./pos-types.ts";

/** 최근 선점한 요청(번호 → 요청 id) 기록 — 결제 신호가 오면 어느 요청인지 찾는 데 쓴다 */
export const RECENT_KEY = "stiz_recent_charges";
const RECENT_MAX = 20;

export type RecentCharge = { id: string; shortCode: string; amount: number; at: number };

export type StartResult =
  | "started"
  | "busy" // 이미 다른 결제를 준비 중(중복 클릭)
  | "draft_not_empty" // 결제 화면에 다른 상품이 담겨 있어 덮어쓰지 않음
  | "claim_failed" // 서버 선점 실패(이미 가져감·만료·네트워크)
  | "invalid" // 금액·면세·만료 검사 실패
  | "error"; // POS 조작 중 오류

export type ChargeFlowDeps = {
  sdk: PosSdkLike;
  api: ServerApi;
  now?: () => number;
};

/** 최근 선점 목록 읽기(망가진 값은 빈 목록) */
export function parseRecent(raw: string | undefined): RecentCharge[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string" && typeof x.shortCode === "string") : [];
  } catch {
    return [];
  }
}

/** 최근 선점 목록에 한 건 더하기(같은 번호는 새 것으로 교체, 최대 20건) */
export function addRecent(list: RecentCharge[], item: RecentCharge): RecentCharge[] {
  return [item, ...list.filter((x) => x.shortCode !== item.shortCode)].slice(0, RECENT_MAX);
}

export function createChargeFlow(deps: ChargeFlowDeps) {
  const { sdk, api } = deps;
  const now = deps.now ?? (() => Date.now());
  // 중복 클릭 잠금: 결제 준비 중에는 두 번째 [결제하기] 를 무시한다
  let busy = false;
  // 같은 결제 신호를 두 번 보고하지 않게(paid 는 분할결제마다 한 번씩 온다)
  const reported = new Set<string>();

  async function isDraftEmpty(): Promise<boolean> {
    const d = await sdk.draftOrder.get();
    return !d.lineItems || d.lineItems.length === 0;
  }

  const DRAFT_BUSY_MSG =
    "결제 화면에 다른 상품이 담겨 있어요. 그 주문을 먼저 끝내거나 비운 뒤 다시 [결제하기]를 눌러 주세요.";

  /** 실패를 서버에 참고로 알림(실패해도 흐름에는 영향 없음) */
  async function reportStartFailed(req: ChargeRequest, reason: string): Promise<void> {
    try {
      await api.report(req.id, { event: "start_failed", reason });
    } catch {
      /* 보고 실패는 무시 — 서버 만료 스윕이 정리한다 */
    }
  }

  async function remember(req: ChargeRequest): Promise<void> {
    const list = parseRecent(await sdk.storage.get(RECENT_KEY));
    await sdk.storage.set(
      RECENT_KEY,
      JSON.stringify(addRecent(list, { id: req.id, shortCode: req.shortCode, amount: req.amount, at: now() })),
    );
  }

  /**
   * 결제 시작 공통 경로. claimFn = 서버 선점 호출(대기 요청이면 claim, 미납 목록이면 chargeUnpaid).
   */
  async function start(claimFn: () => Promise<ApiResult<ChargeRequest>>): Promise<StartResult> {
    if (busy) {
      sdk.toast.warn({ message: "결제를 준비하고 있어요. 잠시만 기다려 주세요." });
      return "busy";
    }
    busy = true;
    let claimed: ChargeRequest | null = null;
    try {
      // 1) 서버를 건드리기 전에 먼저 확인: 다른 주문이 담겨 있으면 덮어쓰지 않는다
      if (!(await isDraftEmpty())) {
        sdk.alert.open({ message: DRAFT_BUSY_MSG });
        return "draft_not_empty";
      }
      // 2) 서버 선점(PENDING → SENT). 다른 POS 가 먼저 가져갔으면 여기서 409
      const res = await claimFn();
      if (!res.ok) {
        sdk.toast.warn({ message: res.message });
        return "claim_failed";
      }
      claimed = res.data;
      // 3) 금액·면세·만료 검사
      const v = validateForPos(claimed, now());
      if (!v.ok) {
        await reportStartFailed(claimed, v.reason);
        sdk.alert.open({ message: v.reason });
        return "invalid";
      }
      // 4) 선점하는 사이 누가 상품을 담았을 수 있어 한 번 더 확인
      if (!(await isDraftEmpty())) {
        await reportStartFailed(claimed, "draft_not_empty");
        sdk.alert.open({ message: DRAFT_BUSY_MSG });
        return "draft_not_empty";
      }
      // 5) 비어 있음을 확인했으니 비우기(남은 주문 할인 등 초기화) → 수강료 항목 추가
      await sdk.draftOrder.clear();
      const updated = await sdk.draftOrder.addLineItem(buildLineItem(claimed));
      // 6) 들어간 결과를 다시 확인: 항목 1개 · 금액 일치가 아니면 결제 화면을 열지 않는다
      const total = updated.price?.orderPriceValue;
      if (updated.lineItems.length !== 1 || (typeof total === "number" && total !== claimed.amount)) {
        await sdk.draftOrder.clear();
        await reportStartFailed(claimed, "draft_mismatch");
        sdk.alert.open({ message: "주문 금액이 요청과 달라 결제를 멈췄어요. 사이트에서 확인해 주세요." });
        return "invalid";
      }
      await remember(claimed);
      // 7) 결제 화면으로 전환 — 카드 꽂기·서명은 사람이 한다
      await sdk.draftOrder.startPayment();
      return "started";
    } catch (e) {
      if (claimed) await reportStartFailed(claimed, "pos_error");
      sdk.toast.error({ message: `결제 화면을 여는 중 문제가 생겼어요. 다시 시도해 주세요.${errText(e)}` });
      return "error";
    } finally {
      busy = false;
    }
  }

  /** 대기 요청에서 [결제하기] */
  function startCharge(req: Pick<ChargeRequest, "id">): Promise<StartResult> {
    return start(() => api.claim(req.id));
  }

  /** 미납 목록에서 [결제하기] — 서버가 요청 생성 + 선점을 한 번에 */
  function startChargeForUnpaid(paymentId: string): Promise<StartResult> {
    return start(() => api.chargeUnpaid(paymentId));
  }

  /** 결제/취소 신호 → 우리 주문이면 서버에 참고 보고 */
  async function handlePaymentEvent(event: "paid" | "cancel", paymentId: string, orderId: string): Promise<"ignored" | "reported" | "unknown" | "failed"> {
    const dedupeKey = `${event}:${paymentId}`;
    if (reported.has(dedupeKey)) return "ignored";
    // 우리 주문인지: 주문의 항목 메모에 STIZ:S-xxxx 가 있는지로 판단(다른 매출은 건드리지 않는다)
    const order = await sdk.order.getOrder(orderId);
    const shortCode = findShortCodeInOrder(order);
    if (!shortCode) return "ignored";
    reported.add(dedupeKey);

    const recent = parseRecent(await sdk.storage.get(RECENT_KEY)).find((r) => r.shortCode === shortCode);
    if (!recent) {
      // 다른 기기·다른 플러그인 화면에서 시작한 결제 — 서버가 웹훅으로 직접 맞춘다
      return "unknown";
    }
    let amount: number | undefined;
    let taxExemptAmount: number | undefined;
    try {
      const p = await sdk.payment.getPayment(paymentId);
      amount = p.amountMoney;
      taxExemptAmount = p.taxExemptMoney;
    } catch {
      /* 금액 조회 실패해도 보고는 한다 */
    }
    const res = await api.report(recent.id, { event, tossOrderId: orderId, tossPaymentId: paymentId, amount, taxExemptAmount });
    if (event === "paid") {
      if (res.ok && res.data === "PAID") {
        sdk.toast.success({ message: `${shortCode} 사이트 납부완료로 반영됐어요.` });
      } else {
        sdk.toast.success({
          message: `${shortCode} ${amount ? formatWon(amount) + " " : ""}결제됐어요. 사이트 반영은 토스 확인 후 자동으로 돼요.`,
        });
      }
    } else {
      sdk.toast.warn({ message: `${shortCode} POS 결제가 취소됐어요. 사이트 청구서는 자동으로 되돌리지 않아요 — 원장님께 알려 주세요.` });
    }
    if (!res.ok) {
      reported.delete(dedupeKey); // 다음 신호 때 다시 보고할 수 있게
      return "failed";
    }
    return "reported";
  }

  return { startCharge, startChargeForUnpaid, handlePaymentEvent, isBusy: () => busy };
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  // 오류 문구에 토큰이 섞여 나올 일은 없지만, 길이를 잘라 화면을 넘치지 않게 한다
  return m ? ` (${m.slice(0, 60)})` : "";
}

export type ChargeFlow = ReturnType<typeof createChargeFlow>;
export { kindMessage };
