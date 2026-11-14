"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import {
  cancelShuttleExceptionByAdmin,
  getShuttleExceptionBoardForAdmin,
  searchStudentsForShuttleException,
  submitShuttleExceptionByAdmin,
  type AdminShuttleExceptionBoard,
  type AdminShuttleExceptionInput,
  type AdminShuttleStudent,
} from "@/lib/shuttle/admin-shuttle-exception";

// 관리자 «셔틀 당일 변경» 입력·취소 서버 액션 (2026-11-15 원장 요청).
//
// ★ 네 액션 모두 맨 먼저 requireAdmin() 으로 «원장·부원장»인지 서버에서 확인한다(DB 의 역할을 다시 읽는다).
//   선생님·기사·학부모·비로그인은 여기서 끝난다 — 화면에 버튼이 안 보이는 것만으로 막지 않는다.
//   입력한 사람은 클라이언트가 보낸 값이 아니라 여기서 확인한 관리자 계정 id 다.

const DENIED = { ok: false as const, message: "관리자 권한이 필요합니다." };

/** 원장·부원장이면 그 계정 id, 아니면 null(권한 오류를 화면용 답으로 바꾸려고 감싼다) */
async function adminIdOrNull(): Promise<string | null> {
  try {
    const admin = await requireAdmin();
    return admin.appUserId || null;
  } catch {
    return null;
  }
}

function refresh() {
  // 목록이 보이는 관리자 화면(정규 배차)을 다시 그린다
  revalidatePath("/admin/shuttle/regular-dispatch");
}

/** 학생 찾기(이름) */
export async function searchShuttleExceptionStudentsAction(
  query: string,
): Promise<{ ok: true; students: AdminShuttleStudent[] } | typeof DENIED> {
  const adminId = await adminIdOrNull();
  if (!adminId) return DENIED;
  return { ok: true, students: await searchStudentsForShuttleException(query) };
}

/** 들어와 있는 당일 변경 목록(오늘부터) */
export async function loadShuttleExceptionBoardAction(): Promise<{ ok: true; board: AdminShuttleExceptionBoard } | typeof DENIED> {
  const adminId = await adminIdOrNull();
  if (!adminId) return DENIED;
  return { ok: true, board: await getShuttleExceptionBoardForAdmin() };
}

/** 당일 변경 대신 넣기 — 마감 뒤에도 저장된다(지난 날짜만 거절) */
export async function submitShuttleExceptionByAdminAction(input: AdminShuttleExceptionInput) {
  const adminId = await adminIdOrNull();
  if (!adminId) return DENIED;
  try {
    const result = await submitShuttleExceptionByAdmin(adminId, input);
    if (result.ok) refresh();
    return result;
  } catch (error) {
    console.error("[shuttle-exception-admin] 저장 실패:", error instanceof Error ? error.name : "");
    return { ok: false as const, message: "셔틀 변경을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}

/** 당일 변경 취소(학부모 입력분 포함) */
export async function cancelShuttleExceptionByAdminAction(exceptionId: string) {
  const adminId = await adminIdOrNull();
  if (!adminId) return DENIED;
  try {
    const result = await cancelShuttleExceptionByAdmin(adminId, exceptionId);
    if (result.ok) refresh();
    return result;
  } catch (error) {
    console.error("[shuttle-exception-admin] 취소 실패:", error instanceof Error ? error.name : "");
    return { ok: false as const, message: "취소하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
