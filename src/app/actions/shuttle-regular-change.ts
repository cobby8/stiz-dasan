"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { decideRegularChangeRequest } from "@/lib/shuttle/regularChangeRequest";

// 원장의 셔틀 «계속 바꾸기» 신청 승인·반려 서버 액션(2026-11-14 결정표 c5).
//
// ★ 맨 먼저 requireAdmin() 으로 «원장·부원장»인지 서버에서 확인한다(DB 의 역할을 다시 읽는다).
//   선생님·기사·학부모·비로그인은 여기서 끝난다 — 화면에 버튼이 안 보이는 것만으로 막지 않는다.
//   결정한 사람은 클라이언트가 보낸 값이 아니라 여기서 확인한 관리자 계정 id 다.

export async function decideShuttleRegularChange(input: { requestId: string; approve: boolean; note?: string }) {
  let adminUserId: string;
  try {
    adminUserId = (await requireAdmin()).appUserId;
  } catch {
    return { ok: false as const, message: "관리자 권한이 필요합니다." };
  }
  const requestId = typeof input?.requestId === "string" ? input.requestId.trim() : "";
  if (!requestId) return { ok: false as const, message: "신청을 찾을 수 없어요." };
  try {
    const result = await decideRegularChangeRequest({ adminUserId, requestId, approve: input.approve === true, note: input.note ?? null });
    // 승인 목록이 있는 셔틀 명단 화면과, 명단이 바뀌었으면 그 명단을 읽는 화면들을 다시 그린다
    revalidatePath("/admin/shuttle/regular");
    if (result.ok && result.appliedNow) revalidatePath("/admin/shuttle/regular-dispatch");
    return result;
  } catch (error) {
    console.error("[shuttle-regular-change] 결정 실패", error instanceof Error ? error.name : "");
    return { ok: false as const, message: "처리하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}
