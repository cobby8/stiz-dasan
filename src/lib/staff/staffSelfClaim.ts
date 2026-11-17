import "server-only";
import { prisma } from "@/lib/prisma";
import { createNotificationRecord } from "@/lib/notification";
import { linkMatchingCoachProfileToUser } from "@/lib/staff-coach-link";
import { DIRECT_ADDED_EMAIL_SUFFIX } from "@/lib/staff/staffAccountLink";

/**
 * 로그인 없는 직원 기록에 본인이 직접 로그인을 붙인다(2026-11-17 원장 지시 «알아서 다 처리할 수 있게»).
 *
 * 부르는 쪽(/api/auth/parent-link/verify)이 본인인증(포트원 재조회·건 번호 묶음·10분 신선도)과
 * 대상 판정(selectStaffRecordToClaim — 이 번호의 계정이 그 기록 하나뿐·직원 역할·로그인 없음·이름 일치)을 끝낸 뒤에만 부른다.
 *
 * «로그인 없음»은 다른 곳과 같은 기준이다: authUserId 없음 «그리고» 이메일이 원장이 직접 추가한 기록의 자리표시(@staff.local).
 * 초대로 가입한 직원은 authUserId 없이 User.id = 로그인 id·이메일 «번호@staff.stiz.kr» 이라, authUserId 만 보면 «로그인 없음»으로
 * 잘못 보고 잘 쓰던 계정을 덮어쓰게 된다(보안 검수 2026-11-17) — 조건을 UPDATE 에 다시 적어 그 경우 0줄이 되게 한다.
 *
 * 직원 가드는 «User.email = 로그인 이메일»을 요구하므로 간편로그인 이메일이 반드시 있어야 하고(없으면 붙여도 못 들어온다),
 * 다른 계정이 쓰는 이메일이면 붙이지 않는다.
 * 같은 거래에서 감사 기록을 남기고, 끝난 뒤 다른 원장·부원장의 알림 벨에 한 줄 — 번호 주인이 바뀐 경우에도 원장이 알 수 있게.
 */
export type StaffSelfClaimResult =
  | { ok: true; name: string; role: string }
  | { ok: false; reason: "NO_EMAIL" | "CHANGED" };

export async function claimStaffRecordByIdentity(input: { userId: string; authUserId: string; email: string | null | undefined }): Promise<StaffSelfClaimResult> {
  const email = (input.email || "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "NO_EMAIL" };
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; name: string; phone: string | null; role: string }>>(
      `UPDATE "User"
          SET "authUserId" = $1, email = $2, "phoneVerifiedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $3 AND "authUserId" IS NULL AND role::text <> 'PARENT'
          AND lower(email) LIKE $4
          AND "withdrawnAt" IS NULL AND "withdrawRequestedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "User" o WHERE o.id <> $3 AND (o."authUserId" = $1 OR o.id = $1 OR lower(o.email) = $2))
        RETURNING id, name, phone, role::text AS role`,
      input.authUserId, email, input.userId, `%${DIRECT_ADDED_EMAIL_SUFFIX}`,
    );
    const row = rows[0];
    if (!row) return null;
    // 같은 이름·번호의 코치 프로필이 있고 아직 연결이 없으면 연결한다(초대 가입과 같은 규칙)
    const linked = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Coach" WHERE "userId" = $1 LIMIT 1`, row.id);
    if (linked.length === 0) await linkMatchingCoachProfileToUser(tx, { userId: row.id, name: row.name, phone: row.phone || "", role: row.role });
    // 감사 기록 — 누가(본인)·언제·어떤 길로. 본인인증 내용·토큰은 남기지 않는다.
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'STAFF_LOGIN_LINKED', 'ADMIN', $1, $2::jsonb)`,
      row.id,
      JSON.stringify({ targetUserId: row.id, targetName: row.name, role: row.role, via: "IDENTITY_SELF", loginEmail: email }),
    );
    return row;
  });
  if (!claimed) return { ok: false, reason: "CHANGED" };
  await notifyAdminsOfSelfClaim(claimed);
  return { ok: true, name: claimed.name, role: claimed.role };
}

const ROLE_LABELS: Record<string, string> = { ADMIN: "원장", VICE_ADMIN: "부원장", INSTRUCTOR: "선생님", DRIVER: "기사님" };

/** 다른 원장·부원장의 알림 벨에 한 줄(사후 통지 — 승인 절차가 아니다). 연결은 이미 끝났으므로 알림 실패는 기록만 남긴다. */
async function notifyAdminsOfSelfClaim(row: { id: string; name: string; role: string }) {
  try {
    const admins = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "User" WHERE role IN ('ADMIN', 'VICE_ADMIN') AND "withdrawnAt" IS NULL AND id <> $1`,
      row.id,
    );
    for (const admin of admins) {
      await createNotificationRecord({
        userId: admin.id,
        type: "STAFF_LOGIN_LINKED",
        title: "스태프 로그인 연결",
        message: `${row.name} ${ROLE_LABELS[row.role] ?? "직원"} 계정에 본인인증으로 로그인이 연결됐어요`,
        linkUrl: "/admin/staff",
      });
    }
  } catch (error) {
    console.error("[staff self-claim] admin notice failed:", error instanceof Error ? error.message : String(error));
  }
}
