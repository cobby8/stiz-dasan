// 스토어 앱 네이티브 푸시(e2·d2, 2026-11-14).
//  - 토큰 등록 API: 본인(로그인에 직접 연결된 계정)에게만 저장, 본문의 userId 는 무시
//  - 발송 대상: 웹푸시 구독 + 앱 토큰, 끈 종류는 둘 다 안 보냄, 재시도는 실패한 기기만
//  - 무효 토큰(UNREGISTERED 등) 정리, FCM 키 없으면 앱 발송 조용히 건너뜀
//  - 알림 주소: 우리 사이트 경로만(앱 쪽 정책은 Java·Swift 테스트가 따로 본다)
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

const policy = load("src/lib/push/nativePushPolicy.ts");
const TOKEN_A = "fcmTokenAAAAAAAAAAAAAAAAAAAA:APA91b-abc_def";
const TOKEN_B = "fcmTokenBBBBBBBBBBBBBBBBBBBB:APA91b-xyz_123";

// ── 순수 규칙 ────────────────────────────────────────────────────────────────

test("등록 본문 검사: 플랫폼 두 가지·토큰 길이 20~4096·허용 글자만", () => {
  assert.deepEqual(policy.parseNativePushRegistration({ platform: "android", token: TOKEN_A }), { platform: "android", token: TOKEN_A });
  assert.deepEqual(policy.parseNativePushRegistration({ platform: "ios", token: TOKEN_B, userId: "남의-계정" }), { platform: "ios", token: TOKEN_B }, "userId 는 받지 않는다");
  for (const bad of [null, "x", {}, { platform: "web", token: TOKEN_A }, { platform: "android", token: "short" },
    { platform: "android", token: "a".repeat(4097) }, { platform: "android", token: `${TOKEN_A} space` },
    { platform: "android", token: `${TOKEN_A}"quote` }, { platform: "android", token: 12345678901234567890 }]) {
    assert.equal(policy.parseNativePushRegistration(bad), null, JSON.stringify(bad));
  }
  // DB CHECK 와 같은 범위
  const sql = read("prisma/migrations/20261114000000_native_push_token/migration.sql");
  assert.match(sql, new RegExp(`char_length\\(token\\) BETWEEN ${policy.NATIVE_TOKEN_MIN} AND ${policy.NATIVE_TOKEN_MAX}`));
  assert.match(sql, /platform IN \('android', 'ios'\)/);
});

test("알림 주소 허용 정책: 우리 사이트 경로만, 나머지는 기본 화면", () => {
  assert.equal(policy.safeNativePushPath("/mypage/attendance"), "/mypage/attendance");
  assert.equal(policy.safeNativePushPath("/staff/shuttle?date=2026-11-14"), "/staff/shuttle?date=2026-11-14");
  assert.equal(policy.safeNativePushPath("https://www.stiz-dasan.kr/notices/1"), "/notices/1", "우리 사이트 전체 주소는 경로로");
  assert.equal(policy.safeNativePushPath("https://www.stiz-dasan.kr"), "/");
  for (const bad of [undefined, null, "", "mypage", "https://evil.invalid/x", "//evil.invalid/x", "https://www.stiz-dasan.kr.evil.invalid/x",
    "javascript:alert(1)", "/a\\b", "/a b", "/a\nb", `/${"a".repeat(1100)}`]) {
    assert.equal(policy.safeNativePushPath(bad), "/", String(bad));
  }
  assert.equal(policy.safeNativePushPath(null, "/admin"), "/admin", "기본값을 바꿀 수 있다");
});

test("재시도 id 나누기: 웹 id 그대로, 앱 토큰은 native: 머리글", () => {
  assert.deepEqual(policy.splitRetryIds(undefined), { web: null, native: null });
  assert.deepEqual(policy.splitRetryIds([]), { web: null, native: null });
  assert.deepEqual(policy.splitRetryIds(["w1", "native:t1", "w2"]), { web: ["w1", "w2"], native: ["t1"] });
  assert.deepEqual(policy.splitRetryIds(["native:t1"]), { web: [], native: ["t1"] });
});

// ── FCM 발송 모듈 ────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const ACCOUNT_JSON = JSON.stringify({ type: "service_account", project_id: "stiz-synthetic", client_email: "push@stiz-synthetic.iam.gserviceaccount.com", private_key: PEM });

test("서비스 계정: JSON 원문·base64·한 줄(\\n 글자) 모두 읽고, 칸이 빠지면 null", () => {
  const fcm = load("src/lib/push/fcm.ts", { "@/lib/push/nativePushPolicy": policy });
  assert.equal(fcm.FCM_ENV_NAME, "FCM_SERVICE_ACCOUNT_JSON");
  const raw = fcm.parseServiceAccount(ACCOUNT_JSON);
  assert.equal(raw.projectId, "stiz-synthetic");
  assert.equal(fcm.parseServiceAccount(Buffer.from(ACCOUNT_JSON).toString("base64")).clientEmail, raw.clientEmail);
  const oneLine = JSON.stringify({ project_id: "p", client_email: "e@x", private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n" });
  assert.match(fcm.parseServiceAccount(oneLine).privateKey, /KEY-----\nabc\n-----END/);
  for (const bad of [undefined, "", "not-json", "{}", JSON.stringify({ project_id: "p", client_email: "e" }), JSON.stringify({ project_id: "p", client_email: "e", private_key: "nope" })]) {
    assert.equal(fcm.parseServiceAccount(bad), null, String(bad));
  }
  // 환경변수가 없으면 앱 발송 꺼짐
  const before = process.env.FCM_SERVICE_ACCOUNT_JSON;
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  assert.equal(fcm.fcmServiceAccount(), null);
  if (before !== undefined) process.env.FCM_SERVICE_ACCOUNT_JSON = before;
});

test("FCM 메시지: 안드로이드는 데이터만(앱이 그림), 아이폰은 APNs 알림, 주소는 경로로 정리", () => {
  const fcm = load("src/lib/push/fcm.ts", { "@/lib/push/nativePushPolicy": policy });
  const android = fcm.buildFcmMessage("android", TOKEN_A, { title: "출결", body: "도착했어요", url: "https://evil.invalid/x", tag: "ATTENDANCE" });
  assert.deepEqual(android.message.data, { title: "출결", body: "도착했어요", url: "/", tag: "ATTENDANCE" });
  assert.equal(android.message.notification, undefined, "안드로이드는 notification 없이 data 만");
  assert.equal(android.message.android.priority, "HIGH");
  const ios = fcm.buildFcmMessage("ios", TOKEN_B, { title: "공지", body: "내일 휴강", url: "/notices/3" });
  assert.deepEqual(ios.message.apns.payload.aps.alert, { title: "공지", body: "내일 휴강" });
  assert.deepEqual(ios.message.data, { url: "/notices/3", tag: "" });
  assert.equal(ios.message.token, TOKEN_B);
});

test("FCM 오류 분류: 죽은 토큰만 지우고 일시 오류·인증 오류는 지우지 않는다", () => {
  const fcm = load("src/lib/push/fcm.ts", { "@/lib/push/nativePushPolicy": policy });
  const body = (status, errorCode, message = "") => JSON.stringify({ error: { status, message, details: errorCode ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] : [] } });
  assert.equal(fcm.classifyFcmError(404, body("NOT_FOUND", "UNREGISTERED")).kind, "invalid-token");
  assert.equal(fcm.classifyFcmError(404, "").kind, "invalid-token");
  assert.equal(fcm.classifyFcmError(403, body("PERMISSION_DENIED", "SENDER_ID_MISMATCH")).kind, "invalid-token");
  assert.equal(fcm.classifyFcmError(400, body("INVALID_ARGUMENT", "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token")).kind, "invalid-token");
  assert.equal(fcm.classifyFcmError(400, body("INVALID_ARGUMENT", "INVALID_ARGUMENT", "Invalid JSON payload")).kind, "failed", "메시지 형식 오류는 토큰 잘못이 아니다");
  assert.deepEqual(fcm.classifyFcmError(429, body("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED")), { kind: "failed", code: "FCM_QUOTA_EXCEEDED" });
  assert.equal(fcm.classifyFcmError(503, "<html>").kind, "failed");
  assert.equal(fcm.classifyFcmError(401, body("UNAUTHENTICATED", "THIRD_PARTY_AUTH_ERROR")).kind, "failed");
});

test("FCM 발송: 서비스 계정으로 서명한 JWT 로 접근 토큰을 받고(1시간 재사용), v1 주소로 보낸다", async () => {
  const fcm = load("src/lib/push/fcm.ts", { "@/lib/push/nativePushPolicy": policy });
  fcm.resetFcmAccessTokenCache();
  const account = fcm.parseServiceAccount(ACCOUNT_JSON);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "ya29.synthetic", expires_in: 3600 }) };
    if (init.body.includes(TOKEN_B)) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }) };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const now = () => 1_800_000_000_000;
  assert.deepEqual(await fcm.sendFcm(account, "android", TOKEN_A, { title: "t", body: "b" }, { fetch, now }), { kind: "sent" });
  assert.deepEqual(await fcm.sendFcm(account, "ios", TOKEN_B, { title: "t", body: "b" }, { fetch, now }), { kind: "invalid-token", code: "UNREGISTERED" });
  const auth = calls.filter((c) => c.url.includes("oauth2"));
  assert.equal(auth.length, 1, "접근 토큰은 한 번만 받는다");
  // JWT 서명이 서비스 계정 키로 맞게 됐는지 공개키로 확인
  const assertion = decodeURIComponent(auth[0].init.body.split("assertion=")[1]);
  const [h, c, sig] = assertion.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${c}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")));
  const claims = JSON.parse(Buffer.from(c.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.iss, "push@stiz-synthetic.iam.gserviceaccount.com");
  const send = calls.find((x) => x.url.includes("fcm.googleapis.com"));
  assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/stiz-synthetic/messages:send");
  assert.equal(send.init.headers.Authorization, "Bearer ya29.synthetic");
  // 네트워크가 죽어도 throw 하지 않고 failed
  fcm.resetFcmAccessTokenCache();
  assert.equal((await fcm.sendFcm(account, "android", TOKEN_A, { title: "t", body: "b" }, { fetch: async () => { throw new Error("NET_DOWN"); }, now })).kind, "failed");
});

// ── 발송 함수(sendPushToUser·sendPushToAllParents) ───────────────────────────

/** 대역 DB·FCM 으로 발송 모듈을 불러온다 */
function loadSender({ vapid = false, fcm = true, web = [], native = [], fcmResult = () => ({ kind: "sent" }), optedOut = new Set() } = {}) {
  if (vapid) { process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv"; }
  else { delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
  const log = { webQueries: [], nativeLookups: [], fcmSends: [], deletedNative: [], webSent: [] };
  const mod = load("src/lib/pushNotification.ts", {
    "web-push": { __esModule: true, default: { setVapidDetails() {}, sendNotification: async (sub) => { log.webSent.push(sub.endpoint); } } },
    "@/lib/prisma": { prisma: {
      $queryRawUnsafe: async (sql, ...params) => { log.webQueries.push({ sql, params }); return web; },
      $executeRawUnsafe: async () => 1,
    } },
    "@/lib/parent-notification-preferences": {
      isPushAllowed: async (userId) => !optedOut.has(userId),
      optedOutUserIds: async () => optedOut,
    },
    "@/lib/push/fcm": {
      fcmServiceAccount: () => (fcm ? { projectId: "p", clientEmail: "e", privateKey: "k" } : null),
      sendFcm: async (account, platform, token, payload) => { log.fcmSends.push({ platform, token, payload }); return fcmResult(token); },
    },
    "@/lib/push/nativePushStore": {
      listNativeTokensForUser: async (userId, ids) => { log.nativeLookups.push({ userId, ids }); return native.filter((r) => !ids || ids.includes(r.id)); },
      listNativeTokensForParents: async () => { log.nativeLookups.push({ parents: true }); return native; },
      deleteNativeToken: async (id) => { log.deletedNative.push(id); return true; },
    },
    "@/lib/push/nativePushPolicy": policy,
  });
  return { mod, log };
}

test("발송 대상 계산: 웹푸시 구독 + 앱 토큰을 모두 센다, 끈 종류는 둘 다 안 보낸다", async () => {
  const { mod, log } = loadSender({ vapid: true, web: [{ id: "w1", endpoint: "https://push.example/w1", p256dh: "p", auth: "a" }],
    native: [{ id: "t1", platform: "android", token: TOKEN_A }, { id: "t2", platform: "ios", token: TOKEN_B }] });
  const result = await mod.sendPushToUser("u1", { title: "출결", body: "도착", url: "/mypage", tag: "ATTENDANCE" });
  assert.equal(result.status, "SENT");
  assert.equal(result.subscriptionCount, 3);
  assert.equal(result.sentCount, 3);
  assert.deepEqual(log.webSent, ["https://push.example/w1"]);
  assert.deepEqual(log.fcmSends.map((s) => s.platform).sort(), ["android", "ios"]);
  assert.deepEqual(log.nativeLookups, [{ userId: "u1", ids: null }]);

  const off = loadSender({ vapid: true, native: [{ id: "t1", platform: "android", token: TOKEN_A }], optedOut: new Set(["u1"]) });
  const skipped = await off.mod.sendPushToUser("u1", { title: "t", body: "b", tag: "NOTICE" });
  assert.equal(skipped.errorCode, "PUSH_OPTED_OUT");
  assert.equal(off.log.fcmSends.length, 0, "끈 종류는 앱에도 안 보낸다");
});

test("무효 토큰 정리: UNREGISTERED 는 지우고 재시도 목록에 넣지 않는다, 일시 실패는 native: 로 재시도", async () => {
  const { mod, log } = loadSender({
    native: [{ id: "dead", platform: "android", token: TOKEN_A }, { id: "busy", platform: "ios", token: TOKEN_B }],
    fcmResult: (token) => (token === TOKEN_A ? { kind: "invalid-token", code: "UNREGISTERED" } : { kind: "failed", code: "FCM_UNAVAILABLE" }),
  });
  const result = await mod.sendPushToUser("u1", { title: "t", body: "b" });
  assert.equal(result.status, "FAILED");
  assert.equal(result.removedCount, 1);
  assert.deepEqual(log.deletedNative, ["dead"]);
  assert.deepEqual(result.failedSubscriptionIds, ["native:busy"]);

  // 재시도(push-outbox 가 돌려준 목록): 실패했던 앱 토큰만, 웹 구독은 조회하지 않는다
  const retry = loadSender({ vapid: true, native: [{ id: "busy", platform: "ios", token: TOKEN_B }, { id: "other", platform: "android", token: TOKEN_A }] });
  const again = await retry.mod.sendPushToUser("u1", { title: "t", body: "b" }, { subscriptionIds: ["native:busy"] });
  assert.equal(again.status, "SENT");
  assert.equal(again.subscriptionCount, 1);
  assert.deepEqual(retry.log.nativeLookups, [{ userId: "u1", ids: ["busy"] }]);
  assert.equal(retry.log.webQueries.length, 0, "웹 구독 재시도 대상이 없으면 조회도 안 한다");
});

test("FCM 키 없음: 앱 발송은 조용히 건너뛰고 웹푸시만, 둘 다 없으면 NOT_CONFIGURED(재시도 안 함)", async () => {
  const webOnly = loadSender({ vapid: true, fcm: false, web: [{ id: "w1", endpoint: "https://push.example/w1", p256dh: "p", auth: "a" }], native: [{ id: "t1", platform: "android", token: TOKEN_A }] });
  const result = await webOnly.mod.sendPushToUser("u1", { title: "t", body: "b" });
  assert.equal(result.status, "SENT");
  assert.equal(result.subscriptionCount, 1);
  assert.equal(webOnly.log.nativeLookups.length, 0, "키가 없으면 앱 토큰을 조회하지도 않는다");
  assert.equal(webOnly.log.fcmSends.length, 0);

  const none = loadSender({ vapid: false, fcm: false });
  const r = await none.mod.sendPushToUser("u1", { title: "t", body: "b" });
  assert.equal(r.status, "NOT_CONFIGURED");
  assert.equal(r.errorCode, "VAPID_NOT_CONFIGURED", "대기열 재시도 규칙(shouldRetryPush)이 아는 코드 그대로");

  // VAPID 없이 FCM 만 있어도 앱으로는 간다
  const appOnly = loadSender({ vapid: false, native: [{ id: "t1", platform: "android", token: TOKEN_A }] });
  assert.equal((await appOnly.mod.sendPushToUser("u1", { title: "t", body: "b" })).status, "SENT");
  assert.equal(appOnly.log.webQueries.length, 0);
});

test("전체 공지(sendPushToAllParents): 앱 토큰도 보내고, 공지를 끈 학부모 기기는 뺀다", async () => {
  const { mod, log } = loadSender({ native: [{ id: "t1", userId: "on", platform: "android", token: TOKEN_A }, { id: "t2", userId: "off", platform: "ios", token: TOKEN_B }], optedOut: new Set(["off"]) });
  const result = await mod.sendPushToAllParents({ title: "공지", body: "b", tag: "NOTICE" });
  assert.equal(result.subscriptionCount, 1);
  assert.deepEqual(log.fcmSends.map((s) => s.token), [TOKEN_A]);
  assert.equal(result.failedSubscriptionIds, undefined, "전체 발송은 재시도 목록을 만들지 않는다(예전과 같음)");
  // 대상 = 학부모 역할(웹푸시와 같은 기준)
  assert.match(read("src/lib/push/nativePushStore.ts"), /JOIN "User" u ON u\.id = t\."userId"\s+WHERE u\.role = 'PARENT'/);
});

// ── 토큰 등록 API ───────────────────────────────────────────────────────────

function loadRoute({ authUser, linkedId = "app-me" }) {
  const writes = [];
  const cookies = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => { writes.push({ sql, params }); return [{ id: "row-1" }]; },
    $executeRawUnsafe: async (sql, ...params) => { writes.push({ sql, params }); return 1; },
  };
  const json = (body, init) => ({ body, status: init?.status ?? 200, cookies: { set: (...a) => cookies.push(["set", ...a]), delete: (n) => cookies.push(["delete", n]) } });
  const route = load("src/app/api/push/native/route.ts", {
    "next/server": { NextResponse: { json } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }) },
    "@/lib/prisma": { prisma },
    "@/lib/auth-guard": { findLinkedAppUserId: async (authId) => (authId === "auth-me" ? linkedId : null) },
    "@/lib/push/nativePushPolicy": policy,
  });
  const req = (body) => ({ json: async () => body });
  return { route, req, writes, cookies };
}

test("토큰 등록 권한: 로그인 안 하면 401, 연결 계정 없으면 404, 본문의 userId 는 무시하고 본인에게만", async () => {
  const anon = loadRoute({ authUser: null });
  assert.equal((await anon.route.POST(anon.req({ platform: "android", token: TOKEN_A }))).status, 401);
  assert.equal(anon.writes.length, 0);
  assert.equal((await anon.route.GET()).status, 401, "로그인 확인용 GET 도 401");

  const unlinked = loadRoute({ authUser: { id: "auth-other" } });
  assert.equal((await unlinked.route.POST(unlinked.req({ platform: "android", token: TOKEN_A }))).status, 404);
  assert.equal(unlinked.writes.length, 0);

  const me = loadRoute({ authUser: { id: "auth-me" } });
  assert.equal((await me.route.POST(me.req({ platform: "web", token: TOKEN_A }))).status, 400);
  const ok = await me.route.POST(me.req({ platform: "ios", token: TOKEN_A, userId: "victim" }));
  assert.equal(ok.status, 200);
  const insert = me.writes.find((w) => /INSERT INTO "NativePushToken"/.test(w.sql));
  assert.deepEqual(insert.params, ["app-me", "ios", TOKEN_A], "토큰 주인은 로그인 계정");
  assert.match(insert.sql, /ON CONFLICT \(token\) DO UPDATE SET "userId" = \$1/, "같은 기기에서 다른 사람이 로그인하면 옮긴다");
  assert.ok(me.writes.some((w) => /DELETE FROM "NativePushToken"[\s\S]*LIMIT \$2/.test(w.sql) && w.params[0] === "app-me"), "본인의 옛 토큰만 정리");
  const [, name, value, opts] = me.cookies.find((c) => c[0] === "set");
  assert.equal(name, "stiz_np");
  assert.equal(value, "row-1", "쿠키에는 토큰이 아니라 줄 id");
  assert.equal(opts.httpOnly, true);
  assert.equal((await me.route.GET()).status, 200);
});

test("토큰 해제: 본인 토큰만 지운다", async () => {
  const me = loadRoute({ authUser: { id: "auth-me" } });
  assert.equal((await me.route.DELETE(me.req({}))).status, 400);
  assert.equal((await me.route.DELETE(me.req({ token: TOKEN_A }))).status, 200);
  const del = me.writes.find((w) => /DELETE FROM "NativePushToken"/.test(w.sql));
  assert.match(del.sql, /WHERE token = \$1 AND "userId" = \$2/);
  assert.deepEqual(del.params, [TOKEN_A, "app-me"]);
  const anon = loadRoute({ authUser: null });
  assert.equal((await anon.route.DELETE(anon.req({ token: TOKEN_A }))).status, 401);
});

// ── 로그아웃·탈퇴 정리 ──────────────────────────────────────────────────────

test("로그아웃은 이 기기 토큰을 먼저 지우고, 탈퇴는 그 사람 토큰을 거래 안에서 지운다(표 없으면 건너뜀)", async () => {
  const auth = read("src/app/actions/auth.ts");
  for (const fn of ["logout", "logoutStaff"]) {
    assert.match(auth, new RegExp(`export async function ${fn}\\(\\) \\{\\s*await forgetNativePushOnThisDevice\\(\\);\\s*const supabase = await createClient\\(\\);\\s*await supabase\\.auth\\.signOut\\(\\);`), fn);
  }
  // 이 기기 = 등록 때 남긴 쿠키(줄 id)
  const executed = [];
  let deleted = null;
  const device = load("src/lib/push/nativePushDevice.ts", {
    "next/headers": { cookies: async () => ({ get: (n) => (n === "stiz_np" ? { value: "row-9" } : undefined), delete: (n) => { deleted = n; } }) },
    "@/lib/prisma": { prisma: { $executeRawUnsafe: async (sql, ...p) => { executed.push({ sql, p }); return 1; } } },
    "@/lib/push/nativePushPolicy": policy,
  });
  await device.forgetNativePushOnThisDevice();
  assert.deepEqual(executed, [{ sql: `DELETE FROM "NativePushToken" WHERE id = $1`, p: ["row-9"] }]);
  assert.equal(deleted, "stiz_np");

  // 탈퇴: 표가 없으면(마이그레이션 전) DELETE 를 보내지 않는다 — 실패한 문장이 탈퇴 거래 전체를 무르지 않게
  const store = load("src/lib/push/nativePushStore.ts", { "@/lib/prisma": { prisma: {} } });
  for (const [exists, expected] of [[false, 0], [true, 1]]) {
    const deletes = [];
    await store.deleteNativePushTokensOfUser({ $queryRawUnsafe: async () => [{ ok: exists }], $executeRawUnsafe: async (sql, ...p) => { deletes.push({ sql, p }); return 1; } }, "u-1");
    assert.equal(deletes.length, expected);
    if (expected) assert.deepEqual(deletes[0], { sql: `DELETE FROM "NativePushToken" WHERE "userId" = $1`, p: ["u-1"] });
  }
  assert.match(read("src/app/actions/parent-account.ts"), /DELETE FROM "PushSubscription" WHERE "userId" = \$1`,\s*target,\s*\);\s*\/\/[^\n]*\n\s*await deleteNativePushTokensOfUser\(tx, target\);/);
});

// ── DB·화면 연결 ────────────────────────────────────────────────────────────

test("마이그레이션: 새 표 하나·토큰 unique·RLS ENABLE+FORCE·anon/authenticated 권한 없음, schema.prisma 사본과 같다", () => {
  const sql = read("prisma/migrations/20261114000000_native_push_token/migration.sql");
  const body = sql.replace(/--.*$/gm, "");
  assert.match(body, /CREATE TABLE IF NOT EXISTS public\."NativePushToken"/);
  assert.match(body, /CREATE UNIQUE INDEX IF NOT EXISTS "NativePushToken_token_key"\s+ON public\."NativePushToken" \(token\)/);
  assert.match(body, /ALTER TABLE public\."NativePushToken" ENABLE ROW LEVEL SECURITY;/);
  assert.match(body, /ALTER TABLE public\."NativePushToken" FORCE ROW LEVEL SECURITY;/);
  assert.match(body, /REVOKE ALL ON TABLE public\."NativePushToken" FROM anon, authenticated;/);
  assert.doesNotMatch(body, /ALTER TABLE (public\.)?"(?!NativePushToken)|DROP /, "기존 표는 건드리지 않는다");
  const model = read("prisma/schema.prisma").match(/model NativePushToken \{([\s\S]*?)\n\}/)[1];
  for (const col of ["id", "userId", "platform", "token", "createdAt", "lastSeenAt"]) {
    assert.match(model, new RegExp(`^\\s+${col}\\s`, "m"), col);
    assert.match(body, new RegExp(`(^|\\s|")${col}"?\\s+(TEXT|TIMESTAMPTZ)`, "m"), `SQL ${col}`);
  }
});

test("앱 알림 창구 답 해석·화면 판정(웹): 모양이 틀리면 미지원으로", () => {
  const bridge = load("src/lib/push/nativePushBridge.ts");
  const ok = bridge.parseNativePushReply(`{"v":1,"platform":"android","supported":true,"permission":"granted","token":"${TOKEN_A}"}`);
  assert.deepEqual(ok, { supported: true, permission: "granted", token: TOKEN_A, platform: "android" });
  assert.equal(bridge.parseNativePushReply({ v: 1, platform: "ios", supported: true, permission: "default", token: "short" }).token, null);
  for (const bad of [null, "", "nope", "{}", '{"v":2,"platform":"android","permission":"granted"}', '{"v":1,"platform":"web","permission":"granted"}', '{"v":1,"platform":"ios","permission":"maybe"}']) {
    assert.equal(bridge.parseNativePushReply(bad), null, String(bad));
  }
  assert.equal(bridge.nativePushView(null), "unavailable", "창구 없음(옛 앱)");
  assert.equal(bridge.nativePushView({ ...ok, supported: false }), "unavailable", "Firebase 설정 없는 앱");
  assert.equal(bridge.nativePushView({ ...ok, permission: "denied" }), "denied");
  assert.equal(bridge.nativePushView({ ...ok, permission: "default" }), "default");
  assert.equal(bridge.nativePushView(ok), "granted");
  assert.equal(bridge.NATIVE_PUSH_NOTES.denied, "휴대폰 설정에서 알림을 켜 주세요");
  assert.equal(bridge.NATIVE_PUSH_NOTES.unavailable, "알림은 문자·카카오톡으로 보내드려요");
  // 등록은 로그인 쿠키로 /api/push/native — 401 이면 기록을 지워 로그인 후 바로 다시 등록
  const src = read("src/lib/push/nativePushBridge.ts");
  assert.match(src, /fetch\("\/api\/push\/native", \{\s*method: "POST"/);
  assert.match(src, /res\.status === 401[\s\S]{0,40}clearNativePushSync\(\)/);
});

test("화면 연결: 자동 등록기는 루트 레이아웃에, 설정 화면은 앱 상태대로(켜짐·휴대폰 설정·문자 안내)", () => {
  assert.match(read("src/app/layout.tsx"), /<NativePushRegistrar \/>/);
  const registrar = read("src/components/push/NativePushRegistrar.tsx");
  assert.match(registrar, /if \(!hasNativePushBridge\(\)\) return;/, "브라우저·옛 앱에서는 아무것도 안 한다");
  assert.match(registrar, /fetch\("\/api\/push\/native", \{ method: "GET" \}\)/, "로그인한 사람에게만 자동으로 권한을 묻는다");
  assert.match(registrar, /NATIVE_PUSH_ASKED_KEY\) === "1"\) return;/, "자동으로 묻는 건 기기당 한 번");
  const settings = read("src/app/mypage/settings/SettingsClient.tsx");
  assert.match(settings, /app\.view === "denied" && \([\s\S]*?NATIVE_PUSH_NOTES\.denied/);
  assert.match(settings, /app\.view === "unavailable" && \([\s\S]*?NATIVE_PUSH_NOTES\.unavailable/);
  assert.match(settings, /app\.view === "default" \? \(\s*<Switch on=\{false\} busy=\{app\.busy\} label="휴대폰 알림" onToggle=\{\(\) => void app\.request\(\)\} \/>/);
  assert.doesNotMatch(settings, /앱 알림은 준비 중이에요/, "잘못된 «준비 중» 안내 제거");
  // 종류별 받기 스위치는 앱 알림이 되는 앱에서도 보인다(웹·앱 같은 스위치 — 발송 함수가 둘 다 거른다)
  assert.match(settings, /prefsAvailable && \(!appLacksPush \|\| appCanPush\)/);
});
