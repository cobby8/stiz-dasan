import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminShell = readFileSync(new URL("../src/app/admin/AdminShellClient.tsx", import.meta.url), "utf8");
const themeToggle = readFileSync(new URL("../src/components/ThemeToggle.tsx", import.meta.url), "utf8");
const publicActions = readFileSync(new URL("../src/app/actions/public.ts", import.meta.url), "utf8");
const adminAction = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const enrollForm = readFileSync(new URL("../src/app/apply/enroll/EnrollApplicationForm.tsx", import.meta.url), "utf8");
const trialClient = readFileSync(new URL("../src/app/admin/trial/TrialCrmClient.tsx", import.meta.url), "utf8");

test("관리자 헤더는 알림을 유지하고 승인된 라이트 테마를 사용한다", () => {
  assert.match(adminShell, /<LazyNotificationBell \/>/);
  assert.doesNotMatch(adminShell, /<ThemeToggle/);
  assert.match(themeToggle, /if \(forcedTheme\) return null/);
  assert.match(themeToggle, /resolvedTheme/);
  assert.match(themeToggle, /라이트 모드로 변경/);
  assert.match(themeToggle, /다크 모드로 변경/);
  assert.match(themeToggle, /isDark \? "light_mode" : "dark_mode"/);
});

test("체험 완료 후 수강신청서 링크는 관리자 주요 액션으로 노출된다", () => {
  assert.match(trialClient, /function renderEnrollGuideButton/);
  assert.match(trialClient, /lead\.status !== "ATTENDED"/);
  assert.match(trialClient, /lead\.enrollApplicationReceivedAt/);
  assert.match(trialClient, /handleSendEnrollGuide\(lead\)/);
  assert.match(trialClient, /수강신청 안내/);
  assert.match(trialClient, /안내 재발송/);
  // 목록 단순화 이후에도 체험 완료 후속 안내는 번개 퀵액션의 주요 버튼으로 유지되어야 한다.
  assert.match(trialClient, /openQuickActionId === lead\.id[\s\S]*renderEnrollGuideButton\(lead\)/);
});

test("체험 신청 정보는 수강신청서 자동 채움으로 이어진다", () => {
  for (const field of ["childSchool", "childPhone", "basketballExp", "preferredSlotKey"]) {
    assert.match(publicActions, new RegExp(`${field}: string \\| null`));
    assert.match(publicActions, new RegExp(`"${field}"`));
  }
  assert.match(publicActions, /ADD COLUMN IF NOT EXISTS "childPhone" TEXT/);
  assert.match(publicActions, /parentName === "미입력" \? "" : parentName/);
  assert.match(enrollForm, /const preferredTrialSlot = trialData\?\.preferredSlotKey/);
  assert.match(enrollForm, /const trialChildPhone = trialData\?\.childPhone \|\| trialData\?\.parentPhone \|\| ""/);
  assert.match(enrollForm, /childSchool: trialData\?\.childSchool \|\| ""/);
  assert.match(enrollForm, /childPhone: trialChildPhone/);
  assert.match(enrollForm, /preferredSlotKeys: preferredTrialSlot \? \[preferredTrialSlot\] : \[\]/);
  assert.match(enrollForm, /basketballExp: trialData\?\.basketballExp \|\| ""/);
});

test("등록전환 상태 변경은 확인 모달에서 수강신청서 문자를 자동 발송한다", () => {
  assert.match(trialClient, /sendPostTrialEnrollGuide/);
  assert.match(adminAction, /\[sendPostTrialEnrollGuide SMS\] failed:[\s\S]*?수강신청 안내 문자 준비 중 오류가 발생했습니다/);
  assert.match(trialClient, /type EnrollGuideConfirmState/);
  assert.match(trialClient, /newStatus === "CONVERTED" && lead\.status !== "CONVERTED"/);
  assert.match(trialClient, /setEnrollGuideConfirm\(\{ lead, convertAfterConfirm: true \}\)/);
  assert.match(trialClient, /function EnrollGuideConfirmModal/);
  assert.match(trialClient, /수강신청서를 전송하시겠습니까/);
  assert.match(trialClient, /sendPostTrialEnrollGuide\(lead\.id,[\s\S]*convert: convertAfterConfirm/);
  assert.match(trialClient, /등록전환은 완료됐지만/);
  assert.doesNotMatch(trialClient, /navigator\.clipboard\.writeText\(enrollLink\)/);
});
