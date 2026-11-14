import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 운영 실측(2026-08-09): 세션 100회차 동안 리포트 발행 0건, 수업 내용 0건.
// 원인은 발행 버튼이 아니라 **권한 위치**였다. saveSessionReport·publishSessionReport 가
// 둘 다 requireAdmin() 이라, 선생님이 수업을 마쳐도 원장이 PC 에서 다시 써야 나갔다.
// → 선생님이 종료하면서 같이 끝내게 한다.

const action = await readFile("src/app/actions/staff-sessions.ts", "utf8");
const client = await readFile("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", "utf8");

test("수업 종료와 리포트 발행이 한 번의 UPDATE 로 끝난다", () => {
  // 두 번에 나누면 종료는 됐는데 발행만 실패하는 반쪽 상태가 생긴다.
  assert.match(action, /UPDATE "Session"[\s\S]{0,400}status = 'COMPLETED'[\s\S]{0,400}published = CASE WHEN \$4/);
  assert.match(action, /"publishedAt" = CASE WHEN \$4 AND NOT published THEN NOW\(\)/);
});

test("종료 창이 보낸 한 줄을 그대로 반영한다(지우고 종료하면 지움), 값을 안 보낸 옛 화면만 기존 내용 유지", () => {
  // 2026-11-14 검수: 종료 창은 이미 저장된 한 줄로 채워져 열린다 — 사용자가 지운 것은 지운 것이다.
  assert.match(action, /content = CASE WHEN \$5 THEN \$3 ELSE content END/);
  assert.match(action, /const reportProvided = input\.report !== undefined;/);
  assert.match(action, /input\.sessionId, access\.staff\.appUserId, report, publish, reportProvided,/);
  assert.match(action, /\(input\.report \?\? ""\)\.trim\(\)\.slice\(0, 2000\) \|\| null/);
  assert.doesNotMatch(action, /content = COALESCE\(\$3, content\)/);
});

test("발행 여부는 화면이 정하고, 값이 없으면 발행한다", () => {
  // 기본을 끄면 지금처럼 아무도 발행하지 않아 학부모 화면이 계속 빈다.
  assert.match(action, /input\.publishReport !== false/);
  assert.match(client, /useState\(true\)/);
  assert.match(client, /completeClassSession\(\{[\s\S]{0,120}report,[\s\S]{0,60}publishReport,/);
});

test("수업 종료 알림이 실제로 있는 화면을 가리킨다", () => {
  // 예전 값 "/parent/sessions" 는 없는 주소라 알림을 눌러도 404 였다.
  assert.match(action, /linkUrl: `\/mypage\/reports\/\$\{input\.sessionId\}`/);
  // 주석에는 옛 값이 이유와 함께 남아 있으므로 실제 사용처만 본다.
  assert.doesNotMatch(action, /linkUrl: "\/parent\/sessions"/);
});

test("출결을 다 확인해야 리포트 칸이 열린다", () => {
  // 미확인이 남았으면 종료 자체가 막히므로, 그 상태에서 리포트를 쓰게 하면 헛수고가 된다.
  assert.match(client, /counts\.UNCHECKED === 0 && \(\s*<div className="mt-4" data-end-report>[\s\S]{0,400}session-report/);
});
