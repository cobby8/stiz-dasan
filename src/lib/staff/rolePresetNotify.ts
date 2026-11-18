import "server-only";
import { createNotificationRecord, notifyAdmins } from "@/lib/notification";
import { ROLE_LABELS } from "@/lib/account/roles";
import type { RolePresetOutcome } from "@/lib/staff/rolePreset";

/**
 * 미리 붙인 역할(ROLE_PRESET) 적용 뒤 알림 — 가입 거래가 «끝난 뒤» 부른다(2026-11-18 5단계).
 * 알림이 실패해도 가입·역할 적용은 이미 끝났으므로 오류를 밖으로 던지지 않는다(기록만).
 *   - 바로 열림(ACTIVE): 본인에게 «역할이 열렸어요» + 원장·부원장 벨에 사후 통지
 *   - 원장 확인(PENDING): 원장·부원장 벨에 «확인 후 승인해 주세요»(직원 역할 신청과 같은 신청함 링크)
 */
export async function notifyRolePresetOutcomes(userId: string, outcomes: RolePresetOutcome[]): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.status === "ALREADY") continue;
    const label = ROLE_LABELS[outcome.role];
    try {
      if (outcome.status === "ACTIVE") {
        await createNotificationRecord({
          userId,
          type: "ROLE_REQUEST",
          title: `${label} 역할이 열렸어요`,
          message: `원장님이 미리 준비해 둔 ${label} 역할이 열렸습니다. 앱에서 화면 전환으로 열어 보세요.`,
          linkUrl: outcome.role === "DRIVER" ? "/staff/shuttle" : "/staff",
        });
        await notifyAdmins(
          "ROLE_REQUEST",
          "새 직원 가입",
          `${outcome.invitationName}님이 가입해 ${label} 역할이 열렸습니다(본인인증 이름 일치).`,
          "/admin/staff",
          { notifyCoaches: false, eventId: `role-preset:${outcome.invitationId}` },
        );
      } else {
        await notifyAdmins(
          "ROLE_REQUEST",
          "새 직원 역할 확인",
          `${outcome.invitationName}님 초대 번호로 가입했습니다. ${label} 역할은 확인 후 승인해 주세요.`,
          "/admin/inbox?tab=OTHER&kind=ROLE_GRANT",
          { notifyCoaches: false, eventId: `role-preset:${outcome.invitationId}` },
        );
      }
    } catch (error) {
      console.error("[role preset] notice failed:", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
    }
  }
}
