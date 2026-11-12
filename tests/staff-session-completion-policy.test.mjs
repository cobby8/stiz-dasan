import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("전체 출석은 이미 출결이 있는 아이를 덮어쓰지 않는다(정규·특강 좌석, 동시 저장 포함 — 검수 3)", () => {
  const fn = source.slice(source.indexOf("export async function saveStaffAttendance"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /if \(input\.bulk && previous\[0\]\) \{\s*return \{ ok: true as const, skipped: true as const, message: BULK_ALREADY_RECORDED_MESSAGE \};/);
  // 확인과 저장 사이 경합: 일괄이면 ON CONFLICT 갱신을 하지 않는다 → 0행이면 건너뜀
  assert.match(body, /WHERE \$6::boolean = false\s*RETURNING id`,[\s\S]*?Boolean\(input\.bulk\),\s*\);\s*if \(!saved\[0\]\) \{\s*return \{ ok: true as const, skipped: true as const, message: BULK_ALREADY_RECORDED_MESSAGE \};/);
  const seat = source.slice(source.indexOf("async function saveSeasonalSeatAttendance"));
  const seatBody = seat.slice(0, seat.indexOf("\n}\n"));
  assert.match(seatBody, /AND \(\$6::boolean = false OR e\."attendanceStatus" IS NULL\)/);
  assert.match(seatBody, /skipped: true as const, message: BULK_ALREADY_RECORDED_MESSAGE/);
  assert.match(body, /bulk: input\.bulk,/);
});

test("특강 좌석은 저장됐는데 정규 출석 기록이 실패하면 그 결과를 화면에 돌려준다(검수 2)", () => {
  const seat = source.slice(source.indexOf("async function saveSeasonalSeatAttendance"));
  const seatBody = seat.slice(0, seat.indexOf("\n}\n"));
  assert.match(seatBody, /console\.error\("\[saveSeasonalSeatAttendance\] 정규 Attendance 기록 실패/);
  assert.match(seatBody, /recordWarning: SEAT_RECORD_WARNING_MESSAGE/);
});

test("H1 원장·부원장이 특강을 미리 작성·시작해도 기록의 coachId 는 회차 담당 강사로 채운다", () => {
  // 특강 권한·목록은 «기록이 있으면 기록의 coachId, 없으면 상품 instructorId» 로 본다.
  const access = readFileSync("src/lib/staff-class-access.ts", "utf8");
  assert.match(access, /matched_s\."coachId" = \$3 OR \(matched_s\.id IS NULL AND matched_o\."instructorId" = \$3\)/);
  const list = readFileSync("src/lib/staff-session-queries.ts", "utf8");
  assert.match(list, /access_s\."coachId" = \$3 OR \(access_s\.id IS NULL AND access_o\."instructorId" = \$3\)/);
  // → 원장이 만든 기록의 coachId 가 NULL 이면 담당 강사가 못 본다. 두 INSERT 모두 회차 담당 강사로 채워야 한다.
  const helper = source.slice(source.indexOf("function seasonalInstructorSql"));
  assert.match(helper.slice(0, helper.indexOf("\n}\n")), /SELECT o\."instructorId" FROM "SpecialProgramSessionDate" sd[\s\S]*?JOIN "SpecialProgramOffering" o ON o\.id = sd\."offeringId"[\s\S]*?WHERE sd\.id = \$\{sessionDateParam\}/);
  const plan = source.slice(source.indexOf("export async function savePlannedClassContent"));
  assert.match(plan.slice(0, plan.indexOf("\n}\n")), /'PLANNED', \$4, COALESCE\(\$5::text, \$\{seasonalInstructorSql\("\$6::text"\)\}\), \$6,/);
  const start = source.slice(source.indexOf("export async function startClassSession"));
  assert.match(start, /'IN_PROGRESS',\s*COALESCE\(\$4::text, \$\{seasonalInstructorSql\("\$6::text"\)\}\),\s*NOW\(\), \$5, \$6,/);
});

test("H1 모델: 원장 미리 작성 뒤에도 담당 강사 접근·목록이 유지된다", () => {
  // SQL 판정식을 그대로 옮긴 모델 — 기록 coachId 우선, 기록이 없을 때만 상품 instructorId.
  const canSee = (coachId, offering, sessionRow) => (sessionRow ? sessionRow.coachId === coachId : offering.instructorId === coachId);
  const offering = { instructorId: "coach-kim" };
  const fill = (accessCoachId) => accessCoachId ?? offering.instructorId; // COALESCE(access.coachId, instructorId)
  // 고치기 전: 원장(coachId NULL)이 미리 작성하면 기록 coachId=NULL → 담당 강사가 못 봄
  assert.equal(canSee("coach-kim", offering, { coachId: null }), false);
  // 고친 뒤: 회차 담당 강사로 채워져 계속 보인다
  assert.equal(canSee("coach-kim", offering, { coachId: fill(null) }), true);
  // 담당 강사 본인이 쓰면 그대로 본인
  assert.equal(fill("coach-kim"), "coach-kim");
  // 다른 강사는 여전히 못 본다
  assert.equal(canSee("coach-lee", offering, { coachId: fill(null) }), false);
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
