// 웹 워커(백그라운드) 진입점 — POS 가 켜져 있는 동안 계속 돈다(메뉴에는 안 보인다).
// 근거: https://docs.tossplace.com/guide/pos-integration/plugin/develop/package.html
//       https://docs.tossplace.com/guide/pos-integration/plugin/how-to-work.html (웹 워커 = DOM 없음)
// 하는 일:
//   1) 30초마다 우리 서버의 대기 «현장 결제» 요청 확인(실패하면 지수 백오프)
//   2) 새 요청 → 토스트 «김○○ 수강료(11월) 100,000원 현장 결제 요청 [결제하기]»
//   3) [결제하기] → 결제 흐름(charge.ts)
//   4) 결제/취소 신호 → 서버에 참고 보고
import { posPluginSdk, PosPluginSdkRateLimitError } from "@tossplace/pos-plugin-sdk";
import { createServerApi } from "../core/api.ts";
import { nextPollDelay } from "../core/backoff.ts";
import { createChargeFlow } from "../core/charge.ts";
import { pickNotifications } from "../core/notify.ts";
import type { NotifyLog } from "../core/notify.ts";
import { notificationMessage } from "../core/order.ts";
import type { PosSdkLike } from "../core/pos-types.ts";
import { SETTING_TOKEN_ID, createTokenStore, normalizeToken } from "../core/token.ts";

const sdk = posPluginSdk as unknown as PosSdkLike;
const isRateLimitError = (e: unknown) => PosPluginSdkRateLimitError.isPosPluginSdkRateLimitError(e);

const tokens = createTokenStore(posPluginSdk.secureStore);
const api = createServerApi({ http: posPluginSdk.http, getToken: () => tokens.get(), isRateLimitError });
const flow = createChargeFlow({ sdk, api });

const notified: NotifyLog = new Map();
let failures = 0;
let authWarned = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** 설정 화면(POS 설정 → 외부 서비스 설정)에 토큰 칸을 만든다 */
async function setupSettingScreen(): Promise<void> {
  await posPluginSdk.setting.setInputs([
    {
      id: SETTING_TOKEN_ID,
      label: "사이트 연결 토큰 (사이트 관리자 «POS 연결»에서 발급)",
      type: "password",
      required: false,
      default: "",
      placeholder: "토큰을 붙여 넣으세요",
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
    posPluginSdk.toast.success({ message: "사이트 연결 토큰을 저장했어요." });
  }
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    // 어떤 오류가 나도 폴링이 멈추지 않도록 항상 다음 회차를 예약한다
    pollOnce().catch((e) => {
      console.error("[stiz] 폴링 오류", e instanceof Error ? e.message : e);
      failures += 1;
      schedule(nextPollDelay(failures));
    });
  }, delayMs);
}

async function pollOnce(): Promise<void> {
  const res = await api.listRequests();
  if (res.ok) {
    failures = 0;
    authWarned = false;
    for (const req of pickNotifications(res.data, notified, Date.now())) {
      posPluginSdk.toast.success({
        message: notificationMessage(req),
        button: { text: "결제하기", onClick: () => void flow.startCharge(req) },
      });
    }
    schedule(nextPollDelay(0));
    return;
  }
  // 실패 처리: 토큰 문제는 한 번만 크게 알리고, 나머지는 조용히 간격을 늘린다
  if (res.kind === "no_token" || res.kind === "auth") {
    if (!authWarned) {
      authWarned = true;
      posPluginSdk.toast.error({ message: res.message });
    }
    // 토큰을 넣을 때까지는 secureStore 를 다시 읽어 본다(탭 화면에서 넣었을 수 있음)
    tokens.reload();
    failures = Math.min(failures + 1, 5);
    schedule(nextPollDelay(failures));
    return;
  }
  failures += 1;
  schedule(nextPollDelay(failures, { rateLimited: res.kind === "rate" }));
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
    void flow.handlePaymentEvent("cancel", paymentId, orderId).catch((e) => console.error("[stiz] cancel 처리 실패", e));
  });
  schedule(3_000); // POS 부팅 직후 몰리지 않게 3초 뒤 첫 확인
}

void main();
