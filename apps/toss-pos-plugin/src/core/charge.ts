// 현장 결제 흐름 — 요청을 POS 결제 화면으로 넘기고, 결제/취소 신호를 서버에 «참고용»으로 알린다.
// ⚠️ 납부완료 처리는 서버가 토스플레이스 웹훅(서명 검증) + Open API 재조회로만 한다.
//    여기서 보내는 보고는 기기 위 코드가 보내는 말이라 위조될 수 있으므로, 서버는 기록용으로만 쓴다.
// 요청 한도(60초 100번·30분 200번)에 드는 결제 1건당 SDK 호출 — 단건 약 13번, 묶음(항목 N개)은 약 12+N번:
//   시작 8+N번(주문 확인 2·선점 http 1·비우기 1·담기 N·다시 읽기 1~3·기록 읽기/쓰기 2·결제 화면 1)
//   + 결제 신호 4번(주문 조회 1·기록 읽기 1·결제 조회 1·보고 http 1). 다시 읽기가 늘면 최대 14+N번.
//   N 은 서버·플러그인 모두 최대 10(MAX_ITEMS)이라 묶음 1건도 최대 24번 — 롱폴링(60초 3번)과 합쳐 60초 100번 안이다.
import type { ServerApi, ApiResult } from "./api.ts";
import { kindMessage } from "./api.ts";
import type { ChargeRequest, DismissJob, DismissReport } from "./contract.ts";
import { dismissUnpaidOrder } from "./dismiss.ts";
import { buildLineItems, checkDraftAfterAdd, findShortCodeInOrder, formatWon, parseMemo, validateForPos } from "./order.ts";
import type { PosSdkLike } from "./pos-types.ts";

/** 최근 선점한 요청(번호 → 요청 id) 기록 — 결제 신호가 오면 어느 요청인지 찾는 데 쓴다 */
export const RECENT_KEY = "stiz_recent_charges";
const RECENT_MAX = 20;

export type RecentCharge = { id: string; shortCode: string; amount: number; at: number };

export type StartResult =
  | "started"
  | "unconfirmed" // POS 응답만으로 결제창 상태를 확인할 수 없음
  | "busy" // 이미 다른 결제를 준비 중(중복 클릭)
  | "draft_not_empty" // 결제 화면에 다른 상품이 담겨 있어 덮어쓰지 않음
  | "claim_failed" // 서버 선점 실패(이미 가져감·만료·네트워크)
  | "dismissed" // 사이트 취소를 받아 결제창을 열기 전에 중단
  | "invalid" // 금액·면세·만료 검사 실패
  | "error"; // POS 조작 중 오류

export type ChargeFlowDeps = {
  sdk: PosSdkLike;
  api: ServerApi;
  now?: () => number;
  /** 담은 뒤 다시 읽기 전 잠깐 기다리기(테스트는 0초) */
  sleep?: (ms: number) => Promise<void>;
};

export type StartOptions = {
  /**
   * 자동 시작(워커가 새 요청을 받자마자 여는 경로)이면 true — 화면을 막는 alert 를 띄우지 않는다.
   * 못 열면 워커가 [결제하기] 토스트를 남기고, 금액·면세 문제는 짧은 경고 토스트로만 알린다.
   */
  silent?: boolean;
};

/** 담은 뒤 주문을 다시 읽는 횟수와 간격 — POS 가 합계를 재계산할 틈(최대 약 0.6초) */
export const DRAFT_RECHECK_TRIES = 3;
export const DRAFT_RECHECK_GAP_MS = 300;

/** startPayment 오류 뒤 서버 납부 상태를 묻는 횟수와 간격 — 토스 웹훅 도착(보통 1~2초)을 기다린다(최대 약 6초) */
export const SERVER_STATE_TRIES = 4;
export const SERVER_STATE_GAP_MS = 2000;

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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // 중복 클릭 잠금: 결제 준비 중에는 두 번째 [결제하기] 를 무시한다
  let busy = false;
  let preparing = false;
  let dismissBusy = false;
  const dismissRequested = new Set<string>();
  const stoppedBeforeCheckout = new Set<string>();
  const dismissReports = new Map<string, DismissReport>();
  // 같은 결제 신호를 두 번 보고하지 않게(paid 는 분할결제마다 한 번씩 온다)
  const reported = new Set<string>();
  // 결제 완료 신호를 받은 요청 번호(startPayment 가 결제 뒤 오류를 내도 «실패»로 안내하지 않으려고)
  const paidCodes = new Set<string>();

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

  /**
   * startPayment 가 오류를 냈을 때 결제가 실제로는 진행됐는지.
   * 결제 완료 신호와 장바구니 상태를 확인한다. 결제창이 열려 있어도 항목은 남을 수 있다.
   * 결제 신호가 조금 늦게 올 수 있어 짧게(최대 약 0.9초) 기다리며 다시 본다.
   */
  async function paymentProceeded(req: Pick<ChargeRequest, "id" | "shortCode">): Promise<"paid" | "left_draft" | "stuck"> {
    const { shortCode } = req;
    for (let i = 0; i < DRAFT_RECHECK_TRIES; i++) {
      if (paidCodes.has(shortCode)) return "paid";
      if (i < DRAFT_RECHECK_TRIES - 1) await sleep(DRAFT_RECHECK_GAP_MS);
    }
    // 결제 완료 신호는 워커에만 와서 탭 화면에서 시작한 결제는 paidCodes 가 비어 있을 수 있다(2026-11-10 S-563655:
    // 결제·사이트 반영은 정상인데 18초 뒤 «다시 시도» 오류). 서버는 토스 웹훅으로 납부를 이미 알고 있으니 물어본다(읽기 전용).
    if (await serverSaysPaid(req.id)) return "paid";
    try {
      const d = await sdk.draftOrder.get();
      const ours = (d.lineItems ?? []).some((li) => (parseMemo(li.memo) ?? parseMemo(li.item?.code)) === shortCode);
      return ours ? "stuck" : "left_draft";
    } catch {
      return "stuck"; // 확인이 안 되면 예전처럼 오류로 안내
    }
  }

  /** 서버가 이 요청을 납부완료로 기록했는지 — 웹훅이 1~2초 늦을 수 있어 몇 번 다시 묻는다. 확인 실패는 «모름»(false) */
  async function serverSaysPaid(requestId: string): Promise<boolean> {
    for (let i = 0; i < SERVER_STATE_TRIES; i++) {
      try {
        const r = await api.paymentState(requestId);
        if (r.ok && r.data.paid) return true;
        if (!r.ok && (r.kind === "auth" || r.kind === "not_found" || r.kind === "no_token")) return false;
      } catch {
        /* 조회 실패는 모름으로 둔다 */
      }
      if (i < SERVER_STATE_TRIES - 1) await sleep(SERVER_STATE_GAP_MS);
    }
    return false;
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
  async function start(claimFn: () => Promise<ApiResult<ChargeRequest>>, opts: StartOptions = {}): Promise<StartResult> {
    const silent = opts.silent === true;
    // 사람이 누른 경로는 alert(확인 눌러야 닫힘), 자동 경로는 막지 않는 경고 토스트
    const notice = (message: string, blocking: boolean) => {
      if (!silent) sdk.alert.open({ message });
      else if (blocking) sdk.toast.warn({ message });
    };
    if (busy || dismissBusy) {
      // 자동 경로에선 워커가 [결제하기] 토스트를 따로 남기므로 안내를 겹치지 않는다
      if (!silent) sdk.toast.warn({ message: "결제를 준비하고 있어요. 잠시만 기다려 주세요." });
      return "busy";
    }
    busy = true;
    preparing = true;
    let claimed: ChargeRequest | null = null;
    try {
      // 1) 서버를 건드리기 전에 먼저 확인: 다른 주문이 담겨 있으면 덮어쓰지 않는다
      if (!(await isDraftEmpty())) {
        notice(DRAFT_BUSY_MSG, false); // 자동 경로: [결제하기] 토스트로 충분
        return "draft_not_empty";
      }
      // 2) 서버 선점(PENDING → SENT). 다른 POS 가 먼저 가져갔으면 여기서 409
      const res = await claimFn();
      if (!res.ok) {
        sdk.toast.warn({ message: res.message });
        return "claim_failed";
      }
      claimed = res.data;
      if (dismissRequested.has(claimed.id)) {
        stoppedBeforeCheckout.add(claimed.id);
        return "dismissed";
      }
      // 3) 금액·면세·만료 검사
      const v = validateForPos(claimed, now());
      if (!v.ok) {
        await reportStartFailed(claimed, v.reason);
        notice(v.reason, true);
        return "invalid";
      }
      // 4) 선점하는 사이 누가 상품을 담았을 수 있어 한 번 더 확인
      if (!(await isDraftEmpty())) {
        await reportStartFailed(claimed, "draft_not_empty");
        notice(DRAFT_BUSY_MSG, false);
        return "draft_not_empty";
      }
      // 5) 비어 있음을 확인했으니 비우기(남은 주문 할인 등 초기화) → 수강료 항목 추가
      //    묶음(같은 학생 여러 건)이면 청구마다 항목 1개씩, 서버가 준 순서대로(모두 같은 STIZ:번호 메모)
      await sdk.draftOrder.clear();
      for (const line of buildLineItems(claimed)) {
        await sdk.draftOrder.addLineItem(line);
      }
      // 6) 들어간 결과를 «다시 읽어» 확인한다. addLineItem 반환값은 합계 재계산 전일 수 있어(2026-11-08 S-704715)
      //    판단에 쓰지 않는다. 기준 = 우리 항목 N개 · 항목마다 항목가×수량 = 금액 · 면세 일치 · 메모 번호 + 합계(order.ts checkDraftAfterAdd)
      let check = checkDraftAfterAdd(await sdk.draftOrder.get(), claimed);
      // 통과했어도 합계가 아직 0(재계산 전)이면 끝까지 다시 읽는다 — 자동 할인·봉사료가 뒤늦게 붙는 경우를 잡기 위해.
      // 마지막 시도까지 합계가 0이면 항목 기준 판단으로 통과(검수 권장 2026-11-08)
      for (let i = 1; i < DRAFT_RECHECK_TRIES && (!check.ok || !check.settled); i++) {
        await sleep(DRAFT_RECHECK_GAP_MS);
        check = checkDraftAfterAdd(await sdk.draftOrder.get(), claimed);
      }
      if (!check.ok) {
        await sdk.draftOrder.clear();
        // 서버에 실제 값을 남긴다(서버는 300자까지 보관) — 다음에 같은 일이 나면 원인을 바로 본다
        await reportStartFailed(claimed, `draft_mismatch ${check.detail}`);
        notice("주문 금액이 요청과 달라 결제를 멈췄어요. 사이트에서 확인해 주세요.", true);
        return "invalid";
      }
      await remember(claimed);
      const allowed = await api.startCheck(claimed.id);
      if (dismissRequested.has(claimed.id)) {
        stoppedBeforeCheckout.add(claimed.id);
        return "dismissed";
      }
      if (!allowed.ok) {
        await dismissUnpaidOrder({ sdk, job: claimed, now: now(), stoppedBeforeCheckout: true });
        await reportStartFailed(claimed, `start_check_${allowed.kind}`);
        notice("사이트에서 이 결제 요청을 다시 확인해 주세요.", true);
        return "claim_failed";
      }
      preparing = false;
      // 같은 번호가 이 화면에서 다시 나와도 예전 결제 신호로 오인하지 않게(검수 권장 2026-11-08)
      paidCodes.delete(claimed.shortCode);
      // 7) 결제 화면으로 전환 — 카드 꽂기·서명은 사람이 한다
      // ⚠️ 결제 신호(payment.on("paid"))는 워커에만 걸려 있어, 탭 화면에서 시작한 결제는 paidCodes 가 비어
      //    아래 판정이 장바구니 확인(left_draft → 확인 안내)으로만 간다. 안전한 쪽이라 그대로 둔다.
      try {
        await sdk.draftOrder.startPayment();
      } catch {
        // 2026-11-08 실측(S-092770·S-290064·S-754720): 토스 POS 는 결제가 «끝난 뒤» startPayment 를 오류로 돌려줄 때가 있다
        // (서버에는 PAID 다음에 START_FAILED pos_error 가 찍힘). 그대로 «다시 시도해 주세요»를 띄우면 이중 결제를 부를 수 있어,
        // 결제가 진행됐는지 먼저 본다.
        const after = await paymentProceeded(claimed);
        if (after === "paid") return "started"; // 결제 완료 신호를 이미 받음 — 조용히 끝(완료 토스트는 결제 신호 쪽이 띄움)
        if (after === "left_draft") {
          // 우리 항목이 결제 화면(장바구니)에서 빠졌다 = 결제 단계로 넘어갔다. 다시 결제하라고 하지 않는다.
          sdk.toast.warn({ message: `${claimed.shortCode} 결제 화면 상태를 확인해 주세요. 결제가 끝났다면 사이트에 자동 반영돼요.` });
          return "started";
        }
        if (dismissRequested.has(claimed.id)) return "dismissed";
        sdk.toast.warn({ message: `${claimed.shortCode} POS에 열린 결제 화면을 확인해 주세요.` });
        return "unconfirmed";
      }
      return "started";
    } catch (e) {
      if (claimed) await reportStartFailed(claimed, "pos_error");
      sdk.toast.error({ message: `결제 화면을 여는 중 문제가 생겼어요. 다시 시도해 주세요.${errText(e)}` });
      return "error";
    } finally {
      preparing = false;
      busy = false;
    }
  }

  /** 대기 요청에서 [결제하기] */
  function startCharge(req: Pick<ChargeRequest, "id">, opts: StartOptions = {}): Promise<StartResult> {
    return start(() => api.claim(req.id), opts);
  }

  /** 미납 목록에서 [결제하기] — 서버가 요청 생성 + 선점을 한 번에 */
  function startChargeForUnpaid(paymentId: string): Promise<StartResult> {
    return start(() => api.chargeUnpaid(paymentId));
  }

  function noteDismissal(job: DismissJob): void {
    dismissRequested.add(job.id);
  }

  async function dismissUnpaid(job: DismissJob): Promise<void> {
    noteDismissal(job);
    // 장바구니를 쓰는 동안에는 다음 폴링에 다시 받는다. 결제 화면을 기다리는 동안에는 취소를 처리할 수 있다.
    if (preparing || dismissBusy) return;
    dismissBusy = true;
    try {
      let result = dismissReports.get(job.id);
      if (!result) {
        try {
          const recent = parseRecent(await sdk.storage.get(RECENT_KEY)).find((item) => item.id === job.id && item.shortCode === job.shortCode);
          result = await dismissUnpaidOrder({ sdk, job, recent, now: now(), stoppedBeforeCheckout: stoppedBeforeCheckout.has(job.id) });
        } catch {
          result = { outcome: "FAILED", reason: "POS_DISMISS_SDK_ERROR" };
        }
        dismissReports.set(job.id, result);
      }
      const acknowledged = await api.dismissReport(job.id, result);
      if (!acknowledged.ok && acknowledged.kind !== "conflict" && acknowledged.kind !== "not_found") return;
      dismissReports.delete(job.id);
      dismissRequested.delete(job.id);
      stoppedBeforeCheckout.delete(job.id);
      if (!acknowledged.ok) return;
      if (result.outcome === "DONE") {
        sdk.toast.success({ message: `${job.shortCode} 미결제 요청이 취소됐어요. 결제 화면이 남아 있으면 화면을 닫아 주세요.` });
      } else {
        sdk.toast.warn({ message: `${job.shortCode} 사이트에서 요청을 취소했어요. 이 POS에서 해당 결제 화면과 주문 상태를 확인해 주세요.` });
      }
    } finally {
      dismissBusy = false;
    }
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
    if (event === "paid") paidCodes.add(shortCode);

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
      // 2026-11-08: 사이트가 토스 취소 확인(웹훅) 뒤 청구를 자동으로 «환불»로 바꾼다(분할 결제는 전부 취소됐을 때만)
      sdk.toast.warn({ message: `${shortCode} POS 결제가 취소됐어요. 토스 확인 후 사이트 청구는 자동으로 환불 처리돼요.` });
    }
    if (!res.ok) {
      reported.delete(dedupeKey); // 다음 신호 때 다시 보고할 수 있게
      return "failed";
    }
    return "reported";
  }

  return { startCharge, startChargeForUnpaid, handlePaymentEvent, noteDismissal, dismissUnpaid, isBusy: () => busy || dismissBusy };
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  // 오류 문구에 토큰이 섞여 나올 일은 없지만, 길이를 잘라 화면을 넘치지 않게 한다
  return m ? ` (${m.slice(0, 60)})` : "";
}

export type ChargeFlow = ReturnType<typeof createChargeFlow>;
export { kindMessage };
