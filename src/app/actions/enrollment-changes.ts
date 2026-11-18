"use server";

import { userFacingError } from "@/lib/user-facing-error";
import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { maskEnrollmentChangeRowForRole } from "@/lib/payments/financeRoleMask";
import {
  decideEnrollmentCancelRequest,
  decideEnrollmentChangeRequest,
  getEnrollmentCancelRequests,
  getEnrollmentChangeRequests,
  issueProrationInvoice,
  retryPauseSettlementRefunds,
  settleApprovedPause,
  type PauseSettlementChoice,
} from "@/lib/enrollment/admin-change-request";
import { markCarryHandledManually, markSettlementLineDone } from "@/lib/enrollment/pause-settlement";
import { prisma } from "@/lib/prisma";
import { revalidateEnrollmentStatusCaches } from "@/lib/enrollment/change-cache";
import { recordOperationsSheetManualCheck } from "@/app/actions/operations-sync";

/** 신청함에서 열어 본 반만 조회한다. 기존 수강 변경 화면과 같은 금액·처리 상태를 사용한다. */
export async function readEnrollmentChangesForInbox(requestIds: string[]) {
  const admin = await requireAdmin();
  if (!Array.isArray(requestIds) || requestIds.length === 0 || requestIds.length > 100
      || requestIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)) {
    throw new Error("신청을 다시 선택해 주세요.");
  }
  const ids = [...new Set(requestIds)];
  const [rows, cancelRequests] = await Promise.all([
    getEnrollmentChangeRequests("ALL", ids),
    getEnrollmentCancelRequests(ids).catch((error: { code?: string; meta?: { code?: string } } | null) => {
      // 취소 요청 칸을 아직 적용하지 않은 환경에서도 기존 수강 신청은 열 수 있다.
      if (error?.code === "P2010" && error.meta?.code === "42703") return [];
      throw error;
    }),
  ]);
  return {
    // 부원장에게는 반 변경 차액·휴원 수강료 처리(미리보기·기록) 금액을 뺀다(2026-11-14 원장 결정)
    rows: rows.map((row) => maskEnrollmentChangeRowForRole(row, admin.appUserRole)),
    cancelRequests,
  };
}

/**
 * 수강 변경 신청 승인/거절. 원장·부원장만.
 *
 * 승인은 접수 결정이다. 적용일이 되면 휴원·퇴원은 사이트에 자동 적용되고(적용일이 지난 건은 승인 즉시),
 * (구글 시트·랠리즈는 은퇴해 따로 반영·확인할 것이 없다.)
 * 반 변경은 세 시스템 동기화 검토 원장(HELD)으로 이동한다. 학부모 알림은 별도 승인 전까지 보류한다.
 */
export async function decideEnrollmentChange(input: {
  requestId: string;
  approve: boolean;
  note?: string;
  /**
   * 휴원 승인 때 고르는 수강료 처리. 처리할 금액이 있고 계산이 가능하면 서버가 방식을 요구한다.
   * mode = "CARRY"(이월) | "REFUND"(환불) | "NONE"(없음) · expectedPreviewKey = 화면이 받은 미리보기 지문
   * (getEnrollmentChangeRequests 의 row.settlementPreview.previewKey). 서버가 다시 계산해 다르면 거절하고 승인도 하지 않는다.
   */
  settlement?: PauseSettlementChoice | null;
}) {
  const admin = await requireAdmin();
  // 부원장은 승인·거절만 — 수강료 처리(이월·환불)는 고르지 못하고 원장이 나중에 처리한다(2026-11-14 원장 결정)
  const owner = canSeeAllMoney(admin.appUserRole);
  const result = await decideEnrollmentChangeRequest({
    adminUserId: admin.appUserId,
    requestId: input.requestId,
    approve: input.approve,
    note: input.note ?? null,
    settlement: owner ? input.settlement ?? null : null,
    deferSettlementChoice: !owner,
  });
  revalidatePath("/admin/enrollment-changes");
  // 승인 직후 처리에서 이 신청이든 다른 밀린 신청이든 한 건이라도 사이트에 적용됐으면
  // 관리자 즉시 변경과 같은 범위의 캐시를 비운다.
  if (result.ok && result.appliedCount > 0) revalidateEnrollmentStatusCaches();
  if (result.ok && result.settlement) revalidateSettlementCaches();
  return result;
}

/** 수강료 처리로 청구 금액·환불이 바뀌면 수납·학부모 청구 화면도 새로 읽게 한다 */
function revalidateSettlementCaches() {
  revalidatePath("/admin/finance");
  revalidatePath("/mypage");
  revalidatePath("/mypage/payments");
}

/**
 * 이미 승인된 휴원의 수강료 처리(승인 때 고르지 않은 건 · 신청함에서 승인만 한 건). 원장·부원장만.
 * 입력은 승인 때와 같은 { mode, expectedPreviewKey }.
 */
export async function settlePauseTuition(input: { requestId: string; settlement: PauseSettlementChoice }) {
  // 부원장 차단(2026-11-14 원장 결정): 휴원 수강료 처리(이월·환불)는 원장만
  const admin = await requireOwner();
  const result = await settleApprovedPause({ adminUserId: admin.appUserId, requestId: input.requestId, settlement: input.settlement });
  revalidatePath("/admin/enrollment-changes");
  if (result.ok) revalidateSettlementCaches();
  return result;
}

/** 토스 부분 취소 «다시 시도»(결과 확인 중·실패) */
export async function retryPauseTuitionRefund(settlementId: string) {
  // 부원장 차단: 환불 재시도는 원장만
  const admin = await requireOwner();
  const result = await retryPauseSettlementRefunds({ adminUserId: admin.appUserId, settlementId });
  revalidatePath("/admin/enrollment-changes");
  revalidateSettlementCaches();
  return result;
}

/** 사람 할 일(현금 환불·랠리즈 반영·POS 취소 등)을 «직접 처리함»으로 닫는다 */
export async function markPauseTuitionLineDone(input: { lineId: string; note?: string }) {
  // 부원장 차단: 환불·이월 남은 일 닫기는 원장만
  const admin = await requireOwner();
  const result = await markSettlementLineDone(prisma, { lineId: input.lineId, adminUserId: admin.appUserId, note: input.note ?? null });
  revalidatePath("/admin/enrollment-changes");
  return result;
}

/** 사이트에서 줄일 청구가 없는 이월(랠리즈 청구 등)을 직접 차감했다고 닫는다 */
export async function markPauseCarryHandled(input: { settlementId: string; note?: string }) {
  // 부원장 차단: 이월 직접 차감 확인은 원장만
  const admin = await requireOwner();
  const result = await markCarryHandledManually(prisma, { settlementId: input.settlementId, adminUserId: admin.appUserId, note: input.note ?? null });
  revalidatePath("/admin/enrollment-changes");
  return result;
}

/**
 * 승인된 휴원·퇴원의 학부모 «취소 요청» 승인/거절(2026-11-10 원장 결정 d8). 원장·부원장만.
 * 승인 = 그 신청을 취소(적용 전에만 — 서버가 한 문장 UPDATE 로 다시 확인), 거절 = 원래 승인 그대로.
 * 결과는 취소를 요청한 보호자에게 앱 알림(인앱+웹푸시)만.
 */
export async function decideEnrollmentChangeCancelRequest(input: { requestId: string; approve: boolean; note?: string }) {
  const admin = await requireAdmin();
  const result = await decideEnrollmentCancelRequest({
    adminUserId: admin.appUserId,
    requestId: input.requestId,
    approve: input.approve,
    note: input.note ?? null,
  });
  revalidatePath("/admin/enrollment-changes");
  revalidatePath("/mypage/classes");
  return result;
}

/**
 * 반 변경 차액 청구서 발행. 금액은 서버가 다시 계산한다(화면 값을 믿지 않는다).
 * 원장 결정: 자동 발행하지 않고 원장이 금액과 근거를 보고 누른다.
 */
export async function issueEnrollmentChangeInvoice(requestId: string, expectedPreviewKey: string) {
  // 부원장 차단(2026-11-14 원장 결정): 반 변경 차액 청구는 원장만(차액 금액을 부원장에게 보이지 않는다)
  const admin = await requireOwner();
  const result = await issueProrationInvoice({ adminUserId: admin.appUserId, requestId, expectedPreviewKey });
  revalidatePath("/admin/enrollment-changes");
  revalidatePath("/admin/finance");
  return result;
}

/**
 * 「확인 필요」 화면의 «보류 해제» 버튼용 래퍼.
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

/**
 * 시트 은퇴 상태(시트 칸 SKIPPED)의 복귀 보류 해제 —
 * SKIPPED 칸은 건드리지 않고 복귀 어댑터 보류만 푼다.
 * (랠리즈 칸도 SKIPPED 라, 보류를 풀면 재집계에서 바로 완료(SYNCED)가 된다.)
 */
export async function releaseEnrollmentChangeHoldSheetRetired(commandId: string) {
  return runEnrollmentSyncAction("보류 해제", () => recordOperationsSheetManualCheck(commandId));
}
