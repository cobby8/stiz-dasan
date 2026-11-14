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
  getPauseSettlementPreview,
  issueProrationInvoice,
  retryPauseSettlementRefunds,
  settleApprovedPause,
  type PauseSettlementChoice,
} from "@/lib/enrollment/admin-change-request";
import { markCarryHandledManually, markSettlementLineDone } from "@/lib/enrollment/pause-settlement";
import { prisma } from "@/lib/prisma";
import { revalidateEnrollmentStatusCaches } from "@/lib/enrollment/change-cache";
import { applyOperationsSheet, recordOperationsExternalCheck, recordOperationsSheetManualCheck } from "@/app/actions/operations-sync";
import { isSheetSyncRetired, isSheetTargetDone } from "@/lib/operations-sync/sheetRetirement";
import { isRallyzSyncRetired, RALLYZ_RETIRED_MESSAGE } from "@/lib/operations-sync/rallyzRetirement";

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
    sheetRetired: isSheetSyncRetired(process.env),
    // 2026-11-14 랠리즈 은퇴: 화면이 «랠리즈 반영 확인» 버튼·배지를 숨길 때 쓰는 값
    rallyzRetired: isRallyzSyncRetired(process.env),
  };
}

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
 * 신청함 상세 칸 — 휴원 승인 전에 수강료 처리 미리보기(금액·근거·지문)를 받는다. 원장·부원장만.
 * 수강 변경 화면은 목록 행(row.settlementPreview)으로 받지만, 신청함 행에는 미리보기가 없어 칸을 열 때 따로 읽는다.
 * 휴원이 아니면 preview = null. 읽기 실패는 승인을 막도록 ok:false 로 돌려준다(금액을 모른 채 승인하지 않게).
 */
export async function getPauseTuitionPreview(requestId: string) {
  // 부원장 차단(2026-11-14 원장 결정): 휴원 수강료 금액 미리보기는 원장만
  await requireOwner();
  try {
    return { ok: true as const, preview: await getPauseSettlementPreview(requestId) };
  } catch (error) {
    console.error("[enrollment-changes] 휴원 수강료 미리보기 실패:", (error as Error).message);
    return { ok: false as const, message: "휴원 수강료 미리보기를 읽지 못했습니다. 수강 변경 화면에서 처리해 주세요." };
  }
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

/**
 * 원장이 랠리즈에서 직접 처리했음을 기록(시트 확인이 먼저 끝나야 한다).
 * 2026-11-14 랠리즈 은퇴: 은퇴 상태에서는 recordOperationsExternalCheck 가 아무것도 바꾸지 않고 성공으로 끝난다(삭제는 3단계).
 */
export async function confirmEnrollmentChangeRallyz(commandId: string) {
  return runEnrollmentSyncAction("랠리즈 반영 확인", () => recordOperationsExternalCheck(commandId, "RALLYZ", true));
}

export type BulkRallyzItem = { requestId: string; name: string; reason: string };
export type BulkRallyzResult = { done: number; skipped: BulkRallyzItem[]; failed: BulkRallyzItem[] };

/**
 * 신청함 «선택 N건 랠리즈 반영 확인» — 고른 수강 변경 신청을 한 건씩 단건과 같은 함수로 확인한다.
 * 검증(시트 선행·적용일·보류)과 감사 기록은 recordOperationsExternalCheck 가 건마다 그대로 한다.
 * 이미 확인됐거나 확인 대상이 아닌 건은 건너뛰고, 실패는 이름·사유와 함께 돌려준다(한 건 실패가 나머지를 막지 않는다).
 */
export async function confirmEnrollmentChangesRallyzBulk(requestIds: string[]): Promise<BulkRallyzResult> {
  await requireAdmin();
  if (!Array.isArray(requestIds) || requestIds.length === 0 || requestIds.length > 100
      || requestIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)) {
    throw new Error("신청을 다시 선택해 주세요.");
  }
  const ids = [...new Set(requestIds)];
  const rows = await getEnrollmentChangeRequests("ALL", ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: BulkRallyzResult = { done: 0, skipped: [], failed: [] };
  // 2026-11-14 랠리즈 은퇴: 확인할 랠리즈가 없다 — 아무것도 바꾸지 않고 전부 «필요 없음»으로 돌려준다.
  if (isRallyzSyncRetired(process.env)) {
    for (const id of ids) {
      const row = byId.get(id);
      result.skipped.push({ requestId: id, name: row ? `${row.studentName} · ${row.fromClassName ?? row.kindLabel}` : "알 수 없는 신청", reason: RALLYZ_RETIRED_MESSAGE });
    }
    return result;
  }
  for (const id of ids) {
    const row = byId.get(id);
    const name = row ? `${row.studentName} · ${row.fromClassName ?? row.kindLabel}` : "알 수 없는 신청";
    const skip = (reason: string) => result.skipped.push({ requestId: id, name, reason });
    // 단건 버튼이 켜지는 조건과 같다(적용일 등 나머지 검증은 서버 함수가 건마다 다시 한다)
    if (!row) { skip("신청을 찾지 못했습니다."); continue; }
    if (row.status !== "APPLIED") { skip("이미 처리됐거나 확인 대상이 아닙니다."); continue; }
    if (!row.syncCommandId || !row.rallyzStatus) { skip("랠리즈 확인 대상이 아닙니다."); continue; }
    if (row.rallyzStatus === "SUCCEEDED") { skip("이미 랠리즈 반영이 확인됐습니다."); continue; }
    if (row.syncCommandStatus === "HELD") { skip("보류된 변경입니다. 상세에서 확인해 주세요."); continue; }
    if (!isSheetTargetDone(row.sheetStatus)) { skip("시트 반영이 먼저 필요합니다. 상세에서 처리해 주세요."); continue; }
    try {
      const outcome = await recordOperationsExternalCheck(row.syncCommandId, "RALLYZ", true);
      if ("retired" in outcome) skip(RALLYZ_RETIRED_MESSAGE);
      else if (outcome.skipped) skip("이미 랠리즈 반영이 확인됐습니다.");
      else result.done += 1;
    } catch (error) {
      console.error("[enrollment-changes] 랠리즈 반영 일괄 확인 실패", id, error);
      result.failed.push({ requestId: id, name, reason: userFacingError(error, "랠리즈 반영 확인을 저장하지 못했습니다.") });
    }
  }
  revalidatePath("/admin/enrollment-changes");
  revalidatePath("/admin/inbox");
  return result;
}

/** 자동 시트 반영이 끝내 안 되는 건: 원장이 시트를 직접 고쳤음을 기록(수동 확인) */
export async function confirmEnrollmentChangeSheetManually(commandId: string) {
  return runEnrollmentSyncAction("시트 직접 수정 확인", () => recordOperationsSheetManualCheck(commandId));
}

/**
 * 시트 은퇴 상태(시트 칸 SKIPPED)의 복귀 보류 해제. 서버 함수는 위와 같다 —
 * SKIPPED 칸은 건드리지 않고 복귀 어댑터 보류만 푼다. 오류 문구 이름만 다르다.
 * (랠리즈 은퇴 뒤에는 랠리즈 칸도 SKIPPED 라, 보류를 풀면 재집계에서 바로 완료(SYNCED)가 된다.)
 */
export async function releaseEnrollmentChangeHoldSheetRetired(commandId: string) {
  return runEnrollmentSyncAction("보류 해제", () => recordOperationsSheetManualCheck(commandId));
}
