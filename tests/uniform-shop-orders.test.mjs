// 소명엔비씨 쇼핑몰(stiz.kr) 유니폼 주문 → 학부모 «유니폼 신청 내역»(2026-11-16 원장 «쇼핑몰 주문도 학부모 화면에 보이게»)
//  ① 서명: 고정 입력 → 고정 hex(소명엔비씨와 같은 벡터로 맞춰 본다)
//  ② 기간: 기본 80일(소명엔비씨 최대치)·days·from/to·잘못된 값 거부(KST 자정 경계)
//  ③ 응답 검증: 필수 칸이 빠지거나 형식이 다르면 통째로 거부 · 모르는 추가 칸은 무시 · 전화번호 "" 는 null
//  ④ 동기화: 가짜 fetch·가짜 DB — 헤더·주소(전화번호 없음)·redirect 금지·재시도·실패 시 DB 미변경·upsert 만(DELETE 없음)
//            · 응답에 들어온 주문에서 빠진 품목은 취소 표시(삭제 아님)
//  ⑤ cron 라우트: CRON_SECRET·응답에 개인정보 없음·vercel.json 매시 17분·마이그레이션 모양
//  ⑥ 학부모 매칭: 구매자·수령인 번호·이름 불일치·이름 빈 품목·동명이인·남의 아이·전화번호 없음·표 없는 DB·금지 칸 없음
//            · 이름 두 기준(아이 열쇠 또는 띄어쓰기만 지운 전체 이름)
//  ⑦ 렌더: «쇼핑몰»/«사이트» 글자·상태 라벨·인쇄 이름(등번호 옆)·취소 뺀 건수
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

test("① 서명 글자·서명 hex — 고정 벡터(소명엔비씨 검증용)", () => {
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

test("② 기간: 기본 최근 80일(KST, 소명엔비씨 최대치) · days · from/to · 잘못된 값은 거부", () => {
  // 2026-11-17: 기본 14일 → 80일(14일 뒤부터 주문 상태가 멈추던 문제). 기본값은 상한과 같은 값이다
  assert.equal(sync.CLUB_ORDERS_DEFAULT_DAYS, 80);
  assert.equal(sync.CLUB_ORDERS_DEFAULT_DAYS, sync.CLUB_ORDERS_MAX_DAYS);
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW }), { from: "2026-08-29", to: "2026-11-16" });
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW }), sync.resolveSyncRange({ nowMs: NOW, days: "80" }), "기본 = days=80");
  assert.deepEqual(sync.resolveSyncRange({ nowMs: NOW, days: "14" }), { from: "2026-11-03", to: "2026-11-16" }, "예전 14일은 ?days=14 로");
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

test("③ 모르는 추가 칸은 거부하지 않고 무시한다 — 저장할 행에도 들어가지 않는다(2026-11-17)", () => {
  const b = body([order({ buyerName: "홍길동", memo: "문 앞", items: [item({ price: 39000, optionText: "비밀" })] })], { extra: 1, apiVersion: "2" });
  const r = sync.parseClubOrdersResponse(b, EXPECTED);
  assert.equal(r.ok, true);
  // 검증 결과·저장 계획 어디에도 추가 칸의 이름·값이 없다
  const plan = sync.planShopOrderUpsert(r.orders);
  assert.doesNotMatch(JSON.stringify(r.orders) + JSON.stringify(plan), /buyerName|홍길동|memo|문 앞|price|39000|optionText|비밀|apiVersion|extra/);
  assert.deepEqual(Object.keys(r.orders[0]).sort(), ["buyerPhoneDigits", "cafe24OrderId", "canceled", "items", "orderDate", "paid", "receiverPhoneDigits"]);
  assert.deepEqual(Object.keys(r.orders[0].items[0]).sort(), ["bottomSize", "design", "itemCode", "number", "printName", "productNo", "quantity", "status", "studentName", "topSize", "trackingNo"]);
  // 추가 칸이 있어도 필수 칸 검사는 그대로다
  const { trackingNo: _t, ...noTracking } = item({ price: 1 });
  assert.equal(sync.parseClubOrdersResponse(body([order({ items: [noTracking] })]), EXPECTED).ok, false, "필수 칸이 빠지면 거부");
  assert.equal(sync.parseClubOrdersResponse(body([order({ items: [item({ price: 1, status: "Paid" })] })]), EXPECTED).ok, false, "형식이 다르면 거부");
});

test("③ 전화번호 빈 글자(\"\")는 null 로 받는다 — 빈 글자끼리 같은 번호로 맞춰지지 않게", () => {
  const r = sync.parseClubOrdersResponse(body([order({ buyerPhoneDigits: "", receiverPhoneDigits: "" })]), EXPECTED);
  assert.equal(r.ok, true);
  assert.equal(r.orders[0].buyerPhoneDigits, null);
  assert.equal(r.orders[0].receiverPhoneDigits, null);
  const plan = sync.planShopOrderUpsert(r.orders);
  assert.equal(plan.orders[0].buyerPhoneDigits, null);
  assert.equal(plan.orders[0].receiverPhoneDigits, null);
  // 한쪽만 빈 글자여도 된다. 숫자가 아닌 글자·공백은 여전히 거부
  const one = sync.parseClubOrdersResponse(body([order({ receiverPhoneDigits: "" })]), EXPECTED);
  assert.equal(one.orders[0].buyerPhoneDigits, "01012345678");
  assert.equal(one.orders[0].receiverPhoneDigits, null);
  assert.equal(sync.parseClubOrdersResponse(body([order({ buyerPhoneDigits: " " })]), EXPECTED).ok, false);
});

test("③ 필수 칸이 빠지거나 형식이 다르면 통째로 거부(사유에 값 없음)", () => {
  const { orders: _o, ...noOrders } = body();
  const { trackingNo: _t, ...itemNoTracking } = item();
  const cases = {
    "null": null,
    "배열": [],
    "orders 없음": noOrders,
    "success false": body(undefined, { success: false }),
    "다른 club": body(undefined, { club: "pyeongnae" }),
    "다른 기간": body(undefined, { from: "2026-11-02" }),
    "count 불일치": body(undefined, { count: 2 }),
    "fetchedAt 빈 글자": body(undefined, { fetchedAt: "" }),
    "주문 칸 빠짐": body([(({ paid: _p, ...rest }) => rest)(order())]),
    "품목 칸 빠짐": body([order({ items: [itemNoTracking] })]),
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
  assert.deepEqual(out, { from: RANGE.from, to: RANGE.to, receivedOrders: 1, receivedItems: 1, savedOrders: 1, savedItems: 1, canceledMissingItems: 0 });
  assert.equal(reqs.length, 1);
  // 서명 헤더가 다른 주소로 넘어가지 않게 — 넘겨 보내기(3xx)를 따라가지 않는다
  assert.equal(reqs[0].init.redirect, "error");
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

test("④ 넘겨 보내기(3xx)를 만나면 따라가지 않고 실패한다 — 저장 없음", async () => {
  // redirect: "error" 일 때 진짜 fetch 는 TypeError 를 던진다 — 그 동작을 흉내 낸다
  const db = fakeDb();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.redirect);
    if (init.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
    return jsonRes(200, body());
  };
  await assert.rejects(sync.runShopOrderSync(db, RANGE, { fetchImpl, env: ENV }), /연결 실패/);
  assert.deepEqual(seen, ["error", "error"], "다시 시도할 때도 따라가지 않는다");
  assert.equal(db.calls.length, 0);
});

test("④ 응답에 들어온 주문에서 빠진 품목은 «취소»로 표시한다 — 삭제하지 않고, 응답에 없는 주문은 건드리지 않는다", async () => {
  const sql = sync.UPSERT_SHOP_ORDERS_SQL;
  // 한 SQL 문·jsonb 매개변수 방식 그대로(문장 끝 세미콜론 없음, 매개변수는 $1·$2 뿐)
  assert.doesNotMatch(sql, /;/);
  assert.deepEqual([...new Set(sql.match(/\$\d+/g))].sort(), ["$1", "$2"]);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP/i, "지우지 않는다");
  const gone = sql.slice(sql.indexOf("gone AS ("), sql.lastIndexOf("SELECT (SELECT count(*) FROM up_o)"));
  assert.match(gone, /UPDATE "UniformShopOrderItem" t SET status = 'CANCELED', "updatedAt" = NOW\(\)/);
  // 대상 = 이번 응답에 품목이 들어온 주문(기간 밖·응답에 없는 주문, 품목이 0개로 온 주문은 제외)
  assert.match(gone, /t\."shopOrderId" IN \(SELECT DISTINCT "shopOrderId" FROM src_i\)/);
  // 응답에 있는 품목은 건드리지 않는다(up_i 가 맡는다) · 이미 취소인 것은 다시 고치지 않는다
  assert.match(gone, /NOT EXISTS \(SELECT 1 FROM src_i s WHERE s\.id = t\.id\)/);
  // 이미 취소·반품인 품목은 다시 고치지 않는다(반품이 «취소»로 바뀌어 보이지 않게)
  assert.match(gone, /t\.status NOT IN \('CANCELED', 'RETURNED'\)/);
  assert.match(sql, /\(SELECT count\(\*\) FROM gone\)::int AS "canceledMissingItems"/);

  // 가짜 DB 로 같은 규칙을 실행해 본다 — 저장된 품목 4개 중 «응답에 들어온 주문 A 에서 빠진 것» 하나만 취소가 된다
  const stored = [
    { id: "A:1", shopOrderId: "A", status: "PREPARING" }, // 응답에 있음 → 소명엔비씨 상태로
    { id: "A:2", shopOrderId: "A", status: "PREPARING" }, // 주문 A 는 왔는데 이 품목은 빠짐 → 취소
    { id: "B:1", shopOrderId: "B", status: "SHIPPING" }, // 주문 B 는 응답에 없음(기간 밖) → 그대로
    { id: "C:1", shopOrderId: "C", status: "PAID" }, // 주문 C 는 품목 0개로 옴 → 그대로
  ];
  const db = {
    async $queryRawUnsafe(text, ordersJson, itemsJson) {
      assert.equal(text, sql);
      const srcI = JSON.parse(itemsJson);
      const withItems = new Set(srcI.map((r) => r.shopOrderId));
      let goneCount = 0;
      for (const row of stored) {
        const incoming = srcI.find((r) => r.id === row.id);
        if (incoming) row.status = incoming.status;
        else if (withItems.has(row.shopOrderId) && row.status !== "CANCELED" && row.status !== "RETURNED") { row.status = "CANCELED"; goneCount++; }
      }
      return [{ orders: JSON.parse(ordersJson).length, items: srcI.length, canceledMissingItems: goneCount }];
    },
  };
  const response = body([
    order({ cafe24OrderId: "A", items: [item({ itemCode: "1", status: "SHIPPING" })] }),
    order({ cafe24OrderId: "C", items: [] }),
  ]);
  const out = await sync.runShopOrderSync(db, RANGE, { fetchImpl: async () => jsonRes(200, response), env: ENV });
  assert.equal(out.canceledMissingItems, 1);
  assert.deepEqual(stored.map((r) => `${r.id}=${r.status}`), ["A:1=SHIPPING", "A:2=CANCELED", "B:1=SHIPPING", "C:1=PAID"]);
  assert.equal(stored.length, 4, "행은 지우지 않는다");
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
    "401(다시 안 함)": { fetchImpl: async () => jsonRes(401, { success: false, error: "서명" }), calls: 1, msg: /소명엔비씨 응답 401/ },
    "400": { fetchImpl: async () => jsonRes(400, { success: false }), calls: 1, msg: /400/ },
    "503 두 번": { fetchImpl: async () => jsonRes(503, { success: false }), calls: 2, msg: /503/ },
    "연결 실패": { fetchImpl: async () => { throw new TypeError("fetch failed 01012345678"); }, calls: 2, msg: /연결 실패/ },
    "JSON 아님": { fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError("x"); } }), calls: 1, msg: /JSON/ },
    "모양 이상": { fetchImpl: async () => jsonRes(200, body([order({ items: [item({ status: "?" })] })])), calls: 1, msg: /응답 모양/ },
    "시간 초과": {
      fetchImpl: (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      calls: 2, msg: /시간 초과/, timeoutMs: 5,
    },
    // 머리말은 왔는데 본문을 읽다가 시간 제한에 걸림 — «JSON 이 아닙니다»가 아니라 «시간 초과»여야 하고 한 번 더 시도한다(2026-11-17)
    "본문 읽기 시간 초과": {
      fetchImpl: async (_u, init) => ({
        ok: true, status: 200,
        json: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      }),
      calls: 2, msg: /^소명엔비씨 응답 시간 초과$/, timeoutMs: 5,
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
  assert.deepEqual(okBody, { ok: true, from: "2026-11-01", to: "2026-11-05", receivedOrders: 1, receivedItems: 1, savedOrders: 1, savedItems: 1, canceledMissingItems: 0 });

  // 기간을 주지 않으면 «오늘 포함 80일» 창을 소명엔비씨에 요청한다(매시 cron 이 부르는 모양)
  urls.length = 0;
  const plain = await route.GET(req(""));
  assert.equal(plain.status, 200);
  const asked = new URL(urls[0]).searchParams;
  const plainBody = await plain.json();
  assert.equal(plainBody.from, asked.get("from"));
  assert.equal(Math.round((Date.parse(`${asked.get("to")}T00:00:00Z`) - Date.parse(`${asked.get("from")}T00:00:00Z`)) / 86400000), 79, "오늘 포함 80일");
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
  itemStatus: "SHIPPING", canceled: false, buyerPhoneDigits: ME, receiverPhoneDigits: null, studentName: "김루빈", printName: "RUBIN", trackingNo: "TRACK-999", ...extra,
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
  // 인쇄 이름은 화면 줄에 들어간다(2026-11-17 r3) — 전화번호·학생 이름·송장번호는 여전히 없다
  for (const o of out) for (const k of Object.keys(o)) assert.doesNotMatch(k, /phone|studentName|tracking|stiz/i, k);
  assert.ok(out.every((o) => o.printName === "RUBIN"));
  assert.doesNotMatch(JSON.stringify(out), /TRACK-999|01012345678|김루빈/);
  assert.deepEqual(rules.toChildShopUniformOrders(rows, { phoneKey: null, childNameKey: "김루빈" }), []);
  assert.deepEqual(rules.toChildShopUniformOrders(rows, { phoneKey: ME, childNameKey: "" }), []);
});

test("⑥ 이름 두 기준: 품목 이름이 «아이 열쇠» 또는 «띄어쓰기만 지운 아이 전체 이름»과 같으면 통과(2026-11-17)", () => {
  // 아이 «김루빈A» → 열쇠 «김루빈», 전체 이름 «김루빈A»
  const keys = { phoneKey: ME, childNameKey: rules.childUniformNameKey("김루빈A"), childFullNameKey: rules.orderItemNameKey("김루빈A") };
  assert.deepEqual([keys.childNameKey, keys.childFullNameKey], ["김루빈", "김루빈A"]);
  const names = ["김루빈", "김루빈A", "김 루빈 A", "김루빈B", "김루빈a", "김루빈AA", "김하빈", "", null];
  const shop = rules.toChildShopUniformOrders(names.map((n, i) => shopRow({ itemId: String(i), studentName: n })), keys);
  assert.deepEqual(shop.map((o) => o.id), ["shop:0", "shop:1", "shop:2"], "쇼핑몰");
  const site = rules.toChildUniformOrders(names.map((n, i) => siteRow({ itemId: String(i), studentName: n })), keys);
  assert.deepEqual(site.map((o) => o.id), ["0", "1", "2"], "사이트도 같은 기준");
  for (const [name, expected] of [["김루빈", true], ["김루빈A", true], ["김루빈B", false], ["", false], [null, false]]) {
    assert.equal(rules.orderItemNameMatches(name, keys), expected, String(name));
  }
  // 전체 이름 열쇠를 안 넘기면(옛 부르는 쪽) 아이 열쇠만으로 맞춘다
  assert.equal(rules.orderItemNameMatches("김루빈A", { childNameKey: "김루빈" }), false);
  assert.equal(rules.orderItemNameMatches("김루빈", { childNameKey: "김루빈" }), true);
  // 열쇠가 비면 무엇과도 맞지 않는다(빈 이름끼리 맞는 일 없음)
  assert.equal(rules.orderItemNameMatches("", { childNameKey: "", childFullNameKey: "" }), false);
  // 이름이 맞아도 전화번호가 다르면 여전히 제외
  assert.deepEqual(rules.toChildShopUniformOrders([shopRow({ studentName: "김루빈A", buyerPhoneDigits: "01099990000" })], keys), []);
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
    // 주문서에 구분 글자까지 적은 품목(«김루빈A») — 아이 전체 이름과 같아 보인다 / 다른 구분 글자(«김루빈B»)는 안 보인다
    shopRow({ itemId: "mine-full", orderYmd: "2026-10-20", studentName: "김루빈A", printName: null }),
    shopRow({ itemId: "other-suffix", orderYmd: "2026-10-21", studentName: "김루빈B" }),
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
      const [phone, nameKey, fullKey] = values;
      return world.site.filter((o) => o.parentPhoneDigits === phone && [nameKey, fullKey].includes(o.studentName.replace(/\s/g, "")));
    }
    if (sql.includes(`FROM "UniformShopOrder" o`)) {
      if (!tables) throw new Error('relation "UniformShopOrder" does not exist');
      if (leaky) return world.shop;
      const [phone, nameKey, fullKey] = values;
      return world.shop.filter((o) => (o.buyerPhoneDigits === phone || o.receiverPhoneDigits === phone) && o.studentName !== null && [nameKey, fullKey].includes(o.studentName.replace(/\s/g, "")));
    }
    throw new Error("unexpected sql");
  };
}

test("⑥ 조회: 사이트 + 쇼핑몰(구매자·수령인 번호) 합쳐 최신순 · 쇼핑몰 SQL 은 본인 번호·이름 열쇠 둘로만 · 인쇄 이름 조회·송장번호 미조회", async () => {
  const { run, calls } = loadQuery(fakeWorld());
  const out = await run("mom", "kidA");
  assert.deepEqual(out.map((o) => o.id), ["shop:mine-buyer", "site-1", "shop:mine-receiver", "shop:mine-full"]);
  assert.deepEqual(out.map((o) => o.source), ["shop", "site", "shop", "shop"]);
  assert.deepEqual(out.map((o) => o.statusLabel), ["배송 중", "주문 완료", "배송 완료", "배송 중"]);
  // 인쇄 이름: 쇼핑몰은 printName, 값이 없으면 null(줄에서 생략)
  assert.deepEqual(out.map((o) => o.printName), ["RUBIN", null, "RUBIN", null]);
  // 왕복 3번: 권한 → (사이트 + 쇼핑몰 함께). 표 존재 확인(to_regclass)은 더 하지 않는다(2026-11-17)
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => !c.sql.includes("to_regclass")));
  const shopCall = calls[2];
  assert.deepEqual(shopCall.values, [ME, "김루빈", "김루빈A"], "본인 번호 + 아이 열쇠 + 띄어쓰기만 지운 전체 이름");
  assert.match(shopCall.sql, /o\."buyerPhoneDigits" = \$1 OR o\."receiverPhoneDigits" = \$1/);
  assert.match(shopCall.sql, /i\."studentName" IS NOT NULL/);
  assert.match(shopCall.sql, /regexp_replace\(i\."studentName", '\\s', '', 'g'\) IN \(\$2, \$3\)/, "이름 두 기준");
  assert.match(shopCall.sql, /i\."printName"/, "인쇄 이름은 고른다(r3)");
  assert.doesNotMatch(shopCall.sql, /trackingNo|AT TIME ZONE/, "송장번호 미조회, date 는 시간대 변환 없음");
  // 사이트 주문도 같은 이름 기준 + 이니셜(인쇄 이름)
  assert.deepEqual(calls[1].values, [ME, "김루빈", "김루빈A"]);
  assert.match(calls[1].sql, /regexp_replace\(i\."studentName", '\\s', '', 'g'\) IN \(\$2, \$3\)/);
  assert.match(calls[1].sql, /i\.initials AS "printName"/);
  for (const o of out) for (const k of Object.keys(o)) assert.doesNotMatch(k, /phone|studentName|tracking|stiz|parentName/i);
  assert.doesNotMatch(JSON.stringify(out), /TRACK-999|01012345678|010-1234|남의 주문|김하빈/);
});

test("⑥ SQL 이 조건을 놓쳐도 규칙이 한 번 더 거른다(이중 확인)", async () => {
  const { run } = loadQuery(fakeWorld({ leaky: true }));
  const out = await run("mom", "kidA");
  assert.deepEqual(out.filter((o) => o.source === "shop").map((o) => o.id), ["shop:mine-buyer", "shop:mine-receiver", "shop:mine-full"]);
});

test("⑥ 표가 없는 DB(쇼핑몰 조회 실패) → 쇼핑몰은 빈 목록, 사이트 주문은 그대로 · 로그에 값 없음", async (t) => {
  // 표 존재 확인을 뺐으므로(2026-11-17) 표가 없으면 조회가 실패한다 — 그 실패를 빈 목록으로 바꾼다
  const savedError = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(" "));
  t.after(() => { console.error = savedError; });
  const { run } = loadQuery(fakeWorld({ tables: false }));
  const out = await run("mom", "kidA");
  assert.deepEqual(out.map((o) => o.id), ["site-1"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /쇼핑몰 주문 조회 실패/);
  assert.doesNotMatch(logs[0], /01012345678|김루빈|relation/);
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
  // 인쇄 이름은 등번호 바로 뒤(2026-11-17 r3). 사이트 줄(siteRow)은 인쇄 이름이 없어 생략된다
  assert.match(html, /어웨이 · 23번 · RUBIN · 상의 130 · 하의 130 · 2벌/);
  assert.match(html, /기본형 · 7번 · 상의 140 · 하의 140 · 1벌/);
  assert.match(html, /입금 전/);
  assert.ok(html.indexOf("쇼핑몰") < html.indexOf("사이트"), "최신(쇼핑몰 11-10)이 위");
  assert.doesNotMatch(html, /TRACK-999|01012345678|학원에 문의/);
  assert.doesNotMatch(html.replace(/material-symbols-outlined[^>]*>(expand_less|expand_more)</g, ""), /material-symbols/);
});

test("⑦ 인쇄 이름: 값이 있을 때만 등번호 뒤에 · 사이트 주문은 «이니셜» 칸 · 등번호가 없어도 이름만 보인다", () => {
  const line = (extra) => rules.uniformOrderLine({ design: "기본형", backNumber: "23", topSize: "130", bottomSize: null, quantity: 1, ...extra });
  assert.equal(line({ printName: "LEE JUN" }), "기본형 · 23번 · LEE JUN · 상의 130 · 1벌");
  assert.equal(line({ printName: null }), "기본형 · 23번 · 상의 130 · 1벌");
  assert.equal(line({ printName: "  " }), "기본형 · 23번 · 상의 130 · 1벌", "공백뿐이면 생략");
  assert.equal(line({}), "기본형 · 23번 · 상의 130 · 1벌", "옛 데이터(칸 없음)");
  assert.equal(line({ backNumber: null, printName: "GENO" }), "기본형 · GENO · 상의 130 · 1벌");
  const site = rules.toChildUniformOrders([siteRow({ printName: " GENO " })], { phoneKey: ME, childNameKey: "김루빈" });
  assert.equal(site[0].printName, "GENO");
  assert.equal(rules.uniformOrderLine(site[0]), "기본형 · 7번 · GENO · 상의 140 · 하의 140 · 1벌");
});

test("⑦ 머리줄 «N건»은 취소된 품목을 빼고 센다 — 전부 취소면 건수 글자 없음, 취소된 줄은 그대로 보인다", () => {
  const keys = { phoneKey: ME, childNameKey: "김루빈" };
  const mixed = [
    ...rules.toChildShopUniformOrders([
      shopRow({ itemId: "a" }),
      shopRow({ itemId: "b", itemStatus: "CANCELED" }),
      shopRow({ itemId: "c", canceled: true }), // 주문 전체 취소
      shopRow({ itemId: "d", itemStatus: "RETURNED" }), // 반품도 «N건»에서 뺀다(줄은 «반품» 배지로 남는다)
    ], keys),
    ...rules.toChildUniformOrders([siteRow({ itemId: "s1" }), siteRow({ itemId: "s2", orderStatus: "CANCELED" })], keys),
  ];
  assert.equal(mixed.length, 6);
  assert.equal(rules.countActiveUniformOrders(mixed), 2);
  const render = (orders) => renderToStaticMarkup(React.createElement(Sections.ChildUniformOrdersSection, { uniform: { status: null, receivedYmd: null, freeGrant: null, orders } }));
  const html = render(mixed);
  assert.match(html, />2건</);
  assert.doesNotMatch(html, />6건</);
  assert.equal((html.match(/<li /g) ?? []).length, 6, "취소된 줄도 목록에는 남는다");
  const allCanceled = render(mixed.filter((o) => o.statusLabel === "취소"));
  assert.doesNotMatch(allCanceled, /\d건</, "전부 취소면 건수 글자를 그리지 않는다");
  assert.equal((allCanceled.match(/<li /g) ?? []).length, 3);
});
