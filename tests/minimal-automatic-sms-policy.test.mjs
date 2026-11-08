import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("기본 seed는 중복 접수·배정 전 강사·체험 감사 문자를 끈다", () => {
  const source = read("src/lib/smsTemplate.ts");
  for (const trigger of [
    "TRIAL_NEW_COACH",
    "TRIAL_CONFIRM_PARENT",
    // TRIAL_ATTENDED_PARENT 는 2026-11-09 규칙 자체를 제거(원장 결정)
    "ENROLL_NEW_COACH",
    "ENROLL_CONFIRM_PARENT",
    "SPECIAL_APPLICATION_RECEIVED_PARENT",
    "SPECIAL_APPLICATION_APPROVED_PARENT",
  ]) {
    assert.match(source, new RegExp(`DEFAULT_DISABLED_SMS_TRIGGERS[\\s\\S]*"${trigger}"`));
  }
  assert.doesNotMatch(source, /DEFAULT_DISABLED_SMS_TRIGGERS[\s\S]*"SECURITY_PHONE_OTP"/);
});

test("특강 최초 신청 관리자 템플릿은 호출부가 사용할 변수 계약을 제공한다", () => {
  const source = read("src/lib/smsTemplate.ts");
  assert.match(source, /SPECIAL_APPLICATION_NEW_ADMIN/);
  for (const variable of [
    "childName",
    "seasonTitle",
    "offeringTitle",
    "parentName",
    "parentPhone",
  ]) {
    assert.match(source, new RegExp(`SPECIAL_APPLICATION_NEW_ADMIN[\\s\\S]*"${variable}"`));
  }
  const contract = source.match(/SPECIAL_APPLICATION_NEW_ADMIN[\s\S]*?'(\[[^']+\])'/)?.[1] ?? "";
  assert.doesNotMatch(contract, /applicationId|childGrade/);
});

test("운영 migration은 최소 정책을 명시 적용하며 OTP는 변경하지 않는다", () => {
  const migration = read("prisma/migrations/20260723235000_minimize_automatic_sms_policy/migration.sql");
  assert.match(migration, /SPECIAL_APPLICATION_NEW_ADMIN/);
  assert.match(migration, /SET "isActive" = false/);
  assert.match(migration, /TRIAL_CONFIRM_PARENT/);
  assert.match(migration, /SET "isActive" = true/);
  assert.match(migration, /TRIAL_NEW_ADMIN/);

  const statements = migration
    .split(";")
    .filter((statement) => /UPDATE public\.(?:"SmsTemplate"|"MessageAutomationRule")/.test(statement));
  assert.equal(statements.some((statement) => statement.includes("SECURITY_PHONE_OTP")), false);
});

test("수강 최초 관리자 문자는 신청 ID로 중복을 막고 발송 완료까지 기다린다", () => {
  const publicActions = read("src/app/actions/public.ts");
  assert.match(publicActions, /const enrollmentApplicationId = rows\[0\]\?\.id \|\| "ok"/);
  assert.match(
    publicActions,
    /await notifyAdmins\([\s\S]*?adminTrigger: "ENROLL_NEW_ADMIN"[\s\S]*?notifyCoaches: false[\s\S]*?eventId: enrollmentApplicationId/,
  );
  assert.match(
    publicActions,
    /adminTrigger: "TRIAL_NEW_ADMIN"[\s\S]*?notifyCoaches: false[\s\S]*?eventId: trialLeadId/,
  );
});

test("관리자 전용 알림은 코치 조회와 fallback 발송을 생략할 수 있다", () => {
  const notification = read("src/lib/notification.ts");
  assert.match(notification, /notifyCoaches\?: boolean/);
  assert.match(notification, /smsOptions\?\.notifyCoaches === false[\s\S]*?coachPhones = \[\]/);
});
