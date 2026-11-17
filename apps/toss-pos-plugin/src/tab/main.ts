// 탭 화면(iframe) 진입점 — POS 메뉴 → 기타 → 외부 서비스 설정 → «STIZ 현장 결제»로 연다.
// 근거: https://docs.tossplace.com/guide/pos-integration/plugin/develop/iframe-package.html
// 보여주는 것: 대기·선점 요청 목록 · 미납 검색 · POS 연결 코드 입력/교체. 이름은 서버가 마스킹해 준 그대로 쓴다.
import { posPluginSdk, PosPluginSdkRateLimitError } from "@tossplace/pos-plugin-sdk";
import { createServerApi } from "../core/api.ts";
import { createChargeFlow } from "../core/charge.ts";
import type { StartResult } from "../core/charge.ts";
import type { ChargeRequest, UnpaidItem } from "../core/contract.ts";
import { groupUnpaidByStudent } from "../core/unpaid-groups.ts";
import { formatWon, titleWithoutName } from "../core/order.ts";
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
function rowEl(
  parts: { who: string; what: string; amt: number; code?: string; payLabel?: string; cls?: string; disabled?: boolean },
  onPay: (btn: HTMLButtonElement) => void,
): HTMLLIElement {
  const li = document.createElement("li");
  if (parts.cls) li.className = parts.cls;
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
  btn.textContent = parts.payLabel ?? "결제하기";
  btn.disabled = parts.disabled === true;
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
  unconfirmed: "POS에 열린 결제 화면을 확인해 주세요.",
  busy: "결제를 준비하고 있어요.",
  draft_not_empty: "결제 화면에 다른 상품이 담겨 있어 멈췄어요.",
  claim_failed: "요청을 가져오지 못했어요.",
  dismissed: "사이트에서 이 요청을 취소했어요.",
  invalid: "요청 정보가 맞지 않아 멈췄어요.",
  error: "결제 화면을 여는 중 문제가 생겼어요.",
};

/** 마지막 미납 검색어 — 결제 뒤 검색 결과를 다시 읽는 데 쓴다(2026-11-17: 결제한 줄이 그대로 남아 있었다) */
let lastQuery = "";

/** [결제하기] 공통 처리: 버튼 잠금(중복 클릭 방지) → 흐름 실행 → 대기 목록·미납 검색 새로고침 */
async function pay(btn: HTMLButtonElement, run: () => Promise<StartResult>): Promise<void> {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await run();
    setMsg(START_MSG[r], r === "started" ? "ok" : "bad");
  } finally {
    btn.disabled = false;
    void loadRequests();
    if (lastQuery) void search(lastQuery);
  }
}

async function loadRequests(): Promise<void> {
  const list = $("req-list");
  const res = await api.listRequests();
  if (!res.ok) {
    setConn("bad", res.kind === "no_token" ? "연결 코드 없음" : "연결 안 됨");
    list.replaceChildren(emptyEl(res.message));
    $("req-count").textContent = "";
    return;
  }
  setConn("ok", "연결됨");
  // 대기(PENDING)뿐 아니라 선점(SENT)됐지만 결제 시작이 안 된 요청도 보여 «다시 결제»할 수 있게 한다.
  // 같은 연결 코드로 다시 선점하면 서버가 성공시키고, 다른 POS 가 가져간 건이면 409(NOT_CLAIMABLE) 안내가 뜬다.
  const open = res.data.filter((r: ChargeRequest) => r.status === "PENDING" || r.status === "SENT");
  $("req-count").textContent = `${open.length}건`;
  list.replaceChildren(
    ...(open.length
      ? open.map((r) =>
          rowEl(
            {
              who: r.studentName,
              what: titleWithoutName(r),
              amt: r.amount,
              code: r.shortCode,
              payLabel: r.status === "SENT" ? "다시 결제" : "결제하기",
            },
            (b) => void pay(b, () => flow.startCharge(r)),
          ),
        )
      : [emptyEl("대기 중인 요청이 없어요.")]),
  );
}

/** 미납 한 줄 */
function unpaidRow(u: UnpaidItem, sub: boolean): HTMLLIElement {
  return rowEl(
    {
      who: sub ? "" : u.studentName,
      what: [u.className, titleWithoutName(u)].filter(Boolean).join(" · "),
      amt: u.amount,
      cls: sub ? "sub" : undefined,
      // 이미 열린 요청에 들어 있으면 위 «대기 요청»에서 결제한다(서버도 막는다)
      payLabel: u.hasOpenRequest ? "요청 대기 중" : "결제하기",
      disabled: u.hasOpenRequest,
    },
    (b) => void pay(b, () => flow.startChargeForUnpaid(u.paymentId)),
  );
}

/**
 * 미납 검색 — 학생별로 묶어 보여 준다(2026-11-17 원장: 밀린 달을 한 건씩 세 번 결제했다).
 * 같은 학생 미납이 2건 이상이면 머리줄에 «N건 합계 [전체 결제]» — POS 결제 한 번으로 받는다(최대 10건·500만원, 서버가 다시 확인).
 */
async function search(q: string): Promise<void> {
  const list = $("unpaid-list");
  lastQuery = q.trim();
  if (!lastQuery) {
    list.replaceChildren(emptyEl("이름을 한 글자 이상 넣어 주세요."));
    return;
  }
  const res = await api.searchUnpaid(lastQuery);
  if (!res.ok) {
    list.replaceChildren(emptyEl(res.message));
    return;
  }
  if (res.data.length === 0) {
    list.replaceChildren(emptyEl("미납 청구서가 없어요."));
    return;
  }
  const rows: HTMLLIElement[] = [];
  for (const g of groupUnpaidByStudent(res.data)) {
    if (g.items.length === 1) {
      rows.push(unpaidRow(g.items[0], false));
      continue;
    }
    const label = g.payable.length === 0 ? "요청 대기 중" : g.capped ? `앞 ${g.payable.length}건 결제` : "전체 결제";
    rows.push(
      rowEl(
        { who: g.studentName, what: `미납 ${g.items.length}건 · ${g.rangeText}`, amt: g.payableTotal, payLabel: label, cls: "group", disabled: g.payable.length === 0 },
        (b) => void pay(b, () => flow.startChargeForUnpaidBundle(g.payable.map((u) => u.paymentId))),
      ),
    );
    for (const u of g.items) rows.push(unpaidRow(u, true));
  }
  list.replaceChildren(...rows);
}

async function showTokenState(): Promise<void> {
  $("token-state").textContent = `저장된 POS 연결 코드: ${maskToken(await tokens.get())}`;
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
    input.value = ""; // 화면에 연결 코드가 남지 않게 바로 지운다
    if (!ok) {
      setMsg("POS 연결 코드 모양이 맞지 않아요. 사이트에서 복사한 값을 그대로 붙여 넣어 주세요.", "bad");
      return;
    }
    setMsg("POS 연결 코드를 저장했어요.", "ok");
    await showTokenState();
    await loadRequests();
  });
  $("token-clear").addEventListener("click", async () => {
    await tokens.clear();
    setMsg("POS 연결 코드를 지웠어요.");
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
  // 결제/취소 신호는 워커만 처리한다(탭까지 등록하면 주문 조회·토스트가 두 번씩 난다).
  // 납부 확정은 어차피 서버가 토스 웹훅으로 하므로 탭에서 받지 않아도 빠지는 것이 없다.
  void loadRequests();
  setInterval(() => {
    if (document.visibilityState === "visible") void loadRequests();
  }, TAB_REFRESH_MS);
}

main();
