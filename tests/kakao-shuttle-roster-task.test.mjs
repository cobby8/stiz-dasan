// 카카오 «정규 셔틀 신청» → 원장 할 일 «셔틀 명단에 넣어 주세요» — 연결과 안전 조건을 소스로 못박는다.
// 판정·문구 규칙은 src/lib/kakaoShuttleRosterTask.test.ts 가 실제 실행으로 검사한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(p, "utf8");
const action = read("src/app/actions/kakao-shuttle-roster-task.ts");
const query = read("src/lib/kakao-shuttle-roster-task-query.ts");
const panel = read("src/app/admin/shuttle/regular/KakaoShuttleRosterTasks.tsx");
const page = read("src/app/admin/shuttle/regular/page.tsx");
const inbox = read("src/app/admin/kakao-requests/KakaoRequestsClient.tsx");
const flow = read("src/lib/kakao-shuttle-flow.ts");

test("완료 표시는 원장 전용이고, 읽은 상태 그대로일 때만 바꾸며, 이력을 남긴다", () => {
  assert.match(action, /^"use server";/);
  assert.match(action, /await requireAdmin\(\)/);
  assert.match(action, /WHERE id=\$1 AND status=\$5 AND \("structuredJson"->'rosterTask'->>'doneAt'\) IS NULL/);
  assert.match(action, /'SHUTTLE_ROSTER_DONE'/);
  assert.match(action, /\$executeRawUnsafe/);
});

test("완료 표시는 명단을 바꾸지 않고 학부모에게 아무것도 보내지 않는다", () => {
  for (const src of [action, query, panel]) {
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM)\s+"RegularShuttleStop"/);
    assert.doesNotMatch(src, /@\/lib\/notification|sendSms|sendKakao|CustomerNoticeSender|customer-notice/);
  }
});

test("할 일이 셔틀 명단 화면 맨 위와 카카오 접수함 패널에 같은 판정으로 뜬다", () => {
  assert.match(page, /getOpenKakaoShuttleRosterTasks\(\)/);
  assert.match(page, /<KakaoShuttleRosterTasks tasks=\{rosterTasks\} \/>/);
  assert.match(panel, /셔틀 명단에 넣어 주세요/);
  assert.match(inbox, /isShuttleRosterTask\(row\)/);
  assert.match(inbox, /completeKakaoShuttleRosterTask/);
  assert.match(query, /isShuttleRosterTask/);
});

test("새 정규 셔틀 신청 알림은 그 달 셔틀 명단으로 바로 간다", () => {
  assert.match(flow, /state\.action === "START" \? \{ linkUrl: shuttleRosterTaskHref\(studentId, structured\) \}/);
});

test("병합으로 흡수된 접수 학생은 병합 후 학생 기준으로 명단을 판정·연결하고, 못 찾으면 «명단에 넣기»를 숨긴다", () => {
  // 명단 대상 학생 = 살아 있는 접수 학생 또는 (흡수됐으면) 살아 있는 병합 후 학생
  assert.match(query, /COALESCE\(s\.id, m\.id\) AS "rosterStudentId"/);
  assert.match(query, /LEFT JOIN "Student" o ON o\.id=r\."studentId" AND o\."mergedIntoStudentId" IS NOT NULL/);
  assert.match(query, /LEFT JOIN "Student" m ON m\.id=o\."mergedIntoStudentId" AND m\."mergedIntoStudentId" IS NULL/);
  // 명단 존재 판정·주소 모두 병합 후 학생 id 로
  assert.match(query, /x\."studentId"=t\."rosterStudentId"/);
  assert.doesNotMatch(query, /x\."studentId"=r\."studentId"/);
  assert.match(query, /href: r\.rosterStudentId \? shuttleRosterTaskHref\(String\(r\.rosterStudentId\), r\.structuredJson\) : null/);
  // 주소가 없으면 버튼 대신 안내
  assert.match(panel, /\{task\.href\s*\?\s*<Link href=\{task\.href\}/);
  assert.match(panel, /학생 확인 필요/);
});
