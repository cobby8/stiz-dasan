import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/app/actions/staff-sessions.ts", import.meta.url), "utf8");

test("수업 종료 저장 뒤 학부모 알림 실패를 성공 응답과 분리한다", () => {
  // SQL 이 여러 줄로 늘어나도 깨지지 않게 위치만 찾는다(리포트 발행이 같은 UPDATE 에 합쳐졌다).
  const updateIndex = source.search(/UPDATE "Session"\s+SET status = 'COMPLETED'/);
  const notificationIndex = source.indexOf("getSessionParentRecipients(session)", updateIndex);

  assert.ok(updateIndex >= 0, "수업 종료 DB 갱신이 있어야 합니다.");
  assert.ok(notificationIndex > updateIndex, "학부모 알림은 종료 저장 뒤에 처리해야 합니다.");
  assert.match(source.slice(notificationIndex), /Promise\.allSettled/);
  assert.match(source.slice(notificationIndex), /ok: true as const/);
  // 2026-11-13 G9: 알림은 응답 뒤(after)에 끝까지 돌린다 — 3.5초만 기다리고 끊기던 예산 방식은 없앤다.
  const afterIndex = source.indexOf('runAfterResponse("completeClassSession"', updateIndex);
  assert.ok(afterIndex > updateIndex && afterIndex < notificationIndex, "알림 조회·발송이 after 안에 있어야 합니다.");
  assert.doesNotMatch(source, /NOTIFY_BUDGET_MS|Promise\.race/);
  assert.match(source, /import \{ after \} from "next\/server"/);
  // after 안의 실패는 잡아서 기록만 한다(이미 끝난 수업을 실패로 되돌리지 않는다).
  const helper = source.slice(source.indexOf("function runAfterResponse"));
  assert.match(helper.slice(0, helper.indexOf("\n}\n")), /after\(async \(\) => \{[\s\S]*?catch \(error\)/);
  // b6: 지난 날짜 수업 종료면 학부모 «수업 종료» 알림을 보내지 않는다.
  assert.match(source.slice(updateIndex, afterIndex), /if \(shouldNotifyParentsForSession\(String\(session\.date\)\.slice\(0, 10\)\)\) \{/);
});

test("출석 알림도 응답 뒤에 보내고, 지난 날짜 수업이면 보내지 않는다", () => {
  const fn = source.slice(source.indexOf("export async function saveStaffAttendance"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /shouldNotifyParentsForSession\(sessionYmd\)\) \{[\s\S]*?runAfterResponse\("saveStaffAttendance"/);
  // 알림 발송을 기다리는 곳은 after 안쪽 한 곳뿐(응답 전에는 기다리지 않는다)
  assert.equal((body.match(/await deliverParentNotification/g) ?? []).length, 1);
  assert.ok(body.indexOf("await deliverParentNotification") > body.indexOf('runAfterResponse("saveStaffAttendance"'));
  const seat = source.slice(source.indexOf("async function saveSeasonalSeatAttendance"));
  assert.match(seat.slice(0, seat.indexOf("\n}\n")), /shouldNotifyParentsForSession\(sessionYmd\)\) \{[\s\S]*?runAfterResponse\("saveSeasonalSeatAttendance"/);
});

test("전체 출석 요청(bulk)은 결석 신고 아이를 저장 전에 건너뛴다(개별 출석은 그대로 받는다)", () => {
  const fn = source.slice(source.indexOf("export async function saveStaffAttendance"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const skipAt = body.indexOf("if (input.bulk && input.status === \"PRESENT\" && !isMakeup)");
  const insertAt = body.indexOf('INSERT INTO "Attendance"');
  assert.ok(skipAt > 0 && skipAt < insertAt, "건너뛰기 판정은 출결 저장보다 먼저");
  assert.match(body.slice(skipAt, insertAt), /"RegularAbsence"[\s\S]*?status IN \('REPORTED','CONFIRMED'\)/);
  assert.match(body.slice(skipAt, insertAt), /skipped: true as const, message: BULK_SKIPPED_MESSAGE/);
});

test("정규 수업 시작·미리 작성은 오늘(KST)이 아니면 거절하고, 권한 실패는 결과로 돌려준다", () => {
  const start = source.slice(source.indexOf("export async function startClassSession"));
  assert.match(start, /if \(!input\.sessionDateId\?\.trim\(\) && date !== todayKst\(\)\) \{\s*return \{ ok: false, code: "STALE_DATE", message: STALE_DATE_MESSAGE \};/);
  const plan = source.slice(source.indexOf("export async function savePlannedClassContent"));
  assert.match(plan.slice(0, plan.indexOf("\n}\n")), /input\.date !== todayKst\(\)[\s\S]*?STALE_DATE_MESSAGE/);
  // 진행 중 수업 안내에 반 이름·날짜(b6)
  assert.match(start, /message: activeSessionNotice\(active\[0\]\.className, active\[0\]\.date\)/);
  // 출석·메모·종료·시작 취소는 권한 실패를 던지지 않는다(b5)
  for (const name of ["saveSessionMemo", "saveStaffAttendance", "completeClassSession", "cancelClassSession"]) {
    const fn = source.slice(source.indexOf(`export async function ${name}`));
    assert.match(fn.slice(0, 600), /const gate = await trySessionAccess\(input\.sessionId\);\s*if \(!gate\.ok\) return gate;/, name);
  }
});

test("이미 종료된 수업은 재시도해도 성공으로 응답한다", () => {
  assert.match(
    source,
    /session\.status === "COMPLETED"[\s\S]*?ok: true as const,[\s\S]*?resumed: true/,
  );
});
