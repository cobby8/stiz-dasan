// 본사 쇼핑몰(stiz.kr) 유니폼 주문 → 학부모 «유니폼 신청 내역»(2026-11-16 원장 «쇼핑몰 주문도 학부모 화면에 보이게»)
//  ① 서명: 고정 입력 → 고정 hex(본사와 같은 벡터로 맞춰 본다)
//  ② 기간: 기본 14일·days·from/to·잘못된 값 거부(KST 자정 경계)
//  ③ 응답 검증: 모양이 조금이라도 다르면 통째로 거부
//  ④ 동기화: 가짜 fetch·가짜 DB — 헤더·주소(전화번호 없음)·재시도·실패 시 DB 미변경·upsert 만(DELETE 없음)
//  ⑤ cron 라우트: CRON_SECRET·응답에 개인정보 없음·vercel.json 매시 17분·마이그레이션 모양
//  ⑥ 학부모 매칭: 구매자·수령인 번호·이름 불일치·이름 빈 품목·동명이인·남의 아이·전화번호 없음·표 없는 DB·금지 칸 없음
//  ⑦ 렌더: «쇼핑몰»/«사이트» 글자·상태 라벨
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p));
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const sync = load("src/lib/uniform/shopOrderSync.ts");
const rules = load("src/lib/parent/childUniformRules.ts");

const SECRET = "0123456789abcdef".repeat(4); // 64자리 hex(테스트 전용)
const TS = 1763251200; // 2025-11-16T00:00:00Z
const RANGE = { from: "2026-11-03", to: "2026-11-16" };

// ── ① 서명 ─────────────────────────────────────────────────────────────────

test("① 서명 글자·서명 hex — 고정 벡터(본사 검증용)", () => {
  const input = { secret: SECRET, timestamp: TS, club: "dasan", ...RANGE };
  const signing = sync.clubOrdersSigningString(input);
  assert.equal(
    signing,
    '1763251200.dasan.{"method":"GET","path":"/api/partner/club-orders","query":{"club":"dasan","from":"2026-11-03","to":"2026-11-16"}}',
  );
  const expected = crypto.createHmac("sha256", SECRET).update(signing, "utf8").digest("hex");
  const sig = sync.signClubOrdersRequest(input);
  assert.equal(sig, expected);
  assert.equal(sig, "346e3d25e4e1ca49409b761fd2d5b190b72c43411d596d38dcfaee8afab7745a");
  assert.match(sig, /^[0-9a-f]{64}$/, "소문자 hex");
});

// ── ② 기간 ─────────────────────────────────────────────────────────────────

// 2026-11-15T15:30Z = KST 11-16 00:30 — UTC 로는 아직 15일(자정 경계)
const NOW = Date.UTC(2026, 10, 15, 15, 30);

test("② 기간: 기본 최근 14일(KST) · days · from/to · 잘못된 값은 거부", () => {
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW }), { from: "2026-11-03", to: "2026-11-16" });
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW, days: "1" }), { from: "2026-11-16", to: "2026-11-16" });
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW, days: "80" }), { from: "2026-08-29", to: "2026-11-16" });
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW, from: "2026-01-01", to: "2026-03-21" }), { from: "2026-01-01", to: "2026-03-21" }, "80일(오늘 포함)");
  for (const bad of [
    { days: "81" }, { days: "0" }, { days: "abc" }, { days: "-3" },
    { from: "2026-01-01", to: "2026-03-22" }, // 81일
    { from: "2026-11-10", to: "2026-11-01" },
    { from: "2026-11-01" }, { to: "2026-11-01" },
    { from: "2026-02-30", to: "2026-03-01" },
    { days: "3", from: "2026-11-01", to: "2026-11-02" },
  ]) {
    assert.ok("error" in sync.resolveSyncRange({ nowMs: NOW, ...bad }), JSON.stringify(bad));
  }
});

// ── ③ 응답 검증 ────────────────────────────────────────────────────────────

const item = (extra = {}) => ({
  itemCode: "20261103-0000123-01", productNo: 501, design: "기본형", studentName: "김루빈", printName: "RUBIN", number: "23",
  topSize: "130", bottomSize: "130", quantity: 1, status: "PAID", trackingNo: "123456789012", ...extra,
});
const order = (extra = {}) => ({
  cafe24OrderId: "20261103-0000123", orderDate: "2026-11-03", paid: true, canceled: false,
  buyerPhoneDigits: "01012345678", receiverPhoneDigits: "01055556666", items: [item()], ...extra,
});
const body = (orders = [order()], extra = {}) => ({
  success: true, club: "dasan", from: RANGE.from, to: RANGE.to, count: orders.length, fetchedAt: "2026-11-16T00:00:00.000Z", orders, ...extra,
});
const EXPECTED = { club: "dasan", ...RANGE };

test("③ 정상 응답 → 검증·정리(앞뒤 공백·빈 글자는 null)", () => {
  const r = sync.parseClubOrdersResponse(body([order({ items: [item({ design: "  기본형 ", printName: " " })] })]), EXPECTED);
  assert.equal(r.ok, true);
  assert.equal(r.orders[0].items[0].design, "기본형");
  assert.equal(r.orders[0].items[0].printName, null);
  assert.equal(sync.parseClubOrdersResponse(body([]), EXPECTED).ok, true, "0건도 정상");
});

test("③ 모양이 조금이라도 다르면 통째로 거부(사유에 값 없음)", () => {
  const { orders: _o, ...noOrders } = body();
  const { trackingNo: _t, ...itemNoTracking } = item();
  const cases = {
    "null": null,
    "배열": [],
    "모르는 최상위 칸": body(undefined, { extra: 1 }),
    "orders 없음": noOrders,
    "success false": body(undefined, { success: false }),
    "다른 club": body(undefined, { club: "pyeongnae" }),
    "다른 기간": body(undefined, { from: "2026-11-02" }),
    "count 불일치": body(undefined, { count: 2 }),
    "fetchedAt 빈 글자": body(undefined, { fetchedAt: "" }),
    "주문 모르는 칸": body([order({ buyerName: "홍길동" })]),
    "품목 칸 빠짐": body([order({ items: [itemNoTracking] })]),
    "품목 모르는 칸": body([order({ items: [item({ price: 39000 })] })]),
    "상태 오타": body([order({ items: [item({ status: "Paid" })] })]),
    "수량 글자": body([order({ items: [item({ quantity: "1" })] })]),
    "수량 0": body([order({ items: [item({ quantity: 0 })] })]),
    "productNo 소수": body([order({ items: [item({ productNo: 1.5 })] })]),
    "전화번호 하이픈": body([order({ buyerPhoneDigits: "010-1234-5678" })]),
    "전화번호 숫자형": body([order({ receiverPhoneDigits: 1012345678 })]),
    "paid 글자": body([order({ paid: "Y" })]),
    "주문일 형식": body([order({ orderDate: "2026/11/03" })]),
    "주문일 기간 밖": body([order({ orderDate: "2026-10-01" })]),
    "주문 중복": body([order(), order()]),
    "품목 중복": body([order({ items: [item(), item()] })]),
    "품목 코드에 콜론": body([order({ items: [item({ itemCode: "a:b" })] })]),
    "주문번호 빈 글자": body([order({ cafe24OrderId: "" })]),
    "items 객체": body([order({ items: {} })]),
    "이름 너무 김": body([order({ items: [item({ studentName: "가".repeat(201) })] })]),
  };
  for (const [name, b] of Object.entries(cases)) {
    const r = sync.parseClubOrdersResponse(b, EXPECTED);
    assert.equal(r.ok, false, name);
    assert.doesNotMatch(r.reason, /0101234|김루빈|홍길동/, `${name}: 사유에 값 없음`);
  }
});

test("③ 저장 계획: 품목 id = 주문번호:품목코드, 등번호 = number, 이름·금액·주소 칸 없음", () => {
  const r = sync.parseClubOrdersResponse(body(), EXPECTED);
  const plan = sync.planShopOrderUpsert(r.orders);
  assert.deepEqual(plan.orders, [{ id: "20261103-0000123", orderDate: "2026-11-03", paid: true, canceled: false, buyerPhoneDigits: "01012345678", receiverPhoneDigits: "01055556666" }]);
  assert.equal(plan.items[0].id, "20261103-0000123:20261103-0000123-01");
  assert.equal(plan.items[0].shopOrderId, "20261103-0000123");
  assert.equal(plan.items[0].backNumber, "23");
  for (const row of [...plan.orders, ...plan.items]) for (const k of Object.keys(row)) assert.doesNotMatch(k, /buyerName|receiverName|address|price|amount/i);
});

// ── ④ 동기화(가짜 fetch·가짜 DB) ───────────────────────────────────────────

function fakeDb() {
  const calls = [];
  return { calls, async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return [{ orders: JSON.parse(values[0]).length, items: JSON.parse(values[1]).length }]; } };
}
const jsonRes = (status, b) => ({ ok: status >= 200 && status < 300, status, async json() { return b; } });
const ENV = { STIZ_PARTNER_SECRET: SECRET };

test("④ 정상: 서명 헤더·주소(club·기간만) → upsert 한 번, 결과는 건수만", async () => {
  const db = fakeDb();
  const reqs = [];
  const fetchImpl = async (url, init) => { reqs.push({ url, init }); return jsonRes(200, body()); };
  const out = await sync.runShopOrderSync(db, RANGE, { fetchImpl, env: ENV, nowMs: () => TS * 1000 });
  assert.deepEqual(out, { from: RANGE.from, to: RANGE.to, receivedOrders: 1, receivedItems: 1, savedOrders: 1, savedItems: 1 });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].url, "https://custom.stiz.kr/api/partner/club-orders?club=dasan&from=2026-11-03&to=2026-11-16");
  assert.equal(reqs[0].init.method, "GET");
  assert.equal(reqs[0].init.headers["X-STIZ-Partner"], "dasan");
  assert.equal(reqs[0].init.headers["X-STIZ-Timestamp"], String(TS));
  assert.equal(reqs[0].init.headers["X-STIZ-Signature"], sync.signClubOrdersRequest({ secret: SECRET, timestamp: TS, club: "dasan", ...RANGE }));
  assert.ok(!JSON.stringify(reqs[0].init.headers).includes(SECRET), "비밀키를 헤더에 그대로 넣지 않는다");
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.doesNotMatch(db.calls[0].sql, /DELETE|TRUNCATE|DROP/i, "upsert 만");
  assert.match(db.calls[0].sql, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.equal(JSON.parse(db.calls[0].values[1])[0].trackingNo, "123456789012", "송장번호는 저장(화면으로는 안 나감)");
  assert.doesNotMatch(JSON.stringify(out), /0101234|김루빈/);
});

test("④ 주소는 STIZ_CLUB_ORDERS_API_URL 로 덮어쓸 수 있다", async () => {
  const reqs = [];
  await sync.runShopOrderSync(fakeDb(), RANGE, {
    fetchImpl: async (url) => { reqs.push(url); return jsonRes(200, body([])); },
    env: { ...ENV, STIZ_CLUB_ORDERS_API_URL: "https://staging.example/api/partner/club-orders" },
    nowMs: () => TS * 1000,
  });
  assert.equal(reqs[0], "https://staging.example/api/partner/club-orders?club=dasan&from=2026-11-03&to=2026-11-16");
});

test("④ 0건이면 DB 를 건드리지 않는다", async () => {
  const db = fakeDb();
  const out = await sync.runShopOrderSync(db, RANGE, { fetchImpl: async () => jsonRes(200, body([])), env: ENV });
  assert.equal(db.calls.length, 0);
  assert.equal(out.savedOrders, 0);
});

test("④ 503 이면 1번만 다시(새 서명) — 두 번째 성공", async () => {
  const db = fakeDb();
  let n = 0;
  const seen = [];
  const out = await sync.runShopOrderSync(db, RANGE, {
    fetchImpl: async (_u, init) => { seen.push(init.headers["X-STIZ-Timestamp"]); n++; return n === 1 ? jsonRes(503, { success: false, error: "cafe24" }) : jsonRes(200, body()); },
    env: ENV,
    nowMs: (() => { let t = TS * 1000; return () => (t += 1000); })(),
  });
  assert.equal(n, 2);
  assert.notEqual(seen[0], seen[1], "다시 할 때 새 시각");
  assert.equal(out.savedOrders, 1);
});

test("④ 실패하면 아무것도 저장하지 않는다 — 401·5xx 두 번·연결 실패·시간 초과·JSON 아님·모양 이상·비밀키 없음", async () => {
  const scenarios = {
    "401(다시 안 함)": { fetchImpl: async () => jsonRes(401, { success: false, error: "서명" }), calls: 1, msg: /본사 응답 401/ },
    "400": { fetchImpl: async () => jsonRes(400, { success: false }), calls: 1, msg: /400/ },
    "503 두 번": { fetchImpl: async () => jsonRes(503, { success: false }), calls: 2, msg: /503/ },
    "연결 실패": { fetchImpl: async () => { throw new TypeError("fetch failed 01012345678"); }, calls: 2, msg: /연결 실패/ },
    "JSON 아님": { fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError("x"); } }), calls: 1, msg: /JSON/ },
    "모양 이상": { fetchImpl: async () => jsonRes(200, body([order({ items: [item({ status: "?" })] })])), calls: 1, msg: /응답 모양/ },
    "시간 초과": {
      fetchImpl: (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      calls: 2, msg: /시간 초과/, timeoutMs: 5,
    },
  };
  for (const [name, s] of Object.entries(scenarios)) {
    const db = fakeDb();
    let n = 0;
    const fetchImpl = async (...a) => { n++; return s.fetchImpl(...a); };
    await assert.rejects(sync.runShopOrderSync(db, RANGE, { fetchImpl, env: ENV, timeoutMs: s.timeoutMs }), (e) => {
      assert.equal(e.name, "ShopOrderSyncError", name);
      assert.match(e.message, s.msg, name);
      assert.doesNotMatch(e.message, /0101234|0123456789abcdef/, `${name}: 값·비밀키 없음`);
      return true;
    });
    assert.equal(n, s.calls, `${name}: 호출 수`);
    assert.equal(db.calls.length, 0, `${name}: DB 미변경`);
  }
  for (const env of [{}, { STIZ_PARTNER_SECRET: "short" }]) {
    const db = fakeDb();
    let n = 0;
    await assert.rejects(sync.runShopOrderSync(db, RANGE, { fetchImpl: async () => { n++; return jsonRes(200, body()); }, env }), /STIZ_PARTNER_SECRET/);
    assert.equal(n, 0, "비밀키가 없으면 부르지도 않는다");
    assert.equal(db.calls.length, 0);
  }
});

// ── ⑤ cron 라우트·설정·마이그레이션 ───────────────────────────────────────

function loadRoute(prismaDb) {
  return load("src/app/api/cron/uniform-shop-sync/route.ts", {
    "next/server": { NextResponse: { json: (b, init) => Response.json(b, init) } },
    "@/lib/prisma": { prisma: prismaDb },
    "@/lib/cron/withCronAlert": { withCronAlert: (_name, h) => h },
  });
}
const req = (query, auth = "Bearer cron-test") => ({
  headers: { get: (k) => (k === "authorization" ? auth : null) },
  nextUrl: { searchParams: new URLSearchParams(query) },
});

test("⑤ cron 라우트: CRON_SECRET · 잘못된 기간 400 · 성공은 건수만 · 실패 500 + 사유(개인정보·비밀키 없음)", async (t) => {
  const saved = { CRON_SECRET: process.env.CRON_SECRET, STIZ_PARTNER_SECRET: process.env.STIZ_PARTNER_SECRET, STIZ_CLUB_ORDERS_API_URL: process.env.STIZ_CLUB_ORDERS_API_URL };
  const savedFetch = globalThis.fetch;
  const savedError = console.error;
  const logs = [];
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    globalThis.fetch = savedFetch;
    console.error = savedError;
  });
  process.env.CRON_SECRET = "cron-test";
  process.env.STIZ_PARTNER_SECRET = SECRET;
  delete process.env.STIZ_CLUB_ORDERS_API_URL;
  console.error = (...a) => logs.push(a.join(" "));

  const db = fakeDb();
  const route = loadRoute(db);
  assert.equal((await route.GET(req("", "Bearer wrong"))).status, 401);
  assert.equal((await route.GET(req("days=81"))).status, 400);

  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    return jsonRes(200, body([order({ orderDate: q.get("to") })], { from: q.get("from"), to: q.get("to") }));
  };
  const ok = await route.GET(req("from=2026-11-01&to=2026-11-05"));
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.deepEqual(okBody, { ok: true, from: "2026-11-01", to: "2026-11-05", receivedOrders: 1, receivedItems: 1, savedOrders: 1, savedItems: 1 });
  assert.doesNotMatch(JSON.stringify(okBody), /0101234|0105555|김루빈/);

  globalThis.fetch = async () => jsonRes(200, body([order({ items: [item({ status: "?" })] })]));
  const bad = await route.GET(req("days=3"));
  assert.equal(bad.status, 500);
  const badText = await bad.text();
  assert.match(badText, /응답 모양이 다릅니다/);
  assert.doesNotMatch(badText + logs.join("\n"), /0101234|김루빈|0123456789abcdef/);
  assert.equal(logs.length, 1, "console.error 한 줄");

  // DB 오류 원문은 내보내지 않는다
  globalThis.fetch = async (url) => { const q = new URL(url).searchParams; return jsonRes(200, body(undefined, { from: q.get("from"), to: q.get("to") })); };
  const failing = loadRoute({ async $queryRawUnsafe() { throw new Error('relation "UniformShopOrder" 01012345678'); } });
  const dbFail = await failing.GET(req("from=2026-11-03&to=2026-11-16"));
  assert.equal(dbFail.status, 500);
  assert.doesNotMatch(await dbFail.text(), /01012345678|relation/);
});

test("⑤ 소스·설정: withCronAlert · vercel.json 매시 17분 · 마이그레이션(IF NOT EXISTS·RLS·권한 회수·지우기 없음) · 스키마 모델", () => {
  const src = read("src/app/api/cron/uniform-shop-sync/route.ts");
  assert.match(src, /process\.env\.CRON_SECRET/);
  assert.match(src, /withCronAlert\("uniform-shop-sync", handleGet\)/);
  const vercel = JSON.parse(read("vercel.json"));
  assert.deepEqual(vercel.crons.filter((c) => c.path === "/api/cron/uniform-shop-sync"), [{ path: "/api/cron/uniform-shop-sync", schedule: "17 * * * *" }]);
  const sql = read("prisma/migrations/20261116300000_uniform_shop_orders/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "UniformShopOrder"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "UniformShopOrderItem"/);
  assert.match(sql, /REFERENCES "UniformShopOrder"\("id"\) ON DELETE CASCADE/);
  assert.match(sql, /ALTER TABLE "UniformShopOrder" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE "UniformShopOrderItem" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON "UniformShopOrder" FROM anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON "UniformShopOrderItem" FROM anon, authenticated/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, "").replace(/ON DELETE CASCADE/g, ""), /DROP|DELETE|TRUNCATE|address|price|amount|buyerName/i);
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model UniformShopOrder \{/);
  assert.match(schema, /model UniformShopOrderItem \{/);
  const lib = read("src/lib/uniform/shopOrderSync.ts");
  assert.doesNotMatch(lib, /findMany|\.upsert\(|\.create\(|toISOString\(\)\.slice/);
});

// ── ⑥ 학부모 매칭 ──────────────────────────────────────────────────────────

const ME = "01012345678";
const siteRow = (extra = {}) => ({
  itemId: "site-1", appliedYmd: "2026-11-05", design: "기본형", backNumber: "7", topSize: "140", bottomSize: "140", quantity: 1,
  orderStatus: "RECEIVED", stizSyncStatus: "SENT", hasOrderNumber: true, parentPhoneDigits: ME, studentName: "김루빈", ...extra,
});
const shopRow = (extra = {}) => ({
  itemId: "C1:01", orderYmd: "2026-11-10", design: "어웨이", backNumber: "23", topSize: "130", bottomSize: "130", quantity: 2,
  itemStatus: "SHIPPING", canceled: false, buyerPhoneDigits: ME, receiverPhoneDigits: null, studentName: "김루빈", trackingNo: "TRACK-999", ...extra,
});

test("⑥ 상태 라벨: 8종 + 주문 취소 우선 + 모르는 값은 «확인 중», 색은 상태색 5종", () => {
  const s = (itemStatus, canceled = false) => rules.shopUniformOrderStatus({ itemStatus, canceled });
  assert.deepEqual(
    ["UNPAID", "PAID", "PREPARING", "SHIPPING", "DELIVERED", "CANCELED", "RETURNED", "UNKNOWN", "WEIRD"].map((x) => s(x).label),
    ["입금 전", "결제 완료", "준비 중", "배송 중", "배송 완료", "취소", "반품", "확인 중", "확인 중"],
  );
  assert.equal(s("DELIVERED", true).label, "취소");
  assert.equal(s("DELIVERED").tone, "success");
  assert.equal(s("UNPAID").tone, "warning");
  assert.equal(s("SHIPPING").tone, "info");
  assert.equal(s("CANCELED").tone, "neutral");
});

test("⑥ 규칙 이중 확인: 구매자 번호·수령인 번호 OK · 이름 불일치·이름 빈 품목·다른 번호(동명이인)·열쇠 없음 제외 · 금지 칸 없음", () => {
  const keys = { phoneKey: ME, childNameKey: "김루빈" };
  const rows = [
    shopRow({ itemId: "buyer" }),
    shopRow({ itemId: "receiver", buyerPhoneDigits: "01099990000", receiverPhoneDigits: ME }),
    shopRow({ itemId: "sibling", studentName: "김하빈" }),
    shopRow({ itemId: "noname", studentName: null }),
    shopRow({ itemId: "blank", studentName: "  " }),
    shopRow({ itemId: "other", buyerPhoneDigits: "01099990000", receiverPhoneDigits: "01088887777" }),
    shopRow({ itemId: "spaced", studentName: "김 루빈" }),
  ];
  const out = rules.toChildShopUniformOrders(rows, keys);
  assert.deepEqual(out.map((o) => o.id), ["shop:buyer", "shop:receiver", "shop:spaced"]);
  assert.ok(out.every((o) => o.source === "shop"));
  for (const o of out) for (const k of Object.keys(o)) assert.doesNotMatch(k, /phone|studentName|tracking|printName|stiz/i, k);
  assert.doesNotMatch(JSON.stringify(out), /TRACK-999|01012345678|김루빈/);
  assert.deepEqual(rules.toChildShopUniformOrders(rows, { phoneKey: null, childNameKey: "김루빈" }), []);
  assert.deepEqual(rules.toChildShopUniformOrders(rows, { phoneKey: ME, childNameKey: "" }), []);
});

test("⑥ 합치기: 신청일 최신순, 같은 날은 사이트 먼저, 날짜 없는 줄은 맨 뒤", () => {
  const v = (id, appliedYmd, source) => ({ id, appliedYmd, source, design: null, backNumber: null, topSize: null, bottomSize: null, quantity: 1, statusLabel: "", statusTone: "info" });
  const merged = rules.mergeChildUniformOrders(
    [v("s1", "2026-11-05", "site"), v("s2", "2026-10-01", "site"), v("s0", null, "site")],
    [v("p1", "2026-11-10", "shop"), v("p2", "2026-11-05", "shop")],
  );
  assert.deepEqual(merged.map((o) => o.id), ["p1", "s1", "p2", "s2", "s0"]);
});

function loadQuery(fake) {
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return fake(sql, values); } };
  const q = load("src/lib/parent/childUniformQuery.ts", {
    "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
  });
  return { run: (parent, kid) => q.loadChildUniformOrders(db, parent, kid), calls };
}

const world = {
  users: [{ id: "mom", phone: "010-1234-5678" }, { id: "noPhone", phone: "" }, { id: "otherMom", phone: "010-9999-8888" }],
  students: [
    { id: "kidA", name: "김루빈A", parentId: "mom" },
    { id: "kidNoPhone", name: "김루빈", parentId: "noPhone" },
    { id: "otherKid", name: "김루빈", parentId: "otherMom" },
    { id: "mergedKid", name: "김루빈", parentId: "mom", merged: true },
  ],
  site: [siteRow()],
  shop: [
    shopRow({ itemId: "mine-buyer" }),
    shopRow({ itemId: "mine-receiver", orderYmd: "2026-11-01", buyerPhoneDigits: "01070707070", receiverPhoneDigits: ME, itemStatus: "DELIVERED" }),
    shopRow({ itemId: "theirs", buyerPhoneDigits: "01099998888", design: "남의 주문" }),
    shopRow({ itemId: "sibling", studentName: "김하빈" }),
    shopRow({ itemId: "noname", studentName: null }),
  ],
};

/** 가짜 DB — SQL 의 조건대로 흉내 낸다. leaky=true 면 쇼핑몰 SQL 이 조건을 무시하고 다 돌려준다(규칙 이중 확인 시험) */
function fakeWorld({ tables = true, leaky = false } = {}) {
  return (sql, values) => {
    if (sql.includes(`FROM "Student" s`)) {
      const [sid, uid] = values;
      const s = world.students.find((x) => x.id === sid && x.parentId === uid && !x.merged);
      const me = world.users.find((u) => u.id === uid);
      return s && me ? [{ name: s.name, mePhone: me.phone }] : [];
    }
    if (sql.includes(`FROM "UniformOrder" o`)) {
      const [phone, nameKey] = values;
      return world.site.filter((o) => o.parentPhoneDigits === phone && o.studentName.replace(/\s/g, "") === nameKey);
    }
    if (sql.includes("to_regclass")) return [{ ready: tables }];
    if (sql.includes(`FROM "UniformShopOrder" o`)) {
      if (!tables) throw new Error('relation "UniformShopOrder" does not exist');
      if (leaky) return world.shop;
      const [phone, nameKey] = values;
      return world.shop.filter((o) => (o.buyerPhoneDigits === phone || o.receiverPhoneDigits === phone) && o.studentName !== null && o.studentName.replace(/\s/g, "") === nameKey);
    }
    throw new Error("unexpected sql");
  };
}

test("⑥ 조회: 사이트 + 쇼핑몰(구매자·수령인 번호) 합쳐 최신순 · 쇼핑몰 SQL 은 본인 번호·이름 열쇠로만 · 송장번호 미조회", async () => {
  const { run, calls } = loadQuery(fakeWorld());
  const out = await run("mom", "kidA");
  assert.deepEqual(out.map((o) => o.id), ["shop:mine-buyer", "site-1", "shop:mine-receiver"]);
  assert.deepEqual(out.map((o) => o.source), ["shop", "site", "shop"]);
  assert.deepEqual(out.map((o) => o.statusLabel), ["배송 중", "주문 완료", "배송 완료"]);
  assert.equal(calls.length, 4);
  const shopCall = calls[3];
  assert.deepEqual(shopCall.values, [ME, "김루빈"]);
  assert.match(shopCall.sql, /o\."buyerPhoneDigits" = \$1 OR o\."receiverPhoneDigits" = \$1/);
  assert.match(shopCall.sql, /i\."studentName" IS NOT NULL/);
  assert.doesNotMatch(shopCall.sql, /trackingNo|printName|AT TIME ZONE/, "송장번호·인쇄 이름 미조회, date 는 시간대 변환 없음");
  for (const o of out) for (const k of Object.keys(o)) assert.doesNotMatch(k, /phone|studentName|tracking|stiz|parentName/i);
  assert.doesNotMatch(JSON.stringify(out), /TRACK-999|01012345678|010-1234|남의 주문|김하빈/);
});

test("⑥ SQL 이 조건을 놓쳐도 규칙이 한 번 더 거른다(이중 확인)", async () => {
  const { run } = loadQuery(fakeWorld({ leaky: true }));
  const out = await run("mom", "kidA");
  assert.deepEqual(out.filter((o) => o.source === "shop").map((o) => o.id), ["shop:mine-buyer", "shop:mine-receiver"]);
});

test("⑥ 표가 없는 DB(마이그레이션 전) → 쇼핑몰은 빈 목록, 사이트 주문은 그대로", async () => {
  const { run, calls } = loadQuery(fakeWorld({ tables: false }));
  const out = await run("mom", "kidA");
  assert.deepEqual(out.map((o) => o.id), ["site-1"]);
  assert.ok(calls.every((c) => !c.sql.includes(`FROM "UniformShopOrder"`)), "표가 없으면 읽지 않는다");
});

test("⑥ 남의 아이 · 병합 학생 · 전화번호 없음 → 빈 목록, 쇼핑몰 표는 읽지 않는다", async () => {
  for (const [parent, kid] of [["mom", "otherKid"], ["mom", "mergedKid"], ["noPhone", "kidNoPhone"], ["", "kidA"]]) {
    const { run, calls } = loadQuery(fakeWorld());
    assert.deepEqual(await run(parent, kid), [], `${parent}/${kid}`);
    assert.ok(calls.every((c) => !c.sql.includes("UniformShop")), `${parent}/${kid}: 쇼핑몰 표 미조회`);
  }
});

// ── ⑦ 렌더 ─────────────────────────────────────────────────────────────────

const Sections = load("src/app/mypage/record/ChildProfileSections.tsx", {
  "next/link": { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) },
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
});

test("⑦ 줄: 신청일 · «쇼핑몰»/«사이트» 글자 · 내용 · 상태 배지, 아이콘·송장번호 없음", () => {
  const shop = rules.toChildShopUniformOrders([shopRow({ itemStatus: "UNPAID" })], { phoneKey: ME, childNameKey: "김루빈" });
  const site = rules.toChildUniformOrders([siteRow()], { phoneKey: ME, childNameKey: "김루빈" });
  const orders = rules.mergeChildUniformOrders(site, shop);
  const html = renderToStaticMarkup(React.createElement(Sections.ChildUniformOrdersSection, { uniform: { status: null, receivedYmd: null, freeGrant: null, orders } }));
  assert.match(html, /26\.11\.10/);
  assert.match(html, />쇼핑몰</);
  assert.match(html, />사이트</);
  assert.match(html, /어웨이 · 23번 · 상의 130 · 하의 130 · 2벌/);
  assert.match(html, /입금 전/);
  assert.ok(html.indexOf("쇼핑몰") < html.indexOf("사이트"), "최신(쇼핑몰 11-10)이 위");
  assert.doesNotMatch(html, /TRACK-999|01012345678|학원에 문의/);
  assert.doesNotMatch(html.replace(/material-symbols-outlined[^>]*>(expand_less|expand_more)</g, ""), /material-symbols/);
});
