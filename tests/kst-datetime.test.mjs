import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 시간대 버그는 **로컬에서는 멀쩡하고 배포하면 틀린다**(Vercel=UTC, 개발 PC=KST).
// 그래서 소스를 읽는 검사로는 못 잡는다 — 실제로 실행해서 값을 확인한다.

const {
  todayKst, toKstYmd, kstDow, kstAt, addDaysKst, diffDaysKst, isKstYmd, kstLabel, KST,
} = await loadTsModule("src/lib/datetime/kst.ts");

// KST 08-13 01:00 = UTC 08-12 16:00. 한국은 이미 13일인데 UTC 는 아직 12일이다.
const DAWN = new Date("2026-08-13T01:00:00+09:00").getTime();

test("오늘은 KST 기준이다 — 새벽에 어제가 나오면 안 된다", () => {
  // 이 프로젝트에 실제로 남아 있는 `new Date().toISOString().split("T")[0]` 이
  // 왜 틀렸는지를 그대로 보여준다. 새벽 0~9시에 전날 출석부가 열린다.
  assert.equal(new Date(DAWN).toISOString().slice(0, 10), "2026-08-12", "UTC 로는 아직 12일");
  assert.equal(todayKst(DAWN), "2026-08-13", "한국은 이미 13일");
});

test("요일은 하루 밀리지 않는다", () => {
  assert.equal(kstDow("2026-08-12"), 3); // 수
  assert.equal(kstDow("2026-08-14"), 5); // 금
  assert.equal(kstDow("2026-08-15"), 6); // 토
  assert.equal(kstDow("2026-08-16"), 0); // 일
  // 옛 방식이 왜 위험한지 — T00:00 은 틀리고 T12:00 은 우연히 맞는다.
  // 똑같이 생긴 코드가 시각 리터럴 하나로 갈려서 옆 파일을 보고 따라 쓰면 터진다.
  assert.equal(new Date("2026-08-14T00:00:00+09:00").getUTCDay(), 4, "옛 방식: 하루 밀림");
  assert.equal(new Date("2026-08-14T12:00:00+09:00").getUTCDay(), 5, "옛 방식: 우연히 맞음");
  assert.ok(Number.isNaN(kstDow("2026-8-14")));
  assert.ok(Number.isNaN(kstDow(null)));
});

test("달력에 없는 날짜를 거른다", () => {
  assert.equal(isKstYmd("2026-02-28"), true);
  assert.equal(isKstYmd("2026-02-30"), false);
  assert.equal(isKstYmd("2026-13-01"), false);
  assert.equal(isKstYmd("2026-2-1"), false);
  assert.equal(isKstYmd(""), false);
  assert.equal(isKstYmd(undefined), false);
});

test("자정 경계에서 날짜가 넘어가지 않는다", () => {
  assert.equal(toKstYmd(new Date("2026-08-12T00:00:00+09:00")), "2026-08-12");
  assert.equal(toKstYmd(new Date("2026-08-12T23:59:59+09:00")), "2026-08-12");
  assert.equal(toKstYmd(new Date("2026-08-13T00:00:00+09:00")), "2026-08-13");
  assert.equal(toKstYmd("깨진값"), "");
});

test("시각 비교 기준점(kstAt)", () => {
  assert.equal(kstAt("2026-08-12"), new Date("2026-08-12T00:00:00+09:00").getTime());
  assert.equal(kstAt("2026-08-12", "16:00"), new Date("2026-08-12T16:00:00+09:00").getTime());
  assert.equal(kstAt("2026-08-12", "9:30"), new Date("2026-08-12T09:30:00+09:00").getTime());
  // 시각을 못 읽으면 그 날 자정으로 — 조용히 오늘로 튀지 않는다.
  assert.equal(kstAt("2026-08-12", "미정"), kstAt("2026-08-12"));
  assert.ok(Number.isNaN(kstAt("2026-02-30")));
});

test("날짜 더하기는 달과 해를 넘어도 맞는다", () => {
  assert.equal(addDaysKst("2026-08-12", 1), "2026-08-13");
  assert.equal(addDaysKst("2026-08-12", 7), "2026-08-19");
  assert.equal(addDaysKst("2026-08-31", 1), "2026-09-01");
  assert.equal(addDaysKst("2026-12-31", 1), "2027-01-01"); // 한 해에 한 번 크게 터지는 자리
  assert.equal(addDaysKst("2026-01-01", -1), "2025-12-31");
  assert.equal(addDaysKst("2026-02-28", 1), "2026-03-01"); // 2026 은 평년
  assert.equal(addDaysKst("2028-02-28", 1), "2028-02-29"); // 2028 은 윤년
  assert.equal(addDaysKst("2026-02-30", 1), "");
});

test("60일을 더해도 하루도 어긋나지 않는다", () => {
  // 보강 기한(2개월)이 여기에 걸려 있다. 한 번이라도 밀리면 약관과 어긋난다.
  let ymd = "2026-08-12";
  for (let i = 0; i < 60; i++) ymd = addDaysKst(ymd, 1);
  assert.equal(ymd, addDaysKst("2026-08-12", 60));
  assert.equal(diffDaysKst("2026-08-12", ymd), 60);
});

test("두 날짜 사이 일수", () => {
  assert.equal(diffDaysKst("2026-08-12", "2026-08-19"), 7);
  assert.equal(diffDaysKst("2026-08-19", "2026-08-12"), -7);
  assert.equal(diffDaysKst("2026-08-12", "2026-08-12"), 0);
  assert.ok(Number.isNaN(diffDaysKst("깨짐", "2026-08-12")));
});

test("표시 문구", () => {
  assert.equal(kstLabel("2026-08-14"), "8/14(금)");
  assert.equal(kstLabel(DAWN), "8/13(목)");
  assert.equal(kstLabel("깨진값"), "");
});

test("달 더하기(addMonthsYm)는 달력 숫자만 센다 — 연말·연초·잘못된 입력", async () => {
  const { addMonthsYm, todayKst: today } = await loadTsModule("src/lib/datetime/kst.ts");
  assert.equal(addMonthsYm("2026-11", 1), "2026-12");
  assert.equal(addMonthsYm("2026-12", 1), "2027-01");
  assert.equal(addMonthsYm("2026-01", -1), "2025-12");
  assert.equal(addMonthsYm("2026-11", -5), "2026-06");
  assert.equal(addMonthsYm("2026-03", -14), "2025-01");
  assert.equal(addMonthsYm("2026-13", 1), "");
  assert.equal(addMonthsYm("2026-1", 1), "");
  // 매달 1일 KST 새벽(UTC 로는 아직 전달 말일)에도 «이번 달»은 KST 달
  const firstDawn = new Date("2026-12-01T03:00:00+09:00").getTime();
  assert.equal(today(firstDawn).slice(0, 7), "2026-12");
  assert.equal(addMonthsYm(today(firstDawn).slice(0, 7), -1), "2026-11");
});

test("queries.ts 수납 월 범위·경영 대시보드는 서버 시계 대신 KST 달(2026-11-10 정리)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("src/lib/queries.ts", "utf8");
  const range = src.slice(src.indexOf("function getMonthDateRange"), src.indexOf("function getMonthDateRange") + 500);
  const dash = src.slice(src.indexOf("export const getDashboardExtendedStats"), src.indexOf("export const getDashboardExtendedStats") + 5000);
  for (const [name, body] of [["getMonthDateRange", range], ["getDashboardExtendedStats", dash]]) {
    const code = body.replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /getFullYear\(\)|getMonth\(\)/, name);
    assert.match(code, /addMonthsYm\(/, name);
  }
  assert.match(dash, /const thisMonthKey = todayKst\(\)\.slice\(0, 7\);/);
});

test("시간대 상수는 한 곳에서만 정한다", () => {
  assert.equal(KST, "Asia/Seoul");
});
