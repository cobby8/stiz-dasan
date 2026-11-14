// 학부모 «지각·조퇴 알리기» + 셔틀 자차 표시(2026-11-14 원장 결정표 묶음 B) — 실제로 실행해서 확인한다.
//  ① 알릴 수 있는 시간: 지각 = 수업 시작 전까지, 조퇴 = 수업 끝나기 전까지(직전·정각·직후, 자정 경계, 지난 날짜)
//  ② 예상 시각 범위·고르는 목록·지각/조퇴 시각 순서
//  ③ 셔틀을 물어볼 날인가(명단에 그 방향이 있고 아직 안 탄다고 하지 않은 날만)
//  ④ 서버(가짜 DB · 시계 고정): 보강권이 나가지 않는다 · 조퇴 + 하원 셔틀 기록 · 시간 지난 뒤 거절 · 남의 자녀 거절 · 취소 시 셔틀 기록도 취소
//  ⑤ 기사님 화면 판정: «안 탄다고 기록된 아이»만 잠근다(자차·조퇴·지각) — 지각 예정만 알린 아이·다른 곳에서 타는 아이는 잠기지 않는다
//  ⑥ 학부모 «셔틀 변경» 글자: 안 타요 → 직접 데려다줘요 / 직접 데리러 가요(자차)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");

// 순수 TS 를 CommonJS 로 올려 실행한다(DB·알림만 가짜로 바꿔 끼운다).
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
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

const rules = load("src/lib/regular/arrivalNoticeRules.ts");
const dayRules = load("src/lib/shuttle/dayExceptionRules.ts");
const routeLogic = load("src/lib/shuttle/regularDriverRouteLogic.ts");
const unified = load("src/lib/shuttle/unifiedDriverRunLogic.ts");

// 2026-11-19 = 목요일. 반: 목 17:00~18:20
const DAY = "2026-11-19";
const START = "17:00";
const END = "18:20";

// ── ① 알릴 수 있는 시간 ─────────────────────────────────────────────────────
test("① 지각은 수업 시작 «전»까지 — 1분 전 열림, 정각·직후 닫힘", () => {
  const open = (nowYmd, nowHm) => rules.isArrivalNoticeOpen("LATE", DAY, START, END, nowYmd, nowHm);
  assert.equal(open(DAY, "16:59"), true, "시작 1분 전");
  assert.equal(open(DAY, "17:00"), false, "시작 정각");
  assert.equal(open(DAY, "17:01"), false, "시작 1분 뒤");
  // 결석·셔틀의 «1시간 전» 규칙이 아니다 — 30분 전에도 된다
  assert.equal(open(DAY, "16:30"), true);
});

test("① 조퇴는 수업 끝나기 «전»까지 — 수업 중에도 열림, 끝 정각부터 닫힘", () => {
  const open = (nowYmd, nowHm) => rules.isArrivalNoticeOpen("EARLY", DAY, START, END, nowYmd, nowHm);
  assert.equal(open(DAY, "17:30"), true, "수업 중");
  assert.equal(open(DAY, "18:19"), true, "끝 1분 전");
  assert.equal(open(DAY, "18:20"), false, "끝 정각");
  assert.equal(open(DAY, "18:21"), false, "끝 1분 뒤");
  // 끝 시각을 모르는 반은 시작 시각을 기준으로 본다
  assert.equal(rules.isArrivalNoticeOpen("EARLY", DAY, START, null, DAY, "16:59"), true);
  assert.equal(rules.isArrivalNoticeOpen("EARLY", DAY, START, "", DAY, "17:00"), false);
});

test("① 자정 경계·지난 날짜·잘못된 입력", () => {
  for (const kind of ["LATE", "EARLY"]) {
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, START, END, "2026-11-18", "23:59"), true, `${kind} 전날 23:59`);
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, START, END, DAY, "00:00"), true, `${kind} 당일 00:00`);
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, START, END, "2026-11-20", "00:00"), false, `${kind} 다음 날 00:00`);
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, START, END, "2026-12-31", "10:00"), false, `${kind} 지난 날짜`);
    // 시작 시각을 모르면 전날까지만
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, null, null, "2026-11-18", "23:59"), true);
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, null, null, DAY, "00:00"), false);
    assert.equal(rules.isArrivalNoticeOpen(kind, "2026-02-30", START, END, "2026-02-01", "10:00"), false, "없는 날짜");
    assert.equal(rules.isArrivalNoticeOpen(kind, DAY, START, END, DAY, "25:00"), false, "잘못된 지금 시각");
  }
  // 연말 → 연초(자정을 넘어가는 계산)
  assert.equal(rules.isArrivalNoticeOpen("LATE", "2027-01-01", "10:00", "11:00", "2026-12-31", "23:59"), true);
  assert.equal(rules.isArrivalNoticeOpen("EARLY", "2026-12-31", "22:30", "23:50", "2027-01-01", "00:00"), false);
});

// ── ② 예상 시각 ─────────────────────────────────────────────────────────────
test("② 예상 시각은 수업 시작 뒤 ~ 끝 전(양 끝 정각 제외), HH:mm 만", () => {
  const ok = (value) => rules.isValidExpectedTime(value, START, END);
  assert.equal(ok("17:10"), true);
  assert.equal(ok("17:01"), true);
  assert.equal(ok("18:19"), true);
  assert.equal(ok("17:00"), false, "시작 정각");
  assert.equal(ok("18:20"), false, "끝 정각");
  assert.equal(ok("16:50"), false);
  for (const bad of ["7:10", "25:00", "17:60", "", null, 1710, "17:10:00"]) assert.equal(ok(bad), false, String(bad));
  // 끝 시각을 모르면 시작 뒤면 받는다
  assert.equal(rules.isValidExpectedTime("19:00", START, null), true);
  assert.equal(rules.isValidExpectedTime("17:00", START, null), false);
});

test("② 고르는 시각 목록(10분 간격) · 표시 글자 · 지각/조퇴 순서", () => {
  assert.deepEqual(rules.expectedTimeOptions(START, END), ["17:10", "17:20", "17:30", "17:40", "17:50", "18:00", "18:10"]);
  assert.deepEqual(rules.expectedTimeOptions(null, END), []);
  for (const value of rules.expectedTimeOptions(START, END)) assert.equal(rules.isValidExpectedTime(value, START, END), true);
  assert.equal(rules.arrivalNoticeLabel("LATE", "17:20"), "지각 예정 17:20");
  assert.equal(rules.arrivalNoticeLabel("EARLY", "18:00"), "조퇴 예정 18:00");
  assert.equal(rules.arrivalTimesConsistent("17:20", "18:00"), true);
  assert.equal(rules.arrivalTimesConsistent("18:00", "17:20"), false);
  assert.equal(rules.arrivalTimesConsistent("17:30", "17:30"), false);
  assert.equal(rules.arrivalTimesConsistent(null, "17:30"), true);
});

// ── ③ 셔틀 질문 ─────────────────────────────────────────────────────────────
test("③ 셔틀은 «그날 그 방향을 타는 아이»에게만 묻는다", () => {
  const ask = (kind, rosterDirections, exceptions = [], withinShuttleWindow = true) =>
    rules.shuttleAskNeeded({ kind, rosterDirections, exceptions, withinShuttleWindow });
  assert.equal(ask("EARLY", ["BOARD", "ALIGHT"]), true, "조퇴 → 하원 셔틀");
  assert.equal(ask("EARLY", ["BOARD"]), false, "하원 셔틀을 안 타는 아이");
  assert.equal(ask("LATE", ["BOARD"]), true, "지각 → 등원 셔틀");
  assert.equal(ask("LATE", ["ALIGHT"]), false);
  assert.equal(ask("EARLY", []), false, "셔틀 명단에 없는 아이");
  // 이미 그 방향을 안 탄다고 해 둔 날은 다시 묻지 않는다
  assert.equal(ask("EARLY", ["ALIGHT"], [{ direction: "DROPOFF", kind: "SKIP" }]), false);
  assert.equal(ask("EARLY", ["ALIGHT"], [{ direction: "BOTH", kind: "SKIP" }]), false);
  assert.equal(ask("EARLY", ["ALIGHT"], [{ direction: "PICKUP", kind: "SKIP" }]), true, "등원만 안 타는 날");
  // 보안 검수: 그날 그 방향에 학부모가 이미 낸 변경(다른 곳에서 타요 포함)이 있으면 묻지도 건드리지도 않는다
  assert.equal(ask("EARLY", ["ALIGHT"], [{ direction: "DROPOFF", kind: "LOCATION" }]), false, "다른 곳에서 내리는 날");
  assert.equal(ask("EARLY", ["ALIGHT"], [{ direction: "BOTH", kind: "LOCATION" }]), false);
  assert.equal(ask("EARLY", ["ALIGHT"], [{ direction: "PICKUP", kind: "LOCATION" }]), true, "반대 방향 변경은 상관없다");
  // 셔틀 변경을 받는 범위(14일) 밖: 질문 대신 «셔틀 변경에서 따로» 안내 — 그 방향을 타는 아이에게만
  const later = (kind, rosterDirections, withinShuttleWindow) => rules.shuttleLaterNoticeNeeded({ kind, rosterDirections, withinShuttleWindow });
  assert.equal(later("EARLY", ["ALIGHT"], false), true);
  assert.equal(later("EARLY", ["BOARD"], false), false);
  assert.equal(later("EARLY", ["ALIGHT"], true), false, "범위 안이면 질문이 뜬다");
  assert.equal(ask("EARLY", ["ALIGHT"], [], false), false, "셔틀 변경을 받는 범위(14일) 밖");
  assert.equal(rules.shuttleDirectionOf("EARLY"), "DROPOFF");
  assert.equal(rules.shuttleDirectionOf("LATE"), "PICKUP");
});

// ── ④ 서버(가짜 DB) ─────────────────────────────────────────────────────────
function fakeWorld({ owned = true, roster = ["BOARD", "ALIGHT"], absent = false, exceptions = [] } = {}) {
  const world = { sql: [], notices: [], exceptions: exceptions.map((x) => ({ ...x })), staffNotices: [], shuttleNotices: [], shuttleSaves: [], seq: 0 };
  const query = async (sql, ...args) => {
    world.sql.push(sql);
    if (sql.includes("to_regclass")) return [{ ready: true }];
    if (sql.includes('FROM "Enrollment" e')) {
      return owned ? [{ dayOfWeek: "Thu", startTime: START, endTime: END, studentName: "합성", className: "목 5시", status: "ACTIVE", resumeFrom: null }] : [];
    }
    if (sql.includes('FROM "RegularAbsence"')) return absent ? [{ id: "abs1" }] : [];
    if (sql.includes('FROM "RegularShuttleStop"')) return roster.map((direction) => ({ studentId: "s1", weekday: 4, direction }));
    if (sql.includes('FROM "ShuttleDayException" x')) return world.exceptions.filter((x) => !x.canceled).map((x) => ({ ...x }));
    if (sql.includes('INSERT INTO "RegularArrivalNotice"')) {
      const [studentId, classId, date, kind, expectedTime] = args;
      let row = world.notices.find((n) => n.studentId === studentId && n.classId === classId && n.date === date && n.kind === kind);
      if (!row) { row = { id: `n${++world.seq}`, studentId, classId, date, kind, shuttleExceptionId: null, changeCount: 0 }; world.notices.push(row); }
      else if (row.status === "CANCELLED") row.shuttleExceptionId = null;
      Object.assign(row, { expectedTime, status: "REPORTED", changeCount: row.changeCount + 1 });
      return [{ id: row.id, eventVersion: `v${++world.seq}` }];
    }
    if (sql.includes('UPDATE "RegularArrivalNotice"') && sql.includes("'CANCELLED'")) {
      const row = world.notices.find((n) => n.id === args[0] && n.status === "REPORTED");
      if (!row) return [];
      row.status = "CANCELLED";
      row.changeCount += 1;
      return [{ id: row.id, shuttleExceptionId: row.shuttleExceptionId, eventVersion: `v${++world.seq}` }];
    }
    if (sql.includes('UPDATE "ShuttleDayException"')) {
      const row = world.exceptions.find((x) => x.id === args[0] && !x.canceled);
      if (!row) return [];
      row.canceled = true;
      return [{ id: row.id, direction: row.direction, kind: row.kind, location: null }];
    }
    if (sql.includes('JOIN "Class" c ON c.id = n."classId"')) {
      const [, studentId, classId, date, kind] = args;
      return world.notices
        .filter((n) => n.studentId === studentId && n.classId === classId && n.date === date && n.kind === kind && n.status === "REPORTED")
        .map((n) => ({ id: n.id, expectedTime: n.expectedTime, startTime: START, endTime: END, studentName: "합성", className: "목 5시" }));
    }
    if (sql.includes('SUM("changeCount")')) {
      const [studentId, classId, date] = args;
      return [{ total: world.notices.filter((n) => n.studentId === studentId && n.classId === classId && n.date === date).reduce((sum, n) => sum + n.changeCount, 0) }];
    }
    if (sql.includes('FROM "RegularArrivalNotice"')) {
      const [studentId, classId, date] = args;
      return world.notices.filter((n) => n.studentId === studentId && n.classId === classId && n.date === date).map((n) => ({ ...n }));
    }
    throw new Error(`예상하지 못한 SQL: ${sql.slice(0, 80)}`);
  };
  const db = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: async (sql, ...args) => {
      world.sql.push(sql);
      const row = world.notices.find((n) => n.id === args[0]);
      if (row) row.shuttleExceptionId = args[1];
      return 1;
    },
    $transaction: async (fn) => fn(db),
  };
  const service = load("src/lib/regular/parent-arrival-notice.ts", {
    "@/lib/prisma": { prisma: db },
    "@/lib/account/child-access": { childAccessSql: async () => "TRUE" },
    "@/lib/regular/parent-regular-absence": { ABSENCE_REPORT_WEEKS: 4 },
    "@/lib/operational-staff-notification": { notifyOperationalStaff: async (input) => { world.staffNotices.push(input); return { ok: true }; } },
    "@/lib/shuttle/parent-shuttle-exception": {
      // «셔틀 변경 › 자차»와 같은 저장 함수 — 무엇을 저장하라고 불렀는지 그대로 남긴다
      saveShuttleException: async (_db, value, userId) => {
        world.shuttleSaves.push({ ...value, userId });
        const row = { id: `x${++world.seq}`, studentId: value.studentId, ymd: value.serviceDate, direction: value.direction, kind: value.kind, canceled: false };
        world.exceptions.push(row);
        return [{ id: row.id, changed: true }];
      },
      notifyAdminsOfShuttleException: async (input) => { world.shuttleNotices.push(input); },
      shuttleEventVersion: () => "ver",
    },
  });
  return { world, service };
}

// 시계 고정(KST 글자 → ms)
const realNow = Date.now;
const setClock = (ymd, hm) => { Date.now = () => Date.parse(`${ymd}T${hm}:00+09:00`); };
test.afterEach(() => { Date.now = realNow; });

const INPUT = { studentId: "s1", classId: "c1", date: DAY };

test("④ 조퇴 + «하원 셔틀도 안 타요» → 알림 1건 + 하원 SKIP 셔틀 기록, 보강권·결석 표에는 쓰지 않는다", async () => {
  const { world, service } = fakeWorld();
  setClock(DAY, "17:30"); // 수업 중에도 조퇴는 알릴 수 있다
  const result = await service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00", skipShuttle: true });
  assert.equal(result.ok, true);
  assert.equal(result.shuttleSkipped, true);
  assert.deepEqual(world.notices.map((n) => [n.kind, n.expectedTime, n.status]), [["EARLY", "18:00", "REPORTED"]]);
  // 기존 «안 타요»와 같은 기록: 그 날짜·하원·SKIP, 장소 없음
  assert.equal(world.shuttleSaves.length, 1);
  assert.deepEqual(
    { studentId: world.shuttleSaves[0].studentId, serviceDate: world.shuttleSaves[0].serviceDate, direction: world.shuttleSaves[0].direction, kind: world.shuttleSaves[0].kind, location: world.shuttleSaves[0].location, userId: world.shuttleSaves[0].userId },
    { studentId: "s1", serviceDate: DAY, direction: "DROPOFF", kind: "SKIP", location: null, userId: "p1" },
  );
  assert.equal(world.notices[0].shuttleExceptionId, world.exceptions[0].id, "알림과 셔틀 기록이 이어져 있다(기사님 화면 «조퇴»)");
  // 알림: 원장·담당 선생님(앱 안) 1통 + 기사님 쪽 기존 셔틀 변경 알림 1통
  assert.equal(world.staffNotices.length, 1);
  assert.equal(world.staffNotices[0].includeCoach, true);
  assert.equal(world.staffNotices[0].classId, "c1");
  assert.notEqual(world.staffNotices[0].includeDriver, true);
  assert.match(world.staffNotices[0].message, /조퇴 예정/);
  assert.match(world.staffNotices[0].message, /18:00/);
  assert.equal(world.shuttleNotices.length, 1);
  // ★ 보강권이 나가지 않는다 — 실행된 SQL 어디에도 보강권 표가 없고, 결석 표에는 읽기(SELECT)만 한다
  assert.ok(world.sql.length > 0);
  for (const sql of world.sql) {
    assert.doesNotMatch(sql, /MakeupCredit|MakeupSession/);
    if (/"RegularAbsence"(?!\w)/.test(sql)) assert.match(sql.trim(), /^SELECT/);
  }
});

test("④ 보강권 발급·결석 저장 함수를 아예 쓰지 않는다(소스)", () => {
  const source = read("src/lib/regular/parent-arrival-notice.ts").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(source, /MakeupCredit|issueCreditForReportedAbsence|saveReportedAbsenceInTx|credit-service|absence-report-credit/);
  assert.doesNotMatch(source, /INSERT INTO "RegularAbsence"|UPDATE "RegularAbsence"/);
  // Prisma ORM 메서드 금지(PgBouncer) — raw SQL 만
  for (const file of ["src/lib/regular/parent-arrival-notice.ts", "src/lib/regular/arrival-notice-read.ts"]) {
    assert.doesNotMatch(read(file), /\.(findMany|findFirst|findUnique|create|update|upsert|delete|deleteMany|updateMany)\(/, file);
  }
});

test("④ 지각 예정만 알림(셔틀은 그대로) → 셔틀 기록을 만들지 않는다", async () => {
  const { world, service } = fakeWorld();
  setClock(DAY, "16:59");
  const result = await service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:20", skipShuttle: false });
  assert.equal(result.shuttleSkipped, false);
  assert.equal(world.shuttleSaves.length, 0);
  assert.equal(world.exceptions.length, 0);
  assert.equal(world.staffNotices.length, 1);
  assert.match(world.staffNotices[0].message, /지각 예정/);
});

test("④ «안 타요»를 보내도 셔틀 명단에 그 방향이 없으면 기록을 만들지 않는다(서버 재확인)", async () => {
  const { world, service } = fakeWorld({ roster: ["BOARD"] }); // 등원만 타는 아이
  setClock(DAY, "16:00");
  const result = await service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00", skipShuttle: true });
  assert.equal(result.shuttleSkipped, false);
  assert.equal(world.shuttleSaves.length, 0);
});

test("④ 시간 경계는 서버가 막는다 — 지각: 시작 정각부터 / 조퇴: 끝 정각부터", async () => {
  const late = fakeWorld();
  setClock(DAY, "17:00");
  await assert.rejects(late.service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:20" }), /ARRIVAL_CLOSED_LATE/);
  assert.equal(late.world.notices.length, 0);

  const early = fakeWorld();
  setClock(DAY, "18:19");
  assert.equal((await early.service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:10" })).ok, true);
  setClock(DAY, "18:20");
  await assert.rejects(early.service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00" }), /ARRIVAL_CLOSED_EARLY/);
  // 취소도 같은 규칙
  await assert.rejects(early.service.cancelArrivalNotice("p1", { ...INPUT, kind: "EARLY" }), /ARRIVAL_CLOSED_EARLY/);
  assert.equal(early.world.notices[0].status, "REPORTED");

  // 자정 경계: 전날 23:59 에는 받고, 다음 날 00:00 에는 «지난 날짜»
  const midnight = fakeWorld();
  setClock("2026-11-18", "23:59");
  assert.equal((await midnight.service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:10" })).ok, true);
  setClock("2026-11-20", "00:00");
  await assert.rejects(midnight.service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00" }), /NOT_REPORTABLE_DATE/);
});

test("④ 남의 자녀·다른 요일·범위 밖·수업 시간 밖 시각·결석 알린 날은 거절", async () => {
  setClock(DAY, "10:00");
  await assert.rejects(fakeWorld({ owned: false }).service.submitArrivalNotice("p2", { ...INPUT, kind: "LATE", expectedTime: "17:20" }), /NOT_OWNER/);
  const { service, world } = fakeWorld();
  await assert.rejects(service.submitArrivalNotice("p1", { ...INPUT, date: "2026-11-20", kind: "LATE", expectedTime: "17:20" }), /NOT_REPORTABLE_DATE/);
  await assert.rejects(service.submitArrivalNotice("p1", { ...INPUT, date: "2026-12-24", kind: "LATE", expectedTime: "17:20" }), /ABSENCE_TOO_FAR/);
  await assert.rejects(service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "18:20" }), /ARRIVAL_INVALID_TIME/);
  await assert.rejects(service.submitArrivalNotice("p1", { ...INPUT, kind: "SICK", expectedTime: "17:20" }), /ARRIVAL_INVALID_KIND/);
  assert.equal(world.notices.length, 0);
  await assert.rejects(fakeWorld({ absent: true }).service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:20" }), /ARRIVAL_ABSENT/);
  // 지각이 조퇴보다 늦을 수 없다
  await service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "17:30" });
  await assert.rejects(service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:40" }), /ARRIVAL_TIME_ORDER/);
});

test("④ 시각 바꾸기는 같은 줄을 고치고, 같은 내용 다시 보내기는 알림을 또 보내지 않는다", async () => {
  const { world, service } = fakeWorld();
  setClock(DAY, "12:00");
  await service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:20" });
  const again = await service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:20" });
  assert.equal(again.noOp, true);
  assert.equal(world.staffNotices.length, 1);
  const changed = await service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime: "17:40" });
  assert.equal(changed.changed, true);
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].expectedTime, "17:40");
  assert.equal(world.staffNotices.length, 2);
  assert.notEqual(world.staffNotices[0].stableEventKey, world.staffNotices[1].stableEventKey);
});

test("④ 취소하면 함께 만든 셔틀 기록도 취소된다(아이가 평소대로 탄다)", async () => {
  const { world, service } = fakeWorld();
  setClock(DAY, "15:00");
  await service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00", skipShuttle: true });
  const result = await service.cancelArrivalNotice("p1", { ...INPUT, kind: "EARLY" });
  assert.equal(result.shuttleRestored, true);
  assert.equal(world.notices[0].status, "CANCELLED");
  assert.equal(world.exceptions[0].canceled, true);
  assert.equal(world.shuttleNotices.at(-1).action, "CANCELED");
  assert.equal(world.staffNotices.at(-1).eventType, "ARRIVAL_NOTICE_CANCELED");
  // 이미 취소한 것을 다시 취소 → 찾을 수 없음
  await assert.rejects(service.cancelArrivalNotice("p1", { ...INPUT, kind: "EARLY" }), /ARRIVAL_NOT_FOUND/);
});

// ── ⑤ 기사님 화면 판정 ──────────────────────────────────────────────────────
const stop = (direction, rows) => ({ label: "푸르지오", arriveTime: direction === "BOARD" ? "16:40" : "18:40", lat: null, lng: null, direction, rows });
const row = (rowId, name, extra = {}) => ({ rowId, name, parentPhone: "01000000000", studentPhone: null, absent: false, ...extra });
const classesOf = () => [{
  classTime: "17:00",
  board: [stop("BOARD", [row("b1", "가"), row("b2", "나"), row("b3", "다")])],
  alight: [stop("ALIGHT", [row("a1", "가"), row("a2", "나"), row("a3", "다")])],
}];
const byName = (r, entry) => r.name === entry.name;

test("⑤ «안 탄다고 기록된 아이»만 그 방향 줄에 사유 글자가 붙는다", () => {
  const out = routeLogic.attachShuttleDayNotes(classesOf(), [
    { name: "가", phone: null, direction: "DROPOFF", kind: "SKIP", location: null, skipLabel: rules.shuttleSkipLabel("EARLY") }, // 조퇴
    { name: "나", phone: null, direction: "PICKUP", kind: "SKIP", location: null, skipLabel: rules.shuttleSkipLabel(null) }, // 자차 등원
    { name: "다", phone: null, direction: "DROPOFF", kind: "LOCATION", location: "다산초", skipLabel: null }, // 다른 곳에서 내림
  ], byName, dayRules.describeException);
  const pick = (id) => [...out[0].board[0].rows, ...out[0].alight[0].rows].find((r) => r.rowId === id);
  assert.equal(pick("a1").skipLabel, "조퇴");
  assert.equal(pick("b1").skipLabel, undefined, "조퇴한 아이의 등원 줄은 그대로");
  assert.equal(pick("b2").skipLabel, "자차");
  assert.equal(pick("a2").skipLabel, undefined, "자차 등원한 아이의 하원 줄은 그대로");
  assert.equal(pick("a3").skipLabel, undefined, "다른 곳에서 타는 아이는 잠그지 않는다");
  assert.equal(pick("a3").shuttleNote, "오늘 탑승 장소: 다산초");
  assert.equal(rules.shuttleSkipLabel("LATE"), "지각");

  // 통합 운행표 줄까지 실려 간다
  const riders = unified.buildRegularRows(out).flatMap((r) => r.riders);
  assert.equal(riders.find((r) => r.checkId === "a1").skipLabel, "조퇴");
  assert.equal("skipLabel" in riders.find((r) => r.checkId === "b1"), false, "사유가 없으면 칸 자체가 없다(종전 모양)");
});

test("⑤ 버튼 잠금 판정 — 자차·조퇴는 잠금, 지각 예정만 알린 아이·결석 아이는 종전대로", () => {
  const view = (rider, stored = null) => unified.riderBoardingView({ kind: "REGULAR", absent: false, ...rider }, stored);
  // 안 탄다고 기록된 아이: 잠금 + 사유 글자, 기본 상태 없음
  const self = view({ skipLabel: "자차" });
  assert.equal(self.blocked, true);
  assert.equal(unified.riderLockLabel({ kind: "REGULAR", absent: false, skipLabel: "자차" }), "자차");
  assert.equal(self.status, null);
  assert.equal(self.dimmed, true);
  assert.equal(view({ skipLabel: "조퇴" }).blocked, true);
  assert.equal(unified.riderLockLabel({ kind: "REGULAR", absent: false, skipLabel: "조퇴" }), "조퇴");
  // 지각 «예정»만 알리고 셔틀은 타는 아이 = 셔틀 기록 없음 → 잠기지 않는다
  const lateOnly = view({});
  assert.equal(lateOnly.blocked, false);
  assert.equal(unified.riderLockLabel({ kind: "REGULAR", absent: false }), null);
  // 결석 신고 아이는 종전 «결석» 표시가 우선(버튼 그대로)
  const absent = view({ absent: true, skipLabel: "자차" });
  assert.equal(absent.blocked, false);
  assert.equal(absent.absentReported, true);
  assert.equal(absent.status, "NOSHOW");
  // 휴원·휴무 잠금 글자가 있으면 그 글자가 먼저
  assert.equal(unified.riderLockLabel({ kind: "REGULAR", absent: false, blockedLabel: "휴원", skipLabel: "자차" }), "휴원");
  // 방학특강 줄은 대상 아님
  assert.equal(unified.riderBoardingView({ kind: "SEASONAL", absent: false, skipLabel: "자차" }, null).blocked, false);

  // 진행률: 잠긴 줄은 체크 대상(분모)에서 빠진다
  const rows = [{ riders: [
    { key: "R:1", kind: "REGULAR", absent: false, skipLabel: "자차" },
    { key: "R:2", kind: "REGULAR", absent: false },
  ] }];
  assert.deepEqual(unified.countProgress(rows, { "R:2": "BOARDED" }), { total: 1, boarded: 1, noshow: 0, self: 0 });
  // 전원이 안 타는 정차는 «정차 안 해도 됨»
  assert.equal(unified.stopAbsenceSummary([rows[0].riders[0]], {}).allSkippable, true);
});

test("⑤ 기사님 화면: 잠긴 줄은 탑승·미탑승 버튼이 비활성이고 사유를 글자로 보인다(소스)", () => {
  const source = read("src/components/shuttle/UnifiedDriverClient.tsx");
  assert.match(source, /const locked = view\.blocked;/);
  assert.match(source, /disabled=\{isBusy \|\| locked\}[^>]*active=\{status === "BOARDED"\}/);
  assert.match(source, /disabled=\{isBusy \|\| locked\}[^>]*active=\{status === "NOSHOW" \|\| status === "SELF"\}/);
  assert.match(source, /\{lockLabel\}/);
  assert.match(source, /const lockLabel = riderLockLabel\(rider\);/);
  // 체크 저장 서버 동작은 그대로 — 서버 거부는 휴원·휴무 글자(blockedLabel)만 본다
  for (const file of ["src/app/api/shuttle/regular-boarding/route.ts", "src/app/api/staff/shuttle/regular-boarding/route.ts"]) {
    assert.doesNotMatch(read(file), /skipLabel/, file);
  }
});

// ── ⑥ 학부모 셔틀 변경 글자 ─────────────────────────────────────────────────
test("⑥ «안 타요» → 직접 데려다줘요 / 직접 데리러 가요(자차)", () => {
  assert.equal(dayRules.parentShuttleChangeLabel("SKIP", "PICKUP"), "직접 데려다줘요(자차)");
  assert.equal(dayRules.parentShuttleChangeLabel("SKIP", "DROPOFF"), "직접 데리러 가요(자차)");
  assert.equal(dayRules.parentShuttleChangeLabel("SKIP", "BOTH"), "등원·하원 모두 자차");
  assert.equal(dayRules.parentShuttleChangeLabel("LOCATION", "PICKUP"), "다른 곳에서 타요");
  assert.equal(dayRules.parentShuttleChangeLabel("???", "PICKUP"), null);
  // 저장 값은 그대로(SKIP) — 기사님·관리자·카카오 쪽 글자도 그대로
  assert.deepEqual([...dayRules.SHUTTLE_EXCEPTION_KINDS], ["SKIP", "LOCATION"]);
  assert.equal(dayRules.describeException({ kind: "SKIP" }), "오늘 셔틀 안 탐");
});

test("마이그레이션: 멱등 · RLS 켜고 강제 · 브라우저 키 권한 회수 · 시간 칸 timestamptz", () => {
  const sql = read("prisma/migrations/20261115140000_regular_arrival_notice/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."RegularArrivalNotice"/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."RegularArrivalNotice" FROM anon, authenticated/);
  assert.match(sql, /"createdAt" TIMESTAMPTZ\(6\)/);
  assert.match(sql, /"updatedAt" TIMESTAMPTZ\(6\)/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /\bTIMESTAMP\b(?!TZ)/i);
  assert.match(sql, /DROP TABLE IF EXISTS public\."RegularArrivalNotice"/, "되돌림 SQL 주석");
  for (const line of sql.replace(/--[^\n]*/g, "").split("\n").filter((l) => /^\s*CREATE (UNIQUE )?INDEX/.test(l))) assert.match(line, /IF NOT EXISTS/);
});

// ── ⑦ 학부모 화면 부품 ─────────────────────────────────────────────────────
test("⑦ 결석 알리기 화면의 지각·조퇴 칸 — 알린 내용 줄 · 시각 고르기 · 셔틀 질문 한 번", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const area = load("src/app/mypage/regular-absence/ArrivalNoticeArea.tsx", {
    "@/components/parent/InlineConfirm": { __esModule: true, default: ({ label }) => React.createElement("button", { type: "button" }, label) },
    "@/components/parent/customerMessage": { customerMessage: (_e, fallback) => fallback },
  });
  const d = { studentId: "s1", classId: "c1", date: DAY, startTime: START, reported: false, locked: false };
  const info = (extra = {}) => ({ endTime: END, open: { LATE: true, EARLY: true }, ask: { LATE: false, EARLY: true }, notices: [], ...extra });
  const html = (props) => renderToStaticMarkup(React.createElement(area.default, { d, onOpen() {}, onClose() {}, onChanged() {}, formKind: null, ...props }));

  // 새로 알릴 수 있는 종류: 열려 있고 아직 안 알린 것만 / 결석을 알린 줄·정보 없는 줄은 없음
  assert.deepEqual(area.arrivalAddableKinds(d, info()), ["LATE", "EARLY"]);
  assert.deepEqual(area.arrivalAddableKinds(d, info({ open: { LATE: false, EARLY: true } })), ["EARLY"], "수업이 시작되면 «늦어요»는 사라진다");
  assert.deepEqual(area.arrivalAddableKinds(d, info({ notices: [{ kind: "LATE", expectedTime: "17:20", label: "지각 예정 17:20", shuttleSkipped: false }] })), ["EARLY"]);
  assert.deepEqual(area.arrivalAddableKinds({ ...d, reported: true }, info()), []);
  assert.deepEqual(area.arrivalAddableKinds(d, undefined), []);

  // 아무것도 없으면 그리지 않는다(줄 높이를 늘리지 않는다)
  assert.equal(html({ info: info() }), "");
  assert.equal(html({ info: undefined }), "");

  // 조퇴 알리는 칸: 시각 목록 + «하원 셔틀도 안 타나요?» 한 번
  const earlyForm = html({ info: info(), formKind: "EARLY" });
  assert.match(earlyForm, /몇 시쯤 나가나요\?/);
  assert.match(earlyForm, /<option value="18:00">18:00<\/option>/);
  assert.match(earlyForm, /하원 셔틀도 안 타나요\?/);
  assert.match(earlyForm, />일찍 가요 알리기<\/button>/);
  // 지각은 등원 셔틀을 안 타는 아이(ask=false)라 묻지 않는다
  const lateForm = html({ info: info(), formKind: "LATE" });
  assert.match(lateForm, /몇 시쯤 도착하나요\?/);
  assert.doesNotMatch(lateForm, /셔틀도 안 타나요/);

  // 알린 내용 줄: «조퇴 예정 18:00» + 셔틀 안 타요 + 시각 바꾸기·알림 취소. 시간이 지나면 버튼이 없다
  const noticed = { notices: [{ kind: "EARLY", expectedTime: "18:00", label: "조퇴 예정 18:00", shuttleSkipped: true }] };
  const line = html({ info: info(noticed) });
  assert.match(line, /조퇴 예정 18:00/);
  assert.match(line, /하원 셔틀 안 타요/);
  assert.match(line, />시각 바꾸기<\/button>/);
  assert.match(line, />알림 취소<\/button>/);
  const closed = html({ info: info({ ...noticed, open: { LATE: false, EARLY: false } }) });
  assert.match(closed, /조퇴 예정 18:00/);
  assert.doesNotMatch(closed, /시각 바꾸기|알림 취소/);
  // 시각 바꾸기로 연 칸은 셔틀을 다시 묻지 않는다
  assert.doesNotMatch(html({ info: info(noticed), formKind: "EARLY" }), /셔틀도 안 타나요/);

  // 아이콘·이모지 없이 글자만, 굵기는 400·500·600·700 만
  const source = read("src/app/mypage/regular-absence/ArrivalNoticeArea.tsx");
  assert.doesNotMatch(source, /UiIcon|material-symbols|lucide|font-extrabold|font-black/);
});

// ── ⑧ 보안 검수·코드 리뷰 반영 ───────────────────────────────────────────────
test("⑧ 하루 변경 상한: 알리기·시각 바꾸기·취소 합계 5번 — 6번째는 저장도 알림도 하지 않는다", async () => {
  const { world, service } = fakeWorld();
  setClock(DAY, "12:00");
  const late = (expectedTime) => service.submitArrivalNotice("p1", { ...INPUT, kind: "LATE", expectedTime });
  await late("17:10"); // 1
  await late("17:20"); // 2
  await service.cancelArrivalNotice("p1", { ...INPUT, kind: "LATE" }); // 3
  await service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00", skipShuttle: true }); // 4 — 조퇴 행도 같은 합계
  await late("17:30"); // 5
  const before = { staff: world.staffNotices.length, shuttle: world.shuttleNotices.length, saves: world.shuttleSaves.length };
  assert.equal(before.staff, 5);
  // 6번째: 시각 바꾸기·취소·다른 종류 모두 거절
  await assert.rejects(late("17:40"), /ARRIVAL_CHANGE_LIMIT/);
  await assert.rejects(service.cancelArrivalNotice("p1", { ...INPUT, kind: "LATE" }), /ARRIVAL_CHANGE_LIMIT/);
  await assert.rejects(service.cancelArrivalNotice("p1", { ...INPUT, kind: "EARLY" }), /ARRIVAL_CHANGE_LIMIT/);
  await assert.rejects(service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:10" }), /ARRIVAL_CHANGE_LIMIT/);
  assert.deepEqual({ staff: world.staffNotices.length, shuttle: world.shuttleNotices.length, saves: world.shuttleSaves.length }, before, "알림·셔틀 기록이 늘지 않는다");
  assert.equal(world.notices.find((n) => n.kind === "LATE").expectedTime, "17:30", "저장도 바뀌지 않는다");
  assert.equal(world.notices.find((n) => n.kind === "EARLY").status, "REPORTED");
  assert.equal(world.exceptions[0].canceled, false, "딸린 셔틀 기록도 그대로");
  // 같은 내용을 다시 보내는 것은 변경이 아니라 그대로 성공(noOp)
  assert.equal((await late("17:30")).noOp, true);
  // 다른 날짜는 따로 센다
  assert.equal((await service.submitArrivalNotice("p1", { ...INPUT, date: "2026-11-26", kind: "LATE", expectedTime: "17:10" })).ok, true);
  assert.equal(rules.ARRIVAL_DAILY_CHANGE_LIMIT, 5);
  assert.equal(rules.arrivalChangeLimitReached([2, 3]), true);
  assert.equal(rules.arrivalChangeLimitReached([2, 2]), false);
  assert.equal(rules.arrivalChangeLimitReached([null, undefined]), false);
});

test("⑧ 상한 안내: 서버 글자 + 화면의 «학원에 전화하기»(번호 없으면 글자만)", () => {
  const route = read("src/app/api/mypage/regular-absence/arrival/route.ts");
  assert.match(route, /ARRIVAL_CHANGE_LIMIT: ARRIVAL_CHANGE_LIMIT_MESSAGE/);
  assert.equal(rules.ARRIVAL_CHANGE_LIMIT_MESSAGE, "오늘은 더 바꿀 수 없어요. 학원에 전화해 주세요.");
  const area = read("src/app/mypage/regular-absence/ArrivalNoticeArea.tsx");
  assert.match(area, /result\?\.code === "ARRIVAL_CHANGE_LIMIT"/);
  assert.match(area, /academyTel\(academyPhone\) && \(/);
  assert.match(area, /학원에 전화하기/);
  assert.match(read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx"), /academyPhone=\{contact\.phone\}/);
  const sql = read("prisma/migrations/20261115140000_regular_arrival_notice/migration.sql");
  assert.match(sql, /"changeCount" INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "changeCount" INTEGER NOT NULL DEFAULT 0/);
});

test("⑧ 그날 그 방향에 미리 낸 셔틀 변경(다른 곳에서 타요)이 있으면 «셔틀도 안 타요»를 보내도 건드리지 않는다", async () => {
  const { world, service } = fakeWorld({ exceptions: [{ id: "loc1", studentId: "s1", ymd: DAY, direction: "DROPOFF", kind: "LOCATION", canceled: false }] });
  setClock(DAY, "12:00");
  const result = await service.submitArrivalNotice("p1", { ...INPUT, kind: "EARLY", expectedTime: "18:00", skipShuttle: true });
  assert.equal(result.ok, true);
  assert.equal(result.shuttleSkipped, false);
  assert.equal(world.shuttleSaves.length, 0, "기존 변경을 SKIP 으로 덮어쓰지 않는다");
  assert.equal(world.exceptions.length, 1);
  assert.equal(world.exceptions[0].canceled, false);
  assert.equal(world.notices[0].shuttleExceptionId, null);
  // 알림을 취소해도 기존 변경은 그대로
  await service.cancelArrivalNotice("p1", { ...INPUT, kind: "EARLY" });
  assert.equal(world.exceptions[0].canceled, false);
  assert.equal(world.shuttleNotices.length, 0);
});

test("⑧ 학부모 홈 «오늘 셔틀»·아이 기록: 자차로 신청한 방향은 «자차»로 보인다", () => {
  const summary = load("src/lib/mypage/summary.ts");
  const item = (extra) => ({ id: "x", serviceDate: DAY, direction: "PICKUP", status: "CONFIRMED", pickupEtaLabel: "16:40 승차", dropoffEtaLabel: null, ...extra });
  // 하원만 자차: 등원은 예정 시각 그대로, 하원 줄은 «하원 자차»
  assert.deepEqual(summary.todayShuttleLineTexts([item({ selfRideDirections: ["DROPOFF"] })]), ["등원 16:40 승차", "하원 자차"]);
  // 등원만 자차
  assert.deepEqual(
    summary.todayShuttleLineTexts([item({ direction: "DROPOFF", pickupEtaLabel: null, dropoffEtaLabel: "18:40 하차", selfRideDirections: ["PICKUP"] })]),
    ["등원 자차", "하원 18:40 하차"],
  );
  // 표시가 없으면 종전 그대로
  assert.deepEqual(summary.todayShuttleLineTexts([item({})]), ["등원 16:40 승차"]);

  const childRules = load("src/lib/shuttle/childShuttleRules.ts");
  const leg = (state, time) => ({ stopName: "푸르지오", time, state, note: null, changedTo: null });
  const day = (board, alight) => ({ ymd: DAY, weekday: 4, dayLabel: "목", classId: "c1", className: "목 5시", classTime: "17:00", status: "RUN", statusText: "운행", board, alight });
  const items = childRules.rosterOverviewItems("s1", "합성", [day(leg("RUN", "16:40"), leg("SKIP", "18:40"))]);
  assert.equal(items.length, 1, "타지 않는 방향은 항목을 만들지 않는다(종전 그대로)");
  assert.deepEqual(items[0].selfRideDirections, ["DROPOFF"]);
  const plain = childRules.rosterOverviewItems("s1", "합성", [day(leg("RUN", "16:40"), leg("RUN", "18:40"))]);
  assert.equal(plain.length, 2);
  assert.equal("selfRideDirections" in plain[0], false, "자차가 없으면 칸 자체가 없다");
  assert.equal(childRules.SHUTTLE_SELF_STATUS_TEXT, "자차(신청)");
});

test("⑧ 카카오 대화의 «안 타요» 글자 — 보이는 글자만 자차로, 받는 말은 그대로", () => {
  const source = read("src/lib/kakao-shuttle-flow.ts");
  assert.match(source, /label: "안 타요\(자차\)", messageText: `\$\{P\} 안 타요`/);
  assert.match(source, /parentShuttleChangeLabel\("SKIP", state\.direction \?\? ""\)/);
});

test("⑧ 표 확인은 «있다»만 기억하고, 셔틀 재료는 차례로 읽는다(DB 연결 한도)", async () => {
  let calls = 0;
  let ready = false;
  const reader = load("src/lib/regular/arrival-notice-read.ts", {
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async () => { calls += 1; return [{ ready }]; } } },
  });
  assert.equal(await reader.arrivalNoticeReady(), false);
  assert.equal(await reader.arrivalNoticeReady(), false);
  assert.equal(calls, 2, "«없다»는 기억하지 않는다 — 마이그레이션 뒤 바로 켜진다");
  ready = true;
  assert.equal(await reader.arrivalNoticeReady(), true);
  assert.equal(await reader.arrivalNoticeReady(), true);
  assert.equal(calls, 3, "«있다»는 한 번만 묻는다");
  const service = read("src/lib/regular/parent-arrival-notice.ts");
  assert.match(service, /for \(const month of months\) rosterByMonth\.set\(month, await loadRosterDirections\(studentIds, month\)\);/);
});
