import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 출시 전 수정(2026-11-13 원장 지시) — 선생님 출석부 f1 체험 아이 · f2 결석 학부모 알림 · f3 금액 숨김.
const rules = await loadTsModule("src/lib/staff-session-rules.ts");
const notice = await loadTsModule("src/lib/regular/absence-parent-notice.ts");
const read = (path) => readFileSync(path, "utf8");

/** 파일에서 함수 하나의 본문(다음 최상위 선언 전까지)만 잘라 본다. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾지 못함`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function |\nexport const |\ntype /);
  return next < 0 ? rest : rest.slice(0, next);
}

// ── f1 체험 아이 ─────────────────────────────────────────

test("f1 체험 출석부 키는 «trial:» 로 구분되고 정규·좌석 키와 섞이지 않는다", () => {
  assert.equal(rules.trialRosterKey("lead-1"), "trial:lead-1");
  assert.equal(rules.parseTrialRosterKey("trial:lead-1"), "lead-1");
  assert.equal(rules.parseTrialRosterKey("student-1"), null);
  assert.equal(rules.parseTrialRosterKey("trial:"), null);
  assert.equal(rules.parseTrialRosterKey(null), null);
  assert.equal(rules.parseTrialRosterKey(`trial:${"x".repeat(129)}`), null);
});

test("f1 출석·지각은 «일정 확정»을 «체험 완료»로 올리고, 선생님이 올린 것만 결석 때 되돌린다", () => {
  const next = (currentStatus, previousMark, nextMark) => rules.trialLeadStatusAfterStaffMark({ currentStatus, previousMark, nextMark });
  assert.equal(next("SCHEDULED", null, "PRESENT"), "ATTENDED");
  assert.equal(next("SCHEDULED", null, "LATE"), "ATTENDED");
  assert.equal(next("ATTENDED", "PRESENT", "LATE"), "ATTENDED");
  assert.equal(next("SCHEDULED", null, "ABSENT"), "SCHEDULED");
  // 선생님이 출석으로 올렸다가 결석으로 고침 → 되돌린다
  assert.equal(next("ATTENDED", "PRESENT", "ABSENT"), "SCHEDULED");
  // 관리자가 직접 «체험 완료»로 둔 것(선생님 표시 없음)은 결석을 찍어도 건드리지 않는다
  assert.equal(next("ATTENDED", null, "ABSENT"), "ATTENDED");
  // 다른 단계(등록 완료 등)는 손대지 않는다
  assert.equal(next("CONVERTED", null, "PRESENT"), "CONVERTED");
  assert.equal(next("CONVERTED", "PRESENT", "ABSENT"), "CONVERTED");
});

test("f1 체험 출결 저장은 정규 출석 표·보강권·학부모 출석 알림을 타지 않는다", () => {
  const source = read("src/app/actions/staff-sessions.ts");
  const body = functionBody(source, "saveTrialAttendance");
  assert.doesNotMatch(body, /"Attendance"/);
  assert.doesNotMatch(body, /syncCredit|deliverParentNotification|applyAttendanceAbsenceReason/);
  assert.match(body, /UPDATE "TrialLead"/);
  // 명단 조회와 같은 조건으로 이 반·이 날 체험 아이인지 다시 확인한다
  assert.match(body, /trialOnClassDateSql\("tl"/);
  // 정규 저장보다 먼저 체험 키를 가른다
  const save = functionBody(source, "saveStaffAttendance");
  assert.ok(save.indexOf("parseTrialRosterKey") >= 0 && save.indexOf("parseTrialRosterKey") < save.indexOf('INSERT INTO "Attendance"'));
});

test("f1 체험 명단은 이름·학년·출결만 고르고 학부모 연락처는 내려보내지 않는다", () => {
  const source = read("src/lib/staff-session-queries.ts");
  const body = functionBody(source, "getTrialRosterRows");
  assert.match(body, /tl\."childName", tl\."childGrade"/);
  assert.doesNotMatch(body, /parentPhone|parentName|memo|hopeNote|trialFee/);
  assert.match(source, /trial: true,/);
  // 조회 실패(마이그레이션 전)여도 정규 출석부는 열린다
  assert.match(body, /catch \(error\)[\s\S]*return \[\];/);
  // scheduledDate 는 timestamptz → KST 변환은 한 번만
  assert.match(source, /\."scheduledDate" AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.doesNotMatch(source, /"scheduledDate" AT TIME ZONE 'UTC'/);
});

test("f1 체험 아이는 수강료 조회 대상이 아니다(특강 좌석으로 오인 금지)", () => {
  const source = read("src/lib/staff-monthly-fees.ts");
  assert.match(source, /roster\.filter\(s => !s\.makeup && !s\.trial\)/);
});

test("f1 마이그레이션 CHECK 값은 출결 상태 3개와 같고 schema 사본에도 칸이 있다", () => {
  const sql = read("prisma/migrations/20261113200000_trial_lead_staff_attendance/migration.sql");
  assert.match(sql, /"staffAttendanceStatus" IN \('PRESENT', 'LATE', 'ABSENT'\)/);
  assert.match(sql, /되돌림:/);
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /staffAttendanceStatus\s+String\?/);
  assert.match(schema, /staffAttendanceAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
});

// ── f2 결석 학부모 알림 ─────────────────────────────────────

test("f2 결석 알림 문구는 짧고 정중하며, 같은 아이·날·반·학부모는 한 번만", () => {
  assert.equal(
    notice.absenceNoticeMessage("월4 초등반", "김하늘"),
    "오늘 월4 초등반 수업에 김하늘 학생이 결석으로 확인되었습니다. 사정이 있으시면 학원으로 알려 주세요.",
  );
  assert.equal(notice.absenceNoticeTitle("월4 초등반"), "월4 초등반 결석 안내");
  const key = notice.absenceNoticeDedupeKey({ classId: "c1", dateYmd: "2026-11-13", studentId: "s1", userId: "u1" });
  assert.equal(key, "absence:c1:2026-11-13:student:s1:user:u1");
  assert.ok(notice.ABSENCE_NOTICE_DELAY_MINUTES >= 2 && notice.ABSENCE_NOTICE_DELAY_MINUTES <= 10);
});

test("f2 결석 알림은 매분 크론에서 «몇 분 뒤에도 결석»인 정규 수강생만 고른다", () => {
  const sweep = read("src/lib/regular/absence-parent-notice-sweep.ts");
  assert.match(sweep, /a\.status = 'ABSENT'/);
  // 몇 분 뒤에도 결석일 때만 — 시간대 없는 updatedAt 은 UTC 로 붙여 비교
  assert.match(sweep, /\(a\."updatedAt" AT TIME ZONE 'UTC'\) <= NOW\(\) - make_interval\(mins => \$2::int\)/);
  // 오늘(KST) 수업만 — 날짜는 공용 모듈
  assert.match(sweep, /todayKst\(nowMs\)/);
  // 정규 수업·정규 수강생만(특강·보강 제외)
  assert.match(sweep, /"specialProgramSessionDateId" IS NULL/);
  assert.match(sweep, /e\.status = 'ACTIVE'/);
  // 학부모 신고·기간 결석이 있으면 보내지 않음
  assert.match(sweep, /NOT EXISTS \(SELECT 1 FROM "RegularAbsence" ra[\s\S]*ra\.status IN \('REPORTED','CONFIRMED'\)/);
  // 기존 앱 알림함+웹푸시 경로만(유료 문자 금지)
  assert.match(sweep, /deliverParentNotification\(/);
  assert.doesNotMatch(sweep, /sms|Sms|SMS|alimtalk/);
  assert.match(sweep, /absenceNoticeDedupeKey\(/);

  const cron = read("src/app/api/cron/push-outbox/route.ts");
  assert.match(cron, /sweepAbsenceParentNotices\(/);
  // 결석 알림이 실패해도 밀린 푸시 처리는 계속한다
  assert.ok(cron.indexOf("sweepAbsenceParentNotices(") < cron.indexOf("processPushOutbox(50)"));
  assert.match(cron, /catch \(error\)/);
});

test("f2 출결 저장은 결석 알림을 즉시 보내지 않는다(잘못 누름 대비 — 크론이 보낸다)", () => {
  const source = read("src/app/actions/staff-sessions.ts");
  assert.doesNotMatch(source, /ATTENDANCE_ABSENT/);
});

// ── f3 금액 숨김 ───────────────────────────────────────────

test("f3 수강료·미납은 원장·부원장만 — 선생님은 서버 응답에서도 빠진다", () => {
  assert.equal(rules.canSeeStaffFees("ADMIN"), true);
  assert.equal(rules.canSeeStaffFees("VICE_ADMIN"), true);
  assert.equal(rules.canSeeStaffFees("INSTRUCTOR"), false);
  assert.equal(rules.canSeeStaffFees("DRIVER"), false);
  assert.equal(rules.canSeeStaffFees(null), false);

  const fees = read("src/lib/staff-monthly-fees.ts");
  const monthly = functionBody(fees, "getStaffSessionMonthlyFees");
  assert.ok(monthly.indexOf("canViewFees()") >= 0 && monthly.indexOf("canViewFees()") < monthly.indexOf("readContext("));
  assert.match(monthly, /items: \[\]/);
  const billing = functionBody(fees, "getStaffAttendanceBilling");
  assert.ok(billing.indexOf("canViewFees()") >= 0 && billing.indexOf("canViewFees()") < billing.indexOf("readContext("));
});

test("f3 선생님 출석부 화면은 수강료 줄을 숨기고 조회도 하지 않는다", () => {
  const page = read("src/app/staff/sessions/[sessionId]/page.tsx");
  assert.match(page, /showFees=\{canSeeStaffFees\(access\.staff\.appUserRole\)\}/);
  const client = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  assert.match(client, /if \(!showFees\) return;\s*let active = true;/);
  assert.match(client, /\{showFees && !student\.makeup && !student\.trial && <button/);
  assert.match(client, /\{showFees && <div aria-live="polite"/);
});
