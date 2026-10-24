import type { WebsiteOperationsEvent, WebsiteOperationsEventKind } from "./policy";

type EnrollmentStatus = "ACTIVE" | "PAUSED" | "WITHDRAWN";

const STATUS_EVENT: Record<EnrollmentStatus, { eventType: string; kind: WebsiteOperationsEventKind; label: string }> = {
  ACTIVE: { eventType: "ENROLLMENT_RESUMED", kind: "RESUME", label: "수강 복귀" },
  PAUSED: { eventType: "ENROLLMENT_PAUSED", kind: "PAUSE", label: "휴원" },
  WITHDRAWN: { eventType: "ENROLLMENT_WITHDRAWN", kind: "WITHDRAW", label: "퇴원" },
};

function seoulDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function buildEnrollmentOperationsEvent(input: {
  enrollmentId: string;
  changedAt: Date;
  actorUserId: string;
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  previousStatus: EnrollmentStatus | null;
  nextStatus: EnrollmentStatus;
  enrollmentApplicationId?: string;
  /** 관리자 직접 변경이 남긴 수강 변경 이력(EnrollmentChangeRequest) id. 「수강 변경 신청」 화면이 이 값으로 원장을 찾는다. */
  enrollmentChangeRequestId?: string;
}): WebsiteOperationsEvent | null {
  if (input.previousStatus === input.nextStatus) return null;

  const transition = input.previousStatus === null
    ? { eventType: "ENROLLMENT_CREATED", kind: "CLASS_ADD" as const, label: "수강 등록" }
    : STATUS_EVENT[input.nextStatus];

  const fromClassId = input.previousStatus === null ? null : input.classId;
  const toClassId = input.previousStatus === null ? input.classId : null;
  return {
    eventId: `Enrollment:${input.enrollmentId}:${input.changedAt.toISOString()}:${input.nextStatus}`,
    eventType: transition.eventType,
    actorUserId: input.actorUserId,
    studentId: input.studentId,
    studentName: input.studentName,
    kind: transition.kind,
    effectiveDate: seoulDate(input.changedAt),
    before: input.previousStatus === null
      ? null
      : { enrollmentId: input.enrollmentId, classId: input.classId, className: input.className, status: input.previousStatus },
    after: {
      enrollmentId: input.enrollmentId,
      classId: input.classId,
      className: input.className,
      status: input.nextStatus,
      effectiveDate: seoulDate(input.changedAt),
      fromClassId,
      toClassId,
      parentConfirmed: true,
      // 신청 출처만 연결하며, 외부 등록 완료를 의미하지 않습니다.
      ...(input.enrollmentApplicationId ? { enrollmentApplicationId: input.enrollmentApplicationId } : {}),
      // 직접 휴원·퇴원·복귀 이력 연결. 원장 키가 해시라 이 값이 없으면 화면에서 "확인 필요"를 못 띄운다.
      ...(input.enrollmentChangeRequestId ? { enrollmentChangeRequestId: input.enrollmentChangeRequestId } : {}),
    },
    summary: `${input.studentName} ${input.className} ${transition.label}`,
  };
}
