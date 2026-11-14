// 학부모 화면 «뒤로»(2026-11-14) + 리포트 화면 일시 오류 막기.
//  A. 뒤로가 늘 홈으로 가던 문제: Next.js 는 history.state.idx 를 안 넣고 referrer 는 화면 안 이동에서 안 바뀐다
//     → 탭마다 이동 기록(inAppHistory)을 남겨 «돌아갈 곳이 있나»를 판단한다.
//  B. 서버 요청 하나의 순간 끊김(fetch failed / other side closed)으로 화면 전체가 오류가 된 문제
//     → 바깥 요청 시간 제한+재시도 1회 · 보조 조회 기본값 · 오류 화면 자동 1회 재시도.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const hist = await loadTsModule("src/lib/navigation/inAppHistory.ts");
const { resolveBackAction } = await loadTsModule("src/lib/navigation/backAction.ts");
const resilience = await loadTsModule("src/lib/net/resilience.ts");
const autoRetry = await loadTsModule("src/lib/mypage/errorAutoRetry.ts");
const read = (p) => readFile(p, "utf8");

/** 주소들을 차례로 지나간 뒤의 기록 */
const walk = (...entries) => entries.reduce((stack, e) => hist.nextInAppHistory(stack, e), []);

// ── A-1. 기록 규칙 ──────────────────────────────────────────────────────────

test("새 화면은 쌓고, 바로 앞 화면으로 돌아오면 하나 뺀다", () => {
  assert.deepEqual(walk("/mypage", "/mypage/reports", "/mypage/reports/s1"), ["/mypage", "/mypage/reports", "/mypage/reports/s1"]);
  assert.deepEqual(walk("/mypage", "/mypage/reports", "/mypage/reports/s1", "/mypage/reports"), ["/mypage", "/mypage/reports"], "뒤로 = pop");
  assert.deepEqual(walk("/mypage", "/mypage/reports", "/mypage"), ["/mypage"], "두 번 뒤로 가면 첫 화면만");
});

test("같은 주소(새로고침)는 그대로, 같은 화면에서 쿼리만 바뀌면 맨 끝을 바꿔 끼운다", () => {
  assert.deepEqual(walk("/mypage", "/mypage/news", "/mypage/news"), ["/mypage", "/mypage/news"]);
  assert.deepEqual(walk("/mypage", "/mypage/news", "/mypage/news?page=2", "/mypage/news?page=3"), ["/mypage", "/mypage/news?page=3"]);
  // 쪽 넘김 뒤 뒤로(쿼리 다른 같은 화면) → 바꿔 끼우고, 한 번 더 뒤로 → 홈으로 pop
  assert.deepEqual(walk("/mypage", "/mypage/news?page=2", "/mypage/news?page=1", "/mypage"), ["/mypage"]);
  // 앞 화면이 쿼리가 달라도 같은 경로면 돌아온 것으로 본다(기록을 «짧게» 보는 쪽 — 죽은 버튼 방지)
  assert.deepEqual(walk("/mypage/history?month=3", "/mypage/annual", "/mypage/history?month=5"), ["/mypage/history?month=5"]);
});

test("기록은 최대 30개 — 오래된 것부터 버린다", () => {
  const many = Array.from({ length: 40 }, (_, i) => `/mypage/news/${i}`);
  const stack = walk(...many);
  assert.equal(stack.length, hist.IN_APP_HISTORY_MAX);
  assert.equal(stack[0], "/mypage/news/10");
  assert.equal(stack.at(-1), "/mypage/news/39");
});

test("entryOf·pathOf — 해시는 빼고 쿼리는 남긴다", () => {
  assert.equal(hist.entryOf("/mypage/news", "page=2"), "/mypage/news?page=2");
  assert.equal(hist.entryOf("/mypage/news", "?page=2"), "/mypage/news?page=2");
  assert.equal(hist.entryOf("/mypage", ""), "/mypage");
  assert.equal(hist.pathOf("/mypage/reports?x=1#news-notices"), "/mypage/reports");
});

test("hasInAppHistory — 맨 끝이 지금 화면이 아니면 판단 보류(null)", () => {
  assert.equal(hist.hasInAppHistory([], "/mypage"), null);
  assert.equal(hist.hasInAppHistory(["/mypage"], "/mypage"), false);
  assert.equal(hist.hasInAppHistory(["/mypage", "/mypage/settings"], "/mypage/settings"), true);
  assert.equal(hist.hasInAppHistory(["/mypage", "/mypage/news?page=2"], "/mypage/news"), true, "쿼리는 무시하고 경로로 본다");
  assert.equal(hist.hasInAppHistory(["/mypage"], "/mypage/settings"), null, "아직 이 화면을 기록하기 전");
});

test("저장 값이 깨져 있어도 throw 하지 않고 빈 기록", () => {
  assert.deepEqual(hist.parseInAppHistory(null), []);
  assert.deepEqual(hist.parseInAppHistory("{not json"), []);
  assert.deepEqual(hist.parseInAppHistory('{"a":1}'), []);
  assert.deepEqual(hist.parseInAppHistory('["/mypage", 3, "http://evil.example", "/mypage/news"]'), ["/mypage", "/mypage/news"]);
});

// ── A-2. 브라우저 저장·판단(가짜 window) ─────────────────────────────────────

function fakeWindow({ historyLength = 2, storageThrows = false } = {}) {
  const data = new Map();
  const storage = {
    getItem: (k) => { if (storageThrows) throw new Error("blocked"); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error("blocked"); data.set(k, String(v)); },
  };
  globalThis.window = { sessionStorage: storage, history: { length: historyLength } };
  hist.resetPageLoadStateForTest(); // 새 페이지를 불러온 직후로(첫 기록 판정은 document 가 없어 건너뜀)
  return { data };
}

test("parentHistoryDecision — 학부모 화면만, 기록 2칸 이상 + 브라우저 기록 2칸 이상일 때 true", () => {
  try {
    fakeWindow();
    assert.equal(hist.parentHistoryDecision("/staff/students"), null, "선생님 화면은 판단하지 않는다(옛 방식 그대로)");
    assert.equal(hist.parentHistoryDecision("/notices"), null, "공개 사이트도 그대로");
    assert.equal(hist.parentHistoryDecision("/mypagex"), null, "비슷한 이름의 다른 경로");
    hist.recordInAppNavigation("/mypage");
    assert.equal(hist.parentHistoryDecision("/mypage"), false, "앱 첫 화면 — 기록 없음");
    hist.recordInAppNavigation("/mypage/reports");
    hist.recordInAppNavigation("/mypage/reports/s1");
    assert.equal(hist.parentHistoryDecision("/mypage/reports/s1"), true);
    assert.equal(hist.parentHistoryDecision("/mypage/settings"), null, "기록 전 화면은 보류");

    // 새 탭으로 열려 sessionStorage 가 복사된 경우 — 브라우저 기록은 1칸이라 back 하면 안 된다
    fakeWindow({ historyLength: 1 });
    hist.recordInAppNavigation("/mypage");
    hist.recordInAppNavigation("/mypage/news");
    assert.equal(hist.parentHistoryDecision("/mypage/news"), false);
  } finally {
    delete globalThis.window;
  }
});

test("sessionStorage 가 막힌 브라우저에서도 throw 하지 않고 메모리로 기억한다", () => {
  try {
    fakeWindow({ storageThrows: true });
    assert.doesNotThrow(() => hist.recordInAppNavigation("/mypage"));
    hist.recordInAppNavigation("/mypage/apply");
    assert.equal(hist.parentHistoryDecision("/mypage/apply"), true);
  } finally {
    delete globalThis.window;
  }
});

test("기록이 바뀌면 구독자에게 알린다(뒤로 버튼 다시 그리기)", () => {
  try {
    fakeWindow();
    let calls = 0;
    const before = hist.inAppHistoryVersion();
    const off = hist.subscribeInAppHistory(() => { calls += 1; });
    hist.recordInAppNavigation("/mypage/x");
    off();
    hist.recordInAppNavigation("/mypage/y");
    assert.equal(calls, 1);
    assert.equal(hist.inAppHistoryVersion(), before + 2);
  } finally {
    delete globalThis.window;
  }
});

// ── A-3. resolveBackAction 과 합친 결과 ──────────────────────────────────────

test("설치된 앱: 학부모 화면 안에서 이동했으면 이전 화면으로, 바로 열었으면 /mypage 로", () => {
  const input = (stack, pathname) => ({
    hasHistory: hist.hasInAppHistory(stack, pathname) === true,
    pathname,
    fallbackHref: "/",
    scopeHref: "/mypage",
    isInstalledApp: true,
  });
  const stack = walk("/mypage", "/mypage/reports", "/mypage/reports/s1");
  assert.deepEqual(resolveBackAction(input(stack, "/mypage/reports/s1")), { type: "back" }, "예전엔 여기서 /mypage 로 push 됐다");
  assert.deepEqual(resolveBackAction(input(walk("/mypage/reports/s1"), "/mypage/reports/s1")), { type: "push", href: "/mypage" });
  assert.deepEqual(resolveBackAction(input(walk("/mypage"), "/mypage")), { type: "none" });
});

test("브라우저: 기록 있으면 back, 없으면 기존 fallback", () => {
  const stack = walk("/mypage", "/mypage/settings");
  assert.deepEqual(
    resolveBackAction({ hasHistory: hist.hasInAppHistory(stack, "/mypage/settings") === true, pathname: "/mypage/settings", fallbackHref: "/", scopeHref: "/mypage", isInstalledApp: false }),
    { type: "back" },
  );
  assert.deepEqual(
    resolveBackAction({ hasHistory: false, pathname: "/mypage/settings", fallbackHref: "/", scopeHref: "/mypage", isInstalledApp: false }),
    { type: "push", href: "/" },
  );
});

// ── A-4. 소스 검사: 머리줄 버튼·페이지 안 «←» ─────────────────────────────────

const BACK_LINK_FILES = {
  "src/app/mypage/annual/page.tsx": "/mypage/history",
  "src/app/mypage/apply/page.tsx": "/mypage",
  "src/app/mypage/login-methods/page.tsx": "/mypage",
  "src/app/mypage/makeup/MakeupClient.tsx": "/mypage",
  "src/app/mypage/news/page.tsx": "/mypage/reports#news-notices",
  "src/app/mypage/news/[id]/page.tsx": "/mypage/reports#news-notices",
  "src/app/mypage/regular-absence/RegularAbsenceClient.tsx": "/mypage",
  "src/app/mypage/reports/[sessionId]/page.tsx": "/mypage/reports",
  "src/app/mypage/requests/page.tsx": "/mypage",
  "src/app/mypage/requests/[id]/page.tsx": "/mypage/requests",
  "src/app/mypage/roles/RolesClient.tsx": "/mypage",
  "src/app/mypage/settings/page.tsx": "/mypage",
  "src/app/mypage/withdraw/WithdrawClient.tsx": null, // backHref 변수
  "src/components/parent/ParentEmbeddedPublic.tsx": null, // backHref 변수
};

test("학부모 하위 화면 14곳의 «←» 는 고정 Link 가 아니라 ParentBackLink(기록 우선, 없으면 예전 주소)", async () => {
  assert.equal(Object.keys(BACK_LINK_FILES).length, 14);
  for (const [file, fallback] of Object.entries(BACK_LINK_FILES)) {
    const src = await read(file);
    assert.match(src, /<ParentBackLink\b/, `${file}: ParentBackLink 사용`);
    assert.doesNotMatch(src, /<Link[^>]*academy-back-link/, `${file}: 고정 주소 «←» Link 가 남아 있다`);
    if (fallback) assert.ok(src.includes(`fallbackHref="${fallback}"`), `${file}: 예전 주소(${fallback})를 fallback 으로 유지`);
  }
});

test("ParentBackLink — 기록 있으면 한 칸 뒤로, 새 탭 클릭은 기본 동작, 겉은 Link·글자 «←»", async () => {
  const src = await read("src/components/parent/ParentBackLink.tsx");
  assert.match(src, /parentHistoryDecision\(window\.location\.pathname\) === true/);
  assert.match(src, /event\.preventDefault\(\);\s*window\.history\.back\(\)/);
  // 훅을 쓰지 않는다 — 서버 화면 안에 그대로 넣고, 렌더 검사에서도 그려진다
  assert.doesNotMatch(src, /useRouter|usePathname/);
  assert.match(src, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(src, /<Link href=\{fallbackHref\}/);
  assert.match(src, /academy-back-link/);
  assert.match(src, /<span aria-hidden="true">←<\/span>/);
});

test("학부모 layout 에 기록 부품이 마운트되고, 공통 뒤로 버튼이 그 기록을 먼저 본다", async () => {
  const layout = await read("src/app/mypage/layout.tsx");
  assert.match(layout, /<Suspense fallback=\{null\}>\s*<ParentHistoryTracker \/>/);
  const button = await read("src/components/AppBackButton.tsx");
  assert.match(button, /parentHistoryDecision\(pathname\)/);
  // 학부모 범위에서 «기록 없음»이면 설치 여부와 관계없이(스토어 앱 포함) referrer·idx 로 넘어가지 않는다
  assert.ok(button.includes("if (parentDecision !== null) return parentDecision;"));
  assert.doesNotMatch(button, /parentDecision === false && isInstalledApp/);
  assert.match(button, /useSyncExternalStore\(subscribeInAppHistory/);
  // 공개 사이트 기록 판단은 그대로 남아 있다
  assert.match(button, /hasSameOriginPreviousEntry/);
});

// ── B-1. 바깥 요청: 시간 제한 + 재시도 1회 ────────────────────────────────────

const ok = () => new Response("ok", { status: 200 });

test("fetchWithRetry — 연결 끊김 한 번은 다시 시도해 성공한다(매 시도 새 시간 제한)", async () => {
  const signals = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    signals.push(init.signal);
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    return ok();
  };
  const res = await resilience.fetchWithRetry("https://example.test/a", { next: { revalidate: 300 } }, { fetchImpl, retryDelayMs: 0 });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.ok(signals.every((s) => s instanceof AbortSignal) && signals[0] !== signals[1], "시도마다 새 시간 제한");
});

test("fetchWithRetry — 두 번 다 실패하면 원래 오류를 던진다(부르는 쪽 기본값 처리 그대로), 재시도는 1회뿐", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new TypeError("fetch failed"); };
  await assert.rejects(resilience.fetchWithRetry("https://example.test/b", {}, { fetchImpl, retryDelayMs: 0 }), /fetch failed/);
  assert.equal(calls, 2);
});

test("fetchWithRetry — 응답을 받은 경우(500 포함)는 다시 시도하지 않는다", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("x", { status: 500 }); };
  const res = await resilience.fetchWithRetry("https://example.test/c", {}, { fetchImpl, retryDelayMs: 0 });
  assert.equal(res.status, 500);
  assert.equal(calls, 1);
});

test("fetchWithRetry — 응답이 안 오면 시간 제한으로 끊고 다시 시도한다", async () => {
  let calls = 0;
  const fetchImpl = (_url, init) => {
    calls += 1;
    if (calls === 2) return Promise.resolve(ok());
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const started = Date.now();
  const res = await resilience.fetchWithRetry("https://example.test/d", {}, { fetchImpl, timeoutMs: 50, retryDelayMs: 0 });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 2_000);
});

test("구글 시트 요청은 fetchWithRetry 를 쓴다(맨 fetch 금지)", async () => {
  const sheet = await read("src/lib/googleSheetsSchedule.ts");
  assert.equal((sheet.match(/await fetchWithRetry\(/g) || []).length, 3);
  assert.doesNotMatch(sheet, /await fetch\(/);
});

// ── B-2. 보조 조회 기본값 ─────────────────────────────────────────────────────

test("withFallback — 실패하면 기본값 + 단계 기록, 이동 신호(redirect 등)는 다시 던진다", async () => {
  const logs = [];
  const value = await resilience.withFallback("리포트 상세: 사진", async () => { throw new TypeError("fetch failed"); }, "기본", { log: (m) => logs.push(m) });
  assert.equal(value, "기본");
  assert.match(logs[0], /리포트 상세: 사진/);
  const redirectSignal = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
  await assert.rejects(
    resilience.withFallback("x", async () => { throw redirectSignal; }, null, { rethrow: (e) => { if (e?.digest?.startsWith("NEXT_")) throw e; }, log: () => {} }),
    /NEXT_REDIRECT/,
  );
  assert.equal(await resilience.withFallback("x", async () => 7, 0), 7);
});

test("리포트 상세: 권한 판정은 감싸지 않고, 보조 조회 4개만 loadOrDefault", async () => {
  const src = await read("src/app/mypage/reports/[sessionId]/page.tsx");
  assert.match(src, /const viewable = await loadParentViewableSession\(parentId, sessionId\);\s*if \(!viewable\) notFound\(\);/);
  assert.doesNotMatch(src, /loadOrDefault\([^)]*loadParentViewableSession/);
  assert.equal((src.match(/loadOrDefault\("리포트 상세: /g) || []).length, 4);
  const helper = await read("src/lib/server/loadOrDefault.ts");
  assert.match(helper, /unstable_rethrow/);
});

// ── B-3. 오류 화면 자동 1회 재시도 ────────────────────────────────────────────

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("claimAutoRetry — 같은 화면은 1분 안에 한 번만, 다른 화면·1분 뒤는 다시 허락", () => {
  const s = memStorage();
  const t = 1_000_000;
  assert.equal(autoRetry.claimAutoRetry(s, "/mypage/reports/a", t), true);
  assert.equal(autoRetry.claimAutoRetry(s, "/mypage/reports/a", t + 1_500), false, "자동 재시도 뒤 또 실패 → 안내 화면");
  assert.equal(autoRetry.claimAutoRetry(s, "/mypage/reports/b", t + 1_500), true, "다른 화면은 따로");
  assert.equal(autoRetry.claimAutoRetry(s, "/mypage/reports/a", t + autoRetry.AUTO_RETRY_WINDOW_MS + 1), true);
});

test("claimAutoRetry — 저장이 막혀도 메모리로 1회 제한(무한 반복 없음)", () => {
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(autoRetry.claimAutoRetry(blocked, "/mypage/blocked", 5_000), true);
  assert.equal(autoRetry.claimAutoRetry(blocked, "/mypage/blocked", 5_500), false);
  assert.equal(autoRetry.claimAutoRetry(null, "/mypage/null", 1), true);
  assert.equal(autoRetry.claimAutoRetry(null, "/mypage/null", 2), false);
});

test("error.tsx — 1초 뒤 자동 refresh+reset 1회, 판정은 claimAutoRetry, 오류 원문은 화면에 없다", async () => {
  const src = await read("src/app/mypage/error.tsx");
  assert.equal(autoRetry.AUTO_RETRY_DELAY_MS, 1_000);
  assert.match(src, /claimAutoRetry\(storage, pathname, Date\.now\(\)\)/);
  assert.match(src, /setTimeout\([\s\S]*router\.refresh\(\);[\s\S]*reset\(\);[\s\S]*retry \? AUTO_RETRY_DELAY_MS : 0\)/);
  // 판정은 오류마다 한 번(같은 오류로 효과가 다시 돌아도 다시 소모하지 않는다)
  assert.match(src, /if \(decided\.current\?\.error !== error\)/);
  assert.match(src, /clearTimeout\(timer\)/);
  assert.match(src, /다시 불러오는 중/);
  // 화면(JSX)에 오류 원문을 그리지 않는다 — 확인 번호(digest)만
  assert.doesNotMatch(src, /\{error\.message\}|\{String\(error\)\}|\{error\.stack\}/);
  // 효과가 router·reset 바뀜으로 다시 돌아 1회 판정을 소모하지 않게
  assert.match(src, /\}, \[error, pathname\]\);/);
});

// ── A-5. 학부모 화면 밖을 거쳐 들어온 경우(2026-11-14 검수 [높음]) ─────────────────

const ORIGIN = "https://stiz.example";
const env = (referrer, historyLength = 5) => ({ referrer, origin: ORIGIN, historyLength });
function seeded(stack) {
  const store = memStorage();
  store.setItem(hist.IN_APP_HISTORY_KEY, JSON.stringify(stack));
  hist.resetPageLoadStateForTest();
  return store;
}

test("shouldRestartOnPageLoad — 바깥·빈 앞 주소·기록 1칸이면 새로 시작, 학부모 화면 앞 주소·새로고침은 이어 간다", () => {
  const stack = ["/mypage", "/mypage/payments/checkout"];
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage/payments/done", env("https://pay.toss.example/redirect")), true, "결제창(다른 사이트)");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage/payments/done", env("")), true, "앞 주소 없음(redirect 가 referrer 를 지움)");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage", env(ORIGIN + "/login?next=/mypage")), true, "같은 사이트지만 /mypage 밖(로그인)");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage", env(ORIGIN + "/")), true, "공개 홈페이지");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage", env(ORIGIN + "/mypagex")), true, "비슷한 이름의 다른 경로");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage/history", env(ORIGIN + "/mypage")), false, "학부모 화면 안에서 전체 새로 불러오기");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage/payments/checkout", env("https://pay.toss.example/")), false, "새로고침(맨 끝 = 지금 주소)");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage/payments/checkout", env(ORIGIN + "/mypage", 1)), true, "브라우저 기록 1칸이면 새로고침이라도 새로");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/mypage/x", env("not a url")), true);
});

test("결제 완료(/mypage/payments/done)로 돌아오면 «←»는 결제창이 아니라 고정 주소로", () => {
  const store = seeded(["/mypage", "/mypage/payments", "/mypage/payments/checkout"]);
  const stack = hist.recordInAppNavigation("/mypage/payments/done", store, env("https://pay.toss.example/v1/redirect"));
  assert.deepEqual(stack, ["/mypage/payments/done"]);
  assert.equal(hist.hasInAppHistory(stack, "/mypage/payments/done"), false);
  const action = (isInstalledApp) => resolveBackAction({ hasHistory: false, pathname: "/mypage/payments/done", fallbackHref: "/", scopeHref: "/mypage", isInstalledApp });
  assert.deepEqual(action(true), { type: "push", href: "/mypage" });
  assert.deepEqual(action(false), { type: "push", href: "/" }, "브라우저는 기존 fallback(머리줄 버튼) — 결제창으로 back 하지 않는다");
  // 결제 완료 화면 안에서 다시 이동하면 그때부터 정상적으로 쌓인다(첫 기록만 새로 시작)
  assert.deepEqual(hist.recordInAppNavigation("/mypage/payments", store, env("https://pay.toss.example/v1/redirect")), ["/mypage/payments/done", "/mypage/payments"]);
});

test("로그인·공개 홈페이지를 거쳐 들어와도 예전 기록을 이어 붙이지 않는다", () => {
  for (const referrer of [ORIGIN + "/login?next=%2Fmypage%2Fsettings", ORIGIN + "/", "https://pf.kakao.example/x"]) {
    const store = seeded(["/mypage", "/mypage/news", "/mypage/news/1"]);
    assert.deepEqual(hist.recordInAppNavigation("/mypage/settings", store, env(referrer)), ["/mypage/settings"], referrer);
  }
});

test("새 탭(sessionStorage 복사·브라우저 기록 1칸) — 기록이 새로 시작돼 «←»가 죽은 버튼이 되지 않는다", () => {
  try {
    fakeWindow({ historyLength: 1 });
    const store = window.sessionStorage;
    store.setItem(hist.IN_APP_HISTORY_KEY, JSON.stringify(["/mypage", "/mypage/news"]));
    const stack = hist.recordInAppNavigation("/mypage/news/7", store, env(ORIGIN + "/mypage/news", 1));
    assert.deepEqual(stack, ["/mypage/news/7"]);
    assert.equal(hist.parentHistoryDecision("/mypage/news/7"), false, "back 대신 고정 주소(ParentBackLink 는 Link 그대로 이동)");
  } finally {
    delete globalThis.window;
  }
});

test("학부모 화면 안 전체 새로 불러오기·새로고침은 기록을 이어 간다", () => {
  let store = seeded(["/mypage", "/mypage/news"]);
  assert.deepEqual(hist.recordInAppNavigation("/mypage/news/2", store, env(ORIGIN + "/mypage/news")), ["/mypage", "/mypage/news", "/mypage/news/2"]);
  store = seeded(["/mypage", "/mypage/news"]);
  assert.deepEqual(hist.recordInAppNavigation("/mypage/news", store, env("")), ["/mypage", "/mypage/news"], "새로고침");
});

test("location.replace(옛 홈 칸 주소 넘기기)는 쌓지 않고 바꿔 끼운다", async () => {
  const store = seeded(["/mypage/settings", "/mypage"]);
  hist.markNextNavigationAsReplace(store);
  hist.resetPageLoadStateForTest(); // 새 페이지가 열린 직후(메모리 표시는 사라지고 저장소 표시만 남는다)
  assert.deepEqual(hist.recordInAppNavigation("/mypage/history", store, env(ORIGIN + "/mypage")), ["/mypage/settings", "/mypage/history"]);
  assert.equal(store.getItem(hist.IN_APP_REPLACE_KEY), "", "표시는 한 번 쓰면 지운다");
  const client = await read("src/app/mypage/MyPageClient.tsx");
  assert.match(client, /markNextNavigationAsReplace\(\);\s*window\.location\.replace\(moved\)/);
});

// ── B 보강(검수 [낮음]) ──────────────────────────────────────────────────────

test("fetchWithRetry — 부르는 쪽 취소 신호를 시간 제한과 합치고, 스스로 취소했으면 다시 시도하지 않는다", async () => {
  const controller = new AbortController();
  let seen;
  let calls = 0;
  const fetchImpl = (_url, init) => {
    calls += 1;
    seen = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const pending = resilience.fetchWithRetry("https://example.test/e", { signal: controller.signal }, { fetchImpl, timeoutMs: 5_000, retryDelayMs: 0 });
  controller.abort(new Error("caller-cancel"));
  await assert.rejects(pending, /caller-cancel/);
  assert.equal(calls, 1, "취소는 재시도하지 않는다");
  assert.notEqual(seen, controller.signal, "AbortSignal.any 로 합친 신호");
  assert.equal(seen.aborted, true);
});

test("canAutoRetry — 판정만 하고 기록은 남기지 않는다(오류 화면 첫 그림용)", async () => {
  const s = memStorage();
  assert.equal(autoRetry.canAutoRetry(s, "/mypage/peek", 10), true);
  assert.equal(autoRetry.canAutoRetry(s, "/mypage/peek", 20), true, "몇 번 물어도 그대로");
  assert.equal(autoRetry.claimAutoRetry(s, "/mypage/peek", 30), true);
  assert.equal(autoRetry.canAutoRetry(s, "/mypage/peek", 40), false);
  const src = await read("src/app/mypage/error.tsx");
  assert.ok(src.includes("useState(() => peekAutoRetry(pathname))"), "첫 그림부터 판정 결과대로");
});
