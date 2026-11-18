import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TRIAL_SELF_SERVICE_BLOCK_MESSAGE,
  normalizeTrialLookupInput,
  sameTrialSchedule,
  trialScheduleText,
  trialSelfCancelNote,
  trialSelfChangeNote,
  trialSelfServiceCancelBlock,
  trialSelfServiceChangeBlock,
  trialSelfServiceStatusLabel,
} from "../src/lib/trial-self-service/rules.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const actions = read("src/app/actions/trial-self-service.ts");
const manageClient = read("src/app/apply/trial/manage/TrialManageClient.tsx");
const managePage = read("src/app/apply/trial/manage/page.tsx");
const trialPage = read("src/app/apply/trial/page.tsx");
const trialForm = read("src/app/apply/trial/TrialApplicationForm.tsx");
const publicActions = read("src/app/actions/public.ts");

const NOW = Date.parse("2026-11-18T03:00:00Z");

test("조회 입력: 번호는 숫자만, 10~11자리, 이름은 공백 제거", () => {
  assert.deepEqual(normalizeTrialLookupInput({ childName: "  김한결 ", parentPhone: "010-1234 5678" }), { childName: "김한결", phoneDigits: "01012345678" });
  assert.equal(normalizeTrialLookupInput({ childName: "김한결", parentPhone: "010-123" }), null);
  assert.equal(normalizeTrialLookupInput({ childName: "   ", parentPhone: "01012345678" }), null);
  assert.equal(normalizeTrialLookupInput({ childName: "김한결", parentPhone: 1012345678 }), null);
});

test("진행 중(접수·연락·확정 전 시각)인 신청만 변경·취소할 수 있다", () => {
  for (const status of ["NEW", "CONTACTED"]) {
    assert.equal(trialSelfServiceChangeBlock({ status, scheduledDate: null }, NOW), null);
    assert.equal(trialSelfServiceCancelBlock({ status, scheduledDate: null }, NOW), null);
  }
  const upcoming = { status: "SCHEDULED", scheduledDate: "2026-11-20T08:00:00Z" };
  assert.equal(trialSelfServiceChangeBlock(upcoming, NOW), null);
  assert.equal(trialSelfServiceCancelBlock(upcoming, NOW), null);
});

test("체험이 끝났거나 등록 단계로 넘어간 신청은 막는다", () => {
  for (const status of ["ATTENDED", "CONVERTED", "LOST", "CANCELLED", null]) {
    assert.equal(trialSelfServiceChangeBlock({ status, scheduledDate: null }, NOW), "CLOSED");
    assert.equal(trialSelfServiceCancelBlock({ status, scheduledDate: null }, NOW), "CLOSED");
  }
  assert.equal(trialSelfServiceChangeBlock({ status: "SCHEDULED", scheduledDate: "2026-11-17T08:00:00Z" }, NOW), "TRIAL_PASSED");
  for (const extra of [
    { attendedDate: "2026-11-10T08:00:00Z" },
    { convertedStudentId: "s1" },
    { convertedDate: "2026-11-11T00:00:00Z" },
    { enrollApplicationId: "e1" },
    { enrollApplicationReceivedAt: "2026-11-12T00:00:00Z" },
  ]) {
    assert.equal(trialSelfServiceChangeBlock({ status: "CONTACTED", scheduledDate: null, ...extra }, NOW), "PROGRESSED");
    assert.equal(trialSelfServiceCancelBlock({ status: "CONTACTED", scheduledDate: null, ...extra }, NOW), "PROGRESSED");
  }
});

test("체험비를 냈거나 입금 대기면 일정 변경만 되고 취소는 학원 문의", () => {
  const base = { status: "NEW", scheduledDate: null };
  assert.equal(trialSelfServiceChangeBlock({ ...base, trialFeeConfirmed: true }, NOW), null);
  assert.equal(trialSelfServiceCancelBlock({ ...base, trialFeeConfirmed: true }, NOW), "PAID");
  assert.equal(trialSelfServiceCancelBlock({ ...base, trialFeePaymentStatus: "PAID" }, NOW), "PAID");
  assert.equal(trialSelfServiceCancelBlock({ ...base, trialFeePaymentStatus: "NEEDS_REFUND" }, NOW), "PAID");
  assert.equal(trialSelfServiceCancelBlock({ ...base, trialFeePaymentStatus: "WAITING_FOR_DEPOSIT" }, NOW), "DEPOSIT_WAITING");
  assert.equal(trialSelfServiceCancelBlock({ ...base, trialFeePaymentStatus: "REFUNDED" }, NOW), null);
  for (const message of Object.values(TRIAL_SELF_SERVICE_BLOCK_MESSAGE)) assert.match(message, /학원/);
});

test("일정 문구와 관리자 이력 문장", () => {
  const before = { trialDate: "2026-11-20", trialDay: "목", trialPeriod: "4" };
  const after = { trialDate: "2026-11-22", trialDay: "토", trialPeriod: "2" };
  assert.equal(trialScheduleText(before), "11월 20일(목) 4교시");
  assert.equal(trialScheduleText({ trialDate: null, trialDay: null, trialPeriod: null }), "일정 미입력");
  assert.equal(sameTrialSchedule(before, { ...before }), true);
  assert.equal(sameTrialSchedule(before, after), false);
  assert.equal(trialSelfChangeNote(before, after, false), "학부모 온라인 일정 변경: 11월 20일(목) 4교시 → 11월 22일(토) 2교시");
  assert.match(trialSelfChangeNote(before, after, true), /다시 확정 필요/);
  assert.equal(trialSelfCancelNote("  일정이\n안 맞아요 "), "학부모 온라인 취소: 일정이 안 맞아요");
  assert.equal(trialSelfCancelNote(""), "학부모 온라인 취소");
  assert.equal(trialSelfCancelNote("가".repeat(500)).length, "학부모 온라인 취소: ".length + 200);
  assert.equal(trialSelfServiceStatusLabel("SCHEDULED"), "체험 확정");
});

test("서버 액션: 이름+숫자 번호로만 찾고 진행 중 신청만, 원시 SQL만 쓴다", () => {
  assert.match(actions, /^"use server";/);
  assert.match(actions, /LOWER\(TRIM\("childName"\)\) = LOWER\(\$1\)/);
  assert.match(actions, /regexp_replace\(COALESCE\("parentPhone", ''\), '\[\^0-9\]', '', 'g'\) = \$2/);
  assert.match(actions, /status IN \(\$\{ACTIVE_STATUS_SQL\}\)/);
  assert.doesNotMatch(actions, /prisma\.trialLead\.|\.findMany\(|\.update\(\{/);
  // 변경·취소는 행을 잠그고 DB 값으로 다시 판단한다
  assert.equal((actions.match(/FOR UPDATE/g) ?? []).length, 2);
  assert.match(actions, /trialSelfServiceChangeBlock\(leadOf\(row\)\)/);
  assert.match(actions, /trialSelfServiceCancelBlock\(leadOf\(row\)\)/);
  // 새 일정도 공개 신청서와 같은 기준(시간표·마감·요일)으로 검증
  assert.match(actions, /trialScheduleError\(/);
});

test("서버 액션: 응답에 개인정보를 싣지 않는다", () => {
  const typeBlock = actions.slice(actions.indexOf("export type MyTrialApplication"), actions.indexOf("export type TrialLookupResult"));
  for (const field of ["parentPhone", "parentName", "childSchool", "childBirthDate", "childGrade", "childName"]) {
    assert.doesNotMatch(typeBlock, new RegExp(field));
  }
  assert.doesNotMatch(actions, /"parentPhone", "parentName"|SELECT[^`]*"childSchool"/);
});

test("서버 액션: 시도 횟수 제한(접속 주소·이름+번호, 원문 대신 해시)", () => {
  assert.match(actions, /takePublicRateLimit\(`trial-self:ip:/);
  assert.match(actions, /takePublicRateLimit\(`trial-self:key:\$\{sha\(/);
  for (const fn of ["lookupMyTrialApplications", "changeMyTrialApplication", "cancelMyTrialApplication"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 900), /allowAttempt\(key\)/, fn);
  }
  // 신청서의 «기존 신청 불러오기»도 같은 장부로 제한한다
  assert.match(publicActions, /if \(!\(await allowExistingTrialLookup\(\)\)\) return null;/);
});

test("변경·취소는 관리자 이력과 관리자 알림을 남기고 학부모 문자는 보내지 않는다", () => {
  assert.match(actions, /INSERT INTO "ApplicationContactLog"[\s\S]*'SCHEDULED'[\s\S]*'학부모\(온라인\)'/);
  assert.match(actions, /INSERT INTO "ApplicationContactLog"[\s\S]*'CANCELLED'[\s\S]*'학부모\(온라인\)'/);
  assert.match(actions, /status = 'CANCELLED', "lostReason" = \$1/);
  assert.match(actions, /status = CASE WHEN status = 'SCHEDULED' THEN 'CONTACTED' ELSE status END/);
  assert.match(actions, /notifyAdmins\("TRIAL_APPLICATION", title, message, "\/admin\/trial", \{ notifyCoaches: false, eventId \}\)/);
  assert.doesNotMatch(actions, /adminTrigger|sendParentSms|sendSms/);
  assert.match(actions, /revalidatePath\("\/admin\/trial"\)/);
});

test("공개 화면: 진입점과 확인·변경·취소 화면", () => {
  assert.match(trialPage, /href="\/apply\/trial\/manage"/);
  assert.match(trialForm, /href="\/apply\/trial\/manage"/);
  assert.match(managePage, /robots: \{ index: false, follow: false \}/);
  assert.match(manageClient, /lookupMyTrialApplications\(credentials\)/);
  assert.match(manageClient, /changeMyTrialApplication\(/);
  assert.match(manageClient, /cancelMyTrialApplication\(/);
  assert.match(manageClient, /disabled=\{!item\.canChange \|\| isPending\}/);
  assert.match(manageClient, /disabled=\{!item\.canCancel \|\| isPending\}/);
});
