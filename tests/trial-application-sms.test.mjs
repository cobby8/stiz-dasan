import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const publicAction = readFileSync(new URL("../src/app/actions/public.ts", import.meta.url), "utf8");
const adminAction = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const trialForm = readFileSync(new URL("../src/app/apply/trial/TrialApplicationForm.tsx", import.meta.url), "utf8");
const trialCrm = readFileSync(new URL("../src/app/admin/trial/TrialCrmClient.tsx", import.meta.url), "utf8");
const notification = readFileSync(new URL("../src/lib/notification.ts", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const sms = readFileSync(new URL("../src/lib/sms.ts", import.meta.url), "utf8");

test("체험 신청은 한글 요일이 아니라 DB 슬롯키로 담당 코치 SMS를 매칭한다", () => {
  assert.match(publicAction, /TRIAL_DAY_KEY_BY_LABEL/);
  assert.match(publicAction, /월:\s*"Mon"/);
  assert.match(publicAction, /금:\s*"Fri"/);
  assert.match(publicAction, /function resolveTrialSlotKey/);
  assert.match(publicAction, /preferredSlotKey,\s*\/\/ preferredSlotKey/);
  assert.match(publicAction, /slotKeys:\s*preferredSlotKey \? \[preferredSlotKey\] : undefined/);
});

test("체험 신청 폼은 실제 빈자리 슬롯의 slotKey를 서버로 넘긴다", () => {
  assert.match(trialForm, /availableSlots/);
  // 일정 검증과 같은 교시 해석을 사용하며, 실제 전송은 아래 slotKey 검사를 유지한다.
  assert.match(trialForm, /trialSlotPeriod as getSlotPeriod/);
  assert.match(trialForm, /selectedSlot\?\.slotKey/);
  // 시각 표시 대신 잔여 인원·마감을 보여주도록 바뀌었다.
  // 이 테스트가 지키려는 "실제 빈자리"에는 오히려 이쪽이 맞다.
  assert.match(trialForm, /slot\.available <= 0/);
  assert.match(trialForm, /잔여 \$\{slot\.available\}명/);
});

test("체험 신청 완료 화면은 체험비 입금 안내와 복사/송금 흐름을 제공한다", () => {
  assert.match(trialForm, /TRIAL_FEE_PAYMENT_INFO/);
  assert.match(trialForm, /체험수업비 입금 안내/);
  assert.match(trialForm, /3333-05-1344817/);
  assert.match(trialForm, /copyTrialFeeAccount/);
  assert.match(trialForm, /handleTrialFeeTransfer/);
  assert.match(trialForm, /navigator\.clipboard\.writeText/);
  assert.match(trialForm, /navigator\.share/);
});

test("체험 신청 SMS는 발송 장부에 성공과 실패를 남긴다", () => {
  assert.match(notification, /"NotificationDelivery"/);
  assert.match(notification, /channel,\s*"dedupeKey"/);
  assert.match(notification, /'SMS'/);
  assert.match(notification, /result\.ok \? "SENT" : "FAILED"/);
  assert.match(notification, /sendSmsDetailed/);
  assert.match(publicAction, /eventId:\s*trialLeadId/);
  assert.match(queries, /smsDeliveryTotal/);
  assert.match(queries, /sms_delivery/);
});

test("SMS 요청은 일정 시간 안에 끝나도록 제한한다", () => {
  assert.match(sms, /SMS_REQUEST_TIMEOUT_MS/);
  assert.match(sms, /AbortController/);
  assert.match(sms, /controller\.signal/);
});

test("관리자는 실패한 체험 신청 문자만 다시 발송할 수 있다", () => {
  assert.match(notification, /export async function sendTrackedSms/);
  assert.match(notification, /deliveryRunId/);
  assert.match(adminAction, /export async function resendTrialApplicationSms/);
  assert.match(adminAction, /latest\.status = 'FAILED'/);
  assert.match(adminAction, /sendTrackedSms/);
  assert.match(trialCrm, /resendTrialApplicationSms/);
  assert.match(trialCrm, /체험 신청 문자 중 실패한 문자만 다시 보낼까요/);
});

test("체험 문자 배지는 과거 실패가 아니라 최신 발송 상태 기준으로 집계한다", () => {
  assert.match(queries, /SELECT DISTINCT ON \(\s*nd\."recipientPhone"/);
  assert.match(queries, /COUNT\(\*\) FILTER \(WHERE latest\.status = 'FAILED'\)/);
  assert.match(queries, /MAX\(latest\."updatedAt"\) AS sms_latest_at/);
});
