// 2026-11-14 출결 «주간 보드»(원장 «10월 1주차, 10월 2주차처럼 주 단위로»).
//  - 주차 계산(목요일이 속한 달 기준)·월요일 보정·월말/연말 경계를 실제로 돌려 본다
//  - 주간 API 가 관리자 확인을 맨 먼저 하고, 입력 패널과 같은 조회 함수를 재사용하는지 소스로 못 박는다
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const w = await loadTsModule("src/lib/attendance/weekBoard.ts");

test("월요일 보정 — 어느 요일이든 그 주 월요일, 잘못된 입력은 오늘이 든 주", () => {
  assert.equal(w.mondayOf("2026-11-14"), "2026-11-09"); // 토
  assert.equal(w.mondayOf("2026-11-15"), "2026-11-09"); // 일 → 앞 월요일(주 = 월~일)
  assert.equal(w.mondayOf("2026-11-09"), "2026-11-09"); // 월 그대로
  assert.equal(w.mondayOf("2026-10-01"), "2026-09-28"); // 달을 거슬러
  assert.equal(w.mondayOf("2027-01-01"), "2026-12-28"); // 해를 거슬러
  assert.equal(w.mondayOf("2026-02-30"), "");
  assert.equal(w.normalizeWeekStart("2026-11-12", "2026-01-01"), "2026-11-09");
  assert.equal(w.normalizeWeekStart("abc", "2026-11-14"), "2026-11-09");
  assert.equal(w.normalizeWeekStart(null, "2026-11-14"), "2026-11-09");
  assert.equal(w.normalizeWeekStart(" 2026-11-16 ", "2026-01-01"), "2026-11-16");
  // 기간(2020-01-01~2030-12-31) 밖이면 이번 주
  assert.equal(w.normalizeWeekStart("2019-12-31", "2026-11-14"), "2026-11-09");
  assert.equal(w.normalizeWeekStart("2031-01-01", "2026-11-14"), "2026-11-09");
  assert.equal(w.normalizeWeekStart("2020-01-01", "2026-11-14"), "2019-12-30"); // 첫날이 든 주
  assert.equal(w.normalizeWeekStart("2030-12-31", "2026-11-14"), "2030-12-30");
  // 이전/다음 주 버튼 범위
  assert.equal(w.isWeekInRange("2019-12-30"), true);
  assert.equal(w.isWeekInRange("2019-12-23"), false);
  assert.equal(w.isWeekInRange("2030-12-30"), true);
  assert.equal(w.isWeekInRange("2031-01-06"), false);
});

test("주차 — 목요일이 속한 달의 몇 번째 목요일", () => {
  // 9/28~10/4 주: 목요일 10/1 → 10월 1주차 (9월 마지막 주가 아니다)
  assert.equal(w.weekTitle("2026-09-28"), "10월 1주차");
  assert.equal(w.weekTitle("2026-10-05"), "10월 2주차");
  // 이번 주(11/9~11/15): 목요일 11/12 → 11월 2주차
  assert.equal(w.weekTitle("2026-11-09"), "11월 2주차");
  assert.equal(w.weekRangeLabel("2026-11-09"), "11/9~11/15");
  // 월말 경계: 10/26~11/1 주는 목요일 10/29 → 10월 5주차
  assert.equal(w.weekTitle("2026-10-26"), "10월 5주차");
  // 11/30~12/6 주: 목요일 12/3 → 12월 1주차
  assert.equal(w.weekTitle("2026-11-30"), "12월 1주차");
  // 연말 경계: 12/28~1/3 주는 목요일 12/31 → 12월 5주차 (2026년)
  assert.deepEqual(w.weekOfMonth("2026-12-28"), { year: 2026, month: 12, week: 5 });
  assert.equal(w.weekRangeLabel("2026-12-28"), "12/28~1/3");
  // 2027-12-27~2028-01-02 주는 목요일 12/30 → 12월, 2028-01-03 주는 1월 1주차(목 1/6)
  assert.equal(w.weekTitle("2028-01-03"), "1월 1주차");
  // 월요일이 아닌 날을 넣어도 그 주로 계산
  assert.equal(w.weekTitle("2026-10-04"), "10월 1주차");
});

test("주 이동·7일 목록", () => {
  assert.equal(w.shiftWeek("2026-11-09", -1), "2026-11-02");
  assert.equal(w.shiftWeek("2026-11-09", 1), "2026-11-16");
  assert.equal(w.shiftWeek("2026-12-28", 1), "2027-01-04");
  assert.deepEqual(w.weekDays("2026-09-30"), [
    "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  ]);
});

test("보드 상태 — 기록이 있으면 그 값, 없으면 오늘 이후 «예정»·오늘까지 «미확인»", () => {
  assert.equal(w.boardStatusOf("PRESENT", "2026-11-20", "2026-11-14"), "PRESENT");
  assert.equal(w.boardStatusOf(null, "2026-11-20", "2026-11-14"), "PLANNED");
  assert.equal(w.boardStatusOf(null, "2026-11-14", "2026-11-14"), "UNMARKED");
  assert.equal(w.boardStatusOf(undefined, "2026-11-10", "2026-11-14"), "UNMARKED");
  // 앞으로 올 수업에 결석 신고가 있으면 «결석 신고», 지난 수업은 신고가 있어도 기록 전이면 «미확인»
  assert.equal(w.boardStatusOf(null, "2026-11-20", "2026-11-14", true), "REPORTED");
  assert.equal(w.boardStatusOf(null, "2026-11-10", "2026-11-14", true), "UNMARKED");
  assert.equal(w.boardStatusOf("PRESENT", "2026-11-20", "2026-11-14", true), "PRESENT");
  const counts = w.countBoardStatuses(
    [{ status: "PRESENT" }, { status: "PRESENT" }, { status: "ABSENT" }, { status: null }],
    "2026-11-10", "2026-11-14",
  );
  assert.deepEqual(counts, { PRESENT: 2, ABSENT: 1, LATE: 0, UNMARKED: 1, PLANNED: 0, REPORTED: 0 });
  const future = w.countBoardStatuses([{ status: null, absenceReport: { reason: "OTHER" } }, { status: null }], "2026-11-20", "2026-11-14");
  assert.equal(future.REPORTED, 1);
  assert.equal(future.PLANNED, 1);
});

test("질병·부상 표시 — 입력 패널과 같은 기준(결석 + 정규반 + 사유 질병·부상)", () => {
  const ill = { reason: "ILLNESS_INJURY" };
  assert.equal(w.showsIllness({ status: "ABSENT", absenceReport: ill }, null), true);
  assert.equal(w.showsIllness({ status: "ABSENT", absenceReport: ill }, "sd1"), false); // 특강 회차
  assert.equal(w.showsIllness({ status: "PRESENT", absenceReport: ill }, null), false);
  assert.equal(w.showsIllness({ status: null, absenceReport: ill }, null), false);
  assert.equal(w.showsIllness({ status: "ABSENT", absenceReport: { reason: "OTHER" } }, null), false);
});

test("짧은 반 이름 — «월요일 4교시» → «월4», 교시가 없으면 원래 이름", () => {
  assert.equal(w.shortLessonName("월요일 4교시", "2026-11-09"), "월4");
  assert.equal(w.shortLessonName("토요일 2교시 (초등)", "2026-11-14"), "토2");
  assert.equal(w.shortLessonName("겨울 특강 슈팅반", "2026-11-14"), "겨울 특강 슈팅반");
});

test("카드 순서 — 날짜 → 시작 시간 → 이름", () => {
  const items = [
    { date: "2026-11-10", lesson: { startTime: "16:00", name: "B" } },
    { date: "2026-11-09", lesson: { startTime: "18:00", name: "A" } },
    { date: "2026-11-09", lesson: { startTime: "16:00", name: "C" } },
  ].sort(w.compareWeekLessons);
  assert.deepEqual(items.map((i) => `${i.date} ${i.lesson.startTime}`), ["2026-11-09 16:00", "2026-11-09 18:00", "2026-11-10 16:00"]);
});

test("동시 실행 제한 — 한 번에 limit 개까지만, 결과 순서 유지", async () => {
  let running = 0;
  let peak = 0;
  const out = await w.mapWithLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return n * 2;
  });
  assert.ok(peak <= 3, `동시 ${peak}개`);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.deepEqual(await w.mapWithLimit([], 6, async () => 1), []);
});

test("주간 API — requireAdmin 이 맨 먼저, 입력 패널과 같은 조회 함수 재사용, 캐시 금지", () => {
  const src = readFileSync("src/app/api/admin/attendance/week/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const body = src.slice(src.indexOf("export async function GET"));
  const guard = body.indexOf("await requireAdmin()");
  assert.ok(guard > 0, "requireAdmin 호출이 없다");
  for (const later of ["searchParams", "getCachedAdminAttendancePayload(", "getAttendanceByDateAndClass("]) {
    const at = body.indexOf(later);
    assert.ok(at > guard, `${later} 가 관리자 확인보다 먼저 나온다`);
  }
  assert.match(src, /mapWithLimit\(/);
  // 하루치 목록이 실패해도 주 전체가 500 이 되지 않게 날짜별로 잡고 failedDays 로 알린다
  assert.match(src, /failedDays\.push\(date\)/);
  assert.match(src, /lessons, failedDays/);
  assert.match(src, /"Cache-Control": "no-store"/);
  // 새 SQL 로 다시 계산하지 않는다(입력 패널과 숫자가 어긋나지 않게)
  assert.doesNotMatch(src, /queryRawUnsafe|prisma\./);
});
