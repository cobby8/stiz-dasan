import { prisma } from "@/lib/prisma";
import { createNotificationRecord } from "@/lib/notification";

// ── 새 카카오 접수 → 관리자 앱 알림센터 ─────────────────────────────────
// 받는 사람: 원장(ADMIN)·부원장(VICE_ADMIN). 통로: 앱 알림 + 웹 푸시(createNotificationRecord)만.
// 메일·문자는 보내지 않는다 — notifyAdmins 는 설정에 따라 문자까지 나갈 수 있어 일부러 쓰지 않는다
// (원장 결정 2026-10: 관리자 알림은 메일이 아니라 앱 알림센터).

export const KAKAO_INTAKE_NOTIFICATION_TYPE = "KAKAO_PARENT_INTAKE";

/** 알림 한 건의 제목·본문. 원문은 길 수 있어 80자까지만 싣는다(전체는 접수함에서 본다). */
export function buildKakaoIntakeAlert(input: { kindLabel: string; studentName: string | null; sourceText: string; linkUrl?: string }) {
  const chars = [...input.sourceText.replace(/\s+/g, " ").trim()];
  const quote = chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join("");
  const who = input.studentName ? `${input.studentName} 학생` : "자녀 미확인";
  return {
    title: `새 카카오 접수: ${input.kindLabel}`,
    message: `${who} · “${quote}”`,
    linkUrl: "/admin/kakao-requests",
    // 바로 처리된 건(카카오 보강 예약 등)은 그 업무 화면으로 보낸다 — 접수함 '처리 필요'에는 안 보이기 때문
    ...(input.linkUrl ? { linkUrl: input.linkUrl } : {}),
  };
}

export async function notifyAdminsOfKakaoIntake(input: {
  intakeId: string;
  kindLabel: string;
  studentName: string | null;
  sourceText: string;
  linkUrl?: string;
}): Promise<number> {
  const alert = buildKakaoIntakeAlert(input);
  const admins = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "User" WHERE role IN ('ADMIN', 'VICE_ADMIN')`,
  );
  let sent = 0;
  for (const admin of admins) {
    // createNotificationRecord 는 내부에서 오류를 삼킨다 — 한 명 실패가 다른 관리자 알림을 막지 않는다.
    await createNotificationRecord({ userId: admin.id, type: KAKAO_INTAKE_NOTIFICATION_TYPE, ...alert });
    sent += 1;
  }
  return sent;
}
