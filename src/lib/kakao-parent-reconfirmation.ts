import { createHash } from "node:crypto";

export type KakaoReconfirmationPayload = {
  intakeId: string;
  requestId: string;
  commandId: string;
  studentId: string;
  kind: string;
  effectiveDate: string;
  fromClassId: string | null;
  toClassId: string | null;
  shuttleIntent: string | null;
  details: string;
  fromClass: KakaoReconfirmationClassSnapshot | null;
  toClass: KakaoReconfirmationClassSnapshot | null;
};

export type KakaoReconfirmationClassSnapshot = {
  id: string;
  programName: string;
  className: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildKakaoReconfirmationPayload(input: {
  intakeId: string;
  requestId: string;
  commandId: string;
  studentId: string | null;
  kind: string;
  afterJson: Record<string, unknown> | null;
  fromClass?: KakaoReconfirmationClassSnapshot | null;
  toClass?: KakaoReconfirmationClassSnapshot | null;
}): KakaoReconfirmationPayload | null {
  const plan = input.afterJson ?? {};
  const studentId = clean(input.studentId);
  const effectiveDate = clean(plan.effectiveDate);
  if (!input.intakeId || !input.requestId || !input.commandId || !studentId || !effectiveDate) return null;
  const fromClassId = clean(plan.fromClassId) || null;
  const toClassId = clean(plan.toClassId) || null;
  if ((fromClassId && input.fromClass?.id !== fromClassId) || (!fromClassId && input.fromClass)) return null;
  if ((toClassId && input.toClass?.id !== toClassId) || (!toClassId && input.toClass)) return null;
  return {
    intakeId: input.intakeId,
    requestId: input.requestId,
    commandId: input.commandId,
    studentId,
    kind: input.kind,
    effectiveDate,
    fromClassId,
    toClassId,
    shuttleIntent: clean(plan.shuttleIntent) || null,
    details: clean(plan.details),
    fromClass: input.fromClass ?? null,
    toClass: input.toClass ?? null,
  };
}

export function formatKakaoReconfirmationClassLabel(value: KakaoReconfirmationClassSnapshot | null) {
  return value ? `${value.programName} · ${value.className} · ${value.dayOfWeek} ${value.startTime}-${value.endTime}` : null;
}

export function kakaoReconfirmationPayloadHash(payload: KakaoReconfirmationPayload) {
  // 필드 순서가 고정된 payload만 해시해 관리자 보완 뒤 내용이 바뀌면 기존 링크를 무효화한다.
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function kakaoReconfirmationTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
