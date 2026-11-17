// 앱 간편로그인 운영 전환(a1, 2026-11-13).
//
// 스토어 앱(웹뷰)에서 카카오·구글·애플 간편로그인을 «준비 중» 대신 실제로 쓰게 한다.
// 흐름: 앱이 /auth/native/start → 시스템 브라우저(크롬 맞춤 탭·사파리 인증창)로 로그인 →
//       서버가 앱 복귀 주소(kr.co.upturnlabs.stizdasan://auth/return)에 «1회용 code + state»만 실어 돌려보냄 →
//       앱이 code + 앱 메모리의 PKCE 비밀값을 /auth/native/consume 에 내고 웹뷰 로그인 쿠키를 받는다.
//
// 이 파일이 못박는 것:
//  1) 운영 스위치(NATIVE_AUTH_ENABLED + 암호화 키) 없이는 닫혀 있다(외부 설정 전 안전하게 꺼짐)
//  2) 운영(production)에서는 항상 운영 복귀 주소 — 개발 주소로 새지 않는다
//  3) 운영 주소로도 state 불일치·만료·재사용이 거부된다
//  4) 학원 계정이 없거나 취소하면 code 없이 «이유»만 실어 앱으로 돌려보내고 요청을 태운다
//  5) 웹 화면: 앱이 기능을 갖췄고 + 서버 스위치가 켜졌고 + 켜진 제공자가 있을 때만 앱에서 버튼, 아니면 비밀번호 안내
//  6) 서버·안드로이드·아이폰의 복귀 주소 이름이 같다
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const require = createRequire(import.meta.url);
function load(file, deps = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function("require", "exports", "process", "Buffer", js)((name) => (name in deps ? deps[name] : name.startsWith("node:") ? require(name) : (() => { throw Error(`Unexpected dependency ${name}`); })()), exports, process, Buffer);
  return exports;
}

const policy = load("src/lib/native-auth/policy.ts");
const service = load("src/lib/native-auth/service.ts", { "./policy": policy });
const KEY = Buffer.alloc(32, 9).toString("base64url");
const PROD_ENV = { NODE_ENV: "production", NATIVE_AUTH_ENABLED: "true", NATIVE_AUTH_ENCRYPTION_KEY: KEY };
const PROD_CALLBACK = "kr.co.upturnlabs.stizdasan://auth/return";
const verifier = "V".repeat(43), state = "S".repeat(43);
const session = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", authUserId: "synthetic-auth" };

// 메모리 원장(실제 SQL 의 조건을 그대로 흉내 낸다 — 상태·만료·해시 일치)
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async create(row) { rows.set(row.id, { ...row }); },
    async read(id) { return rows.get(id) ?? null; },
    async bindBrowser(id, hash, now) { const r = rows.get(id); if (!r || r.status !== "CREATED" || r.expiresAt <= now) return false; Object.assign(r, { status: "BROWSER", browserHash: hash }); return true; },
    async ready(id, browserHash, codeHash, codeExpiresAt, sealedSession, now) { const r = rows.get(id); if (!r || r.status !== "BROWSER" || r.browserHash !== browserHash || r.expiresAt <= now) return false; Object.assign(r, { status: "READY", codeHash, codeExpiresAt, sealedSession }); return true; },
    async consume(id, challenge, st, codeHash, now) { const r = rows.get(id); if (!r || r.status !== "READY" || r.challenge !== challenge || r.state !== st || r.codeHash !== codeHash || r.expiresAt <= now || r.codeExpiresAt <= now) return null; const claimed = { ...r }; Object.assign(r, { status: "CONSUMED", codeHash: null, sealedSession: null }); return claimed; },
    async cancel(id, challenge, st, now) { const r = rows.get(id); if (!r || !["CREATED", "BROWSER", "READY"].includes(r.status) || r.challenge !== challenge || r.state !== st || r.expiresAt <= now) return false; Object.assign(r, { status: "CANCELLED", codeHash: null, sealedSession: null }); return true; },
  };
}
function harness(env = PROD_ENV) {
  let clock = new Date("2026-11-13T00:00:00Z");
  const store = memoryStore();
  const config = policy.nativeConfig(env);
  const svc = service.createNativeAuthService(store, config, () => clock);
  return { svc, store, config, advance(ms) { clock = new Date(clock.getTime() + ms); } };
}
async function ready(h, platform = "android") {
  const started = await h.svc.start({ platform, provider: "kakao", codeChallenge: policy.digest(verifier), state });
  const browser = await h.svc.beginBrowser(started.flowId);
  const row = await h.svc.browserFlow(started.flowId, browser.binding);
  const callback = new URL(await h.svc.finishBrowser(row, browser.binding, session));
  return { started, browser, row, callback, proof: { flowId: started.flowId, codeVerifier: verifier, state, code: callback.searchParams.get("code") } };
}

// ── 1·2) 스위치와 복귀 주소 ─────────────────────────────────────────────
test("운영 스위치와 올바른 암호화 키가 모두 있어야 켜진다(외부 설정 전에는 꺼짐)", () => {
  assert.equal(policy.nativeAuthEnabled({}), false);
  assert.equal(policy.nativeAuthEnabled({ NATIVE_AUTH_ENABLED: "true" }), false, "키 없음");
  assert.equal(policy.nativeAuthEnabled({ NATIVE_AUTH_ENABLED: "true", NATIVE_AUTH_ENCRYPTION_KEY: "short" }), false, "키 형식 틀림");
  assert.equal(policy.nativeAuthEnabled({ NATIVE_AUTH_ENABLED: "1", NATIVE_AUTH_ENCRYPTION_KEY: KEY }), false, "정확히 true 만");
  assert.equal(policy.nativeAuthEnabled(PROD_ENV), true);
  for (const env of [{}, { ...PROD_ENV, NATIVE_AUTH_ENABLED: "false" }, { ...PROD_ENV, NATIVE_AUTH_ENCRYPTION_KEY: "x" }]) {
    assert.throws(() => policy.nativeConfig(env), (error) => error.status === 503);
  }
});

test("운영에서는 개발 스위치를 켜도 항상 운영 복귀 주소(스토어 앱 ID)다", () => {
  for (const env of [PROD_ENV, { ...PROD_ENV, NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED: "true" }, { ...PROD_ENV, NODE_ENV: "development" }]) {
    const config = policy.nativeConfig(env);
    assert.equal(config.callback("android"), PROD_CALLBACK);
    assert.equal(config.callback("ios"), PROD_CALLBACK);
    assert.equal(config.development, false);
  }
  // 개발 주소는 «개발 서버 + 개발 스위치»일 때만
  const dev = policy.nativeConfig({ ...PROD_ENV, NODE_ENV: "development", NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED: "true" });
  assert.equal(dev.callback("android"), "stiz-academy-android-dev://auth/return");
  assert.equal(policy.PRODUCTION_CALLBACK_SCHEME, "kr.co.upturnlabs.stizdasan");
});

// ── 3) 운영 주소로 도는 전체 흐름 ──────────────────────────────────────
test("운영 복귀 주소에는 flow·code·state 만 있고 토큰·세션은 없다", async () => {
  for (const platform of ["android", "ios"]) {
    const h = harness(); const r = await ready(h, platform);
    assert.equal(`${r.callback.protocol}//${r.callback.host}${r.callback.pathname}`, PROD_CALLBACK);
    assert.deepEqual([...r.callback.searchParams.keys()], ["flow", "code", "state"]);
    assert.doesNotMatch(r.callback.toString(), /synthetic|access_token|refresh_token|authUserId/);
    assert.deepEqual(await h.svc.consume(r.proof), session);
  }
});

test("state·verifier 불일치는 거부하고 정상 요청을 태우지 않는다", async () => {
  const h = harness(); const r = await ready(h);
  for (const change of [{ state: "X".repeat(43) }, { codeVerifier: "W".repeat(43) }, { code: "C".repeat(43) }, { flowId: "F".repeat(43) }]) {
    await assert.rejects(h.svc.consume({ ...r.proof, ...change }));
  }
  assert.deepEqual(await h.svc.consume(r.proof), session, "오답이 먼저 와도 정상 요청은 성공");
});

test("같은 code 는 두 번 쓸 수 없다(재사용 금지)", async () => {
  const h = harness(); const r = await ready(h);
  assert.deepEqual(await h.svc.consume(r.proof), session);
  await assert.rejects(h.svc.consume(r.proof));
  assert.equal(h.store.rows.get(r.proof.flowId).sealedSession, null, "소비 즉시 암호화 세션 삭제");
});

test("만료: code 60초·요청 5분이 지나면 거부한다", async () => {
  const h = harness(); const r = await ready(h);
  h.advance(policy.CODE_TTL_MS);
  await assert.rejects(h.svc.consume(r.proof));
  const h2 = harness();
  const s = await h2.svc.start({ platform: "android", provider: "google", codeChallenge: policy.digest(verifier), state });
  h2.advance(policy.FLOW_TTL_MS);
  await assert.rejects(h2.svc.beginBrowser(s.flowId));
  assert.equal(policy.FLOW_TTL_MS, 5 * 60_000);
});

// ── 4) 실패 이유만 실어 앱으로 돌려보내기 ──────────────────────────────
test("실패 복귀: code 없이 flow·state·이유만 싣고 요청은 바로 취소된다", async () => {
  const h = harness();
  const started = await h.svc.start({ platform: "android", provider: "kakao", codeChallenge: policy.digest(verifier), state });
  const browser = await h.svc.beginBrowser(started.flowId);
  const row = await h.svc.browserFlow(started.flowId, browser.binding);
  const back = new URL(await h.svc.failBrowser(row, "no_account"));
  assert.equal(`${back.protocol}//${back.host}${back.pathname}`, PROD_CALLBACK);
  assert.deepEqual(Object.fromEntries(back.searchParams), { flow: started.flowId, state, error: "no_account" });
  assert.equal(h.store.rows.get(started.flowId).status, "CANCELLED");
  // 모르는 이유는 «failed» 로만 나간다
  const h2 = harness();
  const s2 = await h2.svc.start({ platform: "ios", provider: "apple", codeChallenge: policy.digest(verifier), state });
  const b2 = await h2.svc.beginBrowser(s2.flowId);
  const r2 = await h2.svc.browserFlow(s2.flowId, b2.binding);
  assert.equal(new URL(await h2.svc.failBrowser(r2, "<script>")).searchParams.get("error"), "failed");
});

const next = require("next/server");
function callbackHarness({ allowed = true } = {}) {
  const h = harness();
  const server = { createServerClient: (_url, _key, options) => ({ auth: {
    async signInWithOAuth() { options.cookies.setAll([{ name: `${options.cookieOptions.name}-code-verifier`, value: "synthetic-pkce", options: {} }]); return { data: { url: "https://synthetic.supabase.co/auth/v1/authorize?provider=kakao" }, error: null }; },
    async exchangeCodeForSession() { return { data: { session: { ...session, user: { id: session.authUserId } } }, error: null }; },
    async getUser() { return { data: { user: { id: session.authUserId } }, error: null }; },
    // 가입 화면으로 넘길 때 웹 로그인 쿠키를 적는다(실제 SDK 는 sb-<ref>-auth-token 이름으로 적는다)
    async setSession(tokens) { options.cookies.setAll([{ name: "sb-synthetic-auth-token", value: `web:${tokens.access_token}`, options: { path: "/", maxAge: 3600 } }]); return { data: {}, error: null }; },
  } }) };
  const http = load("src/lib/native-auth/http.ts", { "server-only": {}, "@supabase/ssr": server, "next/server": next, "./policy": { ...policy, nativeConfig: () => h.config }, "./service": { createNativeAuthService: () => h.svc }, "./store": { postgresNativeFlowStore: {} } });
  const deps = { "next/server": next, "@/lib/native-auth/policy": policy, "@/lib/native-auth/http": http };
  const browser = load("src/app/auth/native/browser/route.ts", { ...deps, "@/lib/auth-providers": { getEnabledParentOAuthProviders: async () => ["kakao"] }, "@/lib/parent-oauth": { toSupabaseProvider: (p) => p } });
  // account.linked: 가입·연결을 마친 뒤(=resume 시점)에는 학원 계정이 있다고 바꿀 수 있게 객체로 둔다
  const account = { linked: allowed };
  const callback = load("src/app/auth/native/callback/route.ts", { ...deps, "@/lib/native-auth/store": { requireNativeAccount: async () => account.linked } });
  // 이 브라우저의 웹 로그인(가입·연결 뒤의 세션) — resume 이 읽는다
  const web = { session: { ...session, user: { id: session.authUserId } } };
  const resume = load("src/app/auth/native/resume/route.ts", { ...deps, "@/lib/native-auth/store": { requireNativeAccount: async () => account.linked },
    "@/lib/supabase/server": { createClient: async () => ({ auth: {
      async getSession() { return { data: { session: web.session }, error: null }; },
      async getUser() { return web.session ? { data: { user: { id: web.session.user.id } }, error: null } : { data: { user: null }, error: { message: "none" } }; },
    } }) } });
  return { h, browser, callback, resume, account, web };
}
async function throughBrowser(f, extra = {}, extraCookie = "") {
  const started = await f.h.svc.start({ platform: "android", provider: "kakao", codeChallenge: policy.digest(verifier), state });
  const opened = await f.browser.GET(new next.NextRequest(started.browserUrl));
  assert.equal(opened.status, 307);
  const cookies = opened.cookies.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  const url = new URL(`https://www.stiz-dasan.kr/auth/native/callback?flow=${started.flowId}&provider=kakao`);
  for (const [key, value] of Object.entries({ code: "synthetic-oauth-code", ...extra })) if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
  const finished = await f.callback.GET(new next.NextRequest(url, { headers: { cookie: [cookies, extraCookie].filter(Boolean).join("; "), "sec-fetch-site": "cross-site" } }));
  return { started, finished, cookies };
}

test("callback 라우트: 학원 계정이 없으면 앱으로 튕기지 않고 간편가입으로 이어 주며, 앱 로그인 요청은 살려 둔다(2026-11-17)", async () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.supabase.co";
  try {
    const f = callbackHarness({ allowed: false });
    const { started, finished } = await throughBrowser(f);
    assert.equal(finished.status, 307);
    const back = new URL(finished.headers.get("location"));
    // 같은 사이트의 간편가입 화면으로 — 주소에는 고정 값·제공자 이름만(flow·state·code·토큰 없음)
    assert.equal(back.toString(), "https://www.stiz-dasan.kr/signup/parent?fromApp=1&social=1&provider=kakao&next=%2Fmypage");
    assert.doesNotMatch(back.toString(), /synthetic/);
    // 요청은 취소하지 않는다 — 가입·연결이 끝나면 /auth/native/resume 이 마무리한다
    assert.equal(f.h.store.rows.get(started.flowId).status, "BROWSER");
    const set = finished.cookies.getAll();
    // PKCE 교환 쿠키는 지우고, 바인딩 쿠키(같은 브라우저 증명)는 건드리지 않는다
    assert.ok(set.filter((c) => c.name.startsWith("stiz-native-oauth-")).every((c) => c.value === ""));
    assert.ok(!set.some((c) => c.name === `stiz-native-${started.flowId}`), "바인딩 쿠키는 지우지 않는다");
    // 복귀 표식: 요청 번호만, httpOnly·5분
    const mark = set.find((c) => c.name === "stiz-native-resume");
    assert.equal(mark.value, started.flowId); assert.equal(mark.httpOnly, true); assert.equal(mark.maxAge, 300); assert.equal(mark.path, "/");
    // 웹 간편가입용 로그인 쿠키(카카오 로그인을 다시 시키지 않게)
    const web = set.filter((c) => c.name.startsWith("sb-"));
    assert.equal(web.length, 1);
    assert.equal(web[0].path, "/"); assert.equal(web[0].secure, true); assert.equal(web[0].sameSite, "lax");
    assert.equal(finished.headers.get("cache-control"), "no-store, private");
    // 이 브라우저에 이미 웹 로그인이 있으면 덮어쓰지 않는다 — 요청을 취소하고 로그인 안 된 가입 화면으로만(복귀 표식 없음)
    const g = callbackHarness({ allowed: false });
    const kept = await throughBrowser(g, {}, "sb-existing-auth-token=someone-else");
    assert.equal(kept.finished.headers.get("location"), "https://www.stiz-dasan.kr/signup/parent?fromApp=1");
    assert.equal(g.h.store.rows.get(kept.started.flowId).status, "CANCELLED");
    assert.ok(kept.finished.cookies.getAll().every((c) => !c.name.startsWith("sb-") && c.name !== "stiz-native-resume"), "기존 웹 로그인은 건드리지 않고 복귀 표식도 굽지 않는다");
  } finally { if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = saved; }
});

test("resume 라우트: 가입·연결을 마친 브라우저를 1회용 code 로 앱에 돌려보내고, 조건이 안 맞으면 안내만 한다(2026-11-17)", async () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.supabase.co";
  try {
    const resumeUrl = "https://www.stiz-dasan.kr/auth/native/resume";
    const go = (f, cookie, headers = {}) => f.resume.GET(new next.NextRequest(resumeUrl, { headers: { cookie, ...headers } }));
    const f = callbackHarness({ allowed: false });
    const { started, cookies } = await throughBrowser(f);
    const mine = `${cookies}; stiz-native-resume=${started.flowId}; sb-synthetic-auth-token=web`;
    // 아직 학원 계정이 없으면(가입을 안 마침) 앱으로 보내지 않는다 — 요청도 그대로 둔다
    const early = await go(f, mine);
    assert.equal(early.status, 200);
    assert.match(await early.text(), /앱에서 다시 로그인/);
    assert.equal(f.h.store.rows.get(started.flowId).status, "BROWSER");
    // 바인딩 쿠키가 없는 브라우저(요청을 연 브라우저가 아님)는 통과하지 못한다
    f.account.linked = true;
    const stranger = await go(f, `stiz-native-resume=${started.flowId}; sb-synthetic-auth-token=web`);
    assert.equal(stranger.status, 200);
    assert.equal(f.h.store.rows.get(started.flowId).status, "BROWSER");
    // 가입·연결을 마친 같은 브라우저 → 앱 복귀 주소로 code 만(공급자에서 이어진 이동이라 cross-site 로 표시돼도 통과)
    const done = await go(f, mine, { "sec-fetch-site": "cross-site" });
    assert.equal(done.status, 307);
    const back = new URL(done.headers.get("location"));
    assert.equal(back.protocol, "kr.co.upturnlabs.stizdasan:");
    assert.equal(back.searchParams.get("error"), null);
    assert.doesNotMatch(back.toString(), /synthetic/, "토큰은 주소에 싣지 않는다");
    assert.deepEqual(await f.h.svc.consume({ flowId: started.flowId, codeVerifier: verifier, state, code: back.searchParams.get("code") }), session);
    // 이 브라우저의 웹 로그인·복귀 표식·바인딩 쿠키를 지운다
    const cleared = done.cookies.getAll();
    for (const name of ["sb-synthetic-auth-token", "stiz-native-resume", `stiz-native-${started.flowId}`]) {
      assert.equal(cleared.find((c) => c.name === name)?.value, "", name);
    }
    // 같은 요청은 다시 쓸 수 없다
    const again = await go(f, mine);
    assert.equal(again.status, 200);
    // 로그인이 없는 브라우저
    const h2 = callbackHarness({ allowed: false });
    const second = await throughBrowser(h2);
    h2.account.linked = true; h2.web.session = null;
    assert.equal((await go(h2, `${second.cookies}; stiz-native-resume=${second.started.flowId}`)).status, 200);
    assert.equal(h2.h.store.rows.get(second.started.flowId).status, "BROWSER");
  } finally { if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = saved; }
});

test("연결 시작 표식: 계정·제공자·2분에 묶이고 위조·만료는 거부한다(2026-11-17)", () => {
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY; process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-key";
  try {
    const link = load("src/lib/account/link-start.ts", { "server-only": {} });
    const now = 1_800_000_000_000;
    const token = link.linkStartToken("auth-1", "google", now);
    assert.equal(link.isLinkStartTokenFor(token, "auth-1", "google", now + 1000), true);
    assert.equal(link.isLinkStartTokenFor(token, "auth-2", "google", now + 1000), false, "다른 계정");
    assert.equal(link.isLinkStartTokenFor(token, "auth-1", "kakao", now + 1000), false, "다른 제공자");
    assert.equal(link.isLinkStartTokenFor(token, "auth-1", "google", now + 121_000), false, "만료");
    assert.equal(link.isLinkStartTokenFor(`${now + 9_999_999}.${token.split(".")[1]}`, "auth-1", "google", now), false, "만료 시각 바꿔치기");
    for (const bad of ["", null, undefined, "x", `${now}.short`]) assert.equal(link.isLinkStartTokenFor(bad, "auth-1", "google", now), false);
    assert.equal(link.LINK_START_COOKIE_MAX_AGE, 120);
  } finally { if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; }
});

test("본인인증 하나로 통일(2026-11-17): 간편가입 화면·본인인증 확인 경로의 약속", () => {
  const client = fs.readFileSync("src/components/auth/ParentSignupClient.tsx", "utf8");
  // 간편가입 첫 화면은 본인인증 버튼 하나 — 번호를 따로 묻는 문자 인증은 «샛길»을 눌렀을 때만
  assert.match(client, /step === "phone" && !challengeToken && socialSignup && !smsFallback/);
  assert.match(client, /label="본인인증하고 계속"/);
  assert.match(client, /step === "phone" && !challengeToken && \(!socialSignup \|\| smsFallback\)/);
  const verify = fs.readFileSync("src/app/api/auth/parent-link/verify/route.ts", "utf8");
  // 포트원 재조회(VERIFIED·신선도)와 건 번호 확인이 가입 요청 발급보다 먼저다
  const checkedAt = verify.indexOf('verification.status !== "VERIFIED" || !isFreshVerification(verifiedAt)');
  const boundAt = verify.indexOf("isLinkVerificationIdFor(identityVerificationId, current.user.id)");
  const issueAt = verify.indexOf("await issueIdentityVerifiedSignup(");
  assert.ok(boundAt > 0 && checkedAt > boundAt && issueAt > checkedAt, "건 번호 확인 → 포트원 확인 → 가입 요청 발급 순서");
  // 가입 요청은 «지금 그 간편로그인 사용자»에게만 묶인다
  assert.match(verify, /pendingAuthUserId: current\.user\.id/);
  // 같은 종류의 다른 간편로그인이 이미 붙은 계정은 «연결됨»처럼 넘어가지 않고 멈춘다(가린 이메일만 보여 준다)
  assert.match(verify, /이미 다른 \$\{label\} 계정/);
  assert.match(verify, /function maskEmail\(/);
  const helper = fs.readFileSync("src/lib/parent-signup-verification.ts", "utf8");
  const fn = helper.slice(helper.indexOf("export async function issueIdentityVerifiedSignup("), helper.indexOf("export async function verifyParentSignupOtp("));
  // 로그인 수단이 있는 번호에는 가입 요청을 만들지 않는다 · 문자는 보내지 않는다
  assert.match(fn, /if \(ownership\.kind === "REGISTERED"\) throw new Error\(REGISTERED_PHONE_MESSAGE\);/);
  assert.doesNotMatch(fn, /sendAuthenticationSms/);
  assert.match(fn, /'VERIFIED'/);
});

test("callback 라우트: 카카오 화면에서 취소하면 «cancelled», 정상이면 운영 주소로 code 를 준다", async () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.supabase.co";
  try {
    const cancelled = await throughBrowser(callbackHarness(), { code: null, error: "access_denied" });
    assert.equal(new URL(cancelled.finished.headers.get("location")).searchParams.get("error"), "cancelled");
    const f = callbackHarness();
    const ok = await throughBrowser(f);
    const back = new URL(ok.finished.headers.get("location"));
    assert.equal(back.protocol, "kr.co.upturnlabs.stizdasan:");
    assert.equal(back.searchParams.get("error"), null);
    assert.deepEqual(await f.h.svc.consume({ flowId: ok.started.flowId, codeVerifier: verifier, state, code: back.searchParams.get("code") }), session);
  } finally { if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = saved; }
});

test("브라우저 화면 오류는 JSON 이 아니라 읽을 수 있는 한 줄 안내다", async () => {
  const f = callbackHarness();
  const response = await f.browser.GET(new next.NextRequest("https://www.stiz-dasan.kr/auth/native/browser?flow=bad"));
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /text\/plain/);
  assert.match(await response.text(), /앱으로 돌아가/);
});

// ── 5) 웹 화면 판정 ──────────────────────────────────────────────────
const storeApp = await loadTsModule("src/lib/storeApp.ts");
const ANDROID_NEW = "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 STIZApp/1.0.2 (android) STIZNativeLogin/1";
const IOS_NEW = "Mozilla/5.0 (iPhone) Mobile/15E148 STIZApp/1.0.2 (ios) STIZNativeLogin/1";
const ANDROID_OLD = "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 STIZApp/1.0.1 (android)";

test("앱 화면: 기능 있는 앱 + 서버 스위치 + 켜진 제공자일 때만 버튼", () => {
  const decide = (userAgent, nativeApp, providers) => storeApp.storeAppSocialLogin({ userAgent, nativeApp, providers });
  assert.equal(decide(ANDROID_NEW, true, ["kakao", "google"]), "buttons");
  assert.equal(decide(ANDROID_NEW, false, ["kakao"]), "password-only", "서버 스위치 꺼짐");
  assert.equal(decide(ANDROID_NEW, true, []), "password-only", "켜진 제공자 없음");
  assert.equal(decide(ANDROID_OLD, true, ["kakao"]), "password-only", "옛 앱(기능 없음)");
  assert.equal(decide(ANDROID_NEW, undefined, ["kakao"]), "unknown", "서버 답 전");
  assert.equal(decide(ANDROID_NEW, true, null), "unknown");
  // 아이폰은 Apple 로그인이 켜져 있어야 한다(심사지침 4.8)
  assert.equal(decide(IOS_NEW, true, ["kakao", "google"]), "password-only");
  assert.equal(decide(IOS_NEW, true, ["kakao", "apple"]), "buttons");
  // 앱 링크는 앱이 가로채는 모양 그대로(다른 값이 붙으면 앱이 막는다)
  assert.equal(storeApp.storeAppSocialLoginHref("kakao"), "/auth/oauth/kakao?intent=login");
});

test("로그인 화면 연결: 앱 버튼·비밀번호 만들기 안내·서버 스위치 응답", () => {
  const login = fs.readFileSync("src/app/login/page.tsx", "utf8");
  assert.match(login, /href=\{storeAppSocialLoginHref\(option\.provider\)\}/);
  assert.match(login, /appSocialLogin === "password-only"[\s\S]*href="\/login\/forgot"[\s\S]*문자 인증으로 비밀번호 만들기/);
  // 브라우저 쪽 기존 버튼(다음 주소·수강 인계 포함)은 그대로
  assert.match(login, /storeApp === false && visibleSocialLoginOptions\.length > 0/);
  assert.match(login, /href=\{`\/auth\/oauth\/\$\{option\.provider\}\?\$\{socialLoginQuery\}`\}/);
  const route = fs.readFileSync("src/app/api/auth/providers/route.ts", "utf8");
  assert.match(route, /\{ providers, nativeApp: nativeAuthEnabled\(\) \}/);
  const hook = fs.readFileSync("src/hooks/useEnabledOAuthProviders.ts", "utf8");
  assert.match(hook, /setNativeApp\(data\?\.nativeApp === true\)/, "정확히 true 일 때만 켠다");
});

// ── 6) 세 곳의 복귀 주소 이름이 같다 ───────────────────────────────────
test("서버·안드로이드·아이폰 복귀 주소와 실패 이유 목록이 같다", () => {
  const androidPolicy = fs.readFileSync("apps/driver-android/app/src/main/java/kr/stiz/driver/NativeAuthPolicy.java", "utf8");
  const iosPolicy = fs.readFileSync("apps/stiz-ios/STIZ/NativeAuthPolicy.swift", "utf8");
  const releaseManifest = fs.readFileSync("apps/driver-android/app/src/release/AndroidManifest.xml", "utf8");
  const debugManifest = fs.readFileSync("apps/driver-android/app/src/debug/AndroidManifest.xml", "utf8");
  assert.match(androidPolicy, /RELEASE_CALLBACK_SCHEME = "kr\.co\.upturnlabs\.stizdasan"/);
  assert.match(iosPolicy, /releaseCallbackScheme = "kr\.co\.upturnlabs\.stizdasan"/);
  assert.match(releaseManifest, /android:name="\.NativeAuthReturnActivity"[\s\S]*android:scheme="kr\.co\.upturnlabs\.stizdasan" android:host="auth" android:path="\/return"/);
  assert.doesNotMatch(releaseManifest, /stiz-academy-android-dev/);
  assert.doesNotMatch(debugManifest, /android:scheme="kr\.co\.upturnlabs\.stizdasan"/);
  for (const reason of service.NATIVE_BROWSER_FAILURES) {
    assert.ok(androidPolicy.includes(`"${reason}"`), `android ${reason}`);
    assert.ok(iosPolicy.includes(`"${reason}"`), `ios ${reason}`);
  }
  // 앱은 기능이 켜진 빌드만 사용자 에이전트 표식을 붙인다 — 웹 판정과 같은 글자
  assert.equal(storeApp.NATIVE_LOGIN_USER_AGENT_MARK, " STIZNativeLogin/1");
  assert.match(fs.readFileSync("apps/driver-android/app/src/main/java/kr/stiz/driver/MainActivity.java", "utf8"), /NativeAuthController\.enabled\(\) \? " STIZNativeLogin\/1" : ""/);
  assert.match(fs.readFileSync("apps/stiz-ios/STIZ/WebViewController.swift", "utf8"), /NativeAuthCoordinator\.enabled \? " STIZNativeLogin\/1" : ""/);
});

test("원장 표 마이그레이션은 RLS 를 켜고 공개 역할 권한을 회수하며, 매일 정리된다", () => {
  const sql = fs.readFileSync("prisma/migrations/20261114000000_native_auth_flow/migration.sql", "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."NativeAuthFlow"/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  for (const role of ["PUBLIC", "anon", "authenticated"]) assert.match(sql, new RegExp(`REVOKE ALL ON public\\."NativeAuthFlow" FROM ${role}`));
  assert.doesNotMatch(sql, /SECURITY DEFINER|CREATE POLICY|DROP /);
  assert.match(fs.readFileSync("prisma/schema.prisma", "utf8"), /model NativeAuthFlow \{/);
  assert.match(fs.readFileSync("src/lib/dataRetention.ts", "utf8"), /DELETE FROM "NativeAuthFlow" WHERE "expiresAt" < NOW\(\)-INTERVAL '1 day'/);
});
