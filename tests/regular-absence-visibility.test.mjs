import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 결석 사전 신고는 셔틀 명단에서는 자동으로 빠지는데, **사람에게는 아무 신호가 없었다.**
// 원장은 /admin/absence 를 직접 열어봐야 알고, 선생님은 모른 채 출석을 찍었다.

const parentAbsence = await readFile("src/lib/regular/parent-regular-absence.ts", "utf8");
const staffQueries = await readFile("src/lib/staff-session-queries.ts", "utf8");
const sessionClient = await readFile("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", "utf8");

test("신고와 취소 모두 원장에게 알린다", () => {
  // 취소를 안 알리면 원장이 결석으로 알고 준비한 채로 남는다.
  assert.match(parentAbsence, /kind: "REPORTED"/);
  assert.match(parentAbsence, /kind: "CANCELED"/);
  assert.match(parentAbsence, /notifyOperationalStaff\(\{/);
  assert.match(parentAbsence, /driverContext: \{ studentId: input\.studentId, serviceDate: input\.date \}/);
  assert.match(parentAbsence, /"\/admin\/absence"/);
});

test("알림이 실패해도 신고 자체는 되돌리지 않는다", () => {
  // 학부모는 이미 신고를 마쳤다. 알림 장애로 신고가 사라지면 안 된다.
  assert.match(parentAbsence, /async function notifyAdminsOfAbsenceChange[\s\S]{0,1400}catch \(error\)[\s\S]{0,120}console\.error/);
});

test("취소 알림 근거를 보존하면서 이름과 원본 ID를 확보한다", () => {
  assert.match(parentAbsence, /SET status = 'CANCELLED'/);
  assert.match(parentAbsence, /RETURNING s\.name AS "studentName", c\.name AS "className"/);
  assert.match(parentAbsence, /ra\.id/);
  assert.match(parentAbsence, /canceled\.length === 0/);
});

test("담당 코치와 확정 배차 기사에게 내부 알림을 연결한다", () => {
  // 외부 SMS가 아니라 계정 기반 인앱·웹푸시 전달망이다.
  assert.match(parentAbsence, /includeCoach: true/);
  assert.match(parentAbsence, /includeDriver: true/);
});

test("선생님 출석 명단이 사전 신고를 함께 읽는다", () => {
  assert.match(staffQueries, /LEFT JOIN "RegularAbsence" ra/);
  // 취소(삭제)된 건은 안 나오고, 신고·확정만 보여야 한다.
  assert.match(staffQueries, /ra\.status IN \('REPORTED','CONFIRMED'\)/);
  // 날짜가 안 맞으면 다른 날 결석이 오늘 명단에 뜬다.
  assert.match(staffQueries, /ra\.date = \$3::date/);
});

test("방학특강 명단은 정규 결석 신고를 끌어다 쓰지 않는다", () => {
  // 방학특강은 좌석 기준의 별도 흐름이라 섞으면 잘못된 표시가 난다.
  assert.match(staffQueries, /absenceReport: null/);
});

test("출석 화면에 사전 신고가 보인다", () => {
  assert.match(sessionClient, /student\.absenceReport && \(/);
  assert.match(sessionClient, /학부모 결석 알림/);
  // 사유 표기는 학부모 화면과 같은 표를 쓴다.
  assert.match(sessionClient, /REASON_LABEL as ABSENCE_REASON_LABEL/);
});
