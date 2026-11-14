// 학부모 «아이 기록» 아이 정보·수강 반·셔틀 칸(2026-11-14 원장 «관리자 원생 상세 참고 + 셔틀 정확하게») — 실제로 실행·렌더해서 확인한다.
//  ① 셔틀 규칙: 명단 묶음·시각·요일 순서, 휴무·휴원·퇴원·첫 수업 전·결석·«안 탐»·«다른 곳» 반영, 달 경계, 홈 항목 변환
//  ② 아이 정보 규칙: 성별·만 나이(생일 경계)·학년(3월 경계)·보호자(남의 번호 없음)·보강권 한 줄
//  ③ 조회: 모든 셔틀 SQL 이 확인된 studentId($1)로 묶이고 전화·좌표·메모를 고르지 않는다 / 남의 아이면 셔틀 조회 0번
//  ④ 렌더: 셔틀 없음 · 여러 반 · 휴원 · 휴무·결석·안 탐
//  ⑤ 소스 가드: 숨길 칸 미조회 · 홈 셔틀 조회가 명단을 내 자녀 범위에서만 읽음
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

const rules = load("src/lib/shuttle/childShuttleRules.ts");
const profileRules = load("src/lib/parent/childProfileRules.ts");

// ── 공통 재료 ──────────────────────────────────────────────────────────────
// 2026-11-16 = 월요일. 월 18:00 반(MON), 목 17:00 반(THU)
const cls = (extra = {}) => ({
  classId: "MON", className: "월 6시", dayOfWeek: "Mon", startTime: "18:00", status: "ACTIVE",
  startsOn: null, scheduled: null, pausedResumeOn: null, ...extra,
});
const thu = (extra = {}) => cls({ classId: "THU", className: "목 5시", dayOfWeek: "Thu", startTime: "17:00", ...extra });
const row = (id, weekday, direction, arriveTime, stopName = "정류장", classTime = "18:00~19:20", sortOrder = 0) =>
  ({ id, weekday, direction, arriveTime, stopName, classTime, sortOrder });
const ROWS = [
  row("b1", 1, "BOARD", "17:45", "다산푸르지오", "18:00~19:20", 2),
  row("b1x", 1, "BOARD", "17:40", "늦게 들어온 행", "18:00~19:20", 9), // 같은 요일·방향 둘째 행 — 첫 행(sortOrder)만
  row("a1", 1, "ALIGHT", "19:35", "다산푸르지오", "18:00~19:20", 3),
  row("p1", 1, "PIVOT", "17:50", "학원", "18:00~19:20", 1), // 학생 행 아님
  row("b4", 4, "BOARD", "8:05", "학교 정문", "17:00~18:00", 1), // «8:05» → «08:05»
];
const always = () => true;

// ── ① 셔틀 규칙 ─────────────────────────────────────────────────────────────

test("① 명단 묶음: 요일 × 수업시간, 첫 행만, 학생 행만, 월요일부터, 시각 정리, 반 연결", () => {
  assert.equal(rules.rosterClassStart("18:00~19:20"), "18:00");
  assert.equal(rules.rosterClassStart("9:00-10:00"), "09:00");
  assert.equal(rules.rosterClassStart(null), null);
  const plan = rules.weeklyShuttlePlan(ROWS, [cls(), thu()]);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.dayLabel), ["월", "목"]);
  assert.deepEqual(plan[0].board, { stopName: "다산푸르지오", time: "17:45" }, "sortOrder 첫 행");
  assert.deepEqual(plan[0].alight, { stopName: "다산푸르지오", time: "19:35" });
  assert.equal(plan[0].className, "월 6시");
  assert.equal(plan[1].board.time, "08:05");
  assert.equal(plan[1].alight, null, "하원 행이 없으면 null");
  // 일요일 행은 맨 뒤
  const sun = rules.weeklyShuttlePlan([row("s", 0, "BOARD", "09:00"), row("m", 1, "BOARD", "09:00")], []);
  assert.deepEqual(sun.map((p) => p.dayLabel), ["월", "일"]);
  // 시작 시각이 안 맞아도 그 요일 반이 하나면 그 반, 둘이면 못 고른다(null)
  assert.equal(rules.matchRosterClass(1, "19:00~20:00", [cls()])?.classId, "MON");
  assert.equal(rules.matchRosterClass(1, "19:00~20:00", [cls(), cls({ classId: "MON2", startTime: "16:00" })]), null);
});

test("① 7일 운행: 휴무(연간일정 수업일 아님)·결석·안 탐·다른 곳, 운행 날만 «오늘만» 반영", () => {
  const days = rules.buildShuttleDays({
    today: "2026-11-16", // 월
    rowsForDate: () => ROWS,
    classes: [cls(), thu()],
    isClassDay: (c, ymd) => !(c.classId === "THU" && ymd === "2026-11-19"), // 목요일은 휴무(공휴일 가정)
    absences: [{ ymd: "2026-11-23", classId: "MON" }], // 다음 주 월 결석 — 7일 창 밖
    exceptions: [{ ymd: "2026-11-16", direction: "DROPOFF", kind: "LOCATION", location: "할머니 댁" }],
  });
  assert.deepEqual(days.map((d) => [d.ymd, d.status]), [["2026-11-16", "RUN"], ["2026-11-19", "HOLIDAY"]]);
  assert.equal(days[0].board.state, "RUN");
  assert.equal(days[0].alight.state, "CHANGED");
  assert.equal(days[0].alight.changedTo, "할머니 댁");
  assert.equal(days[0].alight.note, "오늘 탑승 장소: 할머니 댁", "기사님 화면과 같은 문구");
  assert.equal(days[1].statusText, "휴무");

  const skipBoth = rules.buildShuttleDays({
    today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [cls()], isClassDay: always, absences: [],
    exceptions: [{ ymd: "2026-11-16", direction: "BOTH", kind: "SKIP", location: null }],
  });
  assert.equal(skipBoth[0].statusText, "안 탐(신청)");
  assert.equal(skipBoth[0].board.state, "SKIP");
  assert.equal(skipBoth[0].alight.state, "SKIP");

  const absent = rules.buildShuttleDays({
    today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [cls()], isClassDay: always,
    absences: [{ ymd: "2026-11-16", classId: "MON" }],
    exceptions: [{ ymd: "2026-11-16", direction: "BOTH", kind: "SKIP", location: null }],
  });
  assert.equal(absent[0].status, "ABSENT", "결석이 «안 탐»보다 먼저");
  assert.equal(absent[0].board.state, "RUN", "운행 없는 날은 다리 칸을 바꾸지 않고 상태로 말한다");
  // 다른 반 결석은 이 반에 영향 없음
  const otherClass = rules.buildShuttleDays({
    today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [cls()], isClassDay: always,
    absences: [{ ymd: "2026-11-16", classId: "OTHER" }], exceptions: [],
  });
  assert.equal(otherClass[0].status, "RUN");
  // 연간일정이 없으면(null) 명단대로 운행 + 표시
  const unknown = rules.buildShuttleDays({ today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [cls()], isClassDay: () => null, absences: [], exceptions: [] });
  assert.equal(unknown[0].status, "RUN");
  assert.equal(unknown[0].planMissing, true);
});

test("① 수강 상태: 휴원 중·승인된 휴원 기간·퇴원 적용일·첫 수업 전", () => {
  const st = rules.enrollmentStateOn;
  assert.equal(st(cls({ status: "PAUSED" }), "2026-11-16"), "PAUSED");
  assert.equal(st(cls({ status: "PAUSED", pausedResumeOn: "2026-11-16" }), "2026-11-16"), "ACTIVE", "복귀일부터 운행");
  const pause = { kind: "PAUSE", effectiveFrom: "2026-11-20", resumeOn: "2026-12-01" };
  assert.equal(st(cls({ scheduled: pause }), "2026-11-19"), "ACTIVE");
  assert.equal(st(cls({ scheduled: pause }), "2026-11-20"), "PAUSED");
  assert.equal(st(cls({ scheduled: pause }), "2026-12-01"), "ACTIVE");
  assert.equal(st(cls({ scheduled: { kind: "WITHDRAW", effectiveFrom: "2026-11-30", resumeOn: null } }), "2026-11-30"), "ENDED");
  assert.equal(st(cls({ startsOn: "2026-11-23" }), "2026-11-16"), "NOT_STARTED");
  const paused = rules.buildShuttleDays({ today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [cls({ status: "PAUSED" })], isClassDay: always, absences: [], exceptions: [] });
  assert.equal(paused[0].status, "PAUSED");
  assert.equal(paused[0].statusText, "휴원");
  assert.deepEqual(rules.rosterOverviewItems("kid", "합성", paused), [], "휴원 중이면 홈 «오늘 셔틀»에도 없다");
});

test("① 달 경계(11/28~12/4): 날짜마다 그 달 명단 행, 홈 항목은 실제로 타는 칸만 «HH:MM 승차/하차»", () => {
  const nov = [row("n", 1, "BOARD", "17:45", "11월 정류장")];
  const dec = [row("d", 1, "BOARD", "17:30", "12월 정류장"), row("da", 1, "ALIGHT", "19:30", "12월 정류장")];
  const days = rules.buildShuttleDays({
    today: "2026-11-28", rowsForDate: (ymd) => (ymd.startsWith("2026-12") ? dec : nov), classes: [cls()], isClassDay: always, absences: [], exceptions: [],
  });
  assert.deepEqual(days.map((d) => d.ymd), ["2026-11-30", "2026-12-07"].filter((d) => d <= "2026-12-04"));
  assert.equal(days[0].board.stopName, "11월 정류장", "11/30(월)은 11월 명단");
  const items = rules.rosterOverviewItems("kid", "합성", rules.buildShuttleDays({
    today: "2026-11-30", days: 1, rowsForDate: () => dec, classes: [cls()], isClassDay: always, absences: [],
    exceptions: [{ ymd: "2026-11-30", direction: "PICKUP", kind: "SKIP", location: null }],
  }));
  assert.equal(items.length, 1, "안 탄다고 한 등원은 빠지고 하원만");
  assert.equal(items[0].direction, "DROPOFF");
  assert.equal(items[0].dropoffEtaLabel, "19:30 하차");
  assert.equal(items[0].serviceDate, "2026-11-30");
  assert.equal(items[0].classId, "MON");
  assert.equal(items[0].status, "CONFIRMED");
});

// ── ② 아이 정보 규칙 ───────────────────────────────────────────────────────

test("② 성별·만 나이·학년·보호자·보강권", () => {
  for (const [raw, want] of [["남자", "남"], ["남", "남"], ["MALE", "남"], ["여자", "여"], ["여", "여"], [null, null], ["?", null]]) {
    assert.equal(profileRules.genderText(raw), want, String(raw));
  }
  assert.equal(profileRules.koreanAge("2015-11-16", "2026-11-16"), 11, "생일 당일");
  assert.equal(profileRules.koreanAge("2015-11-17", "2026-11-16"), 10, "생일 전날");
  assert.equal(profileRules.koreanAge("2030-01-01", "2026-11-16"), null, "미래 생일");
  // 학년 3월 경계: 2015년생 → 2026-02 는 초4(학년도 2025), 2026-03 은 초5
  assert.equal(profileRules.gradeLine("2015-05-01", null, "2026-02-28"), "초4");
  assert.equal(profileRules.gradeLine("2015-05-01", "2026년 초등 5학년", "2026-03-01"), "초5", "적힌 학년과 같으면 한 번만");
  assert.equal(profileRules.gradeLine("2015-05-01", "초6", "2026-03-01"), "초5 · 등록 학년 초6", "다르면 둘 다");
  assert.equal(profileRules.gradeLine(null, "중1", "2026-03-01"), "중1", "생일을 모르면 적힌 학년");
  const rows = profileRules.guardianRows({ representativeName: "대표", meIsRepresentative: false, me: { name: "가족", phone: "010-1111-2222" }, familyNames: ["할머니"] });
  assert.deepEqual(rows, [
    { label: "대표 보호자", value: "대표" },
    { label: "내 연락처", value: "010-1111-2222" },
    { label: "연결 가족", value: "할머니" },
  ]);
  assert.equal(profileRules.guardianRows({ representativeName: "엄마", meIsRepresentative: true, me: { name: "엄마", phone: null }, familyNames: [] })[0].value, "엄마 (나)");
  assert.equal(profileRules.makeupLine({ available: 2, reserved: 1, nearestExpiryYmd: "2026-12-31" }), "사용 가능 2장 · 12.31까지 · 예약 1장");
  assert.equal(profileRules.makeupLine({ available: 0, reserved: 0, nearestExpiryYmd: null }), "없음");
  assert.equal(profileRules.classTimeText("Mon", "18:00", "19:20"), "월 18:00~19:20");
});

// ── ③ 조회 ─────────────────────────────────────────────────────────────────

test("③ 셔틀 조회: 모든 SQL 이 studentId($1)로 묶이고, 명단 달은 «그 달 이하 최신», 전화·좌표·메모 미조회", async () => {
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes(`FROM "RegularShuttleStop" r`)) {
        return values[1] === "2026-12"
          ? [{ id: "d", weekday: 1, direction: "BOARD", stopName: "12월", arriveTime: "17:30", classTime: "18:00~19:20", sortOrder: 0, serviceMonth: "2026-12" }]
          : [{ id: "n", weekday: 1, direction: "BOARD", stopName: "11월", arriveTime: "17:45", classTime: "18:00~19:20", sortOrder: 0, serviceMonth: "2026-11" }];
      }
      if (sql.includes(`FROM "RegularAbsence"`)) return [];
      if (sql.includes(`FROM "ShuttleDayException"`)) return [{ ymd: "2026-11-30", direction: "PICKUP", kind: "SKIP", location: null }];
      return [];
    },
  };
  const q = load("src/lib/shuttle/childShuttleQuery.ts");
  const out = await q.loadChildRegularShuttle(db, {
    studentId: "kid", today: "2026-11-28", classes: [cls()],
    monthlyDates: (ym, dow) => (dow === "Mon" && ym === "2026-11" ? ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-30"] : []),
  });
  assert.equal(calls.length, 4, "11월·12월 명단 + 결석 + 예외");
  for (const c of calls) {
    assert.equal(c.values[0], "kid", "첫 값은 확인된 학생 id");
    assert.match(c.sql, /"studentId" = \$1/);
    assert.doesNotMatch(c.sql, /studentPhone|parentPhone|latitude|longitude|\bnote\b/, "전화·좌표·메모를 고르지 않는다");
  }
  assert.match(calls[0].sql, /max\(m\."serviceMonth"\)[\s\S]*<= \$2/);
  assert.equal(out.rosterMonth, "2026-11");
  assert.equal(out.weekly[0].board.stopName, "11월");
  assert.equal(out.days.length, 1, "11/30(월) 한 날");
  assert.equal(out.days[0].board.state, "SKIP");
  // 연간일정상 수업일이 아니면 휴무 — 11/30 을 수업일 목록에서 빼면 HOLIDAY
  const holiday = await q.loadChildRegularShuttle(db, {
    studentId: "kid", today: "2026-11-28", classes: [cls()],
    monthlyDates: (ym, dow) => (dow === "Mon" && ym === "2026-11" ? ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"] : []),
  });
  assert.equal(holiday.days[0].status, "HOLIDAY");
});

function loadRecordQuery(fakeRows, spies) {
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return fakeRows(sql, values); } };
  const q = load("src/lib/parent/childRecordQuery.ts", {
    "@/lib/prisma": { prisma: db },
    "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}`, childConnectionsAvailable: async () => true },
    "@/lib/payments/payerAccess": { payerAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
    "@/lib/student-tenure-query": { getStudentTenure: async () => null },
    "@/lib/shuttle/parent": {
      getParentShuttleOverview: async (parentId, options) => { spies.overview.push([parentId, options]); return spies.overviewItems ?? []; },
      getShuttleDriverContact: async () => { spies.driver++; return { name: "기사님", phone: "010-0000-0000" }; },
    },
    "@/lib/enrollment/monthlyClassDates": { loadAnnualPlanEvents: async () => [], getMonthlyClassDates: () => [] },
  });
  return { q, calls };
}

test("③ 남의 아이 id → 첫 SQL 0행 → null, 셔틀·보호자·보강권 조회는 하나도 돌지 않는다", async () => {
  const spies = { overview: [], driver: 0 };
  const { q, calls } = loadRecordQuery(() => [], spies);
  assert.equal(await q.getChildRecord("parent-me", "someone-else"), null);
  assert.equal(calls.length, 1);
  assert.equal(spies.overview.length, 0);
  assert.equal(spies.driver, 0);
});

test("③ 내 아이 → 아이 정보·반·보강권·셔틀(명단 제외 옵션으로 방학특강만 이 아이 것) + 기사님 연락처", async () => {
  const spies = {
    overview: [], driver: 0,
    overviewItems: [
      { id: "s1", studentId: "kid", sourceType: "SPECIAL_PROGRAM", status: "CONFIRMED", title: "겨울특강", direction: "PICKUP", serviceDate: "2027-01-11", stopName: "정문", pickupEtaLabel: "08:53 승차" },
      { id: "s2", studentId: "sibling", sourceType: "SPECIAL_PROGRAM", status: "CONFIRMED", title: "형제 것", direction: "PICKUP", serviceDate: "2027-01-11", stopName: "정문" },
    ],
  };
  const { q, calls } = loadRecordQuery((sql) => {
    if (sql.includes("WHERE s.id = $2")) return [{ id: "kid", name: "합성", hasBaseline: false, canPay: true, birthYmd: "2015-05-01", gender: "남자", school: "다산초", gradeText: "초5", enrollYmd: "2024-03-02", meIsRepresentative: true }];
    if (sql.includes(`LEFT JOIN "User" rep`)) return [{ repName: "엄마", meName: "엄마", mePhone: "010-1234-5678" }];
    if (sql.includes(`FROM "ParentStudentAccess"`)) return [{ name: "아빠" }];
    if (sql.includes(`FROM "MakeupCredit" mc WHERE`)) return [{ status: "AVAILABLE", expiresAt: new Date(Date.now() + 86400000 * 30).toISOString() }, { status: "AVAILABLE", expiresAt: new Date(Date.now() - 86400000).toISOString() }];
    if (sql.includes(`FROM "Enrollment" e`) && sql.includes(`LATERAL`)) return [{ enrollmentId: "e1", enrollmentStatus: "ACTIVE", startsOn: null, classId: "MON", className: "월 6시", dayOfWeek: "Mon", startTime: "18:00", endTime: "19:20", coachName: "코치" }];
    if (sql.includes(`FROM "RegularShuttleStop" r`)) return [{ id: "b", weekday: 1, direction: "BOARD", stopName: "푸르지오", arriveTime: "17:45", classTime: "18:00~19:20", sortOrder: 0, serviceMonth: "2026-11" }];
    return [];
  }, spies);
  const r = await q.getChildRecord("parent-me", "kid");
  assert.equal(r.profile.birthYmd, "2015-05-01");
  assert.equal(r.profile.guardians.me.phone, "010-1234-5678");
  assert.deepEqual(r.profile.guardians.familyNames, ["아빠"]);
  assert.equal(r.profile.makeup.available, 1, "만료 지난 보강권은 사용 가능에서 뺀다(보강 화면과 같은 집계)");
  assert.equal(r.profile.classes[0].chip.text, "수강 중");
  assert.equal(r.shuttle.regular.weekly[0].board.stopName, "푸르지오");
  assert.deepEqual(r.shuttle.others.map((o) => o.id), ["s1"], "형제 항목은 거른다");
  assert.deepEqual(spies.overview, [["parent-me", { includeRoster: false, studentIds: ["kid"] }]]);
  assert.equal(r.shuttle.driver.phone, "010-0000-0000");
  // 권한 확인 뒤 모든 학생 조회는 확인된 id 를 쓴다
  for (const c of calls.slice(1)) assert.ok(c.values.includes("kid"), c.sql.slice(0, 60));
  // 보호자 SQL 은 대표 보호자의 전화를 고르지 않는다
  const g = calls.find((c) => c.sql.includes(`LEFT JOIN "User" rep`));
  assert.doesNotMatch(g.sql, /rep\.phone/);
});

// ── ④ 렌더 ─────────────────────────────────────────────────────────────────

const link = { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) };
const ChildRecordClient = load("src/app/mypage/record/ChildRecordClient.tsx", {
  "next/link": link,
  // 아이 정보 칸의 사진 올리기 부품(2026-11-15)이 올린 뒤 화면을 새로 그릴 때 쓴다
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
  "@/components/admin/list/ListDetailPanel": { __esModule: true, default: ({ children }) => React.createElement("div", null, children) },
}).default;
const today = "2026-11-16";
const profile = (extra = {}) => ({
  birthYmd: "2015-05-01", gender: "여자", school: "다산초", gradeText: "초5", enrollYmd: "2024-03-02",
  guardians: { representativeName: "엄마", meIsRepresentative: true, me: { name: "엄마", phone: "010-1234-5678" }, familyNames: [] },
  classes: [], makeup: { available: 0, reserved: 0, nearestExpiryYmd: null }, ...extra,
});
const base = (extra = {}) => ({
  student: { id: "kid", name: "합성", canPay: true, hasBaseline: false },
  today, payments: [], attendance: [], timeline: { enrollments: [], changes: [] }, seasonal: [],
  uniform: { status: null, receivedYmd: null, freeGrant: null }, reports: { reports: 0, feedbacks: 0 }, tenure: null,
  profile: profile(), shuttle: { regular: { rosterMonth: null, weekly: [], days: [] }, others: [], driver: null },
  ...extra,
});
const render = (record) => renderToStaticMarkup(React.createElement(ChildRecordClient, { record, childList: [{ id: "kid", name: "합성" }], initialYear: null }));

test("④ 셔틀 없음: 아이 정보 칸(라벨:값)·셔틀 «이용하지 않아요»·섹션 순서·아이콘 없음", () => {
  const html = render(base());
  for (const label of ["생년월일", "학년", "학교", "성별", "등록일", "대표 보호자", "내 연락처", "보강권"]) assert.ok(html.includes(label), label);
  assert.match(html, /2015\.5\.1 · 만 11세/);
  assert.match(html, /엄마 \(나\)/);
  assert.match(html, /셔틀을 이용하지 않아요/);
  assert.doesNotMatch(html, /이날 안 타요|셔틀 변경|href="\/mypage\/shuttle/, "타지 않는 아이에겐 변경 링크 없음");
  const order = ["아이 정보", "다닌 기간", "수강 반", "셔틀", "청구 이력", "출석 · 최근 12개월", "수강 반 이력"].map((t) => html.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "위에서 아래 순서");
  assert.ok(order.every((i) => i >= 0));
  // 2026-11-15 아이콘 예외(화살표·종·톱니): 글자 «접기» → 펼침 화살표. 버튼 이름은 칸 제목 글자가 준다
  assert.match(html, /aria-expanded="true"[^>]*>[\s\S]*?<span aria-hidden="true" class="ui-icon[^"]*"><span class="material-symbols-outlined text-xl">expand_less<\/span><span class="ui-icon-fallback">▴<\/span><\/span>/, "머리줄을 눌러 접는다(펼친 칸 = 위 화살표)");
  assert.match(html, /<button[^>]*aria-expanded="true"[^>]*><span class="academy-section-title[^"]*">아이 정보<\/span>/, "버튼 안에 제목 글자가 있다");
  const icons = [...html.matchAll(/class="material-symbols-outlined[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert.ok(icons.length > 0 && icons.every((name) => name === "expand_less" || name === "expand_more"), `펼침 화살표 말고 다른 아이콘이 있다: ${icons.join(", ")}`);
});

test("④ 여러 반 + 휴원: 반마다 한 줄(상태 칩·요일 시간·코치), 셔틀 요일별·7일 일정(휴원·휴무·결석·안 탐)", () => {
  const classes = [
    { enrollmentId: "e1", classId: "MON", className: "월 6시", dayOfWeek: "Mon", startTime: "18:00", endTime: "19:20", status: "ACTIVE", coachName: "김코치", startsOn: null, scheduled: null, pausedResumeOn: null, programName: null, chip: { text: "수강 중", tone: "success" } },
    { enrollmentId: "e2", classId: "THU", className: "목 5시", dayOfWeek: "Thu", startTime: "17:00", endTime: "18:00", status: "PAUSED", coachName: null, startsOn: null, scheduled: null, pausedResumeOn: "2026-12-01", programName: null, chip: { text: "휴원 중 · 12/1 복귀", tone: "neutral" } },
  ];
  const days = [
    { ymd: "2026-11-16", weekday: 1, dayLabel: "월", classId: "MON", className: "월 6시", classTime: "18:00~19:20", status: "RUN", statusText: "운행", planMissing: false,
      board: { stopName: "푸르지오", time: "17:45", state: "RUN", note: null, changedTo: null }, alight: { stopName: "푸르지오", time: "19:35", state: "SKIP", note: "오늘 셔틀 안 탐", changedTo: null } },
    { ymd: "2026-11-19", weekday: 4, dayLabel: "목", classId: "THU", className: "목 5시", classTime: "17:00~18:00", status: "PAUSED", statusText: "휴원", planMissing: false, board: null, alight: null },
  ];
  const html = render(base({
    profile: profile({ classes }),
    shuttle: {
      regular: { rosterMonth: "2026-11", weekly: [{ weekday: 1, dayLabel: "월", classTime: "18:00~19:20", classId: "MON", className: "월 6시", board: { stopName: "푸르지오", time: "17:45" }, alight: { stopName: "푸르지오", time: "19:35" } }], days },
      others: [], driver: { name: "기사님", phone: "010-0000-0000" },
    },
  }));
  assert.match(html, /2개 반/);
  assert.match(html, /월 18:00~19:20 · 코치 김코치/);
  assert.match(html, /휴원 중 · 12\/1 복귀/);
  assert.match(html, /11월 명단/);
  assert.match(html, /승차 17:45 · 푸르지오/);
  assert.match(html, /하차 19:35 · 푸르지오/);
  assert.match(html, /등원 17:45 푸르지오 · 하원 안 탐\(신청\)/);
  assert.match(html, /11\/19\(목\)/);
  assert.match(html, />휴원</);
  assert.match(html, /href="tel:01000000000"/);
  assert.match(html, /href="\/mypage\/shuttle\?studentId=kid"/, "변경은 기존 셔틀 신청 화면으로");
});

test("④ 옛 모양 데이터(아이 정보·셔틀 칸 없음)도 그대로 그린다 / 조회 실패는 칸마다 안내", () => {
  const { profile: _p, shuttle: _s, ...old } = base();
  const html = render(old);
  assert.doesNotMatch(html, /아이 정보/);
  assert.match(html, /합성 기록/);
  const failed = render(base({ profile: null, shuttle: null }));
  assert.match(failed, /아이 정보를 불러오지 못했어요/);
  assert.match(failed, /셔틀 정보를 불러오지 못했어요/);
});

// ── ⑤ 소스 가드 ────────────────────────────────────────────────────────────

test("⑤ 숨길 칸은 조회하지 않는다 · 기록 화면 캐시 금지 유지 · 홈 셔틀 명단은 내 자녀 범위에서만", () => {
  const recordQuery = read("src/lib/parent/childRecordQuery.ts");
  for (const col of profileRules.PROFILE_HIDDEN_COLUMNS) {
    assert.doesNotMatch(recordQuery, new RegExp(`s\\.("${col}"|${col}\\b)`), `Student.${col} 를 고르면 안 된다`);
  }
  assert.doesNotMatch(recordQuery, /import[^;]*unstable_cache|unstable_cache\(/, "캐시 금지(주석 언급은 괜찮다)");
  assert.match(read("src/app/mypage/record/page.tsx"), /export const dynamic = "force-dynamic"/);
  const parent = read("src/lib/shuttle/parent.ts");
  // 명단 항목은 childAccessWhere 로 고른 students 로만 만든다
  assert.match(parent, /rosterOverviewForStudents\(students\)/);
  assert.match(parent, /where:\s*\{\s*\.\.\.await childAccessWhere\(appUserId\)/);
  const shuttleQuery = read("src/lib/shuttle/childShuttleQuery.ts");
  assert.doesNotMatch(shuttleQuery, /studentPhone|parentPhone/);
  assert.doesNotMatch(shuttleQuery, /findMany|findFirst|upsert|\.create\(/, "PgBouncer — $queryRawUnsafe 만");
});

// ── ⑥ 검수 보완(2026-11-14 코드 검수 필수 2 + 권장 3·4) ─────────────────────

test("⑥ 반을 못 찾거나(확인 필요) 다니는 반이 없으면(퇴원) 운행으로 치지 않는다 — 홈 항목도 없음", () => {
  const check = rules.buildShuttleDays({ today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [thu()], isClassDay: always, absences: [], exceptions: [] });
  assert.equal(check[0].status, "CHECK");
  assert.equal(check[0].statusText, "확인 필요");
  const none = rules.buildShuttleDays({ today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [], isClassDay: always, absences: [], exceptions: [] });
  assert.equal(none[0].status, "NO_CLASS");
  assert.deepEqual(rules.rosterOverviewItems("kid", "합성", [...check, ...none]), []);
  const ok = rules.rosterOverviewItems("kid", "합성", rules.buildShuttleDays({ today: "2026-11-16", days: 1, rowsForDate: () => ROWS, classes: [cls()], isClassDay: always, absences: [], exceptions: [] }));
  assert.ok(ok.length === 2 && ok.every((i) => i.fromRoster === true), "명단 항목 표시");
});

test("⑥ 명단 등재 학생 조회: 내 자녀 id 만 넘기고 학생 id 만 고른다, 빈 목록이면 조회 안 함", async () => {
  const q = load("src/lib/shuttle/childShuttleQuery.ts");
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return [{ studentId: "kid" }]; } };
  const set = await q.getRosterStudentIds(db, ["kid", "kid", ""], "2026-11");
  assert.deepEqual([...set], ["kid"]);
  assert.deepEqual(calls[0].values, [["kid"], "2026-11"]);
  assert.match(calls[0].sql, /SELECT DISTINCT r\."studentId"\s+FROM "RegularShuttleStop" r/);
  assert.match(calls[0].sql, /max\(m\."serviceMonth"\)[\s\S]*<= \$2/);
  assert.equal((await q.getRosterStudentIds(db, [], "2026-11")).size, 0);
  assert.equal(calls.length, 1);
});

test("⑥ 소스 가드: «신청 접수» 카드는 명단 등재 여부로 빼고(배정 반·운행 일정·includeRoster 무관), 명단 조회는 처음 병렬 묶음에", () => {
  const parent = read("src/lib/shuttle/parent.ts");
  const cardIdx = parent.indexOf("if (rosterStudents.has(studentId)) return [];");
  assert.ok(cardIdx > 0 && cardIdx < parent.indexOf("if (application.assignedClassId && assignedClassKeys"), "배정 반 판정보다 먼저");
  assert.doesNotMatch(parent, /for \(const item of rosterItems\) if \(item\.classId\) assignedClassKeys/, "7일 운행 항목 기준 판정은 없앴다");
  assert.match(parent, /const \[regularPassengers, seasonalRoster, regularApplications, rosterItems, rosterStudents\] = await Promise\.all/);
  assert.match(parent, /getRosterStudentIds\(prisma, studentIds,/);
  // 대상 좁히기는 내 자녀 범위 안에서만
  assert.match(parent, /const students = only \? accessible\.filter\(\(student\) => only\.has\(student\.id\)\) : accessible;/);
  assert.match(read("src/lib/parent/childRecordQuery.ts"), /getParentShuttleOverview\(parentUserId, \{ includeRoster: false, studentIds: \[sid\] \}\)/);
});

test("⑥ 일정 탭: 명단 항목은 요일별 한 줄 + «날짜별 보기» 링크, 값 없는 «○○ 확인 중» 줄 없음, 다른 카드는 그대로", () => {
  const Detail = load("src/app/mypage/ParentShuttleDetail.tsx", { "next/link": link });
  const roster = (date, direction, eta, extra = {}) => ({
    id: `roster:kid:${date}:${direction}`, fromRoster: true, studentId: "kid", sourceType: "REGULAR_CLASS", classId: "MON", direction, status: "CONFIRMED",
    label: "합성", title: "월 6시", serviceDate: date, routeName: null, stopName: "푸르지오", stopAddress: null, plannedAt: null, vehicleName: null, rideStatus: null,
    pickupEtaLabel: direction === "PICKUP" ? eta : null, dropoffEtaLabel: direction === "DROPOFF" ? eta : null, ...extra,
  });
  const items = [
    roster("2026-11-16", "PICKUP", "17:45 승차"), roster("2026-11-16", "DROPOFF", "19:35 하차"),
    roster("2026-11-19", "PICKUP", "16:45 승차", { title: "목 5시" }),
    { id: "s1", studentId: "kid", sourceType: "SPECIAL_PROGRAM", direction: "PICKUP", status: "REQUESTED", label: "합성", title: "겨울특강", serviceDate: null, routeName: null, stopName: null, stopAddress: null, plannedAt: null, vehicleName: null, rideStatus: null },
  ];
  const lines = Detail.rosterWeekLines(items);
  assert.deepEqual(lines.map((l) => [l.dayLabel, l.text]), [
    ["월", "등원 17:45 승차 푸르지오 · 하원 19:35 하차 푸르지오"],
    ["목", "등원 16:45 승차 푸르지오"],
  ]);
  const html = renderToStaticMarkup(React.createElement(Detail.default, { items }));
  // 2026-11-14 문구 정리: 칸 이름 «정규 셔틀», 링크 «날짜별 보기 ▸», 버튼 «셔틀 변경»
  assert.match(html, />정규 셔틀<\/p>/);
  assert.match(html, /href="\/mypage\/record\?child=kid#record-shuttle-heading"[^>]*>날짜별 보기 ▸/);
  assert.match(html, /href="\/mypage\/shuttle"[^>]*>\s*셔틀 변경/);
  assert.doesNotMatch(html, /요일별\(다가오는 7일\)|아이 기록 › 셔틀|셔틀 당일 변경/);
  // 값이 없는 줄은 줄째 숨긴다(d7) — 운행일이 아직 없는 방학특강 카드에도 «운행일 확인 중» 줄이 없다
  assert.doesNotMatch(html, /운행일 확인 중|노선 확인 중|정류장 확인 중|차량 확인 중|시간 확인 중|>운행일</, "값 없는 줄 없음");
  assert.match(html, /겨울특강/, "방학특강 카드는 그대로");
  assert.match(html, />3건</, "요약 2줄 + 카드 1장");
});
