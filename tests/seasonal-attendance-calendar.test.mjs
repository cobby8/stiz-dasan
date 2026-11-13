import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildAttendanceCalendar,
  calendarCellDateLabel,
  weekStartOf,
  weekdayKeyFromYmd,
} from "../src/lib/seasonal/attendanceCalendar.ts";

// 방학특강 출석 현황판을 주간 달력(가로=요일, 세로=주차)으로 접었다.
// 달력은 "어느 날짜가 어느 칸에 놓이는가"가 곧 원장이 보는 것이므로,
// 배치 계산(순수 함수)과 화면이 지켜야 할 표시 항목을 함께 잠근다.

const client = readFileSync("src/app/admin/seasonal/attendance/SeasonalAttendanceClient.tsx", "utf8");

const d = (ymd, extra = {}) => ({ sessionDateId: ymd, ymd, ...extra });

// ── 열(요일) 산출 ────────────────────────────────────────────────────────────

test("수업이 있는 요일만 열이 된다 — 월·수반은 2열", () => {
  // 2026-07-27(월), 07-29(수), 08-03(월), 08-05(수)
  const cal = buildAttendanceCalendar(["2026-07-27", "2026-07-29", "2026-08-03", "2026-08-05"].map((x) => d(x)));
  assert.deepEqual(cal.columns.map((c) => c.key), ["MON", "WED"]);
  assert.deepEqual(cal.columns.map((c) => c.label), ["월", "수"]);
});

test("월~금 반은 5열이고 월요일부터 순서대로 놓인다", () => {
  const cal = buildAttendanceCalendar(
    ["2026-07-29", "2026-07-27", "2026-07-31", "2026-07-28", "2026-07-30"].map((x) => d(x)),
  );
  assert.deepEqual(cal.columns.map((c) => c.key), ["MON", "TUE", "WED", "THU", "FRI"]);
  assert.equal(cal.weeks.length, 1);
  assert.deepEqual(cal.weeks[0].cells.map((c) => c && c.ymd), [
    "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
  ]);
});

test("주말반도 지원한다 — 토·일만 하면 2열", () => {
  const cal = buildAttendanceCalendar(["2026-08-01", "2026-08-02"].map((x) => d(x)));
  assert.deepEqual(cal.columns.map((c) => c.key), ["SAT", "SUN"]);
});

test("서버가 준 요일 키를 우선 쓰되, 없으면 날짜에서 뽑는다", () => {
  const cal = buildAttendanceCalendar([{ sessionDateId: "a", ymd: "2026-07-27" }]);
  assert.deepEqual(cal.columns.map((c) => c.key), ["MON"]);
  assert.equal(weekdayKeyFromYmd("2026-07-27"), "MON");
  assert.equal(weekdayKeyFromYmd("2026-08-02"), "SUN");
});

// ── 주차(행) 경계 ────────────────────────────────────────────────────────────

test("주는 월요일에 시작한다 — 일요일은 앞선 주에 붙는다", () => {
  assert.equal(weekStartOf("2026-07-27"), "2026-07-27"); // 월
  assert.equal(weekStartOf("2026-08-02"), "2026-07-27"); // 일 → 같은 주
  assert.equal(weekStartOf("2026-08-03"), "2026-08-03"); // 다음 월
});

test("주가 바뀌면 행이 나뉜다 — 금요일과 다음 월요일은 다른 줄", () => {
  const cal = buildAttendanceCalendar(["2026-07-31", "2026-08-03"].map((x) => d(x)));
  assert.equal(cal.weeks.length, 2);
  assert.deepEqual(cal.weeks.map((w) => w.weekStart), ["2026-07-27", "2026-08-03"]);
  // 금 열/월 열 두 개가 만들어지고, 각 주에서 없는 요일은 빈 칸이다.
  assert.deepEqual(cal.columns.map((c) => c.key), ["MON", "FRI"]);
  assert.deepEqual(cal.weeks[0].cells.map((c) => c && c.ymd), [null, "2026-07-31"]);
  assert.deepEqual(cal.weeks[1].cells.map((c) => c && c.ymd), ["2026-08-03", null]);
});

test("주는 항상 날짜 오름차순으로 나온다(입력이 뒤섞여 있어도)", () => {
  const cal = buildAttendanceCalendar(["2026-08-10", "2026-07-27", "2026-08-03"].map((x) => d(x)));
  assert.deepEqual(cal.weeks.map((w) => w.weekStart), ["2026-07-27", "2026-08-03", "2026-08-10"]);
});

// ── 빠진 날짜 = 빈 칸 ────────────────────────────────────────────────────────

test("공휴일 등으로 중간에 빠진 날은 빈 칸으로 남아 간격이 보인다", () => {
  // 월·수반인데 8/5(수)가 공휴일로 빠졌다.
  const cal = buildAttendanceCalendar(
    ["2026-07-27", "2026-07-29", "2026-08-03", "2026-08-10", "2026-08-12"].map((x) => d(x)),
  );
  assert.deepEqual(cal.columns.map((c) => c.key), ["MON", "WED"]);
  assert.deepEqual(cal.weeks.map((w) => w.cells.map((c) => c && c.ymd)), [
    ["2026-07-27", "2026-07-29"],
    ["2026-08-03", null],          // ← 빠진 수요일이 빈 칸으로 보인다
    ["2026-08-10", "2026-08-12"],
  ]);
});

test("한 주가 통째로 쉬면 그 주는 행 자체가 없다(빈 행을 만들지 않는다)", () => {
  const cal = buildAttendanceCalendar(["2026-07-27", "2026-08-10"].map((x) => d(x)));
  assert.deepEqual(cal.weeks.map((w) => w.weekStart), ["2026-07-27", "2026-08-10"]);
});

// ── 회차를 잃지 않는다 ───────────────────────────────────────────────────────

test("같은 주·같은 요일에 회차가 둘이면 행을 더 만들어 하나도 빠뜨리지 않는다", () => {
  const cal = buildAttendanceCalendar([
    { sessionDateId: "오전", ymd: "2026-07-27" },
    { sessionDateId: "오후", ymd: "2026-07-27" },
  ]);
  assert.equal(cal.weeks.length, 2);
  assert.deepEqual(cal.weeks.map((w) => w.cells[0].sessionDateId), ["오전", "오후"]);
});

test("날짜가 이상한 회차도 버리지 않고 unplaced로 돌려준다", () => {
  const cal = buildAttendanceCalendar([
    { sessionDateId: "정상", ymd: "2026-07-27" },
    { sessionDateId: "깨짐", ymd: null },
    { sessionDateId: "없는날", ymd: "2026-02-30" },
  ]);
  assert.equal(cal.weeks.length, 1);
  assert.deepEqual(cal.unplaced.map((x) => x.sessionDateId), ["깨짐", "없는날"]);
});

test("빈 목록에도 깨지지 않는다", () => {
  const cal = buildAttendanceCalendar([]);
  assert.deepEqual(cal.columns, []);
  assert.deepEqual(cal.weeks, []);
  assert.equal(cal.multiMonth, false);
});

// ── 셀 날짜 라벨 ─────────────────────────────────────────────────────────────

test("한 달 안이면 일자만, 두 달 이상 걸치면 월까지 보여준다", () => {
  assert.equal(buildAttendanceCalendar(["2026-08-03", "2026-08-05"].map((x) => d(x))).multiMonth, false);
  assert.equal(buildAttendanceCalendar(["2026-07-27", "2026-08-03"].map((x) => d(x))).multiMonth, true);
  assert.equal(calendarCellDateLabel("2026-07-27", false), "27");
  assert.equal(calendarCellDateLabel("2026-07-27", true), "7/27");
});

// ── 화면이 지켜야 할 것 ──────────────────────────────────────────────────────

test("현황판은 달력 배치 순수 함수를 그대로 쓴다(화면에서 다시 계산하지 않는다)", () => {
  assert.match(client, /buildAttendanceCalendar\(board\)/);
  assert.match(client, /calendarCellDateLabel\(d\.ymd, calendar\.multiMonth\)/);
  // 요일 머리글 + 빈 칸 렌더링
  assert.match(client, /calendar\.columns\.map/);
  assert.match(client, /border-dashed/);
});

test("셀은 정원 초과를 빨강 + '초과'로 알린다 — 코트 전체 기준", () => {
  assert.match(client, /const over = court != null && court > cap;/);
  assert.match(client, /⚠ 초과/);
  // 초과 = 위험색 토큰(색상 6단계 — 하드코딩 빨강·dark: 대신)
  assert.match(client, /over \? "text-\[var\(--color-academy-danger\)\]"/);
});

test("셀은 미확인(출결 체크 안 된 인원)이 남으면 표시한다", () => {
  assert.match(client, /const pending = d\.unchecked > 0 && d\.state !== "PLANNED";/);
  assert.match(client, /pending && <span[\s\S]{0,200}\{d\.unchecked\}<\/span>/);
});

test("셀을 누르면 그 날짜가 선택되고, 선택된 날은 링으로 강조된다", () => {
  assert.match(client, /onClick=\{\(\) => setSelDate\(d\.sessionDateId\)\}/);
  // 2026-11-13 UI 통일: «고른 날짜»는 주 색(네이비)이 아니라 보조 색(하늘색) 링으로 강조한다.
  assert.match(client, /ring-1 ring-\[var\(--color-academy-secondary-strong\)\]/);
});

test("셀에서 뺀 정보(시간·N일차·출결 상세)는 title로 남긴다", () => {
  assert.match(client, /일차 · \$\{d\.startTime\}~\$\{d\.endTime\}/);
  assert.match(client, /출\$\{d\.present\}\/지\$\{d\.late\}\/결\$\{d\.absent\}\/보\$\{d\.makeup\}/);
});

test("두 숫자 기준을 알리는 ※ 설명 한 줄은 그대로 남아 있다", () => {
  assert.match(client, /※ <b>이 반<\/b> = 그 날짜 이 반 인원/);
  assert.match(client, /<b>코트 전체<\/b> = 같은 시간·코트를 쓰는 반을 모두 합친 인원\/정원\(초과 시 빨강\)/);
});

test("출석 체크 후 날짜가 튀지 않게 하는 keepSelection 장치는 유지된다", () => {
  assert.match(client, /loadBoard = useCallback\(async \(oid: string, opts\?: \{ keepSelection\?: boolean \}\)/);
  assert.match(client, /if \(opts\?\.keepSelection && cur && dates\.some\(\(d\) => d\.sessionDateId === cur\)\) return cur;/);
  // 출석 저장·보강 배정·보강 승인 세 경로 모두 선택 유지로 갱신한다.
  assert.equal((client.match(/loadBoard\(offeringId, \{ keepSelection: true \}\)/g) || []).length, 3);
});

test("모바일에서 가로로 밀리지 않게 열을 1fr로 나눠 갖는다", () => {
  assert.match(client, /repeat\(\$\{calendar\.columns\.length \|\| 1\}, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(client, /overflow-x-auto/);
});
