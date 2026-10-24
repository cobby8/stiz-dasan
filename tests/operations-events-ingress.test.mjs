import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("src/app/api/operations-events/route.ts", "utf8");
const contract = readFileSync("src/app/api/operations-events/event-contract.ts", "utf8");
const policy = readFileSync("src/lib/operations-events/policy.ts", "utf8");

test("외부 변경은 HMAC 서명과 5분 재생 방지를 통과해야 한다", () => {
  assert.match(contract, /createHmac\("sha256", params\.secret\)/);
  assert.match(contract, /timingSafeEqual\(expected, supplied\)/);
  assert.match(contract, /5 \* 60_000/);
  assert.match(route, /x-stiz-event-timestamp/);
  assert.match(route, /x-stiz-event-signature/);
  assert.match(route, /status: 401/);
});

test("본문 크기와 필수 설정을 제한한다", () => {
  assert.match(route, /MAX_BODY_BYTES = 64 \* 1024/);
  assert.match(route, /STIZ_OPERATIONS_EVENT_SECRET/);
  assert.match(route, /secret\.length < 32/);
  assert.match(route, /STIZ_OPERATIONS_EVENT_USER_ID/);
  assert.match(route, /status: 413/);
  assert.match(route, /status: 503/);
});

test("외부 eventId는 unique 명령 키로 멱등 접수한다", () => {
  assert.match(route, /operationsEventIdempotencyKey\(event\.source, event\.eventId\)/);
  assert.match(policy, /OPERATIONS_EVENT\|\$\{source\}\|\$\{eventId\.trim\(\)\}/);
  assert.match(route, /WHERE "idempotencyKey"=\$1 LIMIT 1/);
  assert.match(route, /ON CONFLICT \("idempotencyKey"\) DO NOTHING RETURNING id/);
  assert.match(route, /duplicate: true/);
});

test("같은 이벤트 ID의 내용이 달라지면 감사 기록 후 409로 차단한다", () => {
  assert.match(route, /operationsEventPayloadFingerprint\(event\)/);
  assert.match(route, /assertOperationsEventPayloadMatch\(storedFingerprint, incomingFingerprint\)/);
  assert.match(route, /!payloadMatches\(existing\[0\]\.payloadFingerprint, payloadFingerprint\)/);
  assert.match(route, /OPERATIONS_EVENT_CONFLICT/);
  assert.match(route, /PAYLOAD_FINGERPRINT_MISMATCH/);
  assert.match(route, /status: 409/);
});

test("접수는 승인 전 원장만 만들고 실제 동기화나 알림은 실행하지 않는다", () => {
  assert.match(route, /"OperationsRequest"[\s\S]*'DRAFT'/);
  assert.match(route, /holdReason \? "HELD" : "PENDING"/);
  assert.match(route, /'HELD','HELD'/);
  assert.match(route, /OPERATIONS_EVENT_RECEIVED/);
  assert.doesNotMatch(route, /sendSms|sendNotification|applyOperationsSyncRequest|fetch\(/);
});

test("안정적인 학생 식별값이나 변경 종류가 모호하면 HELD 처리한다", () => {
  assert.match(route, /operationsEventPayloadHoldReason\(event\)/);
  assert.match(policy, /!event\.change\.studentId \? "안정적인 학생 식별값이 없습니다/);
  assert.match(policy, /event\.change\.kind === "UNKNOWN"/);
  assert.match(route, /"mergedIntoStudentId" IS NULL/);
  assert.match(route, /전달된 학생 식별값을 운영 사이트에서 찾지 못했습니다/);
  assert.match(route, /resolvedStudent\?\.id \?\? null/);
});

test("공용 검증기가 실제 달력일·월·객체 구조를 fail closed 검증한다", () => {
  assert.match(route, /normalizeOperationsEventPayload\(JSON\.parse\(rawBody\)\)/);
  assert.match(policy, /isExactOperationsDate\(effectiveDate\)/);
  assert.match(policy, /effectiveDate\.slice\(0, 7\) !== effectiveMonth/);
  assert.match(policy, /before !== null && !isPlainOperationsObject\(before\)/);
  assert.match(policy, /!isPlainOperationsObject\(after\)/);
});

test("수강 종류별 반·상태 필수값 누락은 HELD 사유가 된다", () => {
  assert.match(policy, /수강 변경 대상 반 식별값이 없습니다/);
  assert.match(policy, /수강 변경 후 상태가 없습니다/);
  assert.match(policy, /변경 전 반 식별값이 없습니다/);
  assert.match(route, /holdReason \? "HELD" : "PENDING"/);
});
