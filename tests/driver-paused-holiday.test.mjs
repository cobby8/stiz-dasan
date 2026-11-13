// 기사님 운행표 — 휴원 뱃지·버튼 잠금 + 공휴일·휴무 안내(2026-11-14 원장 지시). 실제로 실행·렌더해서 확인한다.
//  ① 잠금 판정(regularRunDayRules): 휴원·예약 휴원 기간·퇴원·예약 퇴원·첫 수업 전·수강 중·모름
//  ② 휴무 판정: 연간일정 수업일이 아닌 날(공휴일·대체공휴일·연휴) + 사유 글자, 일정 확정 전·일요일은 모름
//  ③ 조립: buildRegularRunRows(blockOf) → 줄에 뱃지, 체크 진행률·정차 요약에서 잠긴 줄 제외, 없으면 종전과 같음
//  ④ 서버: 잠긴 줄은 체크 거부(되돌리기만 허용) — 두 저장 API 모두
//  ⑤ 렌더: 기사님 화면 — 휴원 뱃지 + 탑승·미탑승 disabled, 휴무 안내 맨 위
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

// 순수 TS·TSX 를 CommonJS 로 올려 실행한다(필요한 화면 부품만 가짜로 바꿔 끼운다).
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

const rules = load("src/lib/shuttle/regularRunDayRules.ts");
const runRows = load("src/lib/shuttle/regularRunRows.ts");
const unified = load("src/lib/shuttle/unifiedDriverRunLogic.ts");
const schedule = load("src/lib/classSchedule.ts");

// ── 공통 재료 ──────────────────────────────────────────────────────────────
// 학부모 쪽과 같은 모양의 반(ShuttleClassRef). 2026-11-19 = 목요일
const cls = (extra = {}) => ({
  classId: "THU", className: "목 3시", dayOfWeek: "Thu", startTime: "15:00", status: "ACTIVE",
  startsOn: null, scheduled: null, pausedResumeOn: null, ...extra,
});
const THU_ROW = { weekday: 4, classTime: "15:00~16:20" };

test("① 휴원 중이면 «휴원» — 복귀 예정일부터는 잠금 해제", () => {
  const paused = [cls({ status: "PAUSED", pausedResumeOn: "2026-12-03" })];
  assert.equal(rules.rosterRowBlock(THU_ROW, paused, "2026-11-19"), "PAUSED");
  assert.equal(rules.rosterRowBlock(THU_ROW, paused, "2026-12-03"), null);
  // 복귀일 없는 휴원 = 계속 휴원
  assert.equal(rules.rosterRowBlock(THU_ROW, [cls({ status: "PAUSED" })], "2027-01-07"), "PAUSED");
  assert.equal(rules.RIDER_BLOCK_LABEL.PAUSED, "휴원");
});

test("① 승인된 휴원 예약 — 시작일부터 복귀일 전까지만 «휴원»", () => {
  const sched = [cls({ scheduled: { kind: "PAUSE", effectiveFrom: "2026-11-19", resumeOn: "2026-11-26" } })];
  assert.equal(rules.rosterRowBlock(THU_ROW, sched, "2026-11-12"), null);
  assert.equal(rules.rosterRowBlock(THU_ROW, sched, "2026-11-19"), "PAUSED");
  assert.equal(rules.rosterRowBlock(THU_ROW, sched, "2026-11-26"), null);
});

test("① 퇴원·첫 수업 전·수강 중·모름", () => {
  // 정규 반이 하나도 없다 = 퇴원
  assert.equal(rules.rosterRowBlock(THU_ROW, [], "2026-11-19"), "ENDED");
  // 승인된 퇴원 적용일부터
  const wd = [cls({ scheduled: { kind: "WITHDRAW", effectiveFrom: "2026-11-19", resumeOn: null } })];
  assert.equal(rules.rosterRowBlock(THU_ROW, wd, "2026-11-12"), null);
  assert.equal(rules.rosterRowBlock(THU_ROW, wd, "2026-11-19"), "ENDED");
  // 첫 수업 전
  assert.equal(rules.rosterRowBlock(THU_ROW, [cls({ startsOn: "2026-11-26" })], "2026-11-19"), "NOT_STARTED");
  assert.equal(rules.rosterRowBlock(THU_ROW, [cls({ startsOn: "2026-11-19" })], "2026-11-19"), null);
  // 수강 중
  assert.equal(rules.rosterRowBlock(THU_ROW, [cls()], "2026-11-19"), null);
  // 모름 → 잠그지 않는다: 학생 id 없음(undefined) · 그 요일 반 없음(반 이동 등)
  assert.equal(rules.rosterRowBlock(THU_ROW, undefined, "2026-11-19"), null);
  assert.equal(rules.rosterRowBlock(THU_ROW, [cls({ classId: "MON", dayOfWeek: "Mon", status: "PAUSED" })], "2026-11-19"), null);
  // 같은 요일 다른 시간 반이 여럿이면 시작 시각으로 고른다(목 3시 휴원, 목 5시 수강 중)
  const two = [cls({ status: "PAUSED" }), cls({ classId: "THU5", startTime: "17:00" })];
  assert.equal(rules.rosterRowBlock(THU_ROW, two, "2026-11-19"), "PAUSED");
  assert.equal(rules.rosterRowBlock({ weekday: 4, classTime: "17:00~18:20" }, two, "2026-11-19"), null);
});

// ── 휴무: 실제 연간일정 계산(개강~종강 범위 + «학원 휴무» 제외)과 같은 함수로 수업일을 만든다 ──
// 테스트 일정: 9월 = 9/1~9/30, 10월 = 10/1~10/31(10월 일정은 확정), 11월 = 일정 없음(확정 전)
const EVENTS = [
  { title: "추석 연휴 학원 휴무", date: "2026-09-24T00:00:00.000Z", endDate: "2026-09-26T00:00:00.000Z" }, // 목~토 연휴
  { title: "대체공휴일 학원 휴무", date: "2026-09-28T00:00:00.000Z" }, // 월 대체공휴일
  { title: "한글날", date: "2026-10-09T00:00:00.000Z" }, // 공휴일(이름) + 휴무 표시 따로
  { title: "학원 휴무", date: "2026-10-09T00:00:00.000Z" },
  { title: "10월 2주차", date: "2026-10-05T00:00:00.000Z" }, // 주차 표시는 사유가 아니다
];
function closedSet(events) {
  const out = new Set();
  for (const e of events) {
    if (!schedule.CLOSED_RE.test(e.title)) continue;
    const cur = new Date(e.date);
    const end = new Date(e.endDate ?? e.date);
    while (cur <= end) { out.add(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  }
  return out;
}
const RANGES = { "2026-09": ["2026-09-01", "2026-09-30"], "2026-10": ["2026-10-01", "2026-10-31"] };
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const monthlyDates = (ym, dow) => {
  const range = RANGES[ym];
  if (!range) return [];
  return schedule.computeClassDatesFromRange(range[0], range[1], [DOW[dow]], closedSet(EVENTS))[DOW[dow]] ?? [];
};

test("② 연휴(여러 날 휴무)·대체공휴일·공휴일 — 휴무 + 사유", () => {
  assert.deepEqual(rules.regularRunHoliday("2026-09-24", monthlyDates, EVENTS), { ymd: "2026-09-24", title: "추석 연휴 학원 휴무" });
  assert.deepEqual(rules.regularRunHoliday("2026-09-25", monthlyDates, EVENTS), { ymd: "2026-09-25", title: "추석 연휴 학원 휴무" });
  assert.deepEqual(rules.regularRunHoliday("2026-09-26", monthlyDates, EVENTS), { ymd: "2026-09-26", title: "추석 연휴 학원 휴무" });
  assert.deepEqual(rules.regularRunHoliday("2026-09-28", monthlyDates, EVENTS), { ymd: "2026-09-28", title: "대체공휴일 학원 휴무" });
  // 휴무 일정 제목이 «학원 휴무»뿐이면 그 제목, 공휴일 이름은 다른 일정에 있다 → 휴무 일정이 먼저
  assert.equal(rules.regularRunHoliday("2026-10-09", monthlyDates, EVENTS).title, "학원 휴무");
  // 연휴 다음 날(평일 수업일)은 휴무 아님
  assert.equal(rules.regularRunHoliday("2026-09-29", monthlyDates, EVENTS), null);
  assert.equal(rules.regularRunHoliday("2026-09-23", monthlyDates, EVENTS), null);
});

test("② 사유: 휴무 일정이 없고 공휴일 이름만 있으면 그 이름, 아무것도 없으면 기본 문구", () => {
  const onlyName = [{ title: "개천절", date: "2026-10-03T00:00:00.000Z" }];
  assert.equal(rules.holidayReason(onlyName, "2026-10-03"), "개천절");
  assert.equal(rules.holidayReason([{ title: "10월 1주차", date: "2026-10-03T00:00:00.000Z" }], "2026-10-03"), "연간일정 수업 없는 날");
  assert.equal(rules.holidayReason(null, "2026-10-03"), "연간일정 수업 없는 날");
  // 범위 밖 수업 없는 날(종강 뒤) — 사유 일정이 없으면 기본 문구
  const shortRange = (ym, dow) => schedule.computeClassDatesFromRange("2026-10-01", "2026-10-23", [DOW[dow]], new Set())[DOW[dow]] ?? [];
  assert.deepEqual(rules.regularRunHoliday("2026-10-27", shortRange, []), { ymd: "2026-10-27", title: "연간일정 수업 없는 날" });
  // 너무 긴 제목은 자른다
  const long = [{ title: "가".repeat(40) + " 학원 휴무", date: "2026-10-03T00:00:00.000Z" }];
  assert.ok(rules.holidayReason(long, "2026-10-03").endsWith("…"));
});

test("② 모르면 안내 없음 — 연간일정 없음·그 달 확정 전·일요일", () => {
  assert.equal(rules.regularRunHoliday("2026-09-24", null, EVENTS), null);
  assert.equal(rules.regularRunHoliday("2026-11-19", monthlyDates, EVENTS), null); // 11월 일정 확정 전
  assert.equal(rules.regularRunHoliday("2026-09-27", monthlyDates, EVENTS), null); // 일요일(계획표에 없는 요일)
  assert.equal(rules.regularRunHoliday("2026-9-24", monthlyDates, EVENTS), null); // 날짜 형식 아님
});

test("② 한 달 휴무 목록(관리자 «이 달 휴무») — 요일과 함께", () => {
  const sep = rules.monthRunHolidays("2026-09", monthlyDates, EVENTS);
  assert.deepEqual(sep.map((h) => [h.ymd, h.weekday]), [["2026-09-24", 4], ["2026-09-25", 5], ["2026-09-26", 6], ["2026-09-28", 1]]);
  assert.deepEqual(rules.monthRunHolidays("2026-11", monthlyDates, EVENTS), []);
  assert.deepEqual(rules.monthRunHolidays("2026-09", null, EVENTS), []);
});

test("② 최종 잠금 순서 — 수강 상태가 휴무보다 먼저(학부모 쪽과 같은 순서)", () => {
  const holiday = { ymd: "2026-09-24", title: "추석" };
  assert.equal(rules.riderBlockOf(THU_ROW, [cls({ status: "PAUSED" })], "2026-09-24", holiday), "PAUSED");
  assert.equal(rules.riderBlockOf(THU_ROW, [cls()], "2026-09-24", holiday), "HOLIDAY");
  assert.equal(rules.riderBlockOf(THU_ROW, undefined, "2026-09-24", holiday), "HOLIDAY"); // 학생을 몰라도 휴무는 잠근다
  assert.equal(rules.riderBlockOf(THU_ROW, [cls()], "2026-09-23", null), null);
});

// ── ③ 조립 ─────────────────────────────────────────────────────────────────
const base = { weekdayLabel: "목", studentPhone: null, note: null, serviceMonth: "2026-11", latitude: null, longitude: null };
const stop = (id, o) => ({ ...base, id, weekday: 4, classTime: "15:00~16:20", parentPhone: null, ...o });
const STOPS = [
  stop("s1", { arriveTime: "14:30", stopName: "A아파트", direction: "BOARD", studentName: "가나", sortOrder: 1 }),
  stop("s2", { arriveTime: "14:30", stopName: "A아파트", direction: "BOARD", studentName: "휴원생", sortOrder: 2 }),
  stop("s3", { arriveTime: "14:40", stopName: "B초", direction: "BOARD", studentName: "휴원생2", sortOrder: 3 }),
];

test("③ blockOf 가 없으면 종전과 글자 그대로 같다(잠금 칸 없음)", () => {
  const before = runRows.buildRegularRunRows({ stops: STOPS, weekday: 4 });
  const withNone = runRows.buildRegularRunRows({ stops: STOPS, weekday: 4, blockOf: () => null });
  assert.deepEqual(withNone, before);
  assert.ok(before.flatMap((r) => r.riders).every((r) => !("blockedLabel" in r)));
});

test("③ 휴원 줄은 명단에 남고 뱃지가 붙는다 — 진행률·정차 요약에서 빠진다", () => {
  const blocks = { s2: "휴원", s3: "휴원" };
  const rows = runRows.buildRegularRunRows({ stops: STOPS, weekday: 4, blockOf: (id) => blocks[id] ?? null });
  const riders = rows.flatMap((r) => r.riders);
  assert.deepEqual(riders.map((r) => [r.name, r.blockedLabel ?? null]), [["가나", null], ["휴원생", "휴원"], ["휴원생2", "휴원"]]);
  const view = unified.riderBoardingView(riders[1], undefined);
  assert.deepEqual(view, { absentReported: false, status: null, absentDefault: false, dimmed: true, blocked: true });
  // 휴원 + 결석 신고가 겹치면 잠금이 먼저(기본 «결석»으로 세지 않는다)
  assert.equal(unified.riderBoardingView({ ...riders[1], absent: true }, undefined).absentReported, false);
  // 진행률: 분모에서 휴원 2명 제외
  assert.deepEqual(unified.countProgress(rows, {}), { total: 1, boarded: 0, noshow: 0, self: 0 });
  // B초 정차는 전원 휴원 → «정차 안 해도 됨»
  const bStop = rows.find((r) => r.label === "B초");
  assert.equal(unified.stopAbsenceSummary(bStop.riders, {}).allSkippable, true);
  const aStop = rows.find((r) => r.label === "A아파트");
  assert.equal(unified.stopAbsenceSummary(aStop.riders, {}).allSkippable, false);
  // 특강 줄은 잠금 대상이 아니다(뱃지가 와도 무시)
  assert.equal(unified.riderBoardingView({ kind: "SEASONAL", absent: false, blockedLabel: "휴무" }, null).blocked, false);
});

test("④ 서버 거부 판정 — 잠긴 줄은 탑승·미탑승·자차 거부, 되돌리기(null)만 허용", () => {
  for (const st of ["BOARDED", "NOSHOW", "SELF"]) assert.equal(rules.boardingRejectedForBlock("휴원", st), true);
  assert.equal(rules.boardingRejectedForBlock("휴원", null), false);
  assert.equal(rules.boardingRejectedForBlock(null, "BOARDED"), false);
  assert.equal(rules.boardingRejectedForBlock(undefined, "NOSHOW"), false);
});

test("④ 두 저장 API 가 같은 판정으로 409 를 돌려준다(기사 링크·직원 계정)", () => {
  const token = read("src/app/api/shuttle/regular-boarding/route.ts");
  const staff = read("src/app/api/staff/shuttle/regular-boarding/route.ts");
  for (const src of [token, staff]) {
    assert.match(src, /boardingRejectedForBlock\(/);
    // 기사 링크 API = NextResponse.json(…, { status: 409 }) · 직원 API = json(…, 409)
    assert.match(src, /status: 409 \}|\}, 409\)/);
  }
  // 기사 링크 API: 판정은 기사님 화면과 같은 함수(getRegularDriverClasses)의 줄 뱃지로
  assert.match(token, /getRegularDriverClasses\(date\)/);
  // 저장보다 거부 확인이 먼저
  assert.ok(token.indexOf("boardingRejectedForBlock(") < token.indexOf("await setRegularBoarding("));
  assert.ok(staff.indexOf("boardingRejectedForBlock(") < staff.indexOf("await setRegularBoarding("));
});

test("③ 기사님 서버 조립이 잠금 판정을 붙이고 휴무를 내보낸다(한 모듈)", () => {
  const route = read("src/lib/shuttle/regularDriverRoute.ts");
  assert.match(route, /getRegularRunDayBlocks\(selectDriverDayRows\(stops, weekday\), viewDate\)/);
  assert.match(route, /blockOf: \(rowId\) => labelByRowId\.get\(rowId\) \?\? null/);
  const day = read("src/lib/shuttle/regularRunDay.ts");
  // 학부모 셔틀과 같은 연간일정 함수 · $queryRawUnsafe 만
  assert.match(day, /loadAnnualPlanEvents/);
  assert.match(day, /getMonthlyClassDates/);
  assert.doesNotMatch(day, /\.findMany\(|\.findFirst\(|\.create\(|\.update\(/);
  // 관리자 운행표도 같은 규칙 모듈
  assert.match(read("src/app/admin/shuttle/regular-dispatch/page.tsx"), /getRegularRosterMonthMarks/);
  assert.match(read("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx"), /blockOf: \(rowId\) => riderBlocks\[rowId\] \?\? null/);
});

// ── ⑤ 렌더 — 기사님 화면(UnifiedDriverClient). 카드 틀(RunBoard)은 학생 줄만 그리는 가짜로 바꾼다 ──
function renderDriver(props) {
  const esm = (value) => ({ __esModule: true, default: value });
  const mocks = {
    "next/navigation": { useRouter: () => ({ refresh() {}, push() {} }) },
    "next/image": esm(() => null),
    "./DriverWorkspace.module.css": esm(new Proxy({}, { get: (_t, k) => String(k) })),
    "@/components/shuttle/run/RunBoard": esm(({ rows, renderRider, renderStopMeta }) =>
      React.createElement("div", null, rows.map((row) => React.createElement("section", { key: row.key, "data-stop": row.label },
        React.createElement("header", null, renderStopMeta?.(row)),
        row.riders.map((rider) => renderRider(row, rider)))))),
    "@/components/shuttle/run/useRouteRetime": { useRouteRetime: () => ({ retime() {}, notes: {}, cancelPending() {}, clearNote() {} }) },
    "@/components/shuttle/DriverDateNav": esm(() => null),
    "@/components/shuttle/DriverGpsIndicator": esm(() => null),
    "@/hooks/useGpsShare": { useGpsShare: () => ({ state: "idle", transmission: "idle", lastSentAt: null, accuracy: null, mode: "web", nativeRunning: false, nativeMessage: null, start() {}, stop: async () => {} }) },
  };
  const Client = load("src/components/shuttle/UnifiedDriverClient.tsx", mocks).default;
  return renderToStaticMarkup(React.createElement(Client, {
    token: "t", date: "2026-11-19", today: "2026-11-19", prevDate: "2026-11-18", nextDate: "2026-11-20",
    initialBoarding: {}, driverLabel: "정규 셔틀 기사님", ...props,
  }));
}
// 학생 한 명의 줄(뱃지·버튼)을 이름으로 잘라낸다
function riderHtml(html, name) {
  const at = html.indexOf(`>${name}<`);
  assert.ok(at >= 0, `${name} 줄이 없다`);
  const start = html.lastIndexOf("<div", html.lastIndexOf("academy-driver-rider", at));
  const next = html.indexOf("academy-driver-rider", at);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf("<div", next));
}

test("⑤ 렌더: 휴원 학생은 명단에 남고 «휴원» 뱃지 + 탑승·미탑승 disabled, 다른 학생은 그대로", () => {
  const rows = runRows.buildRegularRunRows({ stops: STOPS, weekday: 4, blockOf: (id) => (id === "s2" ? "휴원" : null) });
  const html = renderDriver({ rows });
  const paused = riderHtml(html, "휴원생");
  assert.match(paused, /data-blocked="true"/);
  assert.match(paused, />휴원</);
  assert.equal((paused.match(/<button[^>]*disabled=""/g) ?? []).length, 2, "탑승·미탑승 둘 다 잠금");
  assert.match(paused, /휴원이라 체크하지 않아요/);
  const normal = riderHtml(html, "가나");
  assert.doesNotMatch(normal, /data-blocked/);
  assert.equal((normal.match(/<button[^>]*disabled=""/g) ?? []).length, 0);
  // 휴무가 아니면 맨 위 안내 없음 · 진행률 분모는 잠긴 줄 제외(3명 중 2명)
  assert.doesNotMatch(html, /휴무 \(/);
  assert.match(html, /체크 0\/2/);
});

test("⑤ 렌더: 휴무일 — 맨 위 «오늘은 휴무(사유)» + 정규 줄 전부 회색·잠금", () => {
  const rows = runRows.buildRegularRunRows({ stops: STOPS, weekday: 4, blockOf: () => "휴무" });
  const html = renderDriver({ rows, holiday: { ymd: "2026-11-19", title: "추석 연휴 학원 휴무" } });
  assert.match(html, /오늘은 휴무 \(추석 연휴 학원 휴무\)/);
  assert.ok(html.indexOf("추석 연휴 학원 휴무") < html.indexOf("가나"), "안내가 명단보다 위");
  for (const name of ["가나", "휴원생", "휴원생2"]) {
    const part = riderHtml(html, name);
    assert.match(part, /data-blocked="true"/);
    assert.equal((part.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
    assert.match(part, /오늘은 수업이 없어 체크하지 않아요/);
  }
  assert.match(html, /체크 대상 없음/);
  // 다른 날을 보면 «이날은»
  const other = renderDriver({ rows, date: "2026-11-26", holiday: { ymd: "2026-11-26", title: "학원 휴무" } });
  assert.match(other, /이날은 휴무/);
});

test("④ 기사 링크 저장 API 를 실제로 돌려 본다 — 잠긴 줄 409 · 되돌리기 통과 · 잠금 없는 줄 저장 · 확인 실패면 종전대로", async () => {
  const writes = [];
  let classesCalls = 0;
  let failLookup = false;
  const api = load("src/app/api/shuttle/regular-boarding/route.ts", {
    "next/server": require("next/server"),
    "@/lib/shuttle/regularRun": { async setRegularBoarding(input) { writes.push(input); return { ok: true }; } },
    "@/lib/shuttle/driverToken": { async isAnyDriverRunToken(t) { return t === "tok"; } },
    "@/lib/shuttle/driverStatusRead": { async readDriverBoarding() { return { boarding: {}, checkedAt: {} }; } },
    "@/lib/shuttle/driverLinkAccess": { async driverLinkBlocked() { return false; }, driverLinkDisabledResponse() { return new Response("{}", { status: 410 }); } },
    "@/lib/shuttle/regularDriverRoute": {
      async getRegularDriverClasses() {
        classesCalls++;
        if (failLookup) throw new Error("명단 조회 실패");
        return [{ board: [{ rows: [{ rowId: "ok-row", name: "가나" }, { rowId: "paused-row", name: "휴원생", blockedLabel: "휴원" }] }], alight: [] }];
      },
    },
  });
  const post = (rowId, status) => api.POST(new Request("http://t/api", { method: "POST", body: JSON.stringify({ token: "tok", rowId, status, date: "2026-11-19" }) }));
  for (const status of ["BOARDED", "NOSHOW", "SELF"]) {
    const res = await post("paused-row", status);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /휴원 학생은 체크하지 않습니다/);
  }
  assert.equal(writes.length, 0);
  // 되돌리기는 명단 확인 없이 바로 저장
  const before = classesCalls;
  assert.equal((await post("paused-row", null)).status, 200);
  assert.equal(classesCalls, before);
  // 잠금 없는 줄은 종전대로 저장
  assert.equal((await post("ok-row", "BOARDED")).status, 200);
  // 명단 확인이 실패하면 종전처럼 저장(멀쩡한 체크를 막지 않는다)
  failLookup = true;
  assert.equal((await post("paused-row", "BOARDED")).status, 200);
  assert.deepEqual(writes.map((w) => [w.rowId, w.status]), [["paused-row", null], ["ok-row", "BOARDED"], ["paused-row", "BOARDED"]]);
});
