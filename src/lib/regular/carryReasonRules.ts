// 결석 이월 «대상 사유 ↔ 인정 분류» 짝 규칙(2026-11-17 원장 결정) — 순수 모듈, import 0.
//
// 약관(«출석 및 결석에 따른 수업 이월 및 환불»): 이월(다음 달 수강료 1회분 차감)은
//   «수강생 본인 질병·부상»과 «직계 가족 경조사»만. 나머지 사유(개인 사정·가족 여행·학교 행사·기타)는 보강권.
//
// 서버(청구 준비 저장 resolveWorkbenchAbsence)·화면(청구 준비 이월 버튼)·학부모 신청(이월 검토로 보낼지)·
// 신청함 승인이 모두 이 파일 하나로 판정한다 — 한쪽만 다르면 «화면은 막는데 서버는 통과» 같은 구멍이 생긴다.
// ⚠️ import 를 넣지 마라: 청구 준비 테스트가 이 파일을 그대로 끼워 실행한다(의존이 생기면 테스트 로더가 못 푼다).

/** 질병·부상 사유 값 */
export const ILLNESS_INJURY_REASON = "ILLNESS_INJURY";
/** 직계 가족 경조사 사유 값 */
export const FAMILY_EVENT_REASON = "FAMILY_EVENT";

/** 청구 준비의 인정 분류(eligibility) 값 */
export type CarryEligibility = "ILLNESS_INJURY" | "DIRECT_FAMILY_EVENT";

/** 이월 대상 사유 → 그 사유와 짝이 맞는 인정 분류. 여기 없는 사유는 이월 대상이 아니다. */
export const CARRY_ELIGIBILITY_BY_REASON: Readonly<Record<string, CarryEligibility>> = {
  ILLNESS_INJURY: "ILLNESS_INJURY",
  FAMILY_EVENT: "DIRECT_FAMILY_EVENT",
};

/** 이월 검토(보강권 대신 원장 확인)로 가는 사유 목록 */
export const CARRY_REVIEW_REASONS: readonly string[] = Object.keys(CARRY_ELIGIBILITY_BY_REASON);

/** 약관상 이월 대상이 아닌 결석에 이월을 누르면 보이는 글(서버 오류·화면 안내 공용) */
export const CARRY_NOT_ELIGIBLE_MESSAGE = "약관상 이월 대상(질병·부상, 직계 경조사)이 아닌 결석은 보강으로만 처리됩니다";

/** 사유와 인정 분류가 어긋났을 때(예: 질병 결석을 경조사로 이월) */
export const CARRY_PAIR_MISMATCH_MESSAGE = "결석 사유와 인정 분류를 확인해 주세요.";

/** 이 사유가 이월 검토 대상인가(질병·부상 · 직계 가족 경조사) */
export function isCarryReviewReason(reason: unknown): boolean {
  // hasOwnProperty — "toString" 같은 객체 기본 이름이 통과하지 않게
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(CARRY_ELIGIBILITY_BY_REASON, reason);
}

/** 사유에 맞는 인정 분류. 이월 대상이 아니면 null */
export function carryEligibilityForReason(reason: unknown): CarryEligibility | null {
  return isCarryReviewReason(reason) ? CARRY_ELIGIBILITY_BY_REASON[reason as string] : null;
}

/**
 * 이월(CARRY)을 허용할 수 없는 이유 한 줄. 허용이면 null.
 *  - 사유가 이월 대상이 아니면(개인 사정·가족 여행·학교 행사·기타·사유 없음) → CARRY_NOT_ELIGIBLE_MESSAGE
 *  - 사유는 이월 대상인데 고른 분류가 짝이 아니면 → CARRY_PAIR_MISMATCH_MESSAGE
 */
export function carryPairProblem(eligibility: unknown, reason: unknown): string | null {
  const expected = carryEligibilityForReason(reason);
  if (!expected) return CARRY_NOT_ELIGIBLE_MESSAGE;
  return eligibility === expected ? null : CARRY_PAIR_MISMATCH_MESSAGE;
}
