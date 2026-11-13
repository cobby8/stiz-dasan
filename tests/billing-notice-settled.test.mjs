// 청구·미납 안내 «보내기 직전 납부 확인»·대기 상한·학부모 응답 숫자 제거 테스트(2026-11-13 검수 MED-1·MED-2·LOW-2·LOW-4).
// 실제 DB·문자는 쓰지 않는다 — 가짜 DB 로 SQL 과 인자를 확인하고 순수 함수는 실행한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const q = await loadTsModule("src/lib/billing/noticeQueue.ts");
const view = await loadTsModule("src/lib/seasonal/parentMakeupView.ts");
const read = (p) => readFileSync(p, "utf8");

test("납부 확인 — 결제가 전부 PAID/REFUNDED/CANCELED 인 안내만 고른다(빈 결제 목록은 판단 안 함)", async () => {
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql, ...args) { calls.push({ sql, args }); return [{ deliveryId: "d-paid" }]; },
    async $executeRawUnsafe() { return 0; },
  };
  assert.deepEqual(await q.findSettledBillingDeliveries(db, []), [], "빈 목록이면 DB 를 부르지 않는다");
  assert.equal(calls.length, 0);
  const ids = await q.findSettledBillingDeliveries(db, ["d-paid", "d-open"]);
  assert.deepEqual(ids, ["d-paid"]);
  const { sql, args } = calls[0];
  assert.deepEqual(args, [["d-paid", "d-open"]]);
  assert.match(sql, /cardinality\(n\."paymentIds"\) > 0/);
  assert.match(sql, /NOT EXISTS \([\s\S]*p\.status NOT IN \('PAID', 'REFUNDED', 'CANCELED'\)/);
  assert.deepEqual([...q.BILLING_SETTLED_PAYMENT_STATUSES], ["PAID", "REFUNDED", "CANCELED"]);
});

test("진행 상황 — «납부돼 생략»은 실패로 세지 않고 실패 이름에도 안 나온다", async () => {
  const p = q.summarizeNoticeProgress([
    { channel: "SMS", status: "FAILED", errorCode: q.BILLING_ALREADY_SETTLED_CODE },
    { channel: "SMS", status: "FAILED", errorCode: "PROVIDER" },
    { channel: "ALIMTALK", status: "SENT" },
  ]);
  assert.equal(p.settled, 1);
  assert.equal(p.failed, 1);
  assert.equal(p.sent, 1);
  const db = {
    async $queryRawUnsafe() {
      return [
        { channel: "SMS", status: "FAILED", errorCode: q.BILLING_ALREADY_SETTLED_CODE, studentName: "납부함" },
        { channel: "SMS", status: "FAILED", errorCode: "X", studentName: "실패함" },
      ];
    },
  };
  const loaded = await q.loadBillingNoticeProgress(db, "UNPAID", "2026-11-13");
  assert.deepEqual(loaded.failedNames, ["실패함"]);
  assert.equal(loaded.settled, 1);
  assert.match(read("src/app/admin/finance/FinanceClient.tsx"), /납부돼 생략 \$\{p\.settled\}/);
});

test("대기 상한 — 24시간 넘게 기다린 청구 안내만 만료하고 정리할 묶음을 돌려준다", async () => {
  let seen;
  const db = { async $queryRawUnsafe(sql, ...args) { seen = { sql, args }; return [{ batchId: "b1" }, { batchId: "b1" }, { batchId: null }]; } };
  assert.deepEqual(await q.expireOverdueBillingQueue(db), ["b1"]);
  assert.deepEqual(seen.args, [24, "BILLING_NOTICE_EXPIRED"]);
  assert.match(seen.sql, /d\.status = 'PENDING'/);
  assert.match(seen.sql, /make_interval\(hours => \$1::int\)/);
  assert.match(seen.sql, /EXISTS \(SELECT 1 FROM "BillingNoticeDelivery" bn WHERE bn\."deliveryId" = d\.id\)/);
});

test("대기열 꺼내기 연결 — 만료 → 규칙 확인 → 납부 확인(SKIPPED) 순서, 오류는 SAVEPOINT 로 격리", () => {
  const ledger = read("src/lib/message-ledger.ts");
  const claim = ledger.slice(ledger.indexOf("export async function claimManualMessageQueue"), ledger.indexOf("export async function markManualMessageAccepted"));
  assert.match(claim, /SAVEPOINT billing_expire[\s\S]*?expireOverdueBillingQueue\(tx\)[\s\S]*?ROLLBACK TO SAVEPOINT billing_expire/);
  assert.match(claim, /SAVEPOINT billing_settled_check[\s\S]*?findSettledBillingDeliveries\(tx,[\s\S]*?ROLLBACK TO SAVEPOINT billing_settled_check/);
  assert.match(claim, /status='SKIPPED', "errorCode"=\$2[\s\S]*?BILLING_ALREADY_SETTLED_CODE/);
  assert.ok(claim.indexOf("checkBillingSendRule(tx, trigger)") < claim.indexOf("findSettledBillingDeliveries"));
  // 결과 반영은 SKIPPED → 연결표 FAILED(사유 그대로) — 화면이 사유로 «납부돼 생략»을 구분한다
  const notice = read("src/lib/billing/noticeQueue.ts");
  assert.match(notice, /WHEN d\.status IN \('FAILED', 'SKIPPED'\) THEN 'FAILED'/);
  assert.match(notice, /"errorCode" = d\."errorCode"/);
});

test("학부모 응답 — 보강·방학특강 보강·수강 변경 후보에 정원·인원·남은 자리 숫자가 없다", () => {
  const out = view.toParentSeasonalCandidates({
    seasonalCandidates: [
      { sessionDateId: "s1", label: "1/5(월)", remaining: 6, filled: 4, capacity: 10 },
      { sessionDateId: "s2", label: "1/6(화)", remaining: 2 },
      { sessionDateId: "s3", label: "1/7(수)", remaining: null },
      { sessionDateId: "s4", label: "1/8(목)", remaining: 0 },
    ],
    regularCandidates: [{ classId: "c1", name: "월 1교시", schedule: "Mon 16:00~17:00", nextDate: "2027-01-05", nextLabel: "1/5(월)", capacity: 12, enrolled: 9, gradeAvg: 2.5, instructor: "코치" }],
  });
  assert.deepEqual(out.seasonalCandidates.map((s) => s.seatLevel), ["AVAILABLE", "LOW", "AVAILABLE", "LOW"]);
  assert.deepEqual(Object.keys(out.seasonalCandidates[0]).sort(), ["label", "seatLevel", "sessionDateId"]);
  assert.deepEqual(Object.keys(out.regularCandidates[0]).sort(), ["classId", "name", "nextDate", "nextLabel", "schedule"]);
  assert.match(read("src/lib/seasonal/parent-makeup.ts"), /\.\.\.toParentSeasonalCandidates\(opt\)/);
  const makeup = read("src/lib/makeup/parent-makeup.ts");
  const type = makeup.slice(makeup.indexOf("export type MakeupOption"), makeup.indexOf("export async function getMakeupOptionsForCredit"));
  assert.doesNotMatch(type, /remaining/);
  assert.match(makeup, /seatLevel: seatLevel\(c\.remaining\)/);
  const change = read("src/lib/enrollment/parent-change-request.ts");
  const cls = change.slice(change.indexOf("export type ChangeableClass"), change.indexOf("export type ChildChangeOption"));
  assert.doesNotMatch(cls, /capacity|enrolled/);
  const mapped = change.slice(change.indexOf("classes: classes.map"));
  assert.doesNotMatch(mapped.slice(0, 600), /capacity:|enrolled:/);
  // 신청 때 서버 정원 검사는 숫자로 그대로
  assert.match(change, /waitlisted = Number\(target\[0\]\.enrolled \?\? 0\) >= Number\(target\[0\]\.capacity \?\? 0\)/);
});

test("챗봇 프롬프트 — «정원 안내» 대신 자리 현황(여유/임박/마감)", () => {
  const chat = read("src/app/api/chat/route.ts");
  assert.doesNotMatch(chat, /코치·정원 안내|반별 정원 현황 안내/);
  assert.match(chat, /자리 현황\(여유\/임박\/마감\)/);
});
