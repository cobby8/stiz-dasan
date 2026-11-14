"use server";

// 학부모 «아이 정보 수정»·«연결된 가족 끊기» 서버 동작 (2026-11-14 원장 결정 b4·b5·b7).
//
// ★ 보안: 누구의 아이인지는 화면이 정하지 않는다. requireVerifiedParent() 가 확인한 로그인 사용자(appUserId)와
//   화면이 보낸 학생 id 를 같은 SQL 에서 묶어 다시 확인한다(lib/parent/childEdit — 남의 아이 id 면 0행).
// ★ 고객 발송(문자·알림톡)은 하지 않는다. 변경 신청은 관리자 «앱 안 알림»만 만든다.
// ★ 알림 글에는 아이 이름·항목 이름만 — 건강 특이사항 내용은 넣지 않는다.

import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { notifyAdmins } from "@/lib/notification";
import { REQUEST_FIELD_LABEL } from "@/lib/parent/childEditRules";
import { cancelChangeRequest, createChangeRequest, loadChildEditInfo, saveChildDirect, type ChildEditInfo } from "@/lib/parent/childEdit";
import { loadFamilyForParent, revokeFamilyAsRepresentative, type FamilyOfChild } from "@/lib/account/family-access-parent";

type Result = { ok: true; notice?: string } | { ok: false; error: string };

const SIGN_IN_AGAIN = "다시 로그인해 주세요.";

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 64 ? id : "";
}

/** 수정 시트에 채울 값 + 변경 신청 목록 — 내 아이가 아니면 null */
export async function getChildEditInfo(studentIdRaw: string): Promise<ChildEditInfo | null> {
  const parent = await requireVerifiedParent().catch(() => null);
  const studentId = cleanId(studentIdRaw);
  if (!parent || !studentId) return null;
  try {
    return await loadChildEditInfo(prisma, parent.appUserId, studentId);
  } catch {
    return null;
  }
}

/** 바로 반영 — 학교·학생 전화·주소·건강 특이사항 */
export async function saveChildInfo(studentIdRaw: string, input: { school?: string; phone?: string; address?: string; healthNote?: string }): Promise<Result> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, error: SIGN_IN_AGAIN };
  const studentId = cleanId(studentIdRaw);
  if (!studentId) return { ok: false, error: "아이 정보를 찾지 못했어요." };
  try {
    const saved = await saveChildDirect(prisma, parent.appUserId, studentId, input);
    if (!saved.ok) return saved;
    revalidatePath("/mypage/record");
    revalidatePath(`/admin/students/${studentId}`);
    // 건강 칸을 보냈는데 저장하지 못한 경우에만 알린다(보내지 않았으면 null — 안내 없음)
    return saved.healthSaved !== false ? { ok: true } : { ok: true, notice: "건강 특이사항은 아직 저장할 수 없어요. 나머지는 저장했어요." };
  } catch {
    // 입력 내용(건강 정보 포함)은 로그에 남기지 않는다
    console.error("[saveChildInfo] failed");
    return { ok: false, error: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}

/** 변경 신청 — 이름·생년월일. 원장·부원장에게 앱 안 알림만 보낸다(문자 없음) */
export async function requestChildChange(studentIdRaw: string, field: string, newValue: string): Promise<Result> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, error: SIGN_IN_AGAIN };
  const studentId = cleanId(studentIdRaw);
  if (!studentId) return { ok: false, error: "아이 정보를 찾지 못했어요." };
  try {
    const created = await createChangeRequest(prisma, parent.appUserId, studentId, field, newValue, todayKst());
    if (!created.ok) return created;
    // 관리자 알림 — notifyCoaches:false + 문자 틀 없음 = 앱 안 알림(+푸시)만. 실패해도 신청은 이미 저장됐다
    await notifyAdmins(
      "PROFILE_CHANGE_REQUEST",
      "정보 변경 요청",
      `${created.studentName} · ${REQUEST_FIELD_LABEL[created.field]} 변경 신청`,
      `/admin/students/${studentId}`,
      { notifyCoaches: false },
    ).catch(() => undefined);
    revalidatePath("/mypage/record");
    revalidatePath(`/admin/students/${studentId}`);
    return { ok: true };
  } catch {
    console.error("[requestChildChange] failed");
    return { ok: false, error: "신청하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}

/** 확인 중인 변경 신청 취소 */
export async function cancelChildChange(requestIdRaw: string): Promise<Result> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, error: SIGN_IN_AGAIN };
  const requestId = cleanId(requestIdRaw);
  if (!requestId) return { ok: false, error: "취소할 신청이 없어요." };
  const done = await cancelChangeRequest(prisma, parent.appUserId, requestId);
  if (done.ok) revalidatePath("/mypage/record");
  return done;
}

/** 내 아이별 연결 가족(이름·관계만) */
export async function listMyFamily(): Promise<FamilyOfChild[]> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return [];
  try {
    return await loadFamilyForParent(prisma, parent.appUserId);
  } catch {
    return [];
  }
}

/** 대표 보호자가 다른 가족의 연결을 끊는다 */
export async function revokeMyFamilyMember(studentIdRaw: string, accessIdRaw: string): Promise<Result> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, error: SIGN_IN_AGAIN };
  const studentId = cleanId(studentIdRaw);
  const accessId = cleanId(accessIdRaw);
  if (!studentId || !accessId) return { ok: false, error: "연결 정보를 확인해 주세요." };
  try {
    const done = await prisma.$transaction((tx) => revokeFamilyAsRepresentative(tx, parent.appUserId, studentId, accessId));
    if (!done) return { ok: false, error: "끊을 수 없는 연결이에요. 대표 보호자만 끊을 수 있어요." };
    revalidatePath("/mypage", "layout");
    revalidatePath(`/admin/students/${studentId}`);
    return { ok: true };
  } catch {
    console.error("[revokeMyFamilyMember] failed");
    return { ok: false, error: "처리하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}
