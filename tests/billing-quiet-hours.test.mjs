// 청구·미납 안내 «야간 발송 금지»(KST 21:00~08:00) 테스트(2026-11-13 원장 점검표 f11).
// 서버는 UTC 라서 시각은 전부 UTC 로 만들어 넣고 KST 경계에서 판정이 맞는지 실행해 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const quiet = await loadTsModule("src/lib/billing/quietHours.ts");
const q = await loadTsModule("src/lib/billing/noticeQueue.ts");
const read = (p) => readFileSync(p, "utf8");

// KST 시각 → UTC 밀리초(KST = UTC+9)
const kst = (iso) => Date.parse(`${iso}+09:00`);

test("야간 판정 — KST 경계 20:59/21:00/07:59/08:00 + 자정·월말·연말", () => {
  assert.equal(quiet.isBillingQuietHour(kst("2026-11-13T20:59:59")), false, "20:59 는 보낸다");
  assert.equal(quiet.isBillingQuietHour(kst("2026-11-13T21:00:00")), true, "21:00 부터 막는다");
  assert.equal(quiet.isBillingQuietHour(kst("2026-11-14T00:00:00")), true, "자정");
  assert.equal(quiet.isBillingQuietHour(kst("2026-11-14T07:59:59")), true, "07:59 는 막는다");
  assert.equal(quiet.isBillingQuietHour(kst("2026-11-14T08:00:00")), false, "08:00 부터 보낸다");
  assert.equal(quiet.isBillingQuietHour(kst("2026-11-14T12:00:00")), false, "낮");
  // UTC 날짜가 하루 다른 구간(KST 00:00~08:59 = UTC 전날) — 서버 시계로 판정하면 9시간 어긋난다
  assert.equal(quiet.isBillingQuietHour(Date.parse("2026-11-30T22:30:00Z")), true, "UTC 22:30 = KST 12/1 07:30");
  assert.equal(quiet.isBillingQuietHour(Date.parse("2026-12-31T23:00:00Z")), false, "UTC 12/31 23:00 = KST 1/1 08:00");
  assert.equal(quiet.isBillingQuietHour(Date.parse("2026-12-31T11:59:00Z")), false, "UTC 11:59 = KST 20:59");
  assert.equal(quiet.isBillingQuietHour(Date.parse("2026-12-31T12:00:00Z")), true, "UTC 12:00 = KST 21:00");
  assert.equal(quiet.BILLING_QUIET_START_HOUR, 21);
  assert.equal(quiet.BILLING_QUIET_END_HOUR, 8);
});

test("예약 결과 문구 — 야간이면 «아침 8시에», 낮이면 «1~2분 안에»", () => {
  const queued = [{ channel: "SMS" }];
  const night = q.describeReservation({ label: "수강료 미납 안내", queued, skippedActive: 0, unlinked: [], nowMs: kst("2026-11-13T22:00:00") });
  assert.match(night, /아침 8시에 차례로 나갑니다/);
  const day = q.describeReservation({ label: "수강료 미납 안내", queued, skippedActive: 0, unlinked: [], nowMs: kst("2026-11-13T08:00:00") });
  assert.match(day, /1~2분 안에 차례로 나갑니다/);
});

test("대기열 꺼내기 — 야간엔 연결표에 묶인 청구 안내만 건너뛴다(다른 문자 묶음은 그대로)", () => {
  const ledger = read("src/lib/message-ledger.ts");
  const claim = ledger.slice(ledger.indexOf("export async function claimManualMessageQueue"), ledger.indexOf("export async function markManualMessageAccepted"));
  assert.match(claim, /const billingQuiet = isBillingQuietHour\(nowMs\)/);
  const filter = `AND NOT ($3::boolean AND EXISTS (SELECT 1 FROM "BillingNoticeDelivery" bn WHERE bn."deliveryId" = nd.id))`;
  // «다음 묶음 고르기»와 «행 꺼내기» 두 곳 모두 — 한 곳만 있으면 청구 묶음이 맨 앞에서 다른 묶음을 막는다
  assert.equal(claim.split(filter).length - 1, 2);
  assert.match(claim, /token, billingQuiet,/);
  // 연결표 없는 청구 안내(이론상 없음)가 야간에 꺼내지면 실패로 닫는다 — 되돌리면 매분 같은 묶음이 다른 묶음을 막는다(LOW-1)
  assert.match(claim, /if \(billingQuiet\) \{[\s\S]*?status='FAILED', "errorCode"='BILLING_QUIET_HOURS_UNLINKED'[\s\S]*?finalizeBatchIds\.add\(item\.batchId\)/);
  assert.doesNotMatch(claim, /DELETE FROM "NotificationDelivery"/);
});

test("15분 만료가 밤새 기다리는 청구 안내를 «실패»로 만들지 않는다", () => {
  const n = read("src/lib/notification.ts");
  const fn = n.slice(n.indexOf("export async function expireStaleSmsDeliveries"), n.indexOf("export async function reserveFailClosedSmsDelivery"));
  assert.match(fn, /status = 'PENDING' AND "createdAt" < NOW\(\) - INTERVAL '15 minutes'[\s\S]*?AND NOT EXISTS \(SELECT 1 FROM "BillingNoticeDelivery" bn WHERE bn\."deliveryId" = "NotificationDelivery"\.id\)/);
  // SENDING 2분 만료(공급자 호출 뒤 끊김)는 예전 그대로
  assert.match(fn, /status = 'SENDING' AND "lockedAt" < NOW\(\) - INTERVAL '2 minutes'/);
});

test("자정 연체 cron(payment-overdue, KST 00:10)은 학부모에게 아무것도 보내지 않는다(표시만)", () => {
  const route = read("src/app/api/cron/payment-overdue/route.ts");
  assert.doesNotMatch(route, /sms|Sms|reserveBillingNotices|reserveManualMessageQueue|notify/);
  assert.match(route, /markOverduePayments/);
});

test("관리자 재무 화면 — 야간 안내 한 줄", () => {
  const client = read("src/app/admin/finance/FinanceClient.tsx");
  assert.match(client, /import \{ BILLING_QUIET_HINT, isBillingQuietHour \} from "@\/lib\/billing\/quietHours"/);
  assert.equal(client.split("{BILLING_QUIET_HINT}").length - 1, 1, "발송 메뉴 아래 상시 안내");
  assert.match(client, /isBillingQuietHour\(\) \? BILLING_QUIET_HINT : "보내는 중/);
  assert.match(quiet.BILLING_QUIET_HINT, /밤 9시~아침 8시/);
});
