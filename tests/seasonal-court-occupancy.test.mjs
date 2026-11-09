import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 출석부 "정원" 표시가 승인 검사(ensureSpecialProgramOperationalCapacity)와 같은 기준을 쓰는지 지킨다.
const attendance = readFileSync("src/lib/seasonal/attendance.ts", "utf8");
const client = readFileSync("src/app/admin/seasonal/attendance/SeasonalAttendanceClient.tsx", "utf8");
const seasonalRoute = readFileSync("src/app/api/admin/seasonal/route.ts", "utf8");

const occupancyQuery = attendance.slice(
  attendance.indexOf("export async function getCourtOccupancyByWeekday"),
  attendance.indexOf("// 1) 화면 부트스트랩"),
);

test("코트 점유 집계는 승인 검사와 같은 범위(형제 반 그룹)를 쓴다", () => {
  // linkedClassId가 있으면 같은 시즌 형제 반 전체, 없으면 이 반만 — route.ts scopeWhere와 동일
  assert.match(occupancyQuery, /t\."linkedClassId" IS NULL THEN o\.id = t\.id/);
  assert.match(occupancyQuery, /o\."seasonId" = t\."seasonId" AND o\."linkedClassId" = t\."linkedClassId"/);
});

test("코트 점유 집계는 승인 검사와 같은 대상·요일 조건을 쓴다", () => {
  assert.match(occupancyQuery, /item\.status = 'APPROVED'/);
  assert.match(occupancyQuery, /COUNT\(DISTINCT seat\.item_id\)/);
  // 요일 미선택은 전 요일 등원으로 간주 — route.ts와 같은 표현
  assert.match(occupancyQuery, /COALESCE\(cardinality\(seat\.weekdays\), 0\) = 0 OR wd\.day_key = ANY\(seat\.weekdays\)/);
  assert.match(seasonalRoute, /COALESCE\(cardinality\(app\."selectedWeekdays"\), 0\) = 0/);
});

test("요일별 집계는 한 번의 쿼리로 처리한다(N+1 금지)", () => {
  assert.match(occupancyQuery, /VALUES \('MON'\),\('TUE'\),\('WED'\),\('THU'\),\('FRI'\),\('SAT'\),\('SUN'\)/);
  assert.match(occupancyQuery, /GROUP BY wd\.day_key/);
  // 조회 전용이어야 한다 — 쓰기 구문이 섞이면 안 된다
  assert.doesNotMatch(occupancyQuery, /INSERT|UPDATE|DELETE|executeRawUnsafe/);
  // PgBouncer 호환을 위해 raw 쿼리를 유지한다
  assert.match(occupancyQuery, /\$queryRawUnsafe/);
});

test("보드와 명단 응답이 코트 인원·정원을 함께 내려준다", () => {
  assert.match(attendance, /courtOccupied: courtOccupancy \? \(courtOccupancy\.byWeekday\[p\.weekdayKey\] \?\? 0\) : null/);
  assert.match(attendance, /courtCapacity: courtOccupancy\?\.capacity/);
  // 기존 조회를 늘리지 않도록 병렬로 묶는다
  assert.match(attendance, /Promise\.all\(\[\s*countApprovedStudents\(/);
});

test("화면은 정원과 코트 인원을 비교하고 초과를 구분해 보여준다", () => {
  assert.match(client, /const court = courtOf\(d\);/);
  assert.match(client, /const over = court != null && court > cap;/);
  assert.match(client, /코트 전체/);
  // 초과 = 위험색 토큰(색상 6단계 — 하드코딩 빨강·dark: 대신)
  assert.match(client, /over \? "text-\[var\(--color-academy-danger\)\]"/);
  // 이 반 인원도 계속 보여야 한다 — 달력 셀에 "이 반 · 코트전체/정원" 순으로 나란히 표시한다.
  assert.match(client, /\{d\.scheduled\}<\/span>[\s\S]{0,240}\{court\}\/\{cap\}/);
  // 명단 헤더는 두 기준을 구분해 설명한다
  assert.match(client, /반 명부 \$\{rosterMeta\.totalApprovedStudents\}명\(요일 무관\)/);
  assert.match(client, /이 날 코트 전체 \{rosterMeta\.courtOccupied\}/);
});
