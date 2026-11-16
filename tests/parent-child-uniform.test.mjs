// 학부모 «아이 정보» 유니폼 번호·유니폼 신청 내역(2026-11-16 원장 지시) — 실제로 실행·렌더해서 확인한다.
//  ① 규칙: 이름 열쇠(띄어쓰기·A/B 접미사)·전화번호 열쇠(자리채움 거절)·상태 라벨·번호 한 줄("0" 도 번호)
//  ② 매칭: 전화번호 불일치·이름 불일치·동명이인(다른 번호)·A/B 접미사·전화번호 없음 → 빈 목록, 금지 칸 없음
//  ③ 조회: 남의 아이면 주문 표를 읽지 않는다 · 주문 SQL 은 본인 번호·이름 열쇠로만 묶인다 · 금지 칸 미조회
//  ④ 렌더: 아이 정보 «유니폼» 행 · 신청 내역 줄 · 빈 내역 문구 · 아이콘 없음
import assert from "node:assert/strict";
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

const rules = load("src/lib/parent/childUniformRules.ts");

/** 화면 줄에 들어가면 안 되는 칸 이름 */
const FORBIDDEN_KEYS = /phone|parentName|customerMemo|stiz|lastError|studentName|partnerRequestId/i;

// ── ① 규칙 ─────────────────────────────────────────────────────────────────

test("① 이름 열쇠: 띄어쓰기 제거 · 끝의 A/B·숫자 구분 글자 제거 · 다 떼면 원래 값", () => {
  assert.equal(rules.childUniformNameKey("김루빈"), "김루빈");
  assert.equal(rules.childUniformNameKey("김루빈A"), "김루빈");
  assert.equal(rules.childUniformNameKey("김루빈 B"), "김루빈");
  assert.equal(rules.childUniformNameKey("김루빈2"), "김루빈");
  assert.equal(rules.childUniformNameKey("John"), "John", "영문 이름은 다 떼지 않는다");
  assert.equal(rules.childUniformNameKey(null), "");
  assert.equal(rules.orderItemNameKey(" 김 루빈 "), "김루빈");
  assert.equal(rules.orderItemNameKey("김루빈A"), "김루빈A", "주문 쪽은 띄어쓰기만");
});

test("① 전화번호 열쇠: 숫자만 · 비었음·짧음·자리채움(00000000000)은 null", () => {
  assert.equal(rules.parentOrderPhoneKey("010-1234-5678"), "01012345678");
  assert.equal(rules.parentOrderPhoneKey("01012345678"), "01012345678");
  assert.equal(rules.parentOrderPhoneKey(""), null);
  assert.equal(rules.parentOrderPhoneKey(null), null);
  assert.equal(rules.parentOrderPhoneKey("00000000000"), null);
  assert.equal(rules.parentOrderPhoneKey("1234"), null);
});

test("① 상태 라벨: 취소 · 주문 완료(주문번호·SENT·DUPLICATE) · 접수", () => {
  const s = (orderStatus, stizSyncStatus, hasOrderNumber = false) => rules.parentUniformOrderStatus({ orderStatus, stizSyncStatus, hasOrderNumber }).label;
  assert.equal(s("CANCELED", "SENT", true), "취소");
  assert.equal(s("RECEIVED", "SENT"), "주문 완료");
  assert.equal(s("RECEIVED", "DUPLICATE"), "주문 완료");
  assert.equal(s("RECEIVED", "RETRY_WAIT", true), "주문 완료");
  assert.equal(s("RECEIVED", "PENDING"), "접수");
  assert.equal(s("RECEIVED", "NEEDS_REVIEW"), "접수");
});

test("① 번호 한 줄: 값이 있는 것만, \"0\" 도 번호, 둘 다 없으면 «번호 없음»", () => {
  assert.equal(rules.uniformProfileLine({ status: "보유", number: "23", teamNumber: "0" }), "보유 · 유니폼 번호 23번 · 대표팀 번호 0번");
  assert.equal(rules.uniformProfileLine({ status: null, number: "0", teamNumber: null }), "유니폼 번호 0번");
  assert.equal(rules.uniformProfileLine({ status: null, number: null, teamNumber: "7" }), "대표팀 번호 7번");
  assert.equal(rules.uniformProfileLine({ status: "미신청", number: " ", teamNumber: null }), "미신청 · 번호 없음");
  assert.equal(rules.uniformProfileLine({}), "번호 없음");
  assert.equal(rules.uniformOrderLine({ design: "기본형", backNumber: "0", topSize: "130", bottomSize: "140", quantity: 2 }), "기본형 · 0번 · 상의 130 · 하의 140 · 2벌");
  assert.equal(rules.uniformOrderLine({ design: null, backNumber: null, topSize: null, bottomSize: null, quantity: 1 }), "유니폼 · 1벌");
});

// ── ② 매칭(이중 확인) ─────────────────────────────────────────────────────

const ME = "01012345678";
const orderRow = (extra = {}) => ({
  itemId: "i1", appliedYmd: "2026-11-03", design: "기본형", backNumber: "23", topSize: "130", bottomSize: "130", quantity: 1,
  orderStatus: "RECEIVED", stizSyncStatus: "SENT", hasOrderNumber: true, parentPhoneDigits: ME, studentName: "김루빈", ...extra,
});

test("② 전화번호·이름이 모두 맞는 품목만 — 불일치·동명이인·열쇠 없음은 빈 목록, 금지 칸 없음", () => {
  const keys = { phoneKey: ME, childNameKey: "김루빈" };
  const rows = [
    orderRow(),
    orderRow({ itemId: "other-phone", parentPhoneDigits: "01099998888" }), // 동명이인(다른 집 번호)
    orderRow({ itemId: "sibling", studentName: "김하빈" }), // 같은 번호의 형제 — 이름 불일치
    orderRow({ itemId: "spaced", studentName: "김 루빈" }), // 띄어쓰기는 같은 이름
  ];
  const out = rules.toChildUniformOrders(rows, keys);
  assert.deepEqual(out.map((o) => o.id), ["i1", "spaced"]);
  for (const o of out) for (const key of Object.keys(o)) assert.doesNotMatch(key, FORBIDDEN_KEYS, `금지 칸 ${key}`);
  assert.deepEqual(rules.toChildUniformOrders(rows, { phoneKey: null, childNameKey: "김루빈" }), [], "전화번호 없으면 빈 목록");
  assert.deepEqual(rules.toChildUniformOrders(rows, { phoneKey: ME, childNameKey: "" }), [], "이름 열쇠 없으면 빈 목록");
  assert.deepEqual(rules.toChildUniformOrders([orderRow({ parentPhoneDigits: "01099998888" })], keys), [], "전화번호 불일치");
  assert.equal(out[0].statusLabel, "주문 완료");
  assert.equal(out[0].backNumber, "23");
});

// ── ③ 조회 ─────────────────────────────────────────────────────────────────

function loadQuery(fake) {
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return fake(sql, values); } };
  const q = load("src/lib/parent/childUniformQuery.ts", {
    "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
  });
  return { run: (parent, kid) => q.loadChildUniformOrders(db, parent, kid), calls };
}

/** 가짜 DB — 학생 표(권한)와 주문 표를 SQL 의 조건대로 흉내 낸다 */
function fakeDb({ students, users, orders }) {
  return (sql, values) => {
    if (sql.includes(`FROM "Student" s`)) {
      const [sid, uid] = values;
      const s = students.find((x) => x.id === sid && x.parentId === uid && !x.merged);
      const me = users.find((u) => u.id === uid);
      return s && me ? [{ name: s.name, mePhone: me.phone }] : [];
    }
    if (sql.includes(`FROM "UniformOrder" o`)) {
      const [phone, nameKey] = values;
      return orders.filter((o) => o.parentPhoneDigits === phone && o.studentName.replace(/\s/g, "") === nameKey);
    }
    // 쇼핑몰 표(2026-11-16) — 이 파일에서는 «아직 없는 DB»로 둔다(쇼핑몰 매칭은 uniform-shop-orders.test.mjs)
    if (sql.includes("to_regclass")) return [{ ready: false }];
    throw new Error("unexpected sql");
  };
}

const world = {
  users: [
    { id: "mom", phone: "010-1234-5678" },
    { id: "noPhone", phone: "" },
    { id: "filler", phone: "00000000000" },
    { id: "otherMom", phone: "010-9999-8888" },
  ],
  students: [
    { id: "kidA", name: "김루빈A", parentId: "mom" },
    { id: "kidNoPhone", name: "김루빈", parentId: "noPhone" },
    { id: "kidFiller", name: "김루빈", parentId: "filler" },
    { id: "otherKid", name: "김루빈", parentId: "otherMom" },
    { id: "mergedKid", name: "김루빈", parentId: "mom", merged: true },
  ],
  orders: [
    orderRow({ itemId: "mine", parentPhoneDigits: "01012345678", studentName: "김루빈" }),
    orderRow({ itemId: "theirs", parentPhoneDigits: "01099998888", studentName: "김루빈", design: "남의 주문" }),
  ],
};

test("③ A/B 접미사 아이 → 내 번호로 낸 «김루빈» 주문만, 동명이인 다른 집 주문은 안 보인다", async () => {
  const { run, calls } = loadQuery(fakeDb(world));
  const out = await run("mom", "kidA");
  assert.deepEqual(out.map((o) => o.id), ["mine"]);
  assert.equal(calls.length, 3, "권한·사이트 주문·쇼핑몰 표 확인");
  assert.match(calls[2].sql, /to_regclass/);
  assert.deepEqual(calls[0].values, ["kidA", "mom"]);
  assert.match(calls[0].sql, /s\.id = \$1 AND s\."parentId" = \$2/, "권한 확인을 같은 SQL 에서");
  assert.match(calls[0].sql, /"mergedIntoStudentId" IS NULL/, "병합 학생 제외");
  assert.deepEqual(calls[1].values, ["01012345678", "김루빈"], "본인 번호 + 이름 열쇠로만 묶는다");
  assert.match(calls[1].sql, /o\."parentPhoneDigits" = \$1/);
  assert.match(calls[1].sql, /AT TIME ZONE 'Asia\/Seoul'/);
  assert.doesNotMatch(calls[1].sql, /AT TIME ZONE 'UTC'/, "timestamptz 는 한 번만");
  assert.doesNotMatch(calls[1].sql, /customerMemo|lastError|parentName|stizMessage|o\."parentPhone"[^D]/, "금지 칸 미조회");
  for (const o of out) for (const key of Object.keys(o)) assert.doesNotMatch(key, FORBIDDEN_KEYS);
  assert.doesNotMatch(JSON.stringify(out), /01012345678|010-1234|남의 주문/);
});

test("③ 남의 아이 · 병합된 학생 · 전화번호 없음 · 자리채움 번호 → 빈 목록, 주문 표는 읽지 않는다", async () => {
  for (const [parent, kid] of [["mom", "otherKid"], ["mom", "mergedKid"], ["noPhone", "kidNoPhone"], ["filler", "kidFiller"], ["", "kidA"], ["mom", ""]]) {
    const { run, calls } = loadQuery(fakeDb(world));
    assert.deepEqual(await run(parent, kid), [], `${parent}/${kid}`);
    assert.ok(calls.every((c) => !c.sql.includes(`FROM "UniformOrder"`) && !c.sql.includes("UniformShop")), `${parent}/${kid}: 주문 표 미조회`);
  }
});

test("③ 소스 가드: PgBouncer — $queryRawUnsafe 만, 아이 기록 조회가 권한 확인 뒤 신청 내역을 부른다", () => {
  const src = read("src/lib/parent/childUniformQuery.ts");
  assert.doesNotMatch(src, /findMany|findFirst|upsert|\.create\(/);
  const record = read("src/lib/parent/childRecordQuery.ts");
  assert.match(record, /section\("uniformOrders", \(\) => loadChildUniformOrders\(db, parentUserId, sid\)\)/);
  assert.match(record, /section\("uniformNumbers"/);
});

// ── ④ 렌더 ─────────────────────────────────────────────────────────────────

const link = { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) };
const ChildRecordClient = load("src/app/mypage/record/ChildRecordClient.tsx", {
  "next/link": link,
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
  "@/components/admin/list/ListDetailPanel": { __esModule: true, default: ({ children }) => React.createElement("div", null, children) },
}).default;
const profile = {
  birthYmd: "2015-05-01", gender: "여자", school: "다산초", gradeText: "초5", enrollYmd: "2024-03-02",
  guardians: { representativeName: "엄마", meIsRepresentative: true, me: { name: "엄마", phone: "010-1234-5678" }, familyNames: [] },
  classes: [], makeup: { available: 0, reserved: 0, nearestExpiryYmd: null },
};
const record = (uniform) => ({
  student: { id: "kid", name: "합성", canPay: true, hasBaseline: false },
  today: "2026-11-16", payments: [], attendance: [], timeline: { enrollments: [], changes: [] }, seasonal: [],
  uniform, reports: { reports: 0, feedbacks: 0 }, tenure: null,
  profile, shuttle: { regular: { rosterMonth: null, weekly: [], days: [] }, others: [], driver: null },
});
const render = (uniform) => renderToStaticMarkup(React.createElement(ChildRecordClient, { record: record(uniform), childList: [{ id: "kid", name: "합성" }], initialYear: null }));

test("④ 아이 정보 «유니폼» 행 + 신청 내역 줄(신청일·내용·상태), 아이콘 없음", () => {
  const view = rules.toChildUniformOrders([orderRow({ backNumber: "0" }), orderRow({ itemId: "c", orderStatus: "CANCELED", appliedYmd: "2026-10-01" })], { phoneKey: ME, childNameKey: "김루빈" });
  const html = render({ status: "보유", receivedYmd: null, freeGrant: null, number: "23", teamNumber: "0", numbersLoaded: true, orders: view });
  assert.match(html, /보유 · 유니폼 번호 23번 · 대표팀 번호 0번/);
  assert.match(html, /유니폼 신청 내역/);
  assert.match(html, /26\.11\.03/);
  assert.match(html, /기본형 · 0번 · 상의 130 · 하의 130 · 1벌/);
  assert.match(html, /주문 완료/);
  assert.match(html, /취소/);
  assert.ok(html.indexOf("아이 정보") < html.indexOf("유니폼 신청 내역"));
  const icons = [...html.matchAll(/class="material-symbols-outlined[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert.ok(icons.every((name) => name === "expand_less" || name === "expand_more"), icons.join(","));
});

test("④ 번호 없음·신청 내역 없음·못 읽음·옛 모양", () => {
  const empty = render({ status: null, receivedYmd: null, freeGrant: null, number: null, teamNumber: null, numbersLoaded: true, orders: [] });
  assert.match(empty, /번호 없음/);
  assert.match(empty, /신청 내역이 없어요/);
  assert.match(empty, /data-outside-link/);
  assert.match(empty, /유니폼 신청 ▸/);
  assert.doesNotMatch(empty, /학원에 문의/);
  const failed = render({ status: null, receivedYmd: null, freeGrant: null, number: null, teamNumber: null, numbersLoaded: false, orders: null });
  assert.match(failed, /유니폼 신청 내역을 불러오지 못했어요/);
  const old = render({ status: null, receivedYmd: null, freeGrant: null });
  assert.doesNotMatch(old, /유니폼 신청 내역|번호 없음/, "옛 모양 데이터면 새 칸을 그리지 않는다");
});
