/**
 * 「시트 직접 수정 완료」(시트 수동 확인)의 보류 해제 판정 — DB·서버 의존이 없는 순수 함수.
 *
 * 보류(HELD)는 "사람이 다시 봐야 한다"는 신호다. 시트를 직접 고쳤다는 확인으로 풀어도 되는 건
 * 보류 원인이 시트 쪽일 때뿐이다. 외부 이벤트의 정책 보류(학생 식별값 없음·적용일 없음 등)는
 * 시트를 고친다고 해결되지 않으므로 여기서 풀지 않는다.
 */

/** 외부 이벤트 정책의 복귀 어댑터 미지원 보류 문구(src/lib/operations-events/policy.ts 와 같은 문장) */
export const RESUME_ADAPTER_HOLD_REASON = "RESUME 변경은 시트·랠리즈 전용 동기화 어댑터가 아직 없어 확인보류합니다.";

export type SheetHoldReleaseInput = {
  kind: string;
  studentId: string | null;
  /** 원장 afterJson 의 enrollmentChangeRequestId — 수강 변경 신청과 연결된 건만 이 화면에서 다룬다 */
  enrollmentChangeRequestId: string | null;
  holdReason: string | null;
  sheetStatus: string | null;
  sheetError: string | null;
};

/** HELD 를 PENDING 으로 풀어도 되는지. 안 되면 화면에 그대로 보여 줄 한국어 사유를 돌려준다. */
export function sheetHoldReleaseDecision(input: SheetHoldReleaseInput): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!input.studentId) return refuse("학생이 확정되지 않은 보류 건이라 시트 수동 확인으로 풀 수 없습니다. 학생을 먼저 확인해 주세요.");
  if (!input.enrollmentChangeRequestId) return refuse("수강 변경 신청과 연결되지 않은 보류 건이라 시트 수동 확인으로 풀 수 없습니다.");
  const reason = input.holdReason?.trim() ?? "";
  // ① 시트 자동 반영 중 공통 상태 충돌로 보류 → 시트 시도가 FAILED 이고 그 오류가 곧 보류 사유다
  const fromSheetConflict = input.sheetStatus === "FAILED" && reason !== "" && reason === (input.sheetError?.trim() ?? "");
  // ② 복귀(RESUME)는 시트 자동 반영 어댑터가 없어 보류된 것(다른 정책 사유가 섞이지 않은 경우만)
  const fromResumeAdapter = input.kind === "RESUME" && reason === RESUME_ADAPTER_HOLD_REASON;
  if (fromSheetConflict || fromResumeAdapter) return { ok: true };
  return refuse("시트와 무관한 이유로 보류된 건이라 시트 수동 확인으로 풀 수 없습니다. 보류 사유를 먼저 확인해 주세요.");
}

/** 화면 표시용 보류 사유. 영문 종류 코드가 섞인 문구는 한국어로 다듬는다(저장값은 그대로). */
export function sheetHoldDisplayReason(kind: string, holdReason: string | null): string {
  if (kind === "RESUME" && holdReason?.trim() === RESUME_ADAPTER_HOLD_REASON) {
    return "복귀는 시트 자동 반영을 지원하지 않습니다";
  }
  return holdReason ?? "관리자 확인 필요";
}
