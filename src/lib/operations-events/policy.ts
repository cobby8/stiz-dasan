import { createHash } from "node:crypto";

export type WebsiteOperationsEventKind =
  | "PAUSE"
  | "WITHDRAW"
  | "RESUME"
  | "CLASS_CHANGE"
  | "CLASS_ADD"
  | "SHUTTLE_START"
  | "SHUTTLE_STOP"
  | "SHUTTLE_EXEMPT"
  | "SHUTTLE_CHANGE"
  | "CONTACT_UPDATE"
  | "BILLING_CORRECTION";

export const OPERATIONS_EVENT_SOURCES = ["SHEET", "RALLYZ", "WEBSITE"] as const;
export type OperationsEventSource = (typeof OPERATIONS_EVENT_SOURCES)[number];
export type OperationsEventKind = WebsiteOperationsEventKind | "UNKNOWN";

export type NormalizedOperationsEvent = {
  eventId: string;
  source: OperationsEventSource;
  occurredAt: string;
  change: {
    kind: OperationsEventKind;
    effectiveMonth: string;
    effectiveDate: string | null;
    studentId: string | null;
    studentName: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  };
};

export type WebsiteOperationsEvent = {
  /** 호출한 기능이 재시도해도 변하지 않는 원본 변경 ID입니다. */
  eventId: string;
  eventType: string;
  actorUserId: string;
  studentId: string;
  studentName: string;
  kind: WebsiteOperationsEventKind;
  effectiveDate: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  summary: string;
};

const OPERATIONS_KINDS = new Set<OperationsEventKind>([
  "PAUSE", "WITHDRAW", "RESUME", "CLASS_CHANGE", "CLASS_ADD",
  "SHUTTLE_START", "SHUTTLE_STOP", "SHUTTLE_EXEMPT", "SHUTTLE_CHANGE",
  "CONTACT_UPDATE", "BILLING_CORRECTION", "UNKNOWN",
]);

const cleanText = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function isPlainOperationsObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isExactOperationsDate(value: string) {
  const match = value.match(/^(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/);
  if (!match) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3]);
}

export function operationsEventIdempotencyKey(source: OperationsEventSource, eventId: string) {
  if (!OPERATIONS_EVENT_SOURCES.includes(source) || !eventId.trim()) throw new Error("EVENT_IDENTITY_INVALID");
  return createHash("sha256").update(`OPERATIONS_EVENT|${source}|${eventId.trim()}`).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isPlainOperationsObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

export function operationsEventPayloadFingerprint(normalized: NormalizedOperationsEvent | WebsiteOperationsEvent) {
  const payload = "change" in normalized
    ? { eventId: normalized.eventId, source: normalized.source, change: normalized.change }
    : {
        eventId: normalized.eventId,
        source: "WEBSITE",
        eventType: normalized.eventType,
        studentId: normalized.studentId,
        kind: normalized.kind,
        effectiveDate: normalized.effectiveDate,
        before: normalized.before,
        after: normalized.after,
      };
  // 재전송 시각·표시 문구·담당자는 실제 변경 내용이 아니므로 충돌 지문에서 제외합니다.
  return createHash("sha256").update(JSON.stringify(canonicalJson(payload))).digest("hex");
}

export function assertOperationsEventPayloadMatch(storedFingerprint: string | null | undefined, incomingFingerprint: string) {
  if (!storedFingerprint || storedFingerprint !== incomingFingerprint) {
    throw new Error("EVENT_PAYLOAD_COLLISION: 같은 이벤트 ID에 서로 다른 변경 내용이 전달되었습니다.");
  }
}

function requiredEnrollmentPayloadReason(event: NormalizedOperationsEvent) {
  const { kind, before, after } = event.change;
  const afterClassId = cleanText(after.classId, 100);
  const afterStatus = cleanText(after.status, 20);
  if (["CLASS_ADD", "PAUSE", "WITHDRAW", "RESUME", "CLASS_CHANGE"].includes(kind) && !afterClassId) {
    return "수강 변경 대상 반 식별값이 없습니다.";
  }
  if (["CLASS_ADD", "PAUSE", "WITHDRAW", "RESUME", "CLASS_CHANGE"].includes(kind) && !afterStatus) {
    return "수강 변경 후 상태가 없습니다.";
  }
  if (kind === "CLASS_CHANGE" && !cleanText(before?.classId, 100)) return "변경 전 반 식별값이 없습니다.";
  const expectedStatus = kind === "PAUSE" ? "PAUSED" : kind === "WITHDRAW" ? "WITHDRAWN" : kind === "RESUME" ? "ACTIVE" : null;
  if (expectedStatus && afterStatus !== expectedStatus) return `${kind} 변경 후 상태는 ${expectedStatus}여야 합니다.`;
  return null;
}

export function operationsEventPayloadHoldReason(event: NormalizedOperationsEvent) {
  const adapterHoldReason = !["PAUSE", "WITHDRAW", "UNKNOWN"].includes(event.change.kind)
    ? `${event.change.kind} 변경은 시트·랠리즈 전용 동기화 어댑터가 아직 없어 확인보류합니다.`
    : null;
  const reasons = [
    !event.change.studentId ? "안정적인 학생 식별값이 없습니다." : null,
    event.change.kind === "UNKNOWN" ? "변경 종류를 확인해야 합니다." : null,
    !event.change.effectiveDate ? "정확한 적용일이 없습니다." : null,
    requiredEnrollmentPayloadReason(event),
    adapterHoldReason,
  ].filter(Boolean);
  return reasons.join(" ") || null;
}

/** 외부 이벤트를 공용 형식으로 정규화합니다. 구조·날짜·월이 틀리면 접수 자체를 거부합니다. */
export function normalizeOperationsEventPayload(value: unknown): NormalizedOperationsEvent {
  if (!isPlainOperationsObject(value) || !isPlainOperationsObject(value.change)) throw new Error("EVENT_INVALID");
  const eventId = cleanText(value.eventId, 160);
  const source = cleanText(value.source, 20) as OperationsEventSource;
  const occurredAt = cleanText(value.occurredAt, 40);
  const kind = cleanText(value.change.kind, 40) as OperationsEventKind;
  const effectiveMonth = cleanText(value.change.effectiveMonth, 7);
  const effectiveDate = cleanText(value.change.effectiveDate, 10) || null;
  const before = value.change.before == null ? null : value.change.before;
  const after = value.change.after;

  if (!eventId || !OPERATIONS_EVENT_SOURCES.includes(source)) throw new Error("EVENT_INVALID");
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) throw new Error("EVENT_INVALID");
  if (!OPERATIONS_KINDS.has(kind) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(effectiveMonth)) throw new Error("EVENT_INVALID");
  if (effectiveDate && (!isExactOperationsDate(effectiveDate) || effectiveDate.slice(0, 7) !== effectiveMonth)) {
    throw new Error("EVENT_EFFECTIVE_DATE_INVALID");
  }
  if (before !== null && !isPlainOperationsObject(before)) throw new Error("EVENT_BEFORE_INVALID");
  if (!isPlainOperationsObject(after)) throw new Error("EVENT_AFTER_INVALID");

  return {
    eventId,
    source,
    occurredAt: new Date(occurredAt).toISOString(),
    change: {
      kind,
      effectiveMonth,
      effectiveDate,
      studentId: cleanText(value.change.studentId, 100) || null,
      studentName: cleanText(value.change.studentName, 80) || null,
      before,
      after,
    },
  };
}

export function prepareWebsiteOperationsEvent(input: WebsiteOperationsEvent) {
  if (!input.eventId.trim() || !input.eventType.trim()) throw new Error("운영 변경의 안정적인 이벤트 ID와 종류가 필요합니다.");
  if (!input.actorUserId.trim() || !input.studentId.trim()) throw new Error("운영 변경의 담당자와 학생 식별값이 필요합니다.");
  if (!isExactOperationsDate(input.effectiveDate)) {
    throw new Error("운영 변경 적용일은 YYYY-MM-DD 형식이어야 합니다.");
  }
  if ((input.before !== null && !isPlainOperationsObject(input.before)) || !isPlainOperationsObject(input.after)) {
    throw new Error("운영 변경 전후 값은 객체여야 합니다.");
  }
  if (!input.summary.trim()) throw new Error("운영 변경 요약이 필요합니다.");

  const targetMonth = input.effectiveDate.slice(0, 7);
  const normalized = normalizeOperationsEventPayload({
    eventId: input.eventId,
    source: "WEBSITE",
    occurredAt: new Date().toISOString(),
    change: {
      kind: input.kind,
      effectiveMonth: targetMonth,
      effectiveDate: input.effectiveDate,
      studentId: input.studentId,
      studentName: input.studentName,
      before: input.before,
      after: input.after,
    },
  });
  const structureHoldReason = requiredEnrollmentPayloadReason(normalized);
  if (structureHoldReason) throw new Error(`운영 변경 데이터가 불완전합니다. ${structureHoldReason}`);

  return {
    targetMonth,
    sourceText: `[사이트 변경] ${input.summary.trim()}`,
    idempotencyKey: operationsEventIdempotencyKey("WEBSITE", input.eventId),
    payloadFingerprint: operationsEventPayloadFingerprint(normalized),
    holdReason: operationsEventPayloadHoldReason(normalized),
  };
}
