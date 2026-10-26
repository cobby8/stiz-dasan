import { decideWithdrawal } from "./withdrawal";

export type AccountWithdrawalReview =
  "ADMIN_HANDOFF" | "STAFF_REVIEW" | "ACTIVE_ENROLLMENTS" | null;
export function accountWithdrawalPolicy(input: {
  role: string;
  activeEnrollmentCount: unknown;
  activeStaffGrantCount: unknown;
  activeWorkCount: unknown;
}) {
  const parent = decideWithdrawal({
    activeEnrollmentCount: input.activeEnrollmentCount,
  });
  const grantCount = Number(input.activeStaffGrantCount);
  let reviewReason: AccountWithdrawalReview = null;
  if (["ADMIN", "VICE_ADMIN"].includes(input.role))
    reviewReason = "ADMIN_HANDOFF";
  else if (
    input.role !== "PARENT" ||
    input.activeStaffGrantCount == null ||
    String(input.activeStaffGrantCount).trim() === "" ||
    !Number.isFinite(grantCount) ||
    grantCount !== 0 ||
    input.activeWorkCount == null ||
    String(input.activeWorkCount).trim() === "" ||
    Number(input.activeWorkCount) !== 0
  )
    reviewReason = "STAFF_REVIEW";
  else if (parent.action !== "EXECUTE_NOW") reviewReason = "ACTIVE_ENROLLMENTS";
  const reviewMessage =
    reviewReason === "ADMIN_HANDOFF"
      ? "관리자 계정은 담당 업무와 관리 권한을 먼저 이관해야 합니다. 탈퇴 요청을 남긴 뒤 학원 지원 담당자에게 문의해 주세요. 자동으로 삭제하지 않습니다."
      : reviewReason === "STAFF_REVIEW"
        ? "직원 역할과 담당 업무를 먼저 확인합니다. 탈퇴 요청을 남기면 관리자가 수업·운행 업무를 정리한 뒤 처리합니다."
        : reviewReason === "ACTIVE_ENROLLMENTS"
          ? "수강 중인 자녀의 연락과 수업을 먼저 확인합니다. 요청을 접수하면 관리자가 확인한 뒤 처리합니다."
          : null;
  return { immediate: reviewReason === null, reviewReason, reviewMessage };
}
