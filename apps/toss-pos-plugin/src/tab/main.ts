// 탭 화면(iframe) 진입점 — POS 메뉴 → 기타 → 외부 서비스 설정 → «STIZ 현장 결제»로 연다.
// 근거: https://docs.tossplace.com/guide/pos-integration/plugin/develop/iframe-package.html
// 보여주는 것: 대기 요청 목록 · 미납 검색 · 토큰 입력/교체. 이름은 서버가 마스킹해 준 그대로 쓴다.
import { posPluginSdk, PosPluginSdkRateLimitError } from "@tossplace/pos-plugin-sdk";
import { createServerApi } from "../core/api.ts";
import { createChargeFlow } from "../core/charge.ts";
import type { StartResult } from "../core/charge.ts";
import type { ChargeRequest, UnpaidItem } from "../core/contract.ts";
import { formatWon, itemTitleFor } from "../core/order.ts";
import type { PosSdkLike } from "../core/pos-types.ts";
import { createTokenStore, maskToken } from "../core/token.ts";

const sdk = posPluginSdk as unknown as PosSdkLike;
const tokens = createTokenStore(posPluginSdk.secureStore);
const api = createServerApi({
  http: posPluginSdk.http,
  getToken: () => tokens.get(),
  isRateLimitError: (e) => PosPluginSdkRateLimitError.isPosPluginSdkRateLimitError(e),
});
const flow = createChargeFlow({ sdk, api });

/** 탭이 열려 있는 동안 자동 새로고침 간격 — 워커 폴링(30초)과 합쳐도 요청 제한(30분 200번) 안 */
const TAB_REFRESH_MS = 60_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setMsg(text: string, tone: "" | "ok" | "bad" = ""): void {
  const el = $("msg");
  el.textContent = text;
  el.className = `msg ${tone}`;
}

function setConn(state: "ok" | "bad" | "", text: string): void {
  const el = $("conn");
  el.textContent = text;
  el.className = `pill ${state}`;
}

/** 한 줄 행 만들기 — 글자는 전부 textContent 로 넣어 HTML 로 해석되지 않게 한다 */
function rowEl(parts: { who: string; what: string; amt: number; code?: string }, onPay: (btn: HTMLButtonElement) => void): HTMLLIElement {
  const li = document.createElement("li");
  const cells: [string, string][] = [
    ["who", parts.who],
    ["what", parts.what],
    ["amt", formatWon(parts.amt)],
  ];
  if (parts.code) cells.push(["code", parts.code]);
  for (const [cls, text] of cells) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    li.appendChild(s);
  }
  const btn = document.createElement("button");
  btn.className = "btn primary";
  btn.textContent = "결제하기";
  btn.addEventListener("click", () => onPay(btn));
  li.appendChild(btn);
  return li;
}

function emptyEl(text: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  return li;
}

const START_MSG: Record<StartResult, string> = {
  started: "결제 화면으로 넘어갔어요. 카드를 받아 주세요.",
  busy: "결제를 준비하고 있어요.",
  draft_not_empty: "결제 화면에 다른 상품이 담겨 있어 멈췄어요.",
  claim_failed: "요청을 가져오지 못했어요.",
  invalid: "요청 정보가 맞지 않아 멈췄어요.",
  error: "결제 화면을 여는 중 문제가 생겼어요.",
};

/** [결제하기] 공통 처리: 버튼 잠금(중복 클릭 방지) → 흐름 실행 → 목록 새로고침 */
async function pay(btn: HTMLButtonElement, run: () => Promise<StartResult>): Promise<void> {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await run();
    setMsg(START_MSG[r], r === "started" ? "ok" : "bad");
  } finally {
    btn.disabled = false;
    void loadRequests();
  }
}

async function loadRequests(): Promise<void> {
  const list = $("req-list");
  const res = await api.listRequests();
  if (!res.ok) {
    setConn("bad", res.kind === "no_token" ? "토큰 없음" : "연결 안 됨");
    list.replaceChildren(emptyEl(res.message));
    $("req-count").textContent = "";
    return;
  }
  setConn("ok", "연결됨");
  const pending = res.data.filter((r: ChargeRequest) => r.status === "PENDING");
  $("req-count").textContent = `${pending.length}건`;
  list.replaceChildren(
    ...(pending.length
      ? pending.map((r) =>
          rowEl({ who: r.studentName, what: itemTitleFor(r), amt: r.amount, code: r.shortCode }, (b) =>
            void pay(b, () => flow.startCharge(r)),
          ),
        )
      : [emptyEl("대기 중인 요청이 없어요.")]),
  );
}

async function search(q: string): Promise<void> {
  const list = $("unpaid-list");
  if (!q.trim()) {
    list.replaceChildren(emptyEl("이름을 한 글자 이상 넣어 주세요."));
    return;
  }
  const res = await api.searchUnpaid(q.trim());
  if (!res.ok) {
    list.replaceChildren(emptyEl(res.message));
    return;
  }
  list.replaceChildren(
    ...(res.data.length
      ? res.data.map((u: UnpaidItem) =>
          rowEl({ who: u.studentName, what: [u.className, itemTitleFor(u)].filter(Boolean).join(" · "), amt: u.amount }, (b) =>
            void pay(b, () => flow.startChargeForUnpaid(u.paymentId)),
          ),
        )
      : [emptyEl("미납 청구서가 없어요.")]),
  );
}

async function showTokenState(): Promise<void> {
  $("token-state").textContent = `저장된 토큰: ${maskToken(await tokens.get())}`;
}

function bind(): void {
  $("refresh").addEventListener("click", () => void loadRequests());
  $("toggle-token").addEventListener("click", () => {
    const box = $("token-box");
    box.hidden = !box.hidden;
    if (!box.hidden) void showTokenState();
  });
  $("token-save").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("token-input");
    const ok = await tokens.set(input.value);
    input.value = ""; // 화면에 토큰이 남지 않게 바로 지운다
    if (!ok) {
      setMsg("토큰 모양이 맞지 않아요. 사이트에서 복사한 값을 그대로 붙여 넣어 주세요.", "bad");
      return;
    }
    setMsg("토큰을 저장했어요.", "ok");
    await showTokenState();
    await loadRequests();
  });
  $("token-clear").addEventListener("click", async () => {
    await tokens.clear();
    setMsg("토큰을 지웠어요.");
    await showTokenState();
    await loadRequests();
  });
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void search($<HTMLInputElement>("search-q").value);
  });
}

function main(): void {
  bind();
  // 탭이 따로 설치된 경우에도 결제 신호를 참고 보고한다(같은 플러그인이면 서버가 중복을 무시해야 함 — 계약 참고)
  posPluginSdk.payment.on("paid", (p: string, o: string) => void flow.handlePaymentEvent("paid", p, o).catch(() => undefined));
  posPluginSdk.payment.on("cancel", (p: string, o: string) => void flow.handlePaymentEvent("cancel", p, o).catch(() => undefined));
  void loadRequests();
  setInterval(() => {
    if (document.visibilityState === "visible") void loadRequests();
  }, TAB_REFRESH_MS);
}

main();
