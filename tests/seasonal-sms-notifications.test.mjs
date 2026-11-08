import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seasonal = readFileSync("src/lib/seasonal/notifications.ts", "utf8");
const notification = readFileSync("src/lib/notification.ts", "utf8");
const templates = readFileSync("src/lib/smsTemplate.ts", "utf8");

test("특강 상태별 보호자 문자 트리거를 모두 제공한다", () => {
  for (const trigger of [
    "SPECIAL_APPLICATION_RECEIVED_PARENT",
    "SPECIAL_APPLICATION_APPROVED_PARENT",
    "SPECIAL_APPLICATION_WAITLISTED_PARENT",
    "SPECIAL_APPLICATION_REJECTED_PARENT",
    "SPECIAL_APPLICATION_CANCELLED_PARENT",
    "SPECIAL_ACCOUNT_ACTIVATION_PARENT",
    "SPECIAL_PAYMENT_REQUEST_PARENT",
  ]) {
    assert.match(seasonal, new RegExp(trigger));
    assert.match(templates, new RegExp(trigger));
  }
  assert.match(templates, /_defaultSmsTemplatesEnsured/);
  assert.doesNotMatch(templates, /COUNT\(\*\)::int AS cnt FROM "SmsTemplate"/);
});

test("특강 문자는 안정적인 이벤트 ID와 명시적 retry run만 사용한다", () => {
  assert.match(seasonal, /stableSeasonalEventId/);
  assert.match(seasonal, /input\.applicationId, input\.itemId \|\| "application", input\.trigger/);
  assert.match(seasonal, /deliveryRunId: input\.deliveryRunId/);
  // 2026-11-09: 학원 전화를 채운 변수(variables)로 렌더링한다(«문의: » 빈칸 버그 수정)
  assert.match(seasonal, /renderSmsTemplateResult\(input\.trigger, variables\)/);
});

test("장부 claim 실패 시 공급자를 호출하지 않는 fail-closed 순서다", () => {
  const reserveAt = notification.indexOf("export async function reserveFailClosedSmsDelivery");
  const dispatchAt = notification.indexOf("export async function dispatchReservedSmsDelivery");
  const providerAt = notification.indexOf("sendMessageDetailed({", dispatchAt);
  assert.ok(reserveAt >= 0 && dispatchAt > reserveAt && providerAt > dispatchAt);
  assert.match(notification, /DELIVERY_LEDGER_UNAVAILABLE/);
  assert.match(notification, /DUPLICATE_SKIPPED/);
});

test("발송 장부에는 원문 전화번호와 본문 또는 비밀 URL을 저장하지 않는다", () => {
  const reserve = notification.slice(notification.indexOf("export async function reserveFailClosedSmsDelivery"), notification.indexOf("export async function dispatchReservedSmsDelivery"));
  const claimBlock = reserve.slice(reserve.indexOf('INSERT INTO "NotificationDelivery"'));
  assert.match(claimBlock, /"recipientPhone"[\s\S]*?NULL/);
  assert.match(claimBlock, /recipientHash/);
  assert.doesNotMatch(claimBlock, /bodyLength|input\.body|activationUrl|paymentUrl/);
  assert.match(notification, /hashMessageRecipientPhone/);
  assert.match(notification, /SMS_PROVIDER_FAILED/);
});

test("이 테스트는 실제 SMS 발송 함수를 실행하지 않는다", () => {
  assert.doesNotMatch(import.meta.url, /sms-provider/i);
});

test("템플릿 조회 장애와 누락을 모두 거래성 실패로 보고하고 2000바이트를 넘기지 않는다", () => {
  assert.match(templates, /SmsTemplateRenderResult/);
  assert.match(templates, /TEMPLATE_LOOKUP_FAILED/);
  assert.match(templates, /TEMPLATE_DISABLED_OR_MISSING/);
  assert.match(seasonal, /SEASONAL_SMS_MAX_BYTES = 2000/);
  assert.match(seasonal, /Buffer\.byteLength\(body, "utf8"\)/);
  assert.match(seasonal, /MESSAGE_TOO_LONG/);
  assert.match(seasonal, /const result: SeasonalSmsDeliveryResult = \{ ok: false, status: "FAILED"/);
  assert.doesNotMatch(seasonal, /TEMPLATE_DISABLED_OR_MISSING"\s*\n\s*\? \{ ok: true/);
});

test("트랜잭션 예약과 커밋 후 발송을 분리하고 stale 상태를 종료한다", () => {
  assert.match(seasonal, /export async function reserveSeasonalParentSms/);
  assert.match(seasonal, /export async function dispatchSeasonalParentSms/);
  assert.match(notification, /status = 'SENDING'/);
  assert.match(notification, /FAILED_DELIVERY_UNCERTAIN/);
  assert.match(notification, /RESERVATION_EXPIRED/);
  assert.match(notification, /export function classifySmsDeliveryLease/);
  assert.match(notification, /2 \* 60_000/);
  assert.match(notification, /status = 'PENDING' AND "createdAt" < NOW\(\) - INTERVAL '15 minutes'/);
  assert.match(seasonal, /requiresReissue/);
});
