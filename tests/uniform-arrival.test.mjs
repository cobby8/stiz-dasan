// 유니폼 신청 현황 · 학원 도착 알림(2026-11-21 원장 «학원 도착을 누르면 학부모에게 도착 알림»)
//  ① 단계: 신청 → 원장 확인(무료 증정) → 본사 주문·생산 중 → 학원 도착 → 수령 · 취소
//  ② 경고: 상·하 사이즈 빈칸 · 같은 반 등번호 겹침(이번 신청끼리·이미 정해진 번호) · 다른 반은 경고 없음 · 학생 미연결
//  ③ 필터·건수 · 문자 묶음(학생당 한 통·중복 방지 키 고정)
//  ④ 도착 처리(가짜 DB·가짜 문자): 학생당 문자 한 통 · 두 번 눌러도 문자 한 번(멱등) · 취소·미연결·문자 꺼짐 · 번호 비노출
//  ⑤ 수령 완료 · 서버 액션·메뉴·마이그레이션·문자 틀 모양
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
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

const rules = load("src/lib/uniform/arrivalRules.ts");
const service = load("src/lib/uniform/arrivalService.ts");

const FREE_MEMO = "[3년 재원 무료 증정] 메모";

function row(over = {}) {
  return {
    source: "SITE", itemId: "i1", orderId: "o1", appliedYmd: "2026-11-05",
    studentName: "김하나", design: "블랙", printName: null, backNumber: "9", topSize: "130", bottomSize: "130", quantity: 1,
    orderStatus: "RECEIVED", stizSyncStatus: "SENT", hasOrderNumber: true, customerMemo: null,
    shopItemStatus: null, shopCanceled: null,
    studentId: "s1", candidateCount: 1, linkedByGrant: false,
    arrivedAt: null, receivedAt: null, noticeStatus: null,
    ...over,
  };
}

// ── ① 단계 ────────────────────────────────────────────────────────────────

test("단계: 사이트 신청·무료 증정·본사몰·도착·수령·취소", () => {
  const stage = (over) => rules.uniformStage(row(over));
  assert.equal(stage({ stizSyncStatus: "PENDING", hasOrderNumber: false }), "APPLIED");
  assert.equal(stage({ stizSyncStatus: "NEEDS_REVIEW", hasOrderNumber: false, customerMemo: FREE_MEMO }), "OWNER_REVIEW");
  // 무료 증정이 아닌 확인 필요는 «신청»(전송 오류) — 원장 확인 단계가 아니다
  assert.equal(stage({ stizSyncStatus: "NEEDS_REVIEW", hasOrderNumber: false }), "APPLIED");
  assert.equal(stage({ stizSyncStatus: "SENT" }), "ORDERED");
  assert.equal(stage({ arrivedAt: "2026-11-21T01:00:00.000Z" }), "ARRIVED");
  // 무료 증정이 «원장 확인»에 머물러 있어도 원장이 받아 왔으면 도착이 앞선다
  assert.equal(stage({ stizSyncStatus: "NEEDS_REVIEW", customerMemo: FREE_MEMO, arrivedAt: "2026-11-21T01:00:00.000Z" }), "ARRIVED");
  assert.equal(stage({ arrivedAt: "x", receivedAt: "2026-11-22T01:00:00.000Z" }), "RECEIVED");
  assert.equal(stage({ orderStatus: "CANCELED", arrivedAt: "x" }), "CANCELED");

  const shop = (over) => rules.uniformStage(row({ source: "SHOP", stizSyncStatus: null, hasOrderNumber: null, ...over }));
  assert.equal(shop({ shopItemStatus: "UNPAID" }), "APPLIED");
  assert.equal(shop({ shopItemStatus: "PREPARING" }), "ORDERED");
  assert.equal(shop({ shopItemStatus: "PREPARING", arrivedAt: "x" }), "ARRIVED");
  assert.equal(shop({ shopItemStatus: "PAID", shopCanceled: true }), "CANCELED");
  assert.equal(shop({ shopItemStatus: "RETURNED" }), "CANCELED");
});

test("품목 열쇠: 출처:id 만 받는다", () => {
  assert.deepEqual(rules.parseUniformItemKey("SHOP:123:4"), { source: "SHOP", itemId: "123:4" });
  assert.equal(rules.parseUniformItemKey("OTHER:1"), null);
  assert.equal(rules.parseUniformItemKey("SITE:"), null);
  assert.equal(rules.parseUniformItemKey(5), null);
});

// ── ② 경고 ────────────────────────────────────────────────────────────────

test("경고: 하의 사이즈 빈칸 · 같은 반 등번호 겹침 · 다른 반은 경고 없음 · 학생 미연결", () => {
  const classes = new Map([
    ["s1", [{ classId: "c1", className: "토 3교시" }]],
    ["s2", [{ classId: "c1", className: "토 3교시" }]],
    ["s3", [{ classId: "c2", className: "수 4교시" }]],
  ]);
  const board = rules.buildUniformBoard([
    row({ itemId: "a", studentId: "s1", studentName: "김하나", backNumber: "9", bottomSize: "" }),
    row({ itemId: "b", studentId: "s2", studentName: "이둘", backNumber: "#9" }),
    row({ itemId: "c", studentId: "s3", studentName: "박셋", backNumber: "9" }),
    row({ itemId: "d", studentId: null, candidateCount: 0, studentName: "최넷", backNumber: "9" }),
    row({ itemId: "e", studentId: null, candidateCount: 2, studentName: "동명", backNumber: "1" }),
  ], classes);
  const byId = Object.fromEntries(board.map((item) => [item.itemId, item]));
  const codes = (id) => byId[id].warnings.map((w) => w.code).sort();

  assert.deepEqual(codes("a"), ["DUPLICATE_NUMBER", "MISSING_BOTTOM_SIZE"]);
  assert.match(byId.a.warnings.find((w) => w.code === "DUPLICATE_NUMBER").message, /토 3교시 이둘/);
  assert.deepEqual(codes("b"), ["DUPLICATE_NUMBER"]);
  assert.deepEqual(codes("c"), [], "다른 반의 같은 번호는 겹침이 아니다");
  assert.deepEqual(codes("d"), ["NO_STUDENT"]);
  assert.match(byId.e.warnings[0].message, /여러 명/);
  assert.deepEqual(byId.a.classNames, ["토 3교시"]);
});

test("경고: 같은 반 친구에게 이미 정해진 번호와 겹침 · 본인 번호는 겹침 아님 · 취소 줄은 비교에서 뺀다", () => {
  const classes = new Map([["s1", [{ classId: "c1", className: "토 3교시" }]], ["s2", [{ classId: "c1", className: "토 3교시" }]]]);
  const board = rules.buildUniformBoard([
    row({ itemId: "a", studentId: "s1", backNumber: "7" }),
    row({ itemId: "b", studentId: "s2", backNumber: "23", orderStatus: "CANCELED" }),
  ], classes, [
    { classId: "c1", studentId: "s1", studentName: "김하나", uniformNumber: "7" },
    { classId: "c1", studentId: "s9", studentName: "정아홉", uniformNumber: "23" },
  ]);
  assert.deepEqual(board[0].warnings, []);
  assert.deepEqual(board[1].warnings, [], "취소 줄은 경고를 달지 않는다");
  const clash = rules.buildUniformBoard([row({ itemId: "a", studentId: "s1", backNumber: "23" })], classes, [
    { classId: "c1", studentId: "s9", studentName: "정아홉", uniformNumber: "23" },
  ]);
  assert.match(clash[0].warnings[0].message, /정아홉/);
});

// ── ③ 필터·문자 묶음 ──────────────────────────────────────────────────────

test("필터: 미도착만·출처별·경고만 · 건수", () => {
  const board = rules.buildUniformBoard([
    row({ itemId: "a" }),
    row({ itemId: "b", source: "SHOP", shopItemStatus: "PREPARING", arrivedAt: "x" }),
    row({ itemId: "c", arrivedAt: "x", receivedAt: "y" }),
    row({ itemId: "d", orderStatus: "CANCELED" }),
    row({ itemId: "e", topSize: "" }),
  ], new Map());
  const ids = (filter) => rules.filterUniformBoard(board, filter).map((item) => item.itemId);
  assert.deepEqual(ids({ progress: "NOT_ARRIVED", source: "ALL" }), ["a", "e"]);
  assert.deepEqual(ids({ progress: "ARRIVED", source: "ALL" }), ["b"]);
  assert.deepEqual(ids({ progress: "RECEIVED", source: "ALL" }), ["c"]);
  assert.deepEqual(ids({ progress: "ALL", source: "SHOP" }), ["b"]);
  assert.deepEqual(ids({ progress: "ALL", source: "ALL", warningsOnly: true }), ["e"]);
  assert.deepEqual(rules.countUniformBoard(board), { total: 5, notArrived: 2, arrived: 1, received: 1, warnings: 1 });
  assert.equal(board.find((item) => item.itemId === "b").canReceive, true);
  assert.equal(board.find((item) => item.itemId === "d").canArrive, false);
});

test("문자 묶음: 학생당 한 통 · 중복 방지 키는 가장 작은 도착 id · 미연결은 따로", () => {
  const plan = rules.planUniformArrivalNotices([
    { arrivalId: "z9", key: "SHOP:1", studentId: "s1", studentName: "김하나" },
    { arrivalId: "a1", key: "SHOP:2", studentId: "s1", studentName: "김하나" },
    { arrivalId: "m5", key: "SITE:3", studentId: "s2", studentName: "이둘" },
    { arrivalId: "q2", key: "SITE:4", studentId: null, studentName: "최넷" },
  ]);
  assert.equal(plan.notices.length, 2);
  const s1 = plan.notices.find((n) => n.studentId === "s1");
  assert.deepEqual(s1.arrivalIds, ["a1", "z9"]);
  assert.equal(s1.eventId, "uniform-arrival:a1");
  assert.deepEqual(plan.skipped, [{ arrivalId: "q2", key: "SITE:4" }]);
  assert.equal(rules.noticeChildName("김루빈A"), "김루빈");
  assert.equal(rules.uniformNoticeStatusFromSms({ ok: false, reason: "AUTOMATION_DISABLED" }), "DISABLED");
  assert.equal(rules.uniformNoticeStatusFromSms({ ok: true, reason: "DUPLICATE_SKIPPED" }), "SENT");
  assert.equal(rules.uniformNoticeStatusFromSms({ ok: false, reason: "timeout" }), "FAILED");
});

// ── ④ 도착 처리(가짜 DB) ──────────────────────────────────────────────────

const PARENT_PHONE = "01012345678";

function fakeDb(baseRows) {
  const arrivals = new Map(); // key → { id, studentId, receivedAt, noticeStatus }
  const log = [];
  let seq = 0;
  const boardRows = () => baseRows.map((r) => {
    const a = arrivals.get(`${r.source}:${r.itemId}`);
    return { ...r, studentId: a?.studentId ?? r.studentId, arrivedAt: a ? new Date("2026-11-21T01:00:00Z") : null, receivedAt: a?.receivedAt ?? null, noticeStatus: a?.noticeStatus ?? null };
  });
  return {
    arrivals,
    log,
    async $queryRawUnsafe(sql, ...args) {
      log.push({ sql, args });
      if (sql.includes("WITH items AS")) return boardRows();
      if (sql.includes(`FROM "Enrollment" e JOIN "Class" c`)) return [];
      if (sql.includes(`INSERT INTO "UniformArrival"`)) {
        const [sources, items, sids] = args;
        const out = [];
        sources.forEach((src, i) => {
          const key = `${src}:${items[i]}`;
          if (arrivals.has(key)) return; // ON CONFLICT DO NOTHING
          const id = `arr${String(++seq).padStart(3, "0")}`;
          arrivals.set(key, { id, studentId: sids[i] || null, receivedAt: null, noticeStatus: null });
          out.push({ arrivalId: id, source: src, itemId: items[i], studentId: sids[i] || null });
        });
        return out;
      }
      if (sql.includes("AS phone")) return args[0] === "s-nophone" ? [{ phone: null }] : [{ phone: "010-1234-5678" }];
      if (sql.includes(`UPDATE "UniformArrival" a`)) {
        const [sources, items] = args;
        const out = [];
        sources.forEach((src, i) => {
          const a = arrivals.get(`${src}:${items[i]}`);
          if (a && !a.receivedAt) { a.receivedAt = new Date(); out.push({ studentId: a.studentId }); }
        });
        return out;
      }
      throw new Error(`예상 못 한 조회: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...args) {
      log.push({ sql, args });
      if (sql.includes(`UPDATE "UniformArrival"`) && sql.includes(`"noticeStatus" = $2`)) {
        for (const a of arrivals.values()) if (args[0].includes(a.id)) a.noticeStatus = args[1];
      }
      return 1;
    },
  };
}

function fakeSms(results = {}) {
  const calls = [];
  const send = async (phone, trigger, variables, options) => {
    calls.push({ phone, trigger, variables, options });
    return results[variables.childName] ?? { ok: true };
  };
  return { calls, send };
}

const BASE = [
  row({ itemId: "top", source: "SHOP", stizSyncStatus: null, shopItemStatus: "PREPARING", studentId: "s1", studentName: "김하나" }),
  row({ itemId: "bottom", source: "SHOP", stizSyncStatus: null, shopItemStatus: "PREPARING", studentId: "s1", studentName: "김하나" }),
  row({ itemId: "free", stizSyncStatus: "NEEDS_REVIEW", hasOrderNumber: false, customerMemo: FREE_MEMO, studentId: "s2", studentName: "이둘B", linkedByGrant: true }),
  row({ itemId: "nolink", studentId: null, candidateCount: 0, studentName: "최넷" }),
  row({ itemId: "cancel", orderStatus: "CANCELED", studentId: "s3", studentName: "박셋" }),
  row({ itemId: "nophone", studentId: "s-nophone", studentName: "정다섯" }),
];

test("도착: 학생당 문자 한 통(자동 문자 규칙 트리거) · 학생 상태 갱신 · 미연결·취소·번호 없음", async () => {
  const db = fakeDb(BASE);
  const sms = fakeSms();
  const keys = ["SHOP:top", "SHOP:bottom", "SITE:free", "SITE:nolink", "SITE:cancel", "SITE:nophone", "SITE:top", "bogus"];
  const result = await service.markUniformArrived({ db, sendSms: sms.send }, { keys, actorName: "원장" });

  assert.equal(result.arrived, 5);
  assert.equal(result.rejected, 2, "취소 줄·목록에 없는 줄은 처리하지 않는다");
  assert.deepEqual(result.notices, { SENT: 3, FAILED: 0, SKIPPED_NO_STUDENT: 1, SKIPPED_NO_PHONE: 1, DISABLED: 0 });

  // 상·하의 두 품목인 김하나는 한 통, 이둘B 는 구분 글자 뗀 이름으로 한 통
  assert.equal(sms.calls.length, 2);
  assert.deepEqual(sms.calls.map((c) => c.variables.childName).sort(), ["김하나", "이둘"]);
  for (const call of sms.calls) {
    assert.equal(call.trigger, "UNIFORM_ARRIVED_PARENT");
    assert.equal(call.phone, PARENT_PHONE);
    assert.equal(call.options.eventType, "UNIFORM_ARRIVED");
    assert.match(call.options.eventId, /^uniform-arrival:arr\d+$/);
  }
  // 학생 유니폼 상태: 학원 수령일·미수령(보유·수령완료는 그대로)·빈 칸만 채움
  const studentUpdate = db.log.find((entry) => entry.sql.includes(`UPDATE "Student" s`) && entry.sql.includes(`"uniformReceivedAt" = NOW()`));
  assert.ok(studentUpdate);
  assert.match(studentUpdate.sql, /IN \('보유', '수령완료'\) THEN s\."uniformStatus" ELSE '미수령'/);
  assert.match(studentUpdate.sql, /COALESCE\(s\."uniformAppliedAt"/);
  assert.ok(!studentUpdate.args[0].includes(null), "미연결 줄은 학생을 건드리지 않는다");
  // 결과에는 전화번호가 없다
  assert.ok(!JSON.stringify(result).includes(PARENT_PHONE));
  assert.equal(db.arrivals.get("SITE:nolink").noticeStatus, "SKIPPED_NO_STUDENT");
  assert.equal(db.arrivals.get("SITE:nophone").noticeStatus, "SKIPPED_NO_PHONE");
  assert.equal(db.arrivals.get("SHOP:top").noticeStatus, "SENT");
});

test("도착: 두 번 눌러도 문자는 한 번(멱등) · 동시에 누른 쪽은 빈손", async () => {
  const db = fakeDb(BASE);
  const sms = fakeSms();
  await service.markUniformArrived({ db, sendSms: sms.send }, { keys: ["SITE:free"], actorName: "원장" });
  const again = await service.markUniformArrived({ db, sendSms: sms.send }, { keys: ["SITE:free"], actorName: "원장" });
  assert.equal(again.arrived, 0);
  assert.equal(again.already, 1);
  assert.equal(sms.calls.length, 1);

  // 화면은 아직 «미도착»으로 읽었는데 그 사이 다른 사람이 처리한 경우 — INSERT 가 빈손이면 문자 없음
  const race = fakeDb(BASE);
  const originalQuery = race.$queryRawUnsafe.bind(race);
  race.$queryRawUnsafe = async (sql, ...args) => (sql.includes(`INSERT INTO "UniformArrival"`) ? [] : originalQuery(sql, ...args));
  const raced = await service.markUniformArrived({ db: race, sendSms: sms.send }, { keys: ["SHOP:top"], actorName: null });
  assert.equal(raced.arrived, 0);
  assert.equal(raced.already, 1);
  assert.equal(sms.calls.length, 1);
  const insert = db.log.find((entry) => entry.sql.includes(`INSERT INTO "UniformArrival"`));
  assert.match(insert.sql, /ON CONFLICT \("sourceType", "sourceItemId"\) DO NOTHING/);
});

test("도착: 자동 문자 꺼짐·실패는 기록하고 나머지는 계속 · 상한·빈 선택 거부", async () => {
  const db = fakeDb(BASE);
  const sms = fakeSms({ 김하나: { ok: false, reason: "AUTOMATION_DISABLED" } });
  const failing = async (phone, trigger, variables, options) => {
    if (variables.childName === "이둘") throw new Error(`boom ${phone}`);
    return sms.send(phone, trigger, variables, options);
  };
  const result = await service.markUniformArrived({ db, sendSms: failing }, { keys: ["SHOP:top", "SITE:free"], actorName: null });
  assert.equal(result.notices.DISABLED, 1);
  assert.equal(result.notices.FAILED, 1);
  const failedUpdate = db.log.find((entry) => entry.sql.includes(`"noticeStatus" = $2`) && entry.args[1] === "FAILED");
  assert.ok(!String(failedUpdate.args[2]).includes(PARENT_PHONE), "실패 사유에 번호를 남기지 않는다");

  await assert.rejects(service.markUniformArrived({ db, sendSms: sms.send }, { keys: [], actorName: null }), /골라/);
  const many = Array.from({ length: rules.UNIFORM_ARRIVAL_BATCH_LIMIT + 1 }, (_, i) => `SITE:x${i}`);
  await assert.rejects(service.markUniformArrived({ db, sendSms: sms.send }, { keys: many, actorName: null }), /까지/);
});

test("수령 완료: 도착한 줄만 · 학생 «수령완료»(보유는 그대로) · 문자 없음", async () => {
  const db = fakeDb(BASE);
  const sms = fakeSms();
  await service.markUniformArrived({ db, sendSms: sms.send }, { keys: ["SITE:free"], actorName: null });
  const received = await service.markUniformReceived(db, { keys: ["SITE:free", "SITE:nolink"], actorName: "원장" });
  assert.deepEqual(received, { received: 1, skipped: 1 });
  const update = db.log.find((entry) => entry.sql.includes(`ELSE '수령완료'`));
  assert.match(update.sql, /WHEN s\."uniformStatus" = '보유' THEN s\."uniformStatus" ELSE '수령완료'/);
  assert.deepEqual(update.args[0], ["s2"]);
  const again = await service.markUniformReceived(db, { keys: ["SITE:free"], actorName: "원장" });
  assert.equal(again.received, 0);
  assert.equal(sms.calls.length, 1);
});

test("조회 SQL: 전화번호를 고르지 않는다 · 이름만으로 잇지 않는다 · 도착 기록 학생이 정본", () => {
  const sql = service.uniformBoardSql();
  const selectList = sql.slice(sql.lastIndexOf("SELECT it.source"), sql.indexOf("FROM items it"));
  assert.doesNotMatch(selectList, /phone|p1|p2/i);
  assert.match(sql, /IN \(it\.p1, it\.p2\)/);
  assert.match(sql, /cardinality\(c\.ids\) = 1/);
  assert.match(sql, /COALESCE\(a\."studentId", gr\."studentId"/);
  assert.match(sql, /"mergedIntoStudentId" IS NULL/);
});

// ── ⑤ 연결 모양 ──────────────────────────────────────────────────────────

test("서버 액션·메뉴·마이그레이션·문자 틀", () => {
  const actions = read("src/app/actions/uniform.ts");
  assert.match(actions, /export async function markUniformArrivedAction[\s\S]*?await requireAdmin\(\)/);
  assert.match(actions, /export async function markUniformReceivedAction[\s\S]*?await requireAdmin\(\)/);
  assert.match(actions, /sendParentSmsWithResult/);
  assert.match(actions, /export async function retryUniformOrderDispatch/, "기존 재전송 액션 유지");

  const sections = load("src/lib/admin-sections.ts");
  assert.equal(sections.findAdminSection("/admin/uniform/status").activeHref, "/admin/uniform/status");
  assert.equal(sections.findAdminSection("/admin/uniform").activeHref, "/admin/uniform");
  assert.match(read("src/app/admin/AdminShellClient.tsx"), /href: "\/admin\/uniform\/status", label: "유니폼", section: "uniform"/);

  const migration = read("prisma/migrations/20261121120000_uniform_arrival/migration.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "UniformArrival"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "UniformArrival_sourceType_sourceItemId_key"/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON "UniformArrival" FROM anon, authenticated/);
  assert.match(migration, /'UNIFORM_ARRIVED_PARENT'[\s\S]*ON CONFLICT \(trigger\) DO NOTHING/);
  assert.doesNotMatch(migration, /DROP TABLE(?! IF EXISTS "UniformArrival";)/, "되돌림 주석 말고는 지우지 않는다");

  const template = read("src/lib/smsTemplate.ts");
  const body = rules.uniformArrivedDefaultBody("[스티즈농구교실]");
  assert.ok(template.includes(`"${rules.UNIFORM_ARRIVED_TRIGGER}",`), "앱 기본 틀에도 같은 트리거");
  assert.ok(template.includes(rules.uniformArrivedDefaultBody("${PARENT_MESSAGE_PREFIX}")), "앱 기본 문구 = 규칙 문구");
  assert.match(read("src/lib/messaging/parent-alimtalk-templates.ts"), /UNIFORM_ARRIVED_PARENT: "/);
  assert.ok(migration.includes(body), "마이그레이션 문구와 코드 기본 문구가 같다");
  assert.match(read("prisma/schema.prisma"), /model UniformArrival \{[\s\S]*@@unique\(\[sourceType, sourceItemId\]\)/);
});

test("화면: 미도착 기본 · 경고·출처·무료 증정 표시 · 전화번호·메모 없음", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const board = rules.buildUniformBoard([
    row({ itemId: "a", studentName: "김하나", bottomSize: "", customerMemo: FREE_MEMO, stizSyncStatus: "NEEDS_REVIEW", hasOrderNumber: false }),
    row({ itemId: "b", source: "SHOP", shopItemStatus: "PREPARING", studentName: "이둘", arrivedAt: "x", noticeStatus: "SENT" }),
  ], new Map());
  const views = board.map(({ customerMemo, orderStatus, hasOrderNumber, studentId, ...rest }) => ({ ...rest, isFree: rest.source === "SITE" && Boolean(customerMemo), linked: Boolean(studentId) }));
  const { default: Client } = load("src/app/admin/uniform/status/UniformStatusClient.tsx", {
    "next/link": { __esModule: true, default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/app/actions/uniform": { markUniformArrivedAction: async () => ({}), markUniformReceivedAction: async () => ({}) },
    "@/components/ui/feedback": { askConfirm: async () => true },
  });
  const html = renderToStaticMarkup(React.createElement(Client, { initialItems: views, loadError: "" }));
  assert.match(html, /유니폼 신청 현황/);
  assert.match(html, /김하나/);
  assert.match(html, /하의 사이즈가 비어 있어요/);
  assert.match(html, /무료 증정/);
  assert.match(html, /원장 확인/);
  assert.match(html, /학원 도착<\/button>/);
  assert.doesNotMatch(html, /이둘/, "기본 필터는 미도착만");
  assert.doesNotMatch(html, /3년 재원 무료 증정\] 메모|010/);
  assert.match(html, /href="\/admin\/uniform"/);
});

// ── ⑥ 본사 전송 일괄(2026-11-21 원장 «체크해서 한 번에 처리») ─────────────

function siteOrder(id, over = {}) {
  return {
    id, partnerRequestId: `dasan-uniform-${id}`, parentName: `보호자${id}`, parentPhone: "010-0000-0000", customerMemo: FREE_MEMO,
    orderStatus: "RECEIVED", stizSyncStatus: "NEEDS_REVIEW", stizOrderNumber: null, stizDuplicate: false, stizMessage: null,
    sendAttempts: 0, nextRetryAt: null, lastError: null, lastSentAt: null, createdAt: "2026-11-14T02:34:00.000Z", updatedAt: "2026-11-14T02:34:00.000Z",
    items: [{ id: `${id}-i`, studentName: `학생${id}`, design: "블랙", initials: null, backNumber: "9", topSize: "130", bottomSize: "130", quantity: 2 }],
    ...over,
  };
}

function loadOrdersClient(extraMocks = {}) {
  const React = require("react");
  return load("src/app/admin/uniform/UniformOrdersClient.tsx", {
    "next/link": { __esModule: true, default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/app/actions/uniform": { retryUniformOrderDispatch: async () => ({ syncStatus: "SENT" }) },
    "@/components/ui/feedback": { askConfirm: async () => true },
    ...extraMocks,
  });
}

test("본사 전송 화면: 재전송할 수 있는 행에만 체크 칸 · 모두 고르기 · 일괄 전송 버튼", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { default: Client } = loadOrdersClient();
  const orders = [
    siteOrder("a"),
    siteOrder("b", { stizSyncStatus: "SETUP_REQUIRED", customerMemo: null }),
    siteOrder("c", { stizSyncStatus: "SENT", stizOrderNumber: "ORD-1", customerMemo: null }),
  ];
  const html = renderToStaticMarkup(React.createElement(Client, { initialOrders: orders, loadError: "" }));
  assert.equal((html.match(/신청 고르기/g) ?? []).length, 2, "본사 접수 끝난 행은 체크 칸 없음");
  assert.match(html, /보이는 재전송 가능 신청 모두 고르기/);
  assert.match(html, /선택 0건 본사 전송/);
  assert.match(html, /재전송/, "한 건씩 재전송 버튼은 그대로");
});

test("일괄 전송 확인 글: 무료 증정 중복 주문 경고 · 사이즈 빈 학생", () => {
  const client = loadOrdersClient();
  const text = client.bulkRetryConfirmText([
    siteOrder("a"),
    siteOrder("b", { customerMemo: null, items: [{ id: "b-i", studentName: "김관우", design: null, initials: null, backNumber: "7", topSize: "140", bottomSize: "", quantity: 1 }] }),
  ]);
  assert.match(text, /2건을 STIZ 본사로 한 번에 전송/);
  assert.match(text, /무료 증정 1건 포함 — 이미 본사에 따로 주문한 건이면 본사에 주문이 한 번 더/);
  assert.match(text, /사이즈가 비어 있는 학생: 김관우/);
  assert.match(text, /학부모 문자 안내가 발송될 수/);
  assert.equal(client.bulkRetryConfirmText([siteOrder("c", { customerMemo: null })]).includes("무료 증정"), false);
  assert.equal(client.BULK_RETRY_LIMIT, 30);
});

test("일괄 전송: 한 건씩 차례로 기존 재전송 액션 · 실패해도 나머지 계속", () => {
  const source = read("src/app/admin/uniform/UniformOrdersClient.tsx");
  const handler = source.slice(source.indexOf("async function handleBulkRetry"), source.indexOf("// 상태 칩"));
  assert.match(handler, /for \(const \[index, order\] of targets\.entries\(\)\)[\s\S]*await retryUniformOrderDispatch\(order\.id\)/);
  assert.match(handler, /catch \{\s*failed\.push/);
  assert.match(handler, /askConfirm\(bulkRetryConfirmText\(targets\)/);
  assert.doesNotMatch(handler, /Promise\.all/, "동시에 보내지 않는다(본사 부하·시간 제한)");
});

test("수량 표시: 사이트 신청은 «장» 저장 → 1벌(상·하)·상의만·하의만, 본사몰은 벌 그대로 · 두 화면 모두 사용", () => {
  const label = rules.uniformQuantityLabel;
  assert.equal(label({ topSize: "130", bottomSize: "130", quantity: 2 }), "1벌(상·하)");
  assert.equal(label({ topSize: "140", bottomSize: "", quantity: 1 }), "상의만");
  assert.equal(label({ topSize: null, bottomSize: "120", quantity: 1 }), "하의만");
  assert.equal(label({ source: "SITE", topSize: "130", bottomSize: "130", quantity: 2 }), "1벌(상·하)");
  assert.equal(label({ source: "SHOP", topSize: "130", bottomSize: "130", quantity: 1 }), "1벌");
  assert.equal(rules.uniformOrderQuantityLabel([{ topSize: "130", bottomSize: "130", quantity: 2 }]), "1벌(상·하)");
  assert.equal(rules.uniformOrderQuantityLabel([{ topSize: "130", bottomSize: "130", quantity: 2 }, { topSize: "140", bottomSize: "", quantity: 1 }]), "2명분");

  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { default: Client } = loadOrdersClient();
  const html = renderToStaticMarkup(React.createElement(Client, { initialOrders: [siteOrder("a")], loadError: "" }));
  assert.match(html, /1벌\(상·하\)/);
  assert.doesNotMatch(html, />2벌</);
  assert.match(read("src/app/admin/uniform/status/UniformStatusClient.tsx"), /\{uniformQuantityLabel\(item\)\}/);
});

// ── ⑦ 신청 내용 수정(2026-11-21 원장 «주문 내용을 수정하는 기능») ─────────

const edit = load("src/lib/uniform/orderEdit.ts");
const ORIGINAL = { studentName: "김관우", design: "DYG 블랙&화이트", initials: "KKW", backNumber: "7", topSize: "2XS(140)", bottomSize: null, quantity: 1 };

test("수정 검증: 목록 값·등번호·사이즈 하나 이상 · 수량 재계산 · 옛 값은 그대로 두면 통과", () => {
  const ok = edit.normalizeUniformItemEdit({ ...ORIGINAL, bottomSize: "2XS(140)", backNumber: "#7" }, ORIGINAL);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.quantity, 2, "하의 추가 → 상의 1 + 하의 1");
  assert.equal(ok.value.backNumber, "7");
  const err = (fields) => edit.normalizeUniformItemEdit({ ...ORIGINAL, ...fields }, ORIGINAL).error;
  assert.match(err({ studentName: " " }), /학생 이름/);
  assert.match(err({ design: "없는 디자인" }), /디자인/);
  assert.match(err({ backNumber: "12a" }), /등번호/);
  assert.match(err({ topSize: "", bottomSize: "" }), /하나 이상/);
  assert.match(err({ topSize: "999" }), /상의 사이즈/);
  // 예전 신청의 목록 밖 사이즈("130")는 그대로 두면 통과, 다른 목록 밖 값으로는 못 바꾼다
  const legacy = { ...ORIGINAL, topSize: "130" };
  assert.equal(edit.normalizeUniformItemEdit({ ...legacy, backNumber: "8" }, legacy).ok, true);
  assert.equal(edit.normalizeUniformItemEdit({ ...legacy, topSize: "131" }, legacy).ok, false);
  assert.equal(edit.canEditUniformOrder({ orderStatus: "RECEIVED", stizSyncStatus: "NEEDS_REVIEW" }), true);
  assert.equal(edit.canEditUniformOrder({ orderStatus: "RECEIVED", stizSyncStatus: "SENT" }), false);
  assert.equal(edit.canEditUniformOrder({ orderStatus: "RECEIVED", stizSyncStatus: "SENDING" }), false);
  assert.equal(edit.canEditUniformOrder({ orderStatus: "CANCELED", stizSyncStatus: "PENDING" }), false);
});

function editDb({ status = "NEEDS_REVIEW", updateRows = [{ id: "i1" }] } = {}) {
  const log = [];
  return {
    log,
    async $queryRawUnsafe(sql, ...args) {
      log.push({ sql, args });
      if (sql.startsWith(`SELECT i."uniformOrderId"`)) return [{ ...ORIGINAL, orderId: "o1", orderStatus: "RECEIVED", stizSyncStatus: status }];
      if (sql.includes(`UPDATE "UniformOrderItem" i`)) return updateRows;
      if (sql.includes(`FROM "UniformOrderItem" WHERE "uniformOrderId"`)) return [{ ...ORIGINAL, bottomSize: "2XS(140)" }];
      throw new Error(sql);
    },
    async $executeRawUnsafe(sql, ...args) { log.push({ sql, args }); return 1; },
  };
}

test("수정 저장: 본사 안 간 상태만(WHERE 조건) · 주문 열쇠 재계산 · 감사 기록 전후 값", async () => {
  const db = editDb();
  const result = await edit.updateUniformOrderItem(db, { itemId: "i1", fields: { ...ORIGINAL, bottomSize: "2XS(140)" }, actorUserId: "admin1" });
  assert.deepEqual(result.changed, ["하의 사이즈"]);
  const update = db.log.find((e) => e.sql.includes(`UPDATE "UniformOrderItem" i`));
  assert.match(update.sql, /o\."stizSyncStatus" = ANY\(\$9::text\[\]\)/);
  assert.match(update.sql, /o\."orderStatus" <> 'CANCELED'/);
  assert.deepEqual(update.args[8], ["PENDING", "RETRY_WAIT", "NEEDS_REVIEW", "SETUP_REQUIRED"]);
  assert.equal(update.args[7], 2);
  const signature = db.log.find((e) => e.sql.includes(`"itemSignature" = $2`));
  assert.ok(signature.args[1].includes("2XS(140)"));
  const audit = db.log.find((e) => e.sql.includes(`"OperationsAuditLog"`));
  assert.equal(audit.args[0], "UNIFORM_ORDER_ITEM_EDIT");
  assert.equal(audit.args[1], "admin1");
  assert.doesNotMatch(audit.args[2], /010/);

  // 바뀐 것 없음 → 저장 안 함
  const same = editDb();
  assert.deepEqual((await edit.updateUniformOrderItem(same, { itemId: "i1", fields: ORIGINAL, actorUserId: null })).changed, []);
  assert.ok(!same.log.some((e) => e.sql.includes("UPDATE")));
  // 본사 접수된 신청 거절 · 읽은 뒤 전송이 시작돼 0줄이면 거절
  await assert.rejects(edit.updateUniformOrderItem(editDb({ status: "SENT" }), { itemId: "i1", fields: ORIGINAL, actorUserId: null }), /본사에 이미 접수/);
  await assert.rejects(edit.updateUniformOrderItem(editDb({ updateRows: [] }), { itemId: "i1", fields: { ...ORIGINAL, initials: "K" }, actorUserId: null }), /방금 본사 전송/);
});

test("수정 화면: 서버 액션은 관리자 확인 · 상세 패널에 «내용 수정»(본사 안 간 신청만) · 옛 값도 목록에", () => {
  assert.match(read("src/app/actions/uniform.ts"), /export async function updateUniformOrderItemAction[\s\S]*?await requireAdmin\(\)/);
  const client = read("src/app/admin/uniform/UniformOrdersClient.tsx");
  assert.match(client, /canEditUniformOrder\(d\) && editingItemId !== item\.id/);
  assert.match(client, /본사에 접수된 신청은 여기서 고칠 수 없어요/);
  const form = load("src/app/admin/uniform/UniformItemEditForm.tsx", { "@/app/actions/uniform": { updateUniformOrderItemAction: async () => ({}) } });
  assert.deepEqual(form.optionsWithCurrent(["", "M"], "130"), ["130", "", "M"]);
  assert.deepEqual(form.optionsWithCurrent(["", "M"], "M"), ["", "M"]);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(form.default, { item: { id: "i1", ...ORIGINAL }, onDone() {}, onCancel() {} }));
  assert.match(html, /value="김관우"/);
  assert.match(html, /하의 사이즈/);
  assert.match(html, />저장</);
});
