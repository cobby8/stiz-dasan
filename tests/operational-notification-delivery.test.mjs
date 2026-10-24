import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const delivery = await readFile("src/lib/operational-notification-delivery.ts", "utf8");
const staff = await readFile("src/lib/operational-staff-notification.ts", "utf8");
const absence = await readFile("src/lib/regular/parent-regular-absence.ts", "utf8");
const shuttle = await readFile("src/lib/shuttle/parent-shuttle-exception.ts", "utf8");
const pushOutbox = await readFile("src/lib/push-outbox.ts", "utf8");
const reconciliation = await readFile("src/lib/operational-notification-reconciliation.ts", "utf8");
const reconciliationRoute = await readFile("src/app/api/cron/operational-notification-reconciliation/route.ts", "utf8");

test("인앱 알림과 SENT 장부를 한 SQL 문장에서 원자적으로 만든다", () => {
  assert.match(delivery, /WITH in_app_delivery AS \([\s\S]*INSERT INTO "NotificationDelivery"[\s\S]*notification AS \([\s\S]*INSERT INTO "Notification"[\s\S]*push_delivery AS \([\s\S]*INSERT INTO "NotificationDelivery"/);
  assert.match(delivery, /'IN_APP', 'IN_APP'[\s\S]*'SENT'/);
  assert.match(delivery, /ON CONFLICT \("dedupeKey"\) DO NOTHING/);
});

test("푸시는 PENDING 장부를 먼저 만들고 기존 outbox로 처리한다", () => {
  assert.match(delivery, /'PUSH', 'PUSH'[\s\S]*'PENDING'/);
  assert.match(delivery, /"payloadJSON"/);
  assert.match(delivery, /processPushOutbox\(1, pushDeliveryId\)/);
});

test("수신자별 실패를 숨기지 않고 실제 전달 요약에 남긴다", () => {
  assert.match(staff, /Promise\.allSettled/);
  assert.match(staff, /deliveredCount: successfulDeliveries\.length/);
  assert.match(staff, /failedCount/);
  assert.match(staff, /deliveries,/);
});

test("결석과 셔틀 생성·취소가 원본 ID와 동작 기반 안정 이벤트 키를 쓴다", () => {
  assert.match(absence, /regular-absence:\$\{input\.recordId\}:\$\{input\.kind\}:\$\{input\.eventVersion\}/);
  assert.match(absence, /createHash\("sha256"\)\.update\(reason\)/);
  assert.match(absence, /RETURNING s\.name AS "studentName", c\.name AS "className", ra\.id/);
  assert.match(shuttle, /shuttle-day-exception:\$\{input\.recordId\}:\$\{input\.action \?\? "SUBMITTED"\}:\$\{input\.eventVersion\}/);
  assert.match(shuttle, /createHash\("sha256"\)/);
  assert.match(shuttle, /RETURNING x\.id, x\."studentId"/);
});

test("셔틀 교체는 취소와 신규 저장을 한 SQL 트랜잭션으로 묶는다", () => {
  assert.match(shuttle, /WITH guard AS MATERIALIZED \([\s\S]*existing AS \([\s\S]*canceled AS \([\s\S]*UPDATE "ShuttleDayException"[\s\S]*inserted AS \([\s\S]*INSERT INTO "ShuttleDayException"/);
});

test("동일 요청 재시도는 no-op이고 실제 상태 전이만 새 알림을 만든다", () => {
  assert.match(absence, /status = 'CANCELLED'[\s\S]*reason IS DISTINCT FROM EXCLUDED\.reason/);
  assert.match(absence, /current\[0\]\?\.status === "REPORTED"[\s\S]*noOp: true/);
  assert.match(absence, /eventVersion: `\$\{saved\[0\]\.eventVersion\}-\$\{createHash/);
  assert.match(shuttle, /pg_advisory_xact_lock/);
  assert.match(shuttle, /UNION ALL SELECT id, false AS changed FROM existing/);
  assert.match(shuttle, /!saved\[0\]\.changed[\s\S]*noOp: true/);
});

test("결석 신고와 취소를 반복해도 각 lifecycle 취소 키가 새로 생긴다", () => {
  assert.match(absence, /SET status = 'CANCELLED', "updatedAt" = NOW\(\)/);
  assert.match(absence, /to_char\(ra\."updatedAt",'YYYYMMDDHH24MISSUS'\) AS "eventVersion"/);
  assert.match(absence, /eventVersion: canceled\[0\]\.eventVersion/);
  assert.match(reconciliation, /eventVersion: canceled \? row\.eventVersion/);
  assert.match(reconciliation, /nd\."stableEventKey" =/);
  assert.match(reconciliation, /encode\(digest\(ra\.reason,'sha256'\),'hex'\)/);
});

test("최근 장부 전체 누락은 인증된 내부 cron이 제한적으로 복구한다", () => {
  assert.match(reconciliation, /INTERVAL '14 days'/);
  assert.match(reconciliation, /NOT EXISTS[\s\S]*"NotificationDelivery"/);
  assert.match(reconciliation, /Math\.min\(50, limit\)/);
  assert.match(reconciliationRoute, /CRON_SECRET/);
  assert.match(reconciliationRoute, /reconcileOperationalNotifications\(20\)/);
});

test("셔틀 복구는 현재 payload의 정확한 키만 완료로 인정한다", () => {
  assert.match(reconciliation, /keyedShuttles/);
  assert.match(reconciliation, /"stableEventKey" = ANY\(\$1::text\[\]\)/);
  assert.match(reconciliation, /filter\(\(entry\) => !existing\.has\(entry\.stableEventKey\)\)/);
  assert.doesNotMatch(reconciliation, /shuttle-day-exception:[\s\S]{0,200}LIKE/);
});

test("알림 요약 실패는 처리 완료로 세지 않고 failed로 반환한다", () => {
  assert.match(reconciliation, /notification && notification\.deliveredCount > 0 && notification\.failedCount === 0/);
  assert.match(reconciliation, /else failed \+= 1/);
  assert.match(reconciliation, /return \{ processed, failed,/);
});

test("완료되거나 재시도 한도를 넘긴 푸시 본문은 지운다", () => {
  assert.match(pushOutbox, /PUSH_MAX_ATTEMPTS_EXHAUSTED'[\s\S]{0,160}"payloadJSON" = NULL/);
  assert.match(pushOutbox, /function completeClaim[\s\S]{0,900}"payloadJSON" = NULL/);
  assert.match(pushOutbox, /CASE WHEN \$3 THEN "payloadJSON" ELSE NULL END/);
});
