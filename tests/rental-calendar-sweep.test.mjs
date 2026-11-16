import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-11-16 원장 «캘린더에 넣은 일정이 사이트에서 취소되면 캘린더에서도 삭제»
// 대관 캘린더 맞추기: ① 상태가 바뀔 때마다 매번 ② 삭제 실패분은 매일 정리 cron 이 다시 지운다.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("대관 처리·수정 뒤에는 조건 없이 캘린더를 맞춘다", () => {
  const actions = read("src/app/actions/rental.ts");
  assert.equal((actions.match(/await syncRentalCalendar\(/g) ?? []).length, 2);
  assert.doesNotMatch(actions, /if \([^)]*\) await syncRentalCalendar\(/);
});

test("다시 지우기 대상 = 일정 ID 가 남았는데 캘린더에 있으면 안 되는 상태 — 상태 목록은 ON_CALENDAR 와 같다", () => {
  const source = read("src/lib/rental/gym-rental-calendar.ts");
  const onCalendar = source.match(/const ON_CALENDAR: readonly RentalStatus\[\] = \[([^\]]+)\]/)[1].replace(/"/g, "'").replace(/\s/g, "");
  const sweep = source.match(/status NOT IN \(([^)]+)\)/)[1].replace(/\s/g, "");
  assert.equal(sweep, onCalendar);
  assert.match(source, /"calendarEventId" IS NOT NULL AND status NOT IN/);
  // 삭제에 성공했을 때만 ID 를 비운다(실패하면 남겨 다음에 다시 시도)
  assert.match(source, /await deleteCalendarEventChecked\(row\.calendarEventId\)\) await saveEventId\(row\.id, null\)/);
});

test("매일 정리 cron 이 다시 지우기를 부른다", () => {
  const route = read("src/app/api/cron/data-retention/route.ts");
  assert.match(route, /sweepRentalCalendar\(\)/);
  assert.match(route, /CRON_SECRET/);
});
