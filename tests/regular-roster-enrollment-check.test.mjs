// 셔틀 명단 수강 점검 — «경고만 하고 자동으로 빼지 않는다»를 소스로 못박는다.
// 판정 규칙 자체는 src/lib/shuttle/regularRosterEnrollmentCheckLogic.test.ts 가 실제 실행으로 검사한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edit = readFileSync("src/lib/shuttle/regularRosterEdit.ts", "utf8");
const route = readFileSync("src/app/api/admin/shuttle/regular-roster/route.ts", "utf8");
const client = readFileSync("src/app/admin/shuttle/regular/RegularShuttleClient.tsx", "utf8");

/** 함수 본문(다음 export 전까지) */
function body(src, name) {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} 가 있어야 한다`);
  const next = src.indexOf("\nexport ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

test("수강 점검 조회·확인 기록은 명단 행을 지우거나 고치지 않는다", () => {
  for (const name of ["getRosterEnrollmentCheck", "markRosterMonthReviewed"]) {
    const fn = body(edit, name);
    assert.match(fn, /requireAdmin\(\)/, `${name} 는 원장 전용`);
    assert.doesNotMatch(fn, /DELETE\s+FROM|UPDATE\s+"RegularShuttleStop"|INSERT\s+INTO\s+"RegularShuttleStop"/i, `${name} 는 명단을 바꾸지 않는다`);
  }
  // 확인 기록은 변경 기록 표(ShuttleAuditLog)에만 남긴다
  assert.match(body(edit, "markRosterMonthReviewed"), /REGULAR_ROSTER_MONTH_REVIEWED/);
});

test("API 가 점검 조회와 확인 기록을 연결하고, 화면은 월 복사 전에 경고를 보여 준다", () => {
  assert.match(route, /enrollmentCheck/);
  assert.match(route, /monthReviewed/);
  assert.match(client, /rosterCopyWarningText/);
  assert.match(client, /copyWarningFor\(sourceMonth\)/);
  assert.match(client, /자동으로 빼지 않았습니다/);
});

test("배지는 테마 토큰 색만 쓴다(하드코딩 색 금지)", () => {
  const start = client.indexOf("function EnrollmentFlagBadges");
  const fn = client.slice(start, client.indexOf("export default function", start));
  assert.match(fn, /--color-academy-danger/);
  assert.doesNotMatch(fn, /#[0-9a-f]{3,6}\b|bg-(red|amber|yellow|gray)-/i);
});
