import type { EnrollmentShuttleProgress } from "./shuttle-progress";

export type RegistrationCheck = {
  key: string;
  label: string;
  status: "VERIFIED" | "CHECK_REQUIRED";
  detail: string;
};

export type RegistrationEvidence = {
  applicationId?: string;
  studentId: string | null;
  assignedClassIds: string[];
  activeClassIds: string[];
  requestedStartOn?: Date | string | null;
  enrollmentStarts?: Array<{ classId: string; startsOn: Date | string | null }>;
  shuttleNeeded: boolean;
  shuttleProgress?: EnrollmentShuttleProgress;
  commands: Array<{ id?: string; studentId?: string | null; kind?: string; status: string;
    effectiveMonth?: string; createdAt?: Date; afterJson?: unknown;
    syncAttempts: Array<{ target: string; status: string; verifiedAt: Date | null }> }>;
  invoiceCandidates: number;
  now?: number;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function instant(value: Date | undefined | null) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
function startDate(value: unknown): string | null {
  if (value == null) return null;
  const format = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? format(value) : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00+09:00`);
  return Number.isFinite(date.getTime()) && format(date) === value ? value : null;
}

// 승인 상태와 등록 절차 완료는 다릅니다. 서로 연결되지 않은 기록을 완료 증거로 승격하지 않습니다.
export function registrationReadiness(input: RegistrationEvidence) {
  const siteReady = Boolean(input.studentId) && input.assignedClassIds.length > 0
    && input.assignedClassIds.every((id) => input.activeClassIds.includes(id));
  const checks: RegistrationCheck[] = [{ key: "site", label: "사이트 반 배정", status: siteReady ? "VERIFIED" : "CHECK_REQUIRED", detail: siteReady ? "원생과 배정된 모든 반의 현재 수강 확인" : "학생 연결과 배정 반의 현재 수강 상태 확인 필요" }];
  const now = input.now ?? Date.now();
  const requestedStart = startDate(input.requestedStartOn);
  const startsMatch = Boolean(requestedStart) && input.assignedClassIds.length > 0 && input.assignedClassIds.every(id => {
    const starts = input.enrollmentStarts?.filter(row => row.classId === id) ?? [];
    return starts.length === 1 && startDate(starts[0].startsOn) === requestedStart;
  });
  const evidence = input.commands.map(command => {
    const after = object(command.afterJson);
    const event = object(after.operationsEvent);
    const applicationId = text(after.enrollmentApplicationId);
    const classId = text(after.classId);
    const enrollmentId = text(after.enrollmentId);
    const source = text(event.source);
    const createdAt = instant(command.createdAt);
    const reasons: string[] = ["확정 수강 시작일 근거 없음"];
    if (!input.applicationId || applicationId !== input.applicationId) reasons.push("신청 ID 미연결 또는 불일치");
    if (!input.studentId || command.studentId !== input.studentId) reasons.push("학생 ID 미연결 또는 불일치");
    if (!classId || !input.assignedClassIds.includes(classId)) reasons.push("배정 반 미연결 또는 불일치");
    if (!command.id || !enrollmentId) reasons.push("명령 또는 수강 ID 누락");
    if (source !== "WEBSITE" || command.kind !== "CLASS_ADD") reasons.push("사이트 신규 등록 증거가 아님");
    if (["CANCELED", "CANCELLED", "REJECTED", "FAILED", "HELD"].includes(command.status)) reasons.push("유효한 등록 처리 상태 확인 필요");
    if (siteReady && startsMatch && startDate(after.effectiveDate) === requestedStart && reasons.length === 1) reasons.shift();
    // 과거 시트 재조회 기록만 보여 준다(랠리즈 칸은 2026-11-18 화면에서 지웠다 — 은퇴로 늘 건너뜀).
    const targets = ["SHEET"].map(target => {
      const attempts = command.syncAttempts.filter(attempt => attempt.target === target);
      return { target, attempts: attempts.map(attempt => {
        const verifiedAt = instant(attempt.verifiedAt);
        let issue: string | null = null;
        // 시트 은퇴로 건너뛴 칸은 실패가 아니라 "확인 대상 아님"이다.
        if (attempt.status === "SKIPPED") issue = "시트 운영 종료로 건너뜀";
        else if (attempt.status !== "SUCCEEDED") issue = "재조회 성공 상태 아님";
        else if (!verifiedAt) issue = "유효한 재조회 시각 없음";
        else if (!createdAt) issue = "명령 생성 시각 확인 필요";
        else if (Date.parse(verifiedAt) < Date.parse(createdAt)) issue = "명령 생성 전 재조회 기록";
        else if (Date.parse(verifiedAt) > now) issue = "미래 재조회 시각";
        return { status: attempt.status, verifiedAt, issue };
      }), duplicate: attempts.length > 1 };
    });
    return { commandId: command.id ?? null, applicationId, studentId: command.studentId ?? null,
      classId, enrollmentId, source, kind: command.kind ?? null, status: command.status,
      effectiveMonth: command.effectiveMonth ?? null, eventDate: text(after.effectiveDate), createdAt,
      reasons, targets };
  });
  // 바깥 장부(시트·랠리즈)는 둘 다 은퇴해 확인 항목을 만들지 않는다 — 확인할 곳이 없다.
  for (const [key, label, detail] of [
    ["invoice", "최초 청구서", `유효 청구 후보 ${input.invoiceCandidates}건. 최초 적용기간·반·일할계산·금액 대조 필요`],
    ["invoice-notification", "최초 청구 안내", "정확한 청구서와 연결된 발송 결과 확인 필요"],
    ["uniform", "유니폼·제품 안내", "홈페이지 /shop 안내 전달 및 유니폼 신청 여부 확인 필요"],
    ["teacher", "담당 선생님·연간일정 안내", "최종 배정 반의 담당자 및 연간일정 안내 전달 확인 필요"],
  ]) {
    checks.push({ key, label, detail, status: "CHECK_REQUIRED" });
  }
  if (input.shuttleNeeded) checks.push({ key: "shuttle", label: "셔틀 배차·기사님 안내", detail: input.shuttleProgress ? `${input.shuttleProgress.label} · ${input.shuttleProgress.detail}` : "승하차 장소·확정 시간·배정 기사 안내 전달 확인 필요", status: input.shuttleProgress?.status === "COMPLETE" ? "VERIFIED" : "CHECK_REQUIRED" });
  return { complete: checks.every((check) => check.status === "VERIFIED"), checks, evidence };
}
