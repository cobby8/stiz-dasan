import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { SELECTION_MODES, attendsSessionDate, countOccupancyByDate, pickSessionDatesForApplication, seasonalAttendsSql } from "./attendance-rule.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { weekdayInSeoul } from "./planning.ts";

// 2027 겨울특강 기준: 1/4(월)~1/29(금). 4주 = 1/4~1/29, 3주 = 1/11~1/29.
const FOUR_WEEKS = { periodStartDate: "2027-01-04", periodEndDate: "2027-01-29" };
const THREE_WEEKS = { periodStartDate: "2027-01-11", periodEndDate: "2027-01-29" };

test("자정 경계: UTC 15:00 = KST 다음 날 0시라 3주 기간 첫날에 들어가고, 1초 전은 빠진다", () => {
  const rule = { selectedWeekdays: [], ...THREE_WEEKS };
  assert.equal(attendsSessionDate(rule, "2027-01-10T15:00:00Z"), true); // KST 1/11 00:00
  assert.equal(attendsSessionDate(rule, "2027-01-10T14:59:59Z"), false); // KST 1/10 23:59:59
  assert.equal(attendsSessionDate(rule, new Date("2027-01-10T15:00:00Z")), true); // Date 도 같은 결과
});

test("종료일은 포함, 다음 날 0시부터는 제외", () => {
  const rule = { selectedWeekdays: [], ...THREE_WEEKS };
  assert.equal(attendsSessionDate(rule, "2027-01-29T01:00:00Z"), true); // KST 1/29 10:00
  assert.equal(attendsSessionDate(rule, "2027-01-29T14:59:59Z"), true); // KST 1/29 23:59:59
  assert.equal(attendsSessionDate(rule, "2027-01-29T15:00:00Z"), false); // KST 1/30 00:00
});

test("기간과 요일이 함께 걸린다(3주·월수만)", () => {
  const rule = { selectedWeekdays: ["MON", "WED"], ...THREE_WEEKS };
  assert.equal(attendsSessionDate(rule, "2027-01-11T01:00:00Z"), true); // 1/11 월
  assert.equal(attendsSessionDate(rule, "2027-01-12T01:00:00Z"), false); // 1/12 화
  assert.equal(attendsSessionDate(rule, "2027-01-04T01:00:00Z"), false); // 1/4 월이지만 기간 밖
});

test("월말·연말·윤년 날짜도 KST 달력으로 맞게 읽는다", () => {
  // 연말: UTC 12/31 15:00 = KST 2027-01-01
  const newYear = { selectedWeekdays: [], periodStartDate: "2027-01-01", periodEndDate: "2027-01-31" };
  assert.equal(attendsSessionDate(newYear, "2026-12-31T15:00:00Z"), true);
  assert.equal(attendsSessionDate(newYear, "2026-12-31T14:59:59Z"), false);
  // 월말: UTC 1/31 15:00 = KST 2/1 → 1월 기간 밖
  assert.equal(attendsSessionDate(newYear, "2027-01-31T14:00:00Z"), true);
  assert.equal(attendsSessionDate(newYear, "2027-01-31T15:00:00Z"), false);
  // 윤년: KST 2028-02-29(화) 날짜 선택
  const leap = { selectionMode: "DATE", selectedWeekdays: [], selectedDates: ["2028-02-29"] };
  assert.equal(attendsSessionDate(leap, "2028-02-28T15:00:00Z"), true); // KST 2/29 00:00
  assert.equal(attendsSessionDate(leap, "2028-02-28T14:59:59Z"), false); // KST 2/28
  assert.equal(attendsSessionDate(leap, "2028-02-29T15:00:00Z"), false); // KST 3/1
  // 윤년 2/29 의 요일(화)도 맞게
  assert.equal(attendsSessionDate({ selectedWeekdays: ["TUE"] }, "2028-02-29T01:00:00Z"), true);
});

test("날짜 선택은 요일·기간보다 우선하고, 회차가 없는 날은 횟수에 안 들어간다", () => {
  const sessions = [
    { id: "a", startsAt: "2027-01-04T01:00:00Z" }, // 1/4 월
    { id: "b", startsAt: "2027-01-06T01:00:00Z" }, // 1/6 수
    { id: "c", startsAt: "2027-01-11T01:00:00Z" }, // 1/11 월
  ];
  // 1/5(화)는 회차가 없는 날 — 골라도 횟수에 안 들어간다
  const rule = { selectionMode: "DATE", selectedWeekdays: ["FRI"], selectedDates: ["2027-01-04", "2027-01-05", "2027-01-11"], ...THREE_WEEKS };
  const picked = pickSessionDatesForApplication(sessions, rule);
  assert.deepEqual(picked.map((s: { id: string }) => s.id), ["a", "c"]);
});

// enrollment-dates.ts 의 pickSessionDatesForWeekdays 원본(그 파일은 prisma 를 import 해 테스트에서 직접 못 부른다).
// 원본이 바뀌면 아래 «원본 모양 확인» 테스트가 먼저 깨지도록 한다.
const LEGACY_ALIASES: Record<string, string> = {
  MON: "MON", MONDAY: "MON", 월: "MON", 월요일: "MON", TUE: "TUE", TUESDAY: "TUE", 화: "TUE", 화요일: "TUE",
  WED: "WED", WEDNESDAY: "WED", 수: "WED", 수요일: "WED", THU: "THU", THURSDAY: "THU", 목: "THU", 목요일: "THU",
  FRI: "FRI", FRIDAY: "FRI", 금: "FRI", 금요일: "FRI", SAT: "SAT", SATURDAY: "SAT", 토: "SAT", 토요일: "SAT",
  SUN: "SUN", SUNDAY: "SUN", 일: "SUN", 일요일: "SUN",
};
function legacyPick<T extends { startsAt: Date | string }>(sessionDates: T[], selectedWeekdays: unknown): T[] {
  const wanted = Array.isArray(selectedWeekdays)
    ? selectedWeekdays.map((v) => LEGACY_ALIASES[String(v ?? "").trim().toUpperCase()]).filter(Boolean)
    : [];
  if (wanted.length === 0) return [...sessionDates];
  return sessionDates.filter((sd) => {
    const startsAt = sd.startsAt instanceof Date ? sd.startsAt : new Date(sd.startsAt);
    if (Number.isNaN(startsAt.getTime())) return false;
    return wanted.includes(weekdayInSeoul(startsAt));
  });
}

test("원본 모양 확인: pickSessionDatesForWeekdays 가 위 복사본과 같은 규칙(정규화 + 서울 요일)을 쓴다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/seasonal/enrollment-dates.ts"), "utf8");
  assert.match(source, /export function pickSessionDatesForWeekdays/);
  assert.match(source, /const wanted = normalizeWeekdayKeys\(selectedWeekdays\);\s*if \(wanted\.length === 0\) return \[\.\.\.sessionDates\];/);
  assert.match(source, /return wanted\.includes\(weekdayInSeoul\(startsAt\)\);/);
});

test("기존 신청서(날짜 빈 배열·기간 null)에서 pickSessionDatesForWeekdays 와 결과가 같다", () => {
  // 3주 × 월~토 + 자정 경계 회차 + 잘못된 시각
  const sessions: Array<{ id: string; startsAt: Date | string }> = [];
  for (let day = 1; day <= 23; day += 1) {
    const dd = String(day).padStart(2, "0");
    sessions.push({ id: `m${dd}`, startsAt: `2027-01-${dd}T01:00:00Z` }); // KST 10:00
    sessions.push({ id: `n${dd}`, startsAt: new Date(`2027-01-${dd}T15:00:00Z`) }); // KST 다음 날 0시
  }
  sessions.push({ id: "bad", startsAt: "not-a-date" });
  const weekdaySets: unknown[] = [[], null, undefined, ["MON", "WED"], ["화", "목요일"], ["sat"], ["XYZ"], ["MON", "XYZ"], "MON"];
  for (const selectedWeekdays of weekdaySets) {
    const expected = legacyPick(sessions, selectedWeekdays).map((s) => s.id);
    for (const extra of [{}, { selectedDates: [], periodStartDate: null, periodEndDate: null }, { selectionMode: "WEEKDAY", selectedDates: null }]) {
      const actual = pickSessionDatesForApplication(sessions, { selectedWeekdays: selectedWeekdays as string[], ...extra })
        .map((s: { id: string }) => s.id);
      assert.deepEqual(actual, expected, `selectedWeekdays=${JSON.stringify(selectedWeekdays)} extra=${JSON.stringify(extra)}`);
    }
  }
});

test("SQL 조각에 날짜·기간·요일 세 조건이 모두 들어 있고 KST 변환은 한 번(timestamptz)", () => {
  const sql = seasonalAttendsSql("app", "sd");
  assert.match(sql, /cardinality\(app\."selectedDates"\)/);
  assert.match(sql, /= ANY\(app\."selectedDates"\)/);
  assert.match(sql, /app\."periodStartDate" IS NULL OR .+ >= app\."periodStartDate"/);
  assert.match(sql, /app\."periodEndDate" IS NULL OR .+ <= app\."periodEndDate"/);
  assert.match(sql, /cardinality\(app\."selectedWeekdays"\), 0\) = 0/);
  assert.match(sql, /EXTRACT\(ISODOW FROM sd\."startsAt" AT TIME ZONE 'Asia\/Seoul'\)::int/);
  assert.match(sql, /= ANY\(app\."selectedWeekdays"\)/);
  // startsAt 은 timestamptz — AT TIME ZONE 을 두 번 걸면 9시간 밀린다
  assert.doesNotMatch(sql, /AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(sql, /AT TIME ZONE 'Asia\/Seoul'\)\s*AT TIME ZONE/);
  // 별칭에 SQL 을 끼워 넣지 못한다
  assert.throws(() => seasonalAttendsSql("app; DROP TABLE x", "sd"));
  assert.throws(() => seasonalAttendsSql("app", "sd\"--"));
});

test("4주·3주·날짜 선택 신청자를 섞으면 1/4 과 1/11 의 날짜별 인원이 다르다", () => {
  // 월·수 4주 회차(KST 10:00) + 1/5(화)는 회차 없음
  const sessions = ["04", "06", "11", "13", "18", "20", "25", "27"].map((d) => ({ id: d, startsAt: `2027-01-${d}T01:00:00Z` }));
  const apps = [
    { selectedWeekdays: ["MON", "WED"], ...FOUR_WEEKS }, // 4주
    { selectedWeekdays: ["MON", "WED"], ...THREE_WEEKS }, // 3주
    { selectedWeekdays: ["MON"], ...THREE_WEEKS }, // 3주·월만
    { selectionMode: "DATE", selectedWeekdays: [], selectedDates: ["2027-01-04", "2027-01-06", "2027-01-05"] }, // 날짜 선택
    { selectedWeekdays: [], selectedDates: [] }, // 기존 신청서(전 회차)
  ];
  const occupancy = countOccupancyByDate(apps, sessions);
  assert.equal(occupancy.get("2027-01-04"), 3); // 4주 + 날짜 + 기존
  assert.equal(occupancy.get("2027-01-11"), 4); // 4주 + 3주 + 3주월 + 기존
  assert.equal(occupancy.get("2027-01-13"), 3); // 4주 + 3주 + 기존
  assert.equal(occupancy.has("2027-01-05"), false); // 회차 없는 날은 키가 없다
  assert.deepEqual([...occupancy.keys()], sessions.map((s) => `2027-01-${s.id}`)); // 날짜 오름차순
});

test("제약 짝: SELECTION_MODES 와 마이그레이션 CHECK 허용값이 같다", () => {
  const dir = join(process.cwd(), "prisma/migrations");
  const folder = readdirSync(dir).find((name) => name.endsWith("_seasonal_period_and_date_select"));
  assert.ok(folder, "마이그레이션 폴더가 있어야 한다");
  const sql = readFileSync(join(dir, folder!, "migration.sql"), "utf8");
  const matched = sql.match(/CHECK \("selectionMode" IN \(([^)]*)\)\)/);
  assert.ok(matched, "selectionMode CHECK 가 있어야 한다");
  const values = matched![1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  assert.deepEqual([...values].sort(), [...SELECTION_MODES].sort());
  // 기본값도 허용값 안에 있어야 한다
  assert.match(sql, /"selectionMode" TEXT NOT NULL DEFAULT 'WEEKDAY'/);
});
