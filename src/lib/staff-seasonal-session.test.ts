import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const querySource = readFileSync(new URL("./staff-session-queries.ts", import.meta.url), "utf8");
const accessSource = readFileSync(new URL("./staff-class-access.ts", import.meta.url), "utf8");
const actionSource = readFileSync(new URL("../app/actions/staff-sessions.ts", import.meta.url), "utf8");
const staffPeopleSource = readFileSync(new URL("./staff-class-people.ts", import.meta.url), "utf8");
const enrollmentDatesSource = readFileSync(new URL("./seasonal/enrollment-dates.ts", import.meta.url), "utf8");
const staffHomeSource = readFileSync(new URL("../app/staff/StaffHomeClient.tsx", import.meta.url), "utf8");

test("방학특강 회차는 실제 세션 담당 교사 또는 기본 담당자만 접근한다", () => {
  assert.match(accessSource, /matched_s\."coachId" = \$3/);
  assert.match(accessSource, /matched_o\."instructorId" = \$3/);
  assert.match(querySource, /access_s\."coachId" = \$3/);
  assert.match(querySource, /access_o\."instructorId" = \$3/);
  assert.match(querySource, /access\.coachId/);
  assert.match(querySource, /AT TIME ZONE 'Asia\/Seoul'/);
});

// 2026-07-27 명단 기준을 「전환된 학생」에서 「좌석(SpecialProgramEnrollmentDate)」으로 바꿨다(21032a64).
// 미전환 신청자도 실제 수강생이라 빠지면 안 되고, 취소된 좌석은 빠져야 한다.
test("방학특강 출석 명단은 승인된 신청의 살아있는 좌석으로 제한한다", () => {
  assert.match(querySource, /i\.status = 'APPROVED'/);
  assert.match(querySource, /JOIN "SpecialProgramEnrollmentDate" e\s+ON e\."applicationItemId" = i\.id AND e\."sessionDateId" = sd\.id AND e\.status = 'SCHEDULED'/);
  assert.doesNotMatch(querySource.slice(querySource.indexOf("if (sessionDateId)"), querySource.indexOf("sessionDateId,", querySource.indexOf("WHERE anchor_sd.id = $1"))), /conversionStatus/, "전환 여부로 거르면 미전환 수강생이 명단에서 빠진다");
  assert.match(actionSource, /isSessionRosterStudent/);
  assert.match(actionSource, /getSessionParentRecipients/);
});

test("방학특강 출석 명단은 신청 요일과 실제 회차 요일을 맞춘다", () => {
  // 명단(querySource)은 좌석 기준이라 요일을 다시 거르지 않는다 — 좌석이 생길 때 요일을 맞춘다.
  assert.match(enrollmentDatesSource, /selectedWeekdays/);
  assert.match(enrollmentDatesSource, /NO_MATCHED_DATES/);
  assert.match(actionSource, /selectedWeekdays/);
  assert.match(actionSource, /EXTRACT\(ISODOW FROM sd\."startsAt" AT TIME ZONE 'Asia\/Seoul'\)::int/);
});

test("정규 수업과 같은 날짜의 방학특강 세션은 서로 분리한다", () => {
  assert.match(querySource, /s\."specialProgramSessionDateId" IS NULL/);
  assert.match(querySource, /CASE WHEN sd\.id IS NOT NULL[\s\S]*app\."convertedStudentId"/);
});

test("방학특강 시작은 회차 기반 세션키와 서버 날짜 검증을 사용한다", () => {
  assert.match(actionSource, /sessionDateId\?: string/);
  assert.match(actionSource, /`seasonal:\$\{sessionDateId\}`/);
  assert.match(actionSource, /AT TIME ZONE 'Asia\/Seoul'/);
  assert.match(actionSource, /specialProgramSessionDateId/);
});

test("선생님 수업 관리 명단은 방학특강 회차 ID를 넘겨 해당 요일 학생만 조회한다", () => {
  assert.match(staffPeopleSource, /requireStaffSeasonalSessionAccess/);
  assert.match(staffPeopleSource, /resolveSessionDateId/);
  assert.match(staffPeopleSource, /anchor_sd\.id = \$1/);
  // 요일은 좌석이 맞춘다 — 학생정보 명단도 출석부와 같은 좌석(SCHEDULED) 기준.
  assert.match(staffPeopleSource, /JOIN "SpecialProgramEnrollmentDate" seat\s+ON seat\."applicationItemId" = item\.id AND seat\."sessionDateId" = sd\.id AND seat\.status = 'SCHEDULED'/);
  assert.match(staffHomeSource, /sessionDateId=\{peopleTarget\.sessionDateId\}/);
});
