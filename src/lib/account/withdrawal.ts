/**
 * 회원 탈퇴(계정 삭제) 판정 — DB 에 붙지 않은 순수 모듈.
 *
 * 왜 떼어 놓는가: 탈퇴는 한 번 실행하면 되돌릴 수 없고 개인정보가 걸려 있다.
 * "재학 중인데 즉시 지워버렸다" 같은 사고는 눈으로 읽어서 못 찾는다 — 실제로 돌려서 확인해야 한다.
 * 그래서 판정은 전부 여기 모으고 테스트로 못박는다. DB·Auth 호출은 서버 액션이 맡는다.
 */

/** 탈퇴 관련 두 시각으로 본 계정 상태. */
export type WithdrawalState =
  | "ACTIVE" // 정상 계정
  | "PENDING" // 탈퇴를 신청했고 원장 확인을 기다리는 중
  | "WITHDRAWN"; // 탈퇴 완료(로그인 수단 제거·익명화됨)

export type WithdrawalTimestamps = {
  withdrawRequestedAt?: Date | string | null;
  withdrawnAt?: Date | string | null;
};

function hasValue(value: Date | string | null | undefined): boolean {
  if (value == null) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const text = String(value).trim();
  if (!text) return false;
  return !Number.isNaN(new Date(text).getTime());
}

/**
 * 두 시각으로 상태를 정한다.
 * withdrawnAt 이 있으면 신청 시각이 비어 있어도 탈퇴 완료다 — 재학 중이 아니어서
 * 신청과 처리가 같은 순간에 끝난 경우가 있고, 그때 신청 시각이 비어도 완료는 완료다.
 */
export function withdrawalState(user: WithdrawalTimestamps): WithdrawalState {
  if (hasValue(user.withdrawnAt)) return "WITHDRAWN";
  if (hasValue(user.withdrawRequestedAt)) return "PENDING";
  return "ACTIVE";
}

/** 탈퇴를 새로 신청할 수 있는 상태인가. 이미 신청했거나 탈퇴한 계정은 다시 신청하지 않는다. */
export function canRequestWithdrawal(user: WithdrawalTimestamps): boolean {
  return withdrawalState(user) === "ACTIVE";
}

/** 신청을 취소할 수 있는 상태인가. 이미 처리된 탈퇴는 되돌릴 수 없다. */
export function canCancelWithdrawalRequest(user: WithdrawalTimestamps): boolean {
  return withdrawalState(user) === "PENDING";
}

export type WithdrawalDecision =
  /** 재학 중이 아니다 — 신청과 동시에 바로 처리한다. */
  | { action: "EXECUTE_NOW" }
  /**
   * 재학 중이다 — 신청만 접수하고 원장이 확인한다.
   * 수업 다니는 아이의 보호자 연락이 끊기면 현장에서 바로 사고가 된다(원장 결정 2026-10-24).
   */
  | { action: "REQUEST_ONLY"; activeEnrollmentCount: number };

/**
 * 즉시 처리할지 신청만 받을지 정한다.
 * 수강 중인 반이 하나라도 있으면 신청만 받는다.
 *
 * ⚠️ 음수·NaN 같은 이상한 값이 오면 "재학 중"으로 본다. 모르면 지우지 않는 쪽이 안전하다.
 */
// 건수는 raw SQL 결과에서 온다 — 숫자로 선언해 두면 null·문자열이 와도 타입검사가 통과해
// 방어 코드가 죽은 코드로 보인다. 실제로 올 수 있는 것(unknown)을 그대로 받아 여기서 판정한다.
export function decideWithdrawal(input: { activeEnrollmentCount: unknown }): WithdrawalDecision {
  const raw = input?.activeEnrollmentCount;
  // ⚠️ Number(null) 과 Number("") 은 **0** 이다. 그대로 두면 값이 비었을 때 "재학 중 아님"으로
  //    읽어 **즉시 지워 버린다.** 조회가 실패해 빈 값이 온 경우가 바로 그 상황이다.
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
    return { action: "REQUEST_ONLY", activeEnrollmentCount: 0 };
  }
  const count = Number(raw);
  if (!Number.isFinite(count) || count !== 0) {
    // 음수·NaN 처럼 말이 안 되는 값은 건수 0 으로 보고하되 즉시 삭제는 하지 않는다.
    return { action: "REQUEST_ONLY", activeEnrollmentCount: count > 0 ? count : 0 };
  }
  return { action: "EXECUTE_NOW" };
}

/**
 * 탈퇴 계정의 이메일 자리에 넣을 값.
 *
 * 왜 비우지 않고 바꿔 넣는가: User.email 은 NOT NULL + UNIQUE 다. 그리고 원래 주소를 남겨 두면
 * 같은 학부모가 **다시 가입할 수 없다**(유니크 충돌). 그래서 주소를 치운다.
 * `.invalid` 는 RFC 2606 이 예약한 도메인이라 실제로 존재할 수 없다 — 실수로 메일이 나가지 않는다.
 */
export function anonymizedEmail(userId: string): string {
  const safe = String(userId ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (!safe) throw new Error("탈퇴 처리에 사용할 사용자 ID가 올바르지 않습니다.");
  return `withdrawn+${safe}@deleted.invalid`;
}

/** 화면·장부에 남는 이름. 누구인지 알 수 없어야 하고, 빈 문자열이면 화면이 깨진다. */
export const ANONYMIZED_NAME = "탈퇴한 회원";

/** 탈퇴 처리로 비워지는 User 컬럼 — 로그인 수단과 연락처. 서버 액션과 테스트가 같은 목록을 본다. */
export const CLEARED_USER_COLUMNS = ["phone", "phoneVerifiedAt", "authUserId", "username"] as const;

/** 탈퇴해도 남는 것 — 학원 장부이자 법령(전자상거래법 5년) 보관 대상. 지우면 안 된다. */
export const RETAINED_TABLES = [
  "Student", // 원생 기록(출결·수업의 기준)
  "Attendance", // 출결
  "Payment", // 납부
  "PaymentInvoice", // 청구
  "Enrollment", // 수강 등록
] as const;
