"use server";

// 관리자 학생 상세 — «정보 변경 요청» 승인·반려, «건강·알레르기·특이사항» 보기·고치기 (2026-11-14 원장 결정 b4·b5).
//
// · 모든 함수 첫 줄 requireAdmin()(원장·부원장).
// · 승인하면 신청할 때와 같은 검증(childEditRules)을 다시 하고 Student 의 그 칸 하나만 바꾼다. 신청 표가 변경 이력이다.
// · 신청한 보호자에게는 결과를 «앱 안 알림»으로만 알린다(문자·알림톡 없음). 건강 특이사항 내용은 알림·로그에 쓰지 않는다.

import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { createNotificationRecord } from "@/lib/notification";
import { REQUEST_FIELD_LABEL } from "@/lib/parent/childEditRules";
import { decideProfileChange, listProfileChangesForAdmin, type ChildChangeRequest } from "@/lib/parent/childEdit";
import { loadHealthNotes, saveHealthNoteAsAdmin } from "@/lib/student/healthNote";

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 64 ? id : "";
}

export type StudentProfileExtras = {
  requestsAvailable: boolean;
  requests: ChildChangeRequest[];
  healthAvailable: boolean;
  healthNote: string;
};

/** 학생 상세가 열릴 때 한 번 — 변경 요청 목록 + 건강 특이사항 */
export async function getStudentProfileExtras(studentIdRaw: string): Promise<StudentProfileExtras> {
  await requireAdmin();
  const studentId = cleanId(studentIdRaw);
  const empty: StudentProfileExtras = { requestsAvailable: false, requests: [], healthAvailable: false, healthNote: "" };
  if (!studentId) return empty;
  const [changes, healthAvailable, notes] = await Promise.all([
    listProfileChangesForAdmin(prisma, studentId),
    // 칸이 있는 환경인지(없으면 입력칸을 숨긴다)
    prisma
      .$queryRawUnsafe<Array<{ ok: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'Student' AND column_name = 'healthNote') AS ok`,
      )
      .then((rows) => rows[0]?.ok === true)
      .catch(() => false),
    loadHealthNotes(prisma, [studentId]),
  ]);
  return { requestsAvailable: changes.available, requests: changes.requests, healthAvailable, healthNote: notes[studentId] ?? "" };
}

/** 변경 요청 승인·반려 */
export async function decideStudentProfileChange(
  studentIdRaw: string,
  requestIdRaw: string,
  decision: "APPROVE" | "REJECT",
  note?: string,
): Promise<{ ok: true; requests: ChildChangeRequest[] } | { ok: false; error: string }> {
  const admin = await requireAdmin();
  const studentId = cleanId(studentIdRaw);
  const requestId = cleanId(requestIdRaw);
  if (!studentId || !requestId) return { ok: false, error: "신청 정보를 확인해 주세요." };
  let done;
  try {
    done = await prisma.$transaction((tx) => decideProfileChange(tx, admin.appUserId, studentId, requestId, decision, note, todayKst()));
  } catch {
    console.error("[decideStudentProfileChange] failed");
    return { ok: false, error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
  if (!done.ok) return done;

  // 신청한 보호자에게 결과 알림(앱 안 알림만) — 실패해도 처리는 끝났다(createNotificationRecord 가 오류를 삼킨다)
  const label = REQUEST_FIELD_LABEL[done.field];
  await createNotificationRecord({
    userId: done.requestedByUserId,
    type: "PROFILE_CHANGE_RESULT",
    title: "정보 변경 신청 결과",
    message: done.approved ? `${label} 변경이 반영됐어요.` : `${label} 변경이 반려됐어요. 아이 기록에서 확인해 주세요.`,
    linkUrl: `/mypage/record?child=${encodeURIComponent(done.studentId)}`,
  });

  // 이름·생년월일이 바뀌면 원생 목록·통계(학년)·학부모 화면이 달라진다
  revalidatePath(`/admin/students/${studentId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin");
  revalidatePath("/mypage", "layout");
  for (const tag of ["admin-students", "admin-student-options", "admin-dashboard", "admin-stats"]) revalidateTag(tag, { expire: 0 });

  const changes = await listProfileChangesForAdmin(prisma, studentId);
  return { ok: true, requests: changes.requests };
}

/** 건강·알레르기·특이사항 저장(관리자) */
export async function saveStudentHealthNote(studentIdRaw: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdmin();
  const studentId = cleanId(studentIdRaw);
  if (!studentId) return { ok: false, error: "학생 정보를 확인해 주세요." };
  const saved = await saveHealthNoteAsAdmin(prisma, studentId, note);
  if (saved.status === "invalid") return { ok: false, error: saved.error };
  if (saved.status === "unavailable") return { ok: false, error: "아직 저장할 수 없습니다. 잠시 후 다시 시도해 주세요." };
  revalidatePath(`/admin/students/${studentId}`);
  return { ok: true };
}
