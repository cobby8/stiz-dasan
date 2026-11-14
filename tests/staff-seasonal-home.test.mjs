import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const homeSource = readFileSync("src/app/staff/StaffHomeClient.tsx", "utf8");

test("강사 홈은 정규 수업과 방학특강을 고유 일정키로 구분한다", () => {
  assert.match(homeSource, /lesson\.kind === "SEASONAL"/);
  assert.match(homeSource, /key=\{lesson\.scheduleKey\}/);
  assert.match(homeSource, /lesson\.scheduleKey !== focusClass\?\.scheduleKey/);
});

test("방학특강 수업 시작 요청은 회차 식별자를 함께 보낸다", () => {
  assert.match(homeSource, /startTarget\.sessionDateId/);
  assert.match(homeSource, /\{ sessionDateId: startTarget\.sessionDateId \}/);
  assert.match(homeSource, /startClassSession\(\{/);
});

test("방학특강 학생 정보 패널은 회차 식별자를 함께 보낸다", () => {
  // 2026-11-15 선생님 수업 화면 한 화면 구조: 학생 정보 시트가 수업 줄 안의 출석부 칸으로 옮겨졌다 —
  // 홈이 회차를 수업 본문에 넘기고, 본문이 수업 기록 id 와 회차를 함께 학생 정보 조회에 보낸다(약속은 그대로).
  assert.match(homeSource, /sessionId: lesson\.sessionId,[\s\S]{0,120}sessionDateId: lesson\.sessionDateId,/);
  const panels = readFileSync("src/components/staff/LessonWorkspacePanels.tsx", "utf8");
  assert.match(panels, /useClassPeople\(\{ classId: lesson\.classId, sessionId: lesson\.sessionId, sessionDateId: lesson\.sessionDateId,/);
  const info = readFileSync("src/components/staff/RosterPersonInfo.tsx", "utf8");
  assert.match(info, /loadStaffClassPeople\(\{ classId, sessionId, sessionDateId \}\)/);
});
