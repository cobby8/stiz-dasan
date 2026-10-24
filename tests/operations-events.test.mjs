import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import {
  assertOperationsEventPayloadMatch,
  normalizeOperationsEventPayload,
  operationsEventPayloadHoldReason,
  operationsEventPayloadFingerprint,
  prepareWebsiteOperationsEvent,
} from "../src/lib/operations-events/policy.ts";

const EVENT = {
  eventId: "enrollment:abc:2026-09-01:resume",
  eventType: "ENROLLMENT_RESUMED",
  actorUserId: "admin-1",
  studentId: "student-1",
  studentName: "박찬민",
  kind: "RESUME",
  effectiveDate: "2026-09-01",
  before: { status: "PAUSED" },
  after: { status: "ACTIVE", classId: "adult-tue" },
  summary: "박찬민 화요일 성인반 복귀",
};

test("같은 원본 변경은 표시 문구가 달라도 같은 멱등 키를 만든다", () => {
  const first = prepareWebsiteOperationsEvent(EVENT);
  const retried = prepareWebsiteOperationsEvent({ ...EVENT, summary: "표시 문구만 수정됨" });
  assert.equal(first.idempotencyKey, retried.idempotencyKey);
  assert.equal(first.payloadFingerprint, retried.payloadFingerprint);
  assert.equal(first.targetMonth, "2026-09");
});

test("같은 출처·ID인데 payload가 달라지면 정상 중복이 아닌 충돌이다", () => {
  const first = prepareWebsiteOperationsEvent(EVENT);
  const changed = prepareWebsiteOperationsEvent({ ...EVENT, after: { status: "ACTIVE", classId: "adult-wed" } });
  assert.equal(first.idempotencyKey, changed.idempotencyKey);
  assert.notEqual(first.payloadFingerprint, changed.payloadFingerprint);
  assert.throws(() => assertOperationsEventPayloadMatch(first.payloadFingerprint, changed.payloadFingerprint), /EVENT_PAYLOAD_COLLISION/);
});

test("내부·외부 이벤트는 같은 semantic payload에 같은 지문을 사용한다", () => {
  const internal = prepareWebsiteOperationsEvent(EVENT);
  const external = normalizeOperationsEventPayload({
    eventId: EVENT.eventId,
    source: "WEBSITE",
    occurredAt: "2026-08-27T00:00:00.000Z",
    change: {
      kind: EVENT.kind,
      effectiveMonth: EVENT.effectiveDate.slice(0, 7),
      effectiveDate: EVENT.effectiveDate,
      studentId: EVENT.studentId,
      studentName: EVENT.studentName,
      before: EVENT.before,
      after: EVENT.after,
    },
  });
  assert.equal(internal.payloadFingerprint, operationsEventPayloadFingerprint(external));
});

test("외부 이벤트의 실제 날짜와 적용월이 일치해야 한다", () => {
  const input = {
    eventId: "sheet-1",
    source: "SHEET",
    occurredAt: "2026-08-27T00:00:00.000Z",
    change: {
      kind: "RESUME",
      effectiveMonth: "2026-09",
      effectiveDate: "2026-09-01",
      studentId: "student-1",
      before: { classId: "adult-tue", status: "PAUSED" },
      after: { classId: "adult-tue", status: "ACTIVE" },
    },
  };
  const normalized = normalizeOperationsEventPayload(input);
  assert.match(operationsEventPayloadFingerprint(normalized), /^[a-f0-9]{64}$/);
  assert.throws(() => normalizeOperationsEventPayload({ ...input, change: { ...input.change, effectiveDate: "2026-02-31", effectiveMonth: "2026-02" } }), /EVENT_EFFECTIVE_DATE_INVALID/);
  assert.throws(() => normalizeOperationsEventPayload({ ...input, change: { ...input.change, effectiveMonth: "2026-08" } }), /EVENT_EFFECTIVE_DATE_INVALID/);
});

test("전후 값 배열과 수강 필수값 누락은 통과시키지 않는다", () => {
  const base = {
    eventId: "sheet-2",
    source: "SHEET",
    occurredAt: "2026-08-27T00:00:00.000Z",
    change: { kind: "RESUME", effectiveMonth: "2026-09", effectiveDate: "2026-09-01", studentId: "student-1" },
  };
  assert.throws(() => normalizeOperationsEventPayload({ ...base, change: { ...base.change, before: [], after: {} } }), /EVENT_BEFORE_INVALID/);
  assert.throws(() => normalizeOperationsEventPayload({ ...base, change: { ...base.change, before: null, after: [] } }), /EVENT_AFTER_INVALID/);
  assert.throws(() => prepareWebsiteOperationsEvent({ ...EVENT, after: {} }), /대상 반 식별값/);
});

test("미지원 복귀·셔틀·연락처·청구 이벤트는 명시적으로 HELD 사유를 만든다", () => {
  const common = {
    eventId: "event-unsupported",
    source: "RALLYZ",
    occurredAt: "2026-08-27T00:00:00.000Z",
    change: { effectiveMonth: "2026-09", effectiveDate: "2026-09-01", studentId: "student-1", before: null },
  };
  const cases = [
    { kind: "RESUME", after: { classId: "class-1", status: "ACTIVE" } },
    { kind: "SHUTTLE_CHANGE", after: {} },
    { kind: "CONTACT_UPDATE", after: {} },
    { kind: "BILLING_CORRECTION", after: {} },
  ];
  for (const item of cases) {
    const event = normalizeOperationsEventPayload({ ...common, change: { ...common.change, ...item } });
    assert.match(operationsEventPayloadHoldReason(event) || "", /전용 동기화 어댑터/);
  }
});

test("원장은 홈페이지 완료, 시트·랠리즈 대기이며 청구·알림을 보류한다", () => {
  const source = fs.readFileSync(new URL("../src/lib/operations-events/index.ts", import.meta.url), "utf8");
  assert.match(source, /'HELD','HELD'/);
  assert.match(source, /target === "WEBSITE"/);
  // 2026-10-06 시트 은퇴: 홈페이지 외 칸은 initialSyncAttempt 가 정한다(시트=은퇴 시 SKIPPED, 랠리즈=PENDING).
  assert.match(source, /websiteDone \? "SUCCEEDED" : initial\.status/);
  assert.match(source, /initialSyncAttempt\(target, sheetRetired\)/);
  assert.match(source, /ON CONFLICT \("idempotencyKey"\) DO NOTHING/);
  assert.match(source, /DELETE FROM "OperationsRequest" WHERE id=\$1/);
});

test("안정적인 식별값이나 정확한 적용일이 없으면 원장에 넣지 않는다", () => {
  assert.throws(() => prepareWebsiteOperationsEvent({ ...EVENT, eventId: "", effectiveDate: "9월" }), /이벤트 ID/);
  assert.throws(() => prepareWebsiteOperationsEvent({ ...EVENT, effectiveDate: "2026-02-31" }), /YYYY-MM-DD/);
});
