// 셔틀 타는 곳·내리는 곳 «앞으로 계속» 바꾸기 신청(2026-11-14 결정표 c5).
//  ① 마이그레이션: 새 표 하나(IF NOT EXISTS·CHECK·부분 유니크·RLS), 기존 표·행을 바꾸지 않는다, 되돌림 주석, schema.prisma 사본
//  ② 규칙(실제 실행): 고를 수 있는 종류·요일·방향, 날짜 범위, 위치·동의, 상태 한 줄, 적용 판정
//  ③ 접수(실제 실행 — 가짜 DB): 내 아이만 · 확인 중 1건 · 승인 전에는 명단·학생 위치에 아무것도 쓰지 않는다 · 표가 없으면 거절
//  ④ 상태 전이(실제 실행): 신청 → 취소 / 승인 → 적용일에 명단 반영 / 반려(사유 필수) — 승인 전·적용일 전 명단 불변
//  ⑤ 연결: API(학부모만)·액션(관리자만)·cron·입구·관리자 목록, 기존 관리자 반영 함수 재사용
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const read = (p) => readFileSync(p, "utf8");
const nodeRequire = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : nodeRequire(name);
  module._compile(compiled, absolute);
  return module.exports;
};

const rules = await loadTsModule("src/lib/shuttle/regularChangeRules.ts");
const MIGRATION = "prisma/migrations/20261115120000_shuttle_regular_change_request/migration.sql";
const migration = read(MIGRATION);
const serverSrc = read("src/lib/shuttle/regularChangeRequest.ts");

test("① 마이그레이션: 새 표 하나 — IF NOT EXISTS·CHECK·부분 유니크·RLS, 기존 것을 바꾸는 문장 없음, 되돌림 주석, 스키마 사본", () => {
  const body = migration.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(body, /CREATE TABLE IF NOT EXISTS public\."ShuttleRegularChangeRequest"/);
  assert.match(body, /CHECK \(kind IN \('CHANGE', 'START', 'STOP'\)\)/);
  assert.match(body, /CHECK \(status IN \('PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELED'\)\)/);
  assert.match(body, /directions <@ ARRAY\['PICKUP', 'DROPOFF'\]::text\[\]/);
  assert.match(body, /weekdays <@ ARRAY\[0, 1, 2, 3, 4, 5, 6\]/);
  assert.match(body, /char_length\(note\) <= 300/);
  assert.match(body, /CREATE UNIQUE INDEX IF NOT EXISTS "ShuttleRegularChangeRequest_pending_unique"[\s\S]*?\("studentId"\)\s+WHERE status = 'PENDING'/, "아이당 확인 중 1건");
  assert.match(body, /CREATE INDEX IF NOT EXISTS "ShuttleRegularChangeRequest_due_idx"/);
  assert.match(body, /ENABLE ROW LEVEL SECURITY/);
  assert.match(body, /FORCE ROW LEVEL SECURITY/);
  assert.match(body, /REVOKE ALL ON TABLE public\."ShuttleRegularChangeRequest" FROM anon, authenticated/);
  assert.match(body, /"effectiveFrom" DATE NOT NULL/);
  assert.match(body, /"decidedAt" TIMESTAMPTZ\(6\)/, "시간 칸은 timestamptz");
  assert.doesNotMatch(body, /\bALTER TABLE public\."(?!ShuttleRegularChangeRequest")|\bUPDATE\b(?! CASCADE)|\bDELETE FROM\b|\bDROP\b|\bTRUNCATE\b/, "기존 표·행을 건드리지 않는다");
  assert.match(migration, /되돌림 SQL/);
  assert.match(migration, /-- DROP TABLE IF EXISTS public\."ShuttleRegularChangeRequest";/);
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model ShuttleRegularChangeRequest {"));
  for (const col of ["studentId", "requestedByUserId", "kind", "directions", "weekdays", "pickupJson", "dropoffJson", "effectiveFrom", "status", "decidedByUserId", "decisionNote", "appliedAt", "applyResultJson"]) {
    assert.match(model.slice(0, model.indexOf("\n}")), new RegExp(`\\b${col}\\s`), `schema.prisma 사본에 ${col}`);
  }
  assert.match(schema, /shuttleRegularChangeRequests ShuttleRegularChangeRequest\[\]/);
  // 규칙 상수와 DB 제약이 같은 집합
  assert.deepEqual([...rules.REGULAR_CHANGE_KINDS], ["CHANGE", "START", "STOP"]);
  assert.deepEqual([...rules.REGULAR_CHANGE_STATUSES], ["PENDING", "APPROVED", "APPLIED", "REJECTED", "CANCELED"]);
  assert.equal(rules.REGULAR_CHANGE_NOTE_MAX, 300);
});

// 월·수 반을 다니고, 월요일만 등원·하원 셔틀을 타는 아이
const ctx = (over = {}) => ({
  today: "2026-11-14", classWeekdays: [1, 3],
  roster: [{ weekday: 1, direction: "PICKUP" }, { weekday: 1, direction: "DROPOFF" }],
  ...over,
});
const input = (over = {}) => ({
  kind: "CHANGE", directions: ["PICKUP"], weekdays: null, effectiveFrom: "2026-12-01", note: "", hasPickup: true, hasDropoff: false, consent: true, ...over,
});

test("② 규칙: 위치 바꾸기 — 타는 요일·방향만, 새 위치·동의·날짜 범위", () => {
  const ok = rules.validateRegularChange(input(), ctx());
  assert.deepEqual(ok, { ok: true, value: { kind: "CHANGE", directions: ["PICKUP"], weekdays: null, effectiveFrom: "2026-12-01", note: null } });
  assert.deepEqual(rules.validateRegularChange(input({ directions: ["DROPOFF", "PICKUP"], hasDropoff: true, weekdays: [1, 1], note: "  이사했어요 " }), ctx()).value,
    { kind: "CHANGE", directions: ["PICKUP", "DROPOFF"], weekdays: [1], effectiveFrom: "2026-12-01", note: "이사했어요" });
  const err = (over, c = ctx()) => rules.validateRegularChange(input(over), c).error;
  assert.equal(err({ kind: "MOVE" }), "INVALID_KIND");
  assert.equal(err({ directions: [] }), "DIRECTION_REQUIRED");
  assert.equal(err({ directions: ["BOTH"] }), "DIRECTION_REQUIRED");
  assert.equal(err({ weekdays: [7] }), "INVALID_WEEKDAYS");
  assert.equal(err({ weekdays: "월" }), "INVALID_WEEKDAYS");
  assert.equal(err({ weekdays: [3] }), "WEEKDAY_NOT_ON_ROSTER", "수요일은 셔틀을 안 탄다");
  assert.equal(err({}, ctx({ roster: [] })), "NOT_ON_ROSTER");
  assert.equal(err({ directions: ["DROPOFF"], hasDropoff: false }), "LOCATION_REQUIRED");
  assert.equal(err({ hasPickup: false }), "LOCATION_REQUIRED");
  assert.equal(err({ consent: false }), "CONSENT_REQUIRED");
  assert.equal(err({ effectiveFrom: "2026-11-14" }), "DATE_TOO_SOON", "오늘은 하루 변경으로");
  assert.equal(err({ effectiveFrom: "2026-11-15" }), undefined, "내일부터");
  assert.equal(err({ effectiveFrom: "2027-02-14" }), undefined, "3개월 뒤까지");
  assert.equal(err({ effectiveFrom: "2027-02-15" }), "DATE_TOO_FAR");
  assert.equal(err({ effectiveFrom: "2026-02-30" }), "INVALID_DATE");
  assert.equal(err({ effectiveFrom: "" }), "INVALID_DATE");
  assert.equal(err({ note: "가".repeat(301) }), "NOTE_TOO_LONG");
  assert.deepEqual(rules.regularChangeDateRange("2026-11-30"), { min: "2026-12-01", max: "2027-02-28" }, "월말·2월 말일 접기");
});

test("② 규칙: 이용 시작 = 수업은 있는데 안 타는 요일 · 이용 중단 = 타는 요일(위치·동의 불필요)", () => {
  // 수요일은 수업이 있는데 셔틀을 안 탄다 → 시작 가능
  assert.deepEqual(rules.startableWeekdays(ctx(), ["PICKUP", "DROPOFF"]), [3]);
  assert.deepEqual(rules.selectableWeekdays("START", ctx(), ["PICKUP"]), [3]);
  assert.deepEqual(rules.selectableWeekdays("CHANGE", ctx(), ["PICKUP"]), [1]);
  assert.deepEqual(rules.selectableWeekdays("STOP", ctx(), ["DROPOFF"]), [1]);
  assert.equal(rules.validateRegularChange(input({ kind: "START", weekdays: [3] }), ctx()).ok, true);
  assert.equal(rules.validateRegularChange(input({ kind: "START" }), ctx()).ok, true, "모든 요일 = 안 타는 수업 요일 전부");
  assert.equal(rules.validateRegularChange(input({ kind: "START", weekdays: [1] }), ctx()).error, "ALREADY_ON_ROSTER");
  assert.equal(rules.validateRegularChange(input({ kind: "START", weekdays: [5] }), ctx()).error, "WEEKDAY_NOT_CLASS_DAY");
  assert.equal(rules.validateRegularChange(input({ kind: "START" }), ctx({ classWeekdays: [1] })).error, "NOTHING_TO_START");
  assert.equal(rules.validateRegularChange(input({ kind: "START", hasPickup: false }), ctx()).error, "LOCATION_REQUIRED");
  // 셔틀을 아예 안 타던 아이의 시작
  assert.equal(rules.validateRegularChange(input({ kind: "START", directions: ["PICKUP", "DROPOFF"], hasDropoff: true }), ctx({ roster: [] })).ok, true);
  // 이용 중단
  assert.deepEqual(rules.validateRegularChange(input({ kind: "STOP", hasPickup: false, consent: false, directions: ["DROPOFF"] }), ctx()).value,
    { kind: "STOP", directions: ["DROPOFF"], weekdays: null, effectiveFrom: "2026-12-01", note: null });
  assert.equal(rules.validateRegularChange(input({ kind: "STOP", hasPickup: false, consent: false }), ctx({ roster: [] })).error, "NOT_ON_ROSTER");
  for (const message of Object.values(rules.REGULAR_CHANGE_MESSAGE)) assert.doesNotMatch(message, /학원에 문의|학원으로 문의/, "막다른 문구 금지");
});

test("② 규칙: 학부모 상태 한 줄 «확인 중 / 승인됨(○월 ○일부터) / 반려: 사유» · 요약 · 취소 가능 여부", () => {
  const line = (status, decisionNote = null) => rules.regularChangeStatusLine({ status, effectiveFrom: "2026-12-01", decisionNote });
  assert.deepEqual(line("PENDING"), { text: "확인 중", tone: "warning" });
  assert.deepEqual(line("APPROVED"), { text: "승인됨(12월 1일부터)", tone: "success" });
  assert.deepEqual(line("APPLIED"), { text: "승인됨(12월 1일부터)", tone: "success" }, "반영 끝도 학부모에게는 같은 말");
  assert.deepEqual(line("REJECTED", " 그 길은  차가 못 들어가요 "), { text: "반려: 그 길은 차가 못 들어가요", tone: "danger" });
  assert.deepEqual(line("REJECTED"), { text: "반려", tone: "danger" });
  assert.deepEqual(line("CANCELED"), { text: "취소함", tone: "muted" });
  assert.equal(rules.regularChangeSummary({ kind: "CHANGE", directions: ["PICKUP", "DROPOFF"], weekdays: [1, 3] }), "등원·하원 위치 바꾸기 · 월·수");
  assert.equal(rules.regularChangeSummary({ kind: "CHANGE", directions: ["PICKUP"], weekdays: null }), "등원 위치 바꾸기 · 모든 요일");
  assert.equal(rules.regularChangeSummary({ kind: "STOP", directions: ["DROPOFF"], weekdays: [5] }), "셔틀 이용 중단 · 하원 · 금");
  assert.equal(rules.regularChangeSummary({ kind: "START", directions: ["PICKUP", "DROPOFF"], weekdays: null }), "셔틀 이용 시작 · 등원·하원 · 모든 요일");
  assert.equal(rules.canCancelRegularChange("PENDING"), true);
  for (const s of ["APPROVED", "APPLIED", "REJECTED", "CANCELED"]) assert.equal(rules.canCancelRegularChange(s), false, `${s} 는 학부모가 못 되돌린다`);
  assert.equal(rules.weekdayOfClassDay("Mon"), 1);
  assert.equal(rules.weekdayOfClassDay("Sun"), 0);
  assert.equal(rules.weekdayOfClassDay("Seasonal"), null);
});

test("② 규칙: 적용 판정 — 적용일 전엔 기다림 · 위치 바꾸기는 반영 · 시작/중단은 원장이 명단을 고쳤을 때만 닫힘", () => {
  const plan = (over) => rules.planRegularChangeApply({
    kind: "CHANGE", effectiveFrom: "2026-12-01", today: "2026-12-01", directions: ["PICKUP"], weekdays: null,
    roster: [{ weekday: 1, direction: "PICKUP" }], ...over,
  });
  assert.deepEqual(plan({ today: "2026-11-30" }), { action: "WAIT" }, "적용일 전에는 명단을 바꾸지 않는다");
  assert.deepEqual(plan({}), { action: "APPLY_LOCATION" });
  assert.deepEqual(plan({ today: "2026-12-05" }), { action: "APPLY_LOCATION" }, "늦게 승인해도 반영");
  assert.equal(plan({ kind: "START", roster: [] }).action, "KEEP_OPEN");
  assert.deepEqual(plan({ kind: "START" }), { action: "CLOSE" });
  assert.equal(plan({ kind: "START", weekdays: [3] }).action, "KEEP_OPEN", "신청한 요일(수)에 아직 없다");
  assert.equal(plan({ kind: "STOP" }).action, "KEEP_OPEN");
  assert.deepEqual(plan({ kind: "STOP", roster: [] }), { action: "CLOSE" });
  assert.deepEqual(plan({ kind: "STOP", directions: ["DROPOFF"] }), { action: "CLOSE" }, "하원은 이미 안 탄다");
  assert.equal(plan({ kind: "STOP", today: "2026-11-20", roster: [] }).action, "WAIT");
});

// ── ③④ 가짜 DB 로 실제 실행 ──────────────────────────────────────────────────────
const CONSENT = /SHUTTLE_LOCATION_CONSENT_VERSION = "([^"]+)"/.exec(read("src/lib/seasonal/contracts.ts"))[1];
const place = (name = "새 아파트 정문") => ({ name, address: "경기 남양주시 다산동 1", roadAddress: "다산중앙로 1", latitude: 37.61, longitude: 127.15, placeId: null, source: "MAP_PIN", accuracyMeters: null, note: null });

function harness(over = {}) {
  const state = {
    table: true, today: "2026-11-14",
    students: [{ id: "student-a", parent: "parent-a", name: "합성" }],
    classes: [{ studentId: "student-a", dayOfWeek: "Mon" }, { studentId: "student-a", dayOfWeek: "Wed" }],
    cells: [{ studentId: "student-a", weekday: 1, direction: "BOARD", stopName: "옛 정류장" }, { studentId: "student-a", weekday: 1, direction: "ALIGHT", stopName: "옛 정류장" }],
    requests: [], writes: [], rosterCalls: [], locationWrites: [], staffNotices: [], parentNotices: [], flushed: 0, sql: [],
    ...over,
  };
  const kst = load("src/lib/datetime/kst.ts");
  const fakeKst = { ...kst, todayKst: () => state.today };
  const db = {
    async $queryRawUnsafe(sql, ...v) {
      state.sql.push(sql);
      if (sql.includes("to_regclass")) return [{ found: state.table ? "ShuttleRegularChangeRequest" : null }];
      if (sql.includes('FROM "Student" s') && sql.includes("FOR UPDATE OF s")) return state.students.filter((s) => s.id === v[0] && s.parent === v[1]);
      if (sql.includes('SELECT s.id FROM "Student" s WHERE s.id = $1')) return state.students.filter((s) => s.id === v[0] && s.parent === v[1]).map((s) => ({ id: s.id }));
      if (sql.includes('FROM "Enrollment" e JOIN "Class" c')) return state.classes.filter((c) => c.studentId === v[0]);
      if (sql.includes('FROM "RegularShuttleStop" r')) return state.cells.filter((c) => v[0].includes(c.studentId));
      if (sql.includes(`WHERE "studentId" = $1 AND status = 'PENDING' LIMIT 1`)) return state.requests.filter((r) => r.studentId === v[0] && r.status === "PENDING").map((r) => ({ id: r.id }));
      if (sql.includes("count(*)::int AS n")) {
        assert.match(sql, /\("createdAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/, "timestamptz 는 변환 한 번");
        assert.doesNotMatch(sql, /status/, "취소한 것도 센다");
        return [{ n: state.requests.filter((r) => r.studentId === v[0]).length }];
      }
      if (sql.startsWith('UPDATE "ShuttleRegularChangeRequest" r') && sql.includes("SET status = $2")) {
        assert.match(sql, /r\.id = \$1 AND r\.status = 'PENDING'/, "확인 중일 때만 결정");
        const row = state.requests.find((r) => r.id === v[0] && r.status === "PENDING");
        if (!row) return [];
        Object.assign(row, { status: v[1], decidedByUserId: v[2], decisionNote: v[3] });
        return [{ ...row, studentName: "합성" }];
      }
      if (sql.includes("ORDER BY \"effectiveFrom\", \"createdAt\" LIMIT 200")) {
        assert.match(sql, /status = 'APPROVED' AND "appliedAt" IS NULL\s+AND "effectiveFrom" <= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
        return state.requests.filter((r) => r.status === "APPROVED" && !r.appliedAt && r.effectiveFrom <= state.today && (!v[0] || r.id === v[0])).map((r) => ({ id: r.id }));
      }
      if (sql.includes("FOR UPDATE") && sql.includes('WHERE id = $1 AND status = \'APPROVED\' AND "appliedAt" IS NULL')) {
        return state.requests.filter((r) => r.id === v[0] && r.status === "APPROVED" && !r.appliedAt);
      }
      throw new Error(`예상 밖 조회: ${sql.slice(0, 70)}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      state.sql.push(sql);
      state.writes.push(sql);
      if (sql.includes('INSERT INTO "ShuttleRegularChangeRequest"')) {
        if (state.requests.some((r) => r.studentId === v[1] && r.status === "PENDING")) throw Object.assign(new Error("unique"), { code: "P2002" });
        state.requests.push({
          id: v[0], studentId: v[1], requestedByUserId: v[2], kind: v[3], directions: v[4], weekdays: v[5],
          pickupJson: v[6] ? JSON.parse(v[6]) : null, dropoffJson: v[7] ? JSON.parse(v[7]) : null,
          effectiveFrom: v[8], note: v[9], consentVersion: v[10], status: "PENDING", appliedAt: null,
        });
        return 1;
      }
      if (sql.includes("SET status = 'CANCELED'")) {
        assert.match(sql, /r\.id = \$2 AND r\.status = 'PENDING'/);
        const row = state.requests.find((r) => r.id === v[1] && r.status === "PENDING" && state.students.some((s) => s.id === r.studentId && s.parent === v[0]));
        if (!row) return 0;
        row.status = "CANCELED";
        return 1;
      }
      if (sql.includes("SET status = 'APPLIED'")) {
        const row = state.requests.find((r) => r.id === v[0] && r.status === "APPROVED" && !r.appliedAt);
        if (!row) return 0;
        Object.assign(row, { status: "APPLIED", appliedAt: "now", applyResult: JSON.parse(v[1]) });
        return 1;
      }
      if (sql.includes('INSERT INTO "StudentShuttleLocation"')) { state.locationWrites.push(v); return 1; }
      throw new Error(`예상 밖 쓰기: ${sql.slice(0, 70)}`);
    },
  };
  const prisma = { ...db, $transaction: async (fn) => fn(db) };
  const changeRules = load("src/lib/enrollment/changeRequestRules.ts");
  const realRules = load("src/lib/shuttle/regularChangeRules.ts", { "@/lib/datetime/kst": fakeKst, "@/lib/enrollment/changeRequestRules": changeRules });
  const contracts = { SHUTTLE_LOCATION_CONSENT_VERSION: CONSENT };
  const link = load("src/lib/shuttle/regularLocationLink.ts", {
    "@/lib/prisma": { prisma }, "@/lib/seasonal/contracts": contracts,
    "@/lib/shuttle/placeNameRule": load("src/lib/shuttle/placeNameRule.ts"),
  });
  const api = load("src/lib/shuttle/regularChangeRequest.ts", {
    "@prisma/client": { Prisma: { TransactionIsolationLevel: { ReadCommitted: "ReadCommitted" } } },
    "@/lib/account/child-access": { childAccessSql: async (alias, param) => `${alias}."parentId" = ${param}` },
    "@/lib/prisma": { prisma },
    "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
    "@/lib/datetime/kst": fakeKst,
    "@/lib/seasonal/contracts": contracts,
    "@/lib/students/student-shuttle-location-upsert": load("src/lib/students/student-shuttle-location-upsert.ts"),
    "@/lib/shuttle/regularLocationLink": link,
    "@/lib/shuttle/regularChangeRules": realRules,
    "./regularRosterEdit": {
      lockRosterForLocationInTx: async () => { state.rosterCalls.push({ lock: true }); return ["2026-12"]; },
      applyLocationToRosterInTx: async (_tx, actorId, args, month, locked, onlyWeekdays) => {
        state.rosterCalls.push({ actorId, args, month, locked, onlyWeekdays });
        return { appliedMonths: ["2026-11"], updated: 1, months: [], notices: [{ summary: "위치 변경" }] };
      },
      flushRosterNotices: async (notices) => { state.flushed += notices.length; },
    },
    "@/lib/operational-staff-notification": { notifyOperationalStaff: async (n) => { state.staffNotices.push(n); } },
    "@/lib/operational-notification-delivery": { deliverOperationalNotification: async (n) => { state.parentNotices.push(n); return { duplicate: false }; } },
  });
  return { api, state, prisma };
}

const submitBody = (over = {}) => ({
  studentId: "student-a", kind: "CHANGE", directions: ["PICKUP"], weekdays: null, effectiveFrom: "2026-12-01",
  note: "이사했어요", pickup: place(), dropoff: null, consentVersion: CONSENT, ...over,
});
/** 명단·학생 위치에 닿은 쓰기(없어야 «명단 불변») */
const rosterTouched = (state) => state.rosterCalls.filter((c) => !c.lock).length + state.locationWrites.length
  + state.writes.filter((sql) => /"RegularShuttleStop"|"StudentShuttleLocation"/.test(sql)).length;

test("③ 접수: 내 아이·타는 요일이면 «확인 중» 한 건 — 명단·학생 위치에는 아무것도 쓰지 않는다", async () => {
  const { api, state, prisma } = harness();
  const result = await api.submitRegularChangeRequest("parent-a", submitBody(), prisma);
  assert.equal(result.ok, true);
  assert.equal(state.requests.length, 1);
  const saved = state.requests[0];
  assert.deepEqual({ kind: saved.kind, directions: saved.directions, weekdays: saved.weekdays, effectiveFrom: saved.effectiveFrom, status: saved.status, note: saved.note, by: saved.requestedByUserId },
    { kind: "CHANGE", directions: ["PICKUP"], weekdays: null, effectiveFrom: "2026-12-01", status: "PENDING", note: "이사했어요", by: "parent-a" });
  assert.equal(saved.pickupJson.name, "새 아파트 정문");
  assert.equal(saved.dropoffJson, null, "고르지 않은 방향 위치는 저장하지 않는다");
  assert.equal(rosterTouched(state), 0, "승인 전 명단 불변");
  // 원장에게 앱 알림 한 번(문자·알림톡 아님)
  assert.equal(state.staffNotices.length, 1);
  assert.match(state.staffNotices[0].message, /합성 학생 등원 위치 바꾸기 · 모든 요일 · 12월 1일부터/);
  assert.equal(state.staffNotices[0].linkUrl, "/admin/shuttle/regular");
  assert.doesNotMatch(serverSrc, /sendSms|sendTrackedSms|alimtalk/i, "문자·알림톡 신규 금지");
});

test("③ 권한·중복: 남의 아이는 거절 · 확인 중이 있으면 거절 · 위치는 링크와 같은 검증 · 표가 없으면 거절", async () => {
  const { api, state, prisma } = harness();
  assert.deepEqual(await api.submitRegularChangeRequest("parent-b", submitBody(), prisma), { ok: false, message: "본인 자녀만 신청할 수 있습니다." });
  assert.equal(state.requests.length, 0);
  assert.match((await api.submitRegularChangeRequest("parent-a", submitBody({ pickup: { ...place(), name: " " } }), prisma)).message, /장소 이름|이름/, "장소명 필수(링크 제출과 같은 검증)");
  assert.match((await api.submitRegularChangeRequest("parent-a", submitBody({ pickup: { ...place(), latitude: 200 } }), prisma)).message, /위도/);
  assert.match((await api.submitRegularChangeRequest("parent-a", submitBody({ consentVersion: "old" }), prisma)).message, /위치정보 이용에 동의/);
  assert.match((await api.submitRegularChangeRequest("parent-a", submitBody({ weekdays: [3] }), prisma)).message, /셔틀을 타고 있지 않아요/, "요일·명단은 서버가 다시 본다");
  assert.equal(state.requests.length, 0);
  assert.equal((await api.submitRegularChangeRequest("parent-a", submitBody(), prisma)).ok, true);
  assert.match((await api.submitRegularChangeRequest("parent-a", submitBody({ kind: "STOP", pickup: null, consentVersion: null }), prisma)).message, /이미 확인 중인 신청/);
  assert.equal(state.requests.length, 1);

  const off = harness({ table: false });
  assert.equal((await off.api.submitRegularChangeRequest("parent-a", submitBody(), off.prisma)).ok, false);
  assert.equal(off.state.writes.length, 0, "표가 없으면 아무것도 쓰지 않는다");
  const options = await off.api.getRegularChangeOptions("parent-a", off.prisma);
  assert.deepEqual({ available: options.available, children: options.children, requests: options.requests }, { available: false, children: [], requests: [] });
  assert.deepEqual(await off.api.listRegularChangeRequests(off.prisma), []);
  assert.deepEqual(await off.api.applyDueRegularChanges(), { applied: 0, waiting: 0, appliedIds: [] });
});

test("④ 전이: 신청 → 학부모 취소(확인 중일 때만·내 아이 것만) — 명단 불변", async () => {
  const { api, state, prisma } = harness();
  const { id } = await api.submitRegularChangeRequest("parent-a", submitBody(), prisma);
  assert.equal((await api.cancelRegularChangeRequest("parent-b", id, prisma)).ok, false, "남의 신청은 못 취소");
  assert.equal(state.requests[0].status, "PENDING");
  assert.deepEqual(await api.cancelRegularChangeRequest("parent-a", id, prisma), { ok: true });
  assert.equal(state.requests[0].status, "CANCELED");
  assert.equal((await api.cancelRegularChangeRequest("parent-a", id, prisma)).ok, false, "두 번 취소 불가");
  // 취소한 건은 승인할 수 없다
  assert.deepEqual(await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: id, approve: true }), { ok: false, message: "이미 처리된 신청입니다." });
  assert.equal(rosterTouched(state), 0);
  // 취소 뒤에는 다시 신청할 수 있다
  assert.equal((await api.submitRegularChangeRequest("parent-a", submitBody(), prisma)).ok, true);
});

test("③ 하루 상한(보안 검수 L1): 신청→취소를 되풀이해도 아이당 하루 5건까지 — 여섯 번째는 쓰지 않고 code 와 전화 안내", async () => {
  const { api, state, prisma } = harness();
  assert.equal(rules.REGULAR_CHANGE_DAILY_LIMIT, 5);
  for (let i = 0; i < 5; i++) {
    const made = await api.submitRegularChangeRequest("parent-a", submitBody(), prisma);
    assert.equal(made.ok, true, `${i + 1}번째`);
    assert.equal((await api.cancelRegularChangeRequest("parent-a", made.id, prisma)).ok, true);
  }
  assert.equal(state.staffNotices.length, 5);
  const sixth = await api.submitRegularChangeRequest("parent-a", submitBody(), prisma);
  assert.deepEqual(sixth, { ok: false, message: "오늘은 더 신청할 수 없어요. 학원에 전화해 주세요.", code: "DAILY_LIMIT" });
  assert.equal(state.requests.length, 5, "여섯 번째는 저장되지 않는다");
  assert.equal(state.staffNotices.length, 5, "원장 알림도 더 가지 않는다");
  // 세는 곳은 학생 행 잠금 «뒤»(접수 트랜잭션 안)
  const submit = serverSrc.slice(serverSrc.indexOf("export async function submitRegularChangeRequest"), serverSrc.indexOf("export async function cancelRegularChangeRequest"));
  assert.ok(submit.indexOf("FOR UPDATE OF s") < submit.indexOf("count(*)::int AS n"));
  assert.ok(submit.indexOf("count(*)::int AS n") < submit.indexOf("INSERT INTO ${TABLE}"));
  // API·화면: code 가 오면 전화 버튼(번호가 있을 때만)
  assert.match(read("src/app/api/mypage/shuttle-regular/route.ts"), /"code" in result && result\.code \? \{ code: result\.code \} : \{\}/);
  const client = read("src/app/mypage/shuttle/regular/RegularChangeClient.tsx");
  assert.match(client, /setLimitHit\(data\?\.code === "DAILY_LIMIT"\)/);
  assert.match(client, /\{limitHit && academyTel && <a href=\{`tel:\$\{academyTel\}`\} className="academy-button-secondary">학원에 전화하기<\/a>\}/);
  assert.match(read("src/app/mypage/shuttle/regular/page.tsx"), /academyTel=\{academyTel\(academyPhone\)\}/);
});

test("④ 전이: 승인 = 예약 — 적용일 전에는 명단이 그대로, 적용일에 기존 관리자 반영 함수로 반영(모든 요일이면 학생 위치도)", async () => {
  const { api, state, prisma } = harness();
  const { id } = await api.submitRegularChangeRequest("parent-a", submitBody({ directions: ["PICKUP", "DROPOFF"], dropoff: place("새 아파트 후문") }), prisma);
  const approved = await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: id, approve: true });
  assert.deepEqual(approved, { ok: true, appliedNow: false });
  assert.equal(state.requests[0].status, "APPROVED");
  assert.equal(rosterTouched(state), 0, "적용일(12/1) 전에는 명단·학생 위치 불변");
  assert.equal(state.parentNotices.length, 1);
  assert.equal(state.parentNotices[0].message, "합성 등원·하원 위치 바꾸기 · 모든 요일 신청이 승인됐어요(12월 1일부터)");
  assert.equal(state.parentNotices[0].recipientUserId, "parent-a");
  assert.equal(state.parentNotices[0].audienceScope, "EXTERNAL");
  // 승인 뒤에는 학부모가 취소할 수 없다
  assert.equal((await api.cancelRegularChangeRequest("parent-a", id, prisma)).ok, false);

  // 적용일 전날 cron — 아무것도 안 한다
  state.today = "2026-11-30";
  assert.deepEqual(await api.applyDueRegularChanges(), { applied: 0, waiting: 0, appliedIds: [] });
  assert.equal(rosterTouched(state), 0);

  // 적용일 cron — 명단 잠금 먼저 → 방향마다 학생 위치 저장 + 명단 반영 → APPLIED → 기사님 알림은 커밋 뒤
  state.today = "2026-12-01";
  assert.deepEqual(await api.applyDueRegularChanges(), { applied: 1, waiting: 0, appliedIds: [id] });
  assert.equal(state.requests[0].status, "APPLIED");
  assert.equal(state.rosterCalls[0].lock, true, "명단 잠금이 트랜잭션 첫 일");
  const calls = state.rosterCalls.filter((c) => !c.lock);
  assert.deepEqual(calls.map((c) => [c.args.kind, c.args.name, c.actorId, c.onlyWeekdays]), [["PICKUP", "새 아파트 정문", "admin-a", undefined], ["DROPOFF", "새 아파트 후문", "admin-a", undefined]]);
  assert.deepEqual(calls[0].locked, ["2026-12"]);
  assert.equal(state.locationWrites.length, 2, "모든 요일 = 기준 위치도 새 위치로");
  assert.equal(state.flushed, 2);
  // 두 번 돌아도 한 번만
  assert.deepEqual(await api.applyDueRegularChanges(), { applied: 0, waiting: 0, appliedIds: [] });
  assert.equal(state.rosterCalls.filter((c) => !c.lock).length, 2);
});

test("④ 요일을 고른 위치 바꾸기는 그 요일 칸만 — 학생 기준 위치는 그대로 · 적용일이 지난 뒤 승인하면 바로 반영", async () => {
  const { api, state, prisma } = harness();
  const { id } = await api.submitRegularChangeRequest("parent-a", submitBody({ weekdays: [1], effectiveFrom: "2026-11-15" }), prisma);
  state.today = "2026-11-16"; // 원장이 적용일 뒤에 승인
  assert.deepEqual(await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: id, approve: true }), { ok: true, appliedNow: true });
  const calls = state.rosterCalls.filter((c) => !c.lock);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].onlyWeekdays, [1]);
  assert.equal(state.locationWrites.length, 0, "요일 한정이면 기준 위치를 바꾸지 않는다");
  assert.equal(state.requests[0].status, "APPLIED");
});

test("④ 전이: 반려는 사유 필수 — 학부모에게 사유가 가고 명단은 그대로, 다시 결정할 수 없다", async () => {
  const { api, state, prisma } = harness();
  const { id } = await api.submitRegularChangeRequest("parent-a", submitBody(), prisma);
  assert.match((await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: id, approve: false, note: "  " })).message, /반려 사유/);
  assert.equal(state.requests[0].status, "PENDING");
  assert.deepEqual(await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: id, approve: false, note: "그 길은 차가 못 들어가요" }), { ok: true, appliedNow: false });
  assert.equal(state.requests[0].status, "REJECTED");
  assert.equal(state.parentNotices[0].message, "합성 등원 위치 바꾸기 · 모든 요일 신청이 반려됐어요: 그 길은 차가 못 들어가요");
  assert.equal(rosterTouched(state), 0);
  assert.equal((await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: id, approve: true })).ok, false);
  state.today = "2026-12-01";
  assert.equal((await api.applyDueRegularChanges()).applied, 0, "반려된 건은 적용되지 않는다");
  // 보호자 연결이 끊긴 신청자에게는 알림이 가지 않는다
  const gone = harness();
  const made = await gone.api.submitRegularChangeRequest("parent-a", submitBody(), gone.prisma);
  gone.state.students[0].parent = "parent-z";
  await gone.api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: made.id, approve: true });
  assert.equal(gone.state.parentNotices.length, 0);
});

test("④ 이용 시작·중단: 승인해도 명단은 자동으로 안 바뀐다 — 원장이 명단을 고친 뒤에 닫힌다", async () => {
  // 셔틀을 안 타던 아이의 이용 시작
  const start = harness({ cells: [] });
  const made = await start.api.submitRegularChangeRequest("parent-a", submitBody({ kind: "START", directions: ["PICKUP", "DROPOFF"], dropoff: place("집 앞"), effectiveFrom: "2026-11-15" }), start.prisma);
  assert.equal(made.ok, true);
  start.state.today = "2026-11-15";
  await start.api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: made.id, approve: true });
  assert.equal(start.state.requests[0].status, "APPROVED", "명단에 아직 없으니 열려 있다");
  assert.equal(start.state.rosterCalls.filter((c) => !c.lock).length, 0, "명단에 자동으로 넣지 않는다");
  assert.equal(start.state.locationWrites.length, 2, "원장의 «학생 추가»가 미리 채워지게 신청 위치만 학생 위치로");
  assert.equal(start.state.writes.filter((sql) => /"RegularShuttleStop"/.test(sql)).length, 0);
  // 원장이 명단에 넣은 뒤 cron → 닫힌다
  start.state.cells.push({ studentId: "student-a", weekday: 1, direction: "BOARD", stopName: "새 아파트 정문" });
  assert.equal((await start.api.applyDueRegularChanges()).applied, 1);
  assert.equal(start.state.requests[0].status, "APPLIED");

  // 이용 중단
  const stop = harness();
  const stopMade = await stop.api.submitRegularChangeRequest("parent-a", submitBody({ kind: "STOP", directions: ["PICKUP", "DROPOFF"], pickup: null, consentVersion: null, effectiveFrom: "2026-11-15" }), stop.prisma);
  assert.equal(stopMade.ok, true);
  assert.equal(stop.state.requests[0].pickupJson, null);
  stop.state.today = "2026-11-15";
  await stop.api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: stopMade.id, approve: true });
  assert.equal(stop.state.requests[0].status, "APPROVED");
  assert.equal(rosterTouched(stop.state), 0, "명단에서 자동으로 빼지 않는다");
  stop.state.cells.length = 0; // 원장이 명단에서 뺌
  assert.equal((await stop.api.applyDueRegularChanges()).applied, 1);
});

test("③ 조회: 내 아이만 — 지금 명단·저장된 위치·신청 한 줄(상태 문구) / 원장 목록은 할 일 한 줄", async () => {
  const { api, state, prisma } = harness();
  // 조회용 응답을 덧붙인다(아이 목록·저장 위치·신청 목록)
  const base = prisma.$queryRawUnsafe;
  const withReads = {
    ...prisma,
    async $queryRawUnsafe(sql, ...v) {
      if (sql.includes('array_agg(DISTINCT c."dayOfWeek")')) {
        assert.match(sql, /s\."parentId" = \$1/, "내 아이만");
        return state.students.filter((s) => s.parent === v[0]).map((s) => ({ studentId: s.id, studentName: s.name, classDays: state.classes.filter((c) => c.studentId === s.id).map((c) => c.dayOfWeek) }));
      }
      if (sql.includes('FROM "StudentShuttleLocation"')) return [{ studentId: "student-a", kind: "PICKUP", name: "옛 집", address: "주소", roadAddress: null, latitude: 37.6, longitude: 127.1 }];
      if (sql.includes('FROM "ShuttleRegularChangeRequest" r') && sql.includes("LIMIT 30")) {
        return state.requests.filter((r) => v[0].includes(r.studentId)).map((r) => ({ ...r, createdOn: "2026-11-14" }));
      }
      if (sql.includes('FROM "ShuttleRegularChangeRequest" r') && sql.includes("LIMIT 60")) {
        return state.requests.map((r) => ({ ...r, createdOn: "2026-11-14", studentName: "합성" }));
      }
      return base.call(prisma, sql, ...v);
    },
  };
  await api.submitRegularChangeRequest("parent-a", submitBody({ weekdays: [1] }), prisma);
  const mine = await api.getRegularChangeOptions("parent-a", withReads);
  assert.equal(mine.available, true);
  assert.deepEqual({ min: mine.minEffectiveFrom, max: mine.maxEffectiveFrom, consent: mine.consentVersion }, { min: "2026-11-15", max: "2027-02-14", consent: CONSENT });
  assert.deepEqual(mine.children[0].classWeekdays, [1, 3]);
  assert.deepEqual(mine.children[0].roster.map((r) => [r.weekday, r.direction, r.stopName]), [[1, "PICKUP", "옛 정류장"], [1, "DROPOFF", "옛 정류장"]]);
  assert.equal(mine.children[0].pickup.name, "옛 집");
  assert.equal(mine.children[0].dropoff, null);
  assert.deepEqual({ summary: mine.requests[0].summary, statusText: mine.requests[0].statusText, canCancel: mine.requests[0].canCancel, pickupName: mine.requests[0].pickupName },
    { summary: "등원 위치 바꾸기 · 월", statusText: "확인 중", canCancel: true, pickupName: "새 아파트 정문" });
  // 다른 학부모에게는 아이도 신청도 없다
  const other = await api.getRegularChangeOptions("parent-b", withReads);
  assert.deepEqual({ children: other.children, requests: other.requests }, { children: [], requests: [] });

  await api.decideRegularChangeRequest({ adminUserId: "admin-a", requestId: state.requests[0].id, approve: true });
  const admin = await api.listRegularChangeRequests(withReads);
  assert.equal(admin[0].studentName, "합성");
  assert.equal(admin[0].todo, "12월 1일에 반영 예정");
  assert.deepEqual(admin[0].currentStops, ["월 등원 옛 정류장", "월 하원 옛 정류장"]);
  assert.equal(admin[0].pickupAddress, "다산중앙로 1");
});

test("⑤ 재사용: 위치 검증 = 링크 제출과 같은 함수, 명단 반영 = 관리자 위치 저장과 같은 함수(요일 선택값만 덧붙임)", () => {
  assert.match(serverSrc, /import \{ RegularLocationLinkError, validateRegularLocation, type RegularLocationInput \} from "@\/lib\/shuttle\/regularLocationLink"/);
  assert.match(serverSrc, /import \{ applyLocationToRosterInTx, flushRosterNotices, lockRosterForLocationInTx \} from "\.\/regularRosterEdit"/);
  assert.match(serverSrc, /import \{ upsertStudentShuttleLocation \} from "@\/lib\/students\/student-shuttle-location-upsert"/);
  // 접수 함수 본문은 명단 반영 함수를 부르지 않는다(승인 전 명단 불변)
  const submit = serverSrc.slice(serverSrc.indexOf("export async function submitRegularChangeRequest"), serverSrc.indexOf("export async function cancelRegularChangeRequest"));
  assert.doesNotMatch(submit, /applyLocationToRosterInTx|upsertStudentShuttleLocation|"RegularShuttleStop"\s+SET/);
  assert.match(submit, /childAccessSql\("s", "\$2"\)/);
  assert.match(submit, /FOR UPDATE OF s/);
  // 적용: 잠금 먼저 · 신청 행 잠금 · 상태 조건부 UPDATE · ReadCommitted
  const apply = serverSrc.slice(serverSrc.indexOf("export async function applyDueRegularChanges"));
  assert.ok(apply.indexOf("lockRosterForLocationInTx(tx)") < apply.indexOf("FOR UPDATE"), "명단 잠금이 먼저");
  assert.match(apply, /WHERE id = \$1 AND status = 'APPROVED' AND "appliedAt" IS NULL FOR UPDATE/);
  assert.match(apply, /SET status = 'APPLIED', "appliedAt" = now\(\)[\s\S]{0,160}WHERE id = \$1 AND status = 'APPROVED' AND "appliedAt" IS NULL/);
  assert.match(apply, /isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/);
  assert.match(apply, /"effectiveFrom" <= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/, "DATE 와 KST 오늘 비교(timestamptz now 는 한 번)");
  // 기존 함수: 선택값을 비우면 예전과 같은 동작(관리자 위치 저장은 6번째 인자를 넘기지 않는다)
  const edit = read("src/lib/shuttle/regularRosterEdit.ts");
  const fn = edit.slice(edit.indexOf("export async function applyLocationToRosterInTx"), edit.indexOf("export async function flushRosterNotices"));
  assert.match(fn, /onlyWeekdays\?: readonly number\[\],/);
  assert.match(fn, /const rowIds = onlyWeekdays\s+\? plan\.rowIds\.filter\([\s\S]{0,160}onlyWeekdays\.includes\(row\.weekday\)[\s\S]{0,40}\s+: plan\.rowIds;/);
  assert.match(read("src/lib/shuttle/service.ts"), /applyLocationToRosterInTx\(tx, actor\.appUserId, \{ studentId, kind, name, latitude, longitude \}, undefined, lockedLaterMonths\);/, "관리자 호출은 그대로");
  // 토큰 링크 흐름은 건드리지 않았다
  assert.doesNotMatch(read("src/lib/shuttle/regularLocationLink.ts"), /ShuttleRegularChangeRequest/);
});

test("⑤ 연결: API 는 학부모만 · 액션은 관리자만 · cron 이 적용일 처리 · 입구는 표가 있을 때만 · 관리자 목록은 명단 화면에", () => {
  const route = read("src/app/api/mypage/shuttle-regular/route.ts");
  assert.equal((route.match(/await requireVerifiedParent\(\)/g) ?? []).length, 2, "GET·POST 모두");
  assert.match(route, /cancelRegularChangeRequest\(parent\.appUserId, body\.id\)/);
  assert.match(route, /submitRegularChangeRequest\(parent\.appUserId, body\)/);
  const action = read("src/app/actions/shuttle-regular-change.ts");
  assert.match(action, /^"use server";/);
  assert.match(action, /adminUserId = \(await requireAdmin\(\)\)\.appUserId/);
  assert.ok(action.indexOf("requireAdmin()") < action.indexOf("decideRegularChangeRequest({"), "권한 확인이 먼저");
  assert.doesNotMatch(action, /input\.adminUserId/, "결정한 사람은 화면 값이 아니다");
  const cron = read("src/app/api/cron/enrollment-changes/route.ts");
  assert.match(cron, /await applyDueRegularChanges\(\)\.catch\(/, "실패가 수강 변경 처리를 가리지 않는다");
  const page = read("src/app/mypage/shuttle/page.tsx");
  assert.match(page, /regularChangeAvailable\(\)/);
  assert.match(page, /const regularChangeHref = regularReady\s+\? `\/mypage\/shuttle\/regular/);
  const client = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.match(client, /\{regularChangeHref && \(/);
  assert.match(client, /<Link href=\{regularChangeHref\}[^>]*>계속 바꾸기<\/Link>/);
  const regularPage = read("src/app/mypage/shuttle/regular/page.tsx");
  assert.match(regularPage, /requireVerifiedParent\(\)/);
  assert.match(regularPage, /if \(!initial\.available\) redirect\("\/mypage\/shuttle"\)/);
  const adminPage = read("src/app/admin/shuttle/regular/page.tsx");
  assert.match(adminPage, /await requireAdmin\(\)/);
  assert.match(adminPage, /try \{ changeRequests = await listRegularChangeRequests\(\); \} catch/);
  assert.match(adminPage, /<RegularChangeRequestsPanel rows=\{changeRequests\} \/>/);
});

test("⑤ 화면 규칙: 이름·굵기·색 토큰·아이콘 없음 · 같은 지도 부품 · 규칙 함수로 고를 것을 정한다", () => {
  const parent = read("src/app/mypage/shuttle/regular/RegularChangeClient.tsx");
  const admin = read("src/app/admin/shuttle/regular/RegularChangeRequestsPanel.tsx");
  for (const [name, source] of [["학부모", parent], ["관리자", admin]]) {
    assert.doesNotMatch(source, /font-extrabold|font-black|font-bold/, `${name}: 굵기는 400·500·600·700 중 본문·버튼용만`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/, `${name}: 색 코드 직접 쓰기 금지`);
    assert.doesNotMatch(source, /material-symbols|lucide-react|<svg/, `${name}: 아이콘 없음`);
    assert.doesNotMatch(source, /\p{Extended_Pictographic}/u, `${name}: 이모지 없음`);
    assert.doesNotMatch(source, /text-\[1[01]px\]/, `${name}: 글자 12px 이상`);
  }
  assert.match(parent, /<h1 className="academy-heading">셔틀 계속 바꾸기<\/h1>/);
  assert.match(parent, />셔틀 변경<\/Link>/, "하루 변경 화면 이름 그대로");
  assert.doesNotMatch(parent, /학원에 문의|학원으로 문의/, "막다른 문구 금지");
  assert.match(parent, /import LocationPickerModal, \{ type MapLocationData \} from "@\/components\/maps\/LocationPickerModal"/);
  assert.match(parent, /requirePlaceName/, "장소명 필수(기사님 명단 이름)");
  assert.match(parent, /selectableWeekdays\(kind, ctx, directions\)/);
  assert.match(parent, /min-h-11/, "터치 44px");
  assert.match(parent, /label="신청 취소"[\s\S]{0,160}onConfirm=\{\(\) => cancel\(r\.id\)\}/, "취소는 확인 1회");
  assert.match(admin, /disabled=\{pending \|\| !rejecting\.note\.trim\(\)\}/, "반려는 사유를 적어야 보낸다");
  assert.match(admin, /승인할까요\? 학부모에게 앱 알림이 갑니다\./);
});
