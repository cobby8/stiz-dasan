// ── 적용일이 된 수강 변경 신청을 "사이트에 자동 적용할지 / 보류할지" 판정 ─────────
//
// 원장 결정(2026-10-05, 선택지 A): 승인된 휴원·퇴원은 적용일에 크론이 사이트 수강 상태를
// 바로 바꾼다. 시트·랠리즈는 자동으로 건드리지 않고 "확인 필요"로 남긴다.
// 반 변경(CLASS_CHANGE)은 지금처럼 사람이 확인한다(보류).
//
// DB 를 읽지 않는 순수 함수라서 테스트가 실제로 실행해 판정을 확인할 수 있다.

export type DueEnrollmentSnapshot = {
  studentId: string;
  classId: string;
  status: string;
} | null;

export type DueChangePlan =
  | { action: "APPLY"; expectedStatus: string; nextStatus: "PAUSED" | "WITHDRAWN" }
  | { action: "HOLD"; reason: string };

/** 자동 적용 대상 종류별: 바꿔도 되는 현재 상태 → 바꿀 상태 */
const AUTO_APPLY: Record<string, { from: string[]; to: "PAUSED" | "WITHDRAWN"; label: string }> = {
  // 휴원은 다니고 있는 학생만. 이미 휴원이면 사람이 확인한다.
  PAUSE: { from: ["ACTIVE"], to: "PAUSED", label: "휴원" },
  // 퇴원은 다니는 중이거나 휴원 중인 학생 모두 가능하다.
  WITHDRAW: { from: ["ACTIVE", "PAUSED"], to: "WITHDRAWN", label: "퇴원" },
};

export const DEFAULT_HOLD_REASON = "시트·Rallyz 반영 및 세 시스템 재조회 승인 대기";

export function planDueEnrollmentChange(input: {
  kind: string;
  studentId: string;
  fromClassId: string | null;
  enrollment: DueEnrollmentSnapshot;
  /** 신청한 보호자가 지금도 그 학생의 보호자인지 */
  parentConfirmed: boolean;
  /** 반 변경일 때 희망 반 검사 결과(문제 없으면 null). 호출하는 쪽이 DB 로 확인해 넘긴다. */
  classChangeProblem?: string | null;
}): DueChangePlan {
  const { enrollment } = input;
  // 보호자 연결이 끊겼으면 무엇보다 먼저 사람이 확인해야 한다(기존 우선순위 유지).
  if (!input.parentConfirmed) return { action: "HOLD", reason: "신청 보호자와 현재 학생 연결 재확인 필요" };

  // 학생·반이 신청 당시와 다르면 신청 내용이 지금 수강과 맞지 않는다.
  if (!enrollment || enrollment.studentId !== input.studentId || enrollment.classId !== input.fromClassId) {
    return { action: "HOLD", reason: "신청 이후 현재 수강 상태가 변경됨: 관리자 재확인 필요" };
  }

  const rule = AUTO_APPLY[input.kind];
  if (rule) {
    // 이미 목표 상태 = 누군가 먼저 바꿨다. 두 번 적용하지 않고 사람이 원장(시트·랠리즈)을 맞춘다.
    if (enrollment.status === rule.to) {
      return { action: "HOLD", reason: `이미 ${rule.label} 상태라 자동 적용하지 않음: 관리자 확인 필요` };
    }
    if (!rule.from.includes(enrollment.status)) {
      return { action: "HOLD", reason: `예상 밖 수강 상태(${enrollment.status})라 자동 적용하지 않음: 관리자 재확인 필요` };
    }
    return { action: "APPLY", expectedStatus: enrollment.status, nextStatus: rule.to };
  }

  if (input.kind === "CLASS_CHANGE") {
    // 반 변경은 자동 적용하지 않는다. 사유만 정확히 남겨 보류한다.
    if (enrollment.status !== "ACTIVE") {
      return { action: "HOLD", reason: "신청 이후 현재 수강 상태가 변경됨: 관리자 재확인 필요" };
    }
    return { action: "HOLD", reason: input.classChangeProblem || DEFAULT_HOLD_REASON };
  }

  return { action: "HOLD", reason: "지원되지 않는 수강 변경" };
}
