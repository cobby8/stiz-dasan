// 웹 워커(백그라운드) 진입점 — POS 가 켜져 있는 동안 계속 돈다(메뉴에는 안 보인다).
// 근거: https://docs.tossplace.com/guide/pos-integration/plugin/develop/package.html
//       https://docs.tossplace.com/guide/pos-integration/plugin/how-to-work.html (웹 워커 = DOM 없음)
// 하는 일:
//   1) 롱폴링: 서버에 «최대 20초 기다려 줘» 하고 묻고, 답이 오면 곧바로 다음 대기를 건다(실패하면 지수 백오프).
//      새 요청은 생기는 즉시 답이 와서 보통 1~2초 안에 결제창이 열린다(옛 서버면 14초 간격 폴링으로 돌아간다)
//   2) 새 요청 → 바로 결제 흐름(charge.ts)으로 결제창을 연다(2026-11-08 원장 요청: 누르는 단계 없이, 한 번에 1건)
//   3) 바로 못 열면(다른 주문이 담겨 있음·준비 중·오류) 토스트 «… 현장 결제 요청 [결제하기]» 로 남긴다
//   요청 한도: 정상 30분 90번 + 결제 1건당 SDK 호출 약 13번(backoff.ts 머리말 검산)
//   4) 결제/취소 신호 → 서버에 참고 보고
//   5) 롱폴링 응답의 «결제 취소할 일»(사이트에서 [결제 취소]) → 토스 POS 결제 취소(cancel.ts, 2026-11-08)
import { posPluginSdk, PosPluginSdkRateLimitError } from "@tossplace/pos-plugin-sdk";
import { createServerApi } from "../core/api.ts";
import { LONG_POLL_WAIT_SEC, nextAfterLongPoll, nextPollDelay } from "../core/backoff.ts";
import { createCancelFlow } from "../core/cancel.ts";
import { createChargeFlow } from "../core/charge.ts";
import type { CancelJob, ChargeRequest, DismissJob } from "../core/contract.ts";
import { isFirstNotice, needsManualFallback, pickNotifications } from "../core/notify.ts";
import type { NotifyLog } from "../core/notify.ts";
import { notificationMessage } from "../core/order.ts";
import type { PosSdkLike } from "../core/pos-types.ts";
import { SETTING_TOKEN_ID, createTokenStore, normalizeToken } from "../core/token.ts";

const sdk = posPluginSdk as unknown as PosSdkLike;
const isRateLimitError = (e: unknown) => PosPluginSdkRateLimitError.isPosPluginSdkRateLimitError(e);

const tokens = createTokenStore(posPluginSdk.secureStore);
const api = createServerApi({ http: posPluginSdk.http, getToken: () => tokens.get(), isRateLimitError });
const flow = createChargeFlow({ sdk, api });
const cancelFlow = createCancelFlow({ sdk, api });

const notified: NotifyLog = new Map();
let failures = 0;
let authWarned = false;
let timer: ReturnType<typeof setTimeout> | undefined;
/** 롱폴링이 진행 중인지(최대 25초) — 두 줄로 겹쳐 돌지 않게 */
let inFlight = false;
/** 서버가 연속으로 «일찍» 답한 횟수(backoff.ts nextAfterLongPoll) */
let earlyStreak = 0;
/** 직전 응답의 대기 요청 id(최대 20개) — 서버에 known 으로 보낸다 */
let seenPending: string[] = [];

/** 설정 화면(POS 설정 → 외부 서비스 설정)에 토큰 칸을 만든다 */
async function setupSettingScreen(): Promise<void> {
  await posPluginSdk.setting.setInputs([
    {
      id: SETTING_TOKEN_ID,
      label: "POS 연결 코드 (사이트 관리자 «POS 연결»에서 발급)",
      type: "password",
      required: false,
      default: "",
      placeholder: "연결 코드를 붙여 넣으세요",
    },
  ]);
}

/** 설정 칸에 넣은 토큰을 secureStore 로 옮긴다(탭 화면에서 넣은 경우엔 secureStore 에 바로 있음) */
async function adoptSettingToken(): Promise<void> {
  const values = await posPluginSdk.setting.getValues();
  const t = normalizeToken(values[SETTING_TOKEN_ID]);
  if (t && t !== (await tokens.get())) {
    await tokens.set(t);
    authWarned = false;
    failures = 0;
    posPluginSdk.toast.success({ message: "POS 연결 코드를 저장했어요." });
  }
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void tick();
  }, delayMs);
}

/**
 * 한 회차: 롱폴링 → 다음 회차 예약 → (그 다음에) 새 요청 처리.
 * 다음 회차를 먼저 예약하므로 결제 흐름(startCharge)이 멈춰도 폴링은 계속 돈다.
 */
async function tick(): Promise<void> {
  // 이미 대기 중인 요청이 있으면(설정 변경으로 앞당겨진 경우 등) 겹쳐 걸지 않는다 — 그쪽이 끝나면 다음을 예약한다
  if (inFlight) return;
  inFlight = true;
  let outcome: PollOutcome;
  try {
    outcome = await pollOnce();
  } catch (e) {
    // 어떤 오류가 나도 폴링이 멈추지 않도록 항상 다음 회차를 예약한다
    console.error("[stiz] 폴링 오류", e instanceof Error ? e.message : e);
    failures += 1;
    outcome = { delayMs: nextPollDelay(failures), fresh: [], cancels: [], dismissals: [] };
  } finally {
    inFlight = false;
  }
  schedule(outcome.delayMs);
  handleDismissals(outcome.dismissals);
  handleFresh(outcome.fresh, outcome.dismissals.length === 0);
  handleCancels(outcome.cancels);
}

/**
 * 결제 취소할 일 처리 — 한 건씩 차례로(같은 결제 화면을 두고 겹치지 않게). 결과 안내는 cancel.ts 가 한다.
 * 다음 폴링을 먼저 예약한 뒤 부르므로 취소가 오래 걸려도(POS 확인 창) 폴링은 멈추지 않는다.
 */
let cancelChain: Promise<unknown> = Promise.resolve();
const queuedDismissals = new Set<string>();

function handleDismissals(jobs: DismissJob[]): void {
  for (const job of jobs) {
    flow.noteDismissal(job);
    if (queuedDismissals.has(job.id)) continue;
    queuedDismissals.add(job.id);
    cancelChain = cancelChain.then(() => flow.dismissUnpaid(job))
      .catch((e) => console.error("[stiz] 미결제 요청 취소 처리 실패", e))
      .finally(() => queuedDismissals.delete(job.id));
  }
}

function handleCancels(jobs: CancelJob[]): void {
  for (const job of jobs) {
    cancelChain = cancelChain.then(() => cancelFlow.run(job)).catch((e) => console.error("[stiz] 결제 취소 처리 실패", e));
  }
}

/** 대기 요청 [결제하기] 토스트(자동으로 못 열었거나 두 번째 이후 요청) */
function buttonToast(req: ChargeRequest): void {
  posPluginSdk.toast.success({
    message: notificationMessage(req),
    button: { text: "결제하기", onClick: () => void flow.startCharge(req) }, // 사람이 누른 경로 = alert 안내 그대로
  });
}

/**
 * 새로 알릴 요청 처리. 처음 받은 요청 1건만 버튼 없이 바로 결제창을 연다(2026-11-08 원장 요청).
 * 나머지는 곧바로 [결제하기] 토스트. 자동 시작은 화면을 막는 alert 없이(silent) — 못 열면 토스트로 남긴다.
 */
function handleFresh(fresh: ChargeRequest[], allowAutomatic: boolean): void {
  let autoUsed = false;
  for (const req of fresh) {
    if (allowAutomatic && !autoUsed && isFirstNotice(notified, req.id) && !flow.isBusy()) {
      autoUsed = true;
      void flow
        .startCharge(req, { silent: true })
        .then((result) => {
          if (needsManualFallback(result)) buttonToast(req);
        })
        .catch(() => buttonToast(req));
      continue;
    }
    buttonToast(req);
  }
}

type PollOutcome = { delayMs: number; fresh: ChargeRequest[]; cancels: CancelJob[]; dismissals: DismissJob[] };

async function pollOnce(): Promise<PollOutcome> {
  const startedAt = Date.now();
  const res = await api.waitRequests({ waitSec: LONG_POLL_WAIT_SEC, known: seenPending });
  if (res.ok) {
    failures = 0;
    authWarned = false;
    const { requests, longPoll, cancels, dismissals } = res.data;
    // 이번에 본 대기 요청·취소할 일 = 다음 대기에서 서버가 «이것 때문에» 바로 답하지 않게 알려 줄 목록(합쳐 최대 20개)
    seenPending = [...dismissals.map((job) => job.id), ...cancels.map((job) => job.id), ...requests.filter((r) => r.status === "PENDING").map((r) => r.id)].slice(0, 20);
    const next = nextAfterLongPoll({ longPoll, elapsedMs: Date.now() - startedAt, earlyStreak });
    earlyStreak = next.earlyStreak;
    return { delayMs: next.delayMs, fresh: pickNotifications(requests, notified, Date.now()), cancels, dismissals };
  }
  earlyStreak = 0;
  // 실패 처리: 토큰 문제는 한 번만 크게 알리고, 나머지는 조용히 간격을 늘린다
  if (res.kind === "no_token" || res.kind === "auth") {
    if (!authWarned) {
      authWarned = true;
      posPluginSdk.toast.error({ message: res.message });
    }
    // 토큰을 넣을 때까지는 secureStore 를 다시 읽어 본다(탭 화면에서 넣었을 수 있음)
    tokens.reload();
    failures = Math.min(failures + 1, 5);
    return { delayMs: nextPollDelay(failures), fresh: [], cancels: [], dismissals: [] };
  }
  failures += 1;
  // 서버가 «몇 초 뒤에 다시»를 알려 주면(429 retryAfterSeconds) 그보다 먼저 부르지 않는다
  const serverWaitMs = (res.retryAfterSeconds ?? 0) * 1000;
  return { delayMs: Math.max(serverWaitMs, nextPollDelay(failures, { rateLimited: res.kind === "rate" })), fresh: [], cancels: [], dismissals: [] };
}

async function main(): Promise<void> {
  posPluginSdk.error.addErrorListener((e: Error) => console.error("[stiz] 워커 오류:", e.message));
  try {
    await setupSettingScreen();
    await adoptSettingToken();
  } catch (e) {
    console.error("[stiz] 설정 화면 준비 실패", e);
  }
  posPluginSdk.setting.on("change", () => {
    void adoptSettingToken().then(() => schedule(1_000)).catch(() => undefined);
  });
  // 결제/취소 신호(이벤트는 요청 제한에서 빠진다). 우리 주문이 아니면 아무것도 안 한다
  posPluginSdk.payment.on("paid", (paymentId: string, orderId: string) => {
    void flow.handlePaymentEvent("paid", paymentId, orderId).catch((e) => console.error("[stiz] paid 처리 실패", e));
  });
  posPluginSdk.payment.on("cancel", (paymentId: string, orderId: string) => {
    // 사이트 [결제 취소]로 이 기기가 방금 취소한 결제면 안내를 한 번 더 띄우지 않는다(cancel.ts 가 이미 안내함)
    if (cancelFlow.wasCancelledHere(paymentId)) return;
    void flow.handlePaymentEvent("cancel", paymentId, orderId).catch((e) => console.error("[stiz] cancel 처리 실패", e));
  });
  schedule(3_000); // POS 부팅 직후 몰리지 않게 3초 뒤 첫 확인
}

void main();
