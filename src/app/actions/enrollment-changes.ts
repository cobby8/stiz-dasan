"use server";

import { userFacingError } from "@/lib/user-facing-error";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { decideEnrollmentChangeRequest, issueProrationInvoice } from "@/lib/enrollment/admin-change-request";
import { revalidateEnrollmentStatusCaches } from "@/lib/enrollment/change-cache";
import { applyOperationsSheet, recordOperationsExternalCheck, recordOperationsSheetManualCheck } from "@/app/actions/operations-sync";

/**
 * 수강 변경 신청 승인/거절. 원장·부원장만.
 *
 * 승인은 접수 결정이다. 적용일이 되면 휴원·퇴원은 사이트에 자동 적용되고(적용일이 지난 건은 승인 즉시),
 * 시트·랠리즈는 이 화면의 "확인 필요"에서 관리자가 반영·확인한다.
 * 반 변경은 세 시스템 동기화 검토 원장(HELD)으로 이동한다. 학부모 알림은 별도 승인 전까지 보류한다.
 */
export async function decideEnrollmentChange(input: {
  requestId: string;
  approve: boolean;
  note?: string;
}) {
  const admin = await requireAdmin();
  const result = await decideEnrollmentChangeRequest({
    adminUserId: admin.appUserId,
    requestId: input.requestId,
    approve: input.approve,
    note: input.note ?? null,
  });
  revalidatePath("/admin/enrollment-changes");
  // 승인 직후 처리에서 이 신청이든 다른 밀린 신청이든 한 건이라도 사이트에 적용됐으면
  // 관리자 즉시 변경과 같은 범위의 캐시를 비운다.
  if (result.ok && result.appliedCount > 0) revalidateEnrollmentStatusCaches();
  return result;
}

/**
 * 반 변경 차액 청구서 발행. 금액은 서버가 다시 계산한다(화면 값을 믿지 않는다).
 * 원장 결정: 자동 발행하지 않고 원장이 금액과 근거를 보고 누른다.
 */
export async function issueEnrollmentChangeInvoice(requestId: string, expectedPreviewKey: string) {
  const admin = await requireAdmin();
  const result = await issueProrationInvoice({ adminUserId: admin.appUserId, requestId, expectedPreviewKey });
  revalidatePath("/admin/enrollment-changes");
  revalidatePath("/admin/finance");
  return result;
}

/**
 * 「확인 필요」 화면의 시트·랠리즈 버튼용 래퍼.
 * 내부 운영 동기화 함수는 실패 시 throw 하는데, Next.js 운영 빌드는 서버 액션의 throw 메시지를
 * 영어 일반 문구로 가린다. 그래서 여기서 잡아 한국어 이유를 결과 객체로 돌려준다.
 */
export type EnrollmentSyncActionResult = { ok: true } | { ok: false; message: string };

async function runEnrollmentSyncAction(label: string, action: () => Promise<unknown>): Promise<EnrollmentSyncActionResult> {
  // 권한 검사는 내부 함수도 하지만, 래퍼에서도 먼저 막는다(로그인 이동 등은 try 밖에서 그대로 전파).
  await requireAdmin();
  try {
    await action();
    revalidatePath("/admin/enrollment-changes");
    return { ok: true };
  } catch (error) {
    console.error(`[enrollment-changes] ${label} 실패`, error);
    const message = userFacingError(error, `${label}을(를) 저장하지 못했습니다. 새로고침 후 다시 시도해 주세요.`);
    return { ok: false, message };
  }
}

/** 구글 시트에 휴원·퇴원 자동 반영 */
export async function applyEnrollmentChangeSheet(commandId: string) {
  return runEnrollmentSyncAction("시트 반영", () => applyOperationsSheet(commandId));
}

/** 원장이 랠리즈에서 직접 처리했음을 기록(시트 확인이 먼저 끝나야 한다) */
export async function confirmEnrollmentChangeRallyz(commandId: string) {
  return runEnrollmentSyncAction("랠리즈 반영 확인", () => recordOperationsExternalCheck(commandId, "RALLYZ", true));
}

/** 자동 시트 반영이 끝내 안 되는 건: 원장이 시트를 직접 고쳤음을 기록(수동 확인) */
export async function confirmEnrollmentChangeSheetManually(commandId: string) {
  return runEnrollmentSyncAction("시트 직접 수정 확인", () => recordOperationsSheetManualCheck(commandId));
}

/**
 * 시트 은퇴 상태(시트 칸 SKIPPED)의 복귀 보류 해제. 서버 함수는 위와 같다 —
 * SKIPPED 칸은 건드리지 않고 복귀 어댑터 보류만 풀어 랠리즈 확인으로 넘긴다. 오류 문구 이름만 다르다.
 */
export async function releaseEnrollmentChangeHoldSheetRetired(commandId: string) {
  return runEnrollmentSyncAction("보류 해제", () => recordOperationsSheetManualCheck(commandId));
}
