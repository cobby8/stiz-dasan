/**
 * 구글 시트 원장 은퇴 스위치 (2026-10-06 원장 결정 — Phase 2 시트 종료).
 *
 * 원장이 2026년 10월부터 구글 시트 원장을 새로 만들지 않는다. 그래서 휴원·퇴원 동기화의
 * 확인 칸 3개(SHEET·RALLYZ·WEBSITE) 중 SHEET 는 처음부터 "건너뜀(SKIPPED)"으로 만들고,
 * 완료 판정에서도 SHEET 는 SUCCEEDED 또는 SKIPPED 면 통과시킨다.
 *
 * 되돌리기: 환경변수 STIZ_SHEET_SYNC_RETIRED 를 "0" 으로 두면 옛 3칸 방식(시트도 PENDING)으로 돌아간다.
 * 시트 쓰기 코드(applySheetEnrollmentStatus)는 되돌림용으로 지우지 않고 남겨 둔다.
 *
 * ⚠️ 이 파일은 다른 모듈을 import 하지 않는다 — 테스트(node --test)가 직접 불러 실행한다.
 */

/** 은퇴로 건너뛴 SHEET 시도에 남기는 표식(externalReference). 사람이 고친 MANUAL:<id> 와 구분된다. */
export const SHEET_RETIRED_REFERENCE = "SHEET_RETIRED";

/**
 * 시트 동기화가 은퇴 상태인가?
 * 기본값 = 은퇴(true). 값이 정확히 "0" 일 때만 옛 방식(false).
 * (앞뒤 공백·줄바꿈은 무시한다 — 대시보드에 붙여 넣을 때 줄바꿈이 섞이는 일이 잦다.)
 * env 는 서버 코드에서 process.env 를 넘긴다. 기본값을 두지 않는 이유: 이 파일은 화면(클라이언트)
 * 번들에도 들어가므로 여기서 process.env 를 직접 읽지 않는다.
 */
export function isSheetSyncRetired(env: Record<string, string | undefined>): boolean {
  return env.STIZ_SHEET_SYNC_RETIRED?.trim() !== "0";
}

/** SHEET 칸이 "끝난" 상태인가 — 실제 반영 성공(SUCCEEDED) 또는 은퇴로 건너뜀(SKIPPED). */
export function isSheetTargetDone(status: string | null | undefined): boolean {
  return status === "SUCCEEDED" || status === "SKIPPED";
}

/**
 * 새 동기화 시도(OperationsSyncAttempt)를 만들 때의 처음 상태.
 * - 은퇴 상태의 SHEET → SKIPPED + 표식. verifiedAt 은 NULL(실제로 확인한 적이 없으므로 — 판정은 SKIPPED 만 본다).
 * - 그 외 → PENDING (WEBSITE 를 이미 끝낸 경우는 호출하는 쪽이 따로 SUCCEEDED 로 넣는다).
 */
export function initialSyncAttempt(target: string, retired: boolean): { status: "PENDING" | "SKIPPED"; externalReference: string | null } {
  if (target === "SHEET" && retired) return { status: "SKIPPED", externalReference: SHEET_RETIRED_REFERENCE };
  return { status: "PENDING", externalReference: null };
}
