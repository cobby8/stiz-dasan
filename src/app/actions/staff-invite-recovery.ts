"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { randomUUID } from "node:crypto";
import { requireOwner } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";

export async function listStaffInvitationRecoveries() {
  await requireOwner();
  return prisma.$queryRawUnsafe<Array<{
    id: string;
    name: string;
    status: string;
    processingStartedAt: Date | null;
    recoveryAuthUserId: string | null;
    recoveryError: string | null;
  }>>(
    `SELECT id, name, status, "processingStartedAt", "recoveryAuthUserId", "recoveryError"
     FROM "StaffInvitation"
     WHERE status IN ('PROCESSING', 'RECOVERY_REQUIRED', 'RECOVERING')
     ORDER BY "processingStartedAt" ASC NULLS FIRST`,
  );
}

export async function recoverStaffInvitation(input: { invitationId: string }) {
  const admin = await requireOwner();
  const invitationId = input.invitationId.trim();
  if (!invitationId) return { ok: false as const, message: "복구할 초대를 선택해 주세요." };

  const operationId = randomUUID();
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string;
    phone: string;
    status: string;
    processingStartedAt: Date | null;
    recoveryAuthUserId: string | null;
    claimedAttemptId: string;
  }>>(
    `WITH target AS (
       SELECT id, "processingAttemptId" AS "claimedAttemptId"
       FROM "StaffInvitation"
       WHERE id = $1 AND (
         status = 'RECOVERY_REQUIRED'
         OR (status IN ('PROCESSING', 'RECOVERING') AND "processingStartedAt" <= NOW() - INTERVAL '10 minutes')
       )
       FOR UPDATE
     )
     UPDATE "StaffInvitation" AS invitation
     SET status = 'RECOVERING', "recoveryOperationId" = $2, "processingStartedAt" = NOW(), "updatedAt" = NOW()
     FROM target
     WHERE invitation.id = target.id
     RETURNING invitation.id, invitation.phone, invitation.status, invitation."processingStartedAt",
               invitation."recoveryAuthUserId", target."claimedAttemptId"`,
    invitationId,
    operationId,
  );
  const invitation = rows[0];
  if (!invitation) {
    return { ok: false as const, message: "진행 중인 가입은 10분 후 또는 복구 필요 상태에서만 처리할 수 있습니다." };
  }

  const supabaseAdmin = createAdminClient();
  let ownershipVerified = false;
  const attempts = await prisma.$queryRawUnsafe<Array<{ authUserId: string | null }>>(
    `SELECT "authUserId" FROM "StaffInvitationAuthAttempt"
     WHERE id = $1 AND "invitationId" = $2 AND status IN ('CREATING', 'CREATED', 'RECOVERY_REQUIRED')`,
    invitation.claimedAttemptId,
    invitation.id,
  );
  let authUserId = attempts[0]?.authUserId ?? invitation.recoveryAuthUserId;

  try {
    if (!authUserId) {
      const staffEmail = `${invitation.phone}@staff.stiz.kr`;
      let page = 1;
      while (!authUserId) {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(`인증 계정 조회 실패: ${error.message}`);
        const ownedUser = data.users.find(
          (user) => user.email === staffEmail && user.user_metadata?.invitationAttemptId === invitation.claimedAttemptId,
        );
        authUserId = ownedUser?.id ?? null;
        if (data.users.length < 1000) break;
        page += 1;
      }
    }

    if (authUserId) {
      const { data: ownedAuth, error: ownershipError } = await supabaseAdmin.auth.admin.getUserById(authUserId);
      if (ownershipError && !/not found|does not exist|404/i.test(ownershipError.message)) {
        throw new Error(`인증 계정 소유권 확인 실패: ${ownershipError.message}`);
      }
      if (ownedAuth.user) {
        const expectedEmail = `${invitation.phone}@staff.stiz.kr`;
        const ownsAccount =
          ownedAuth.user.email === expectedEmail &&
          ownedAuth.user.user_metadata?.invitationAttemptId === invitation.claimedAttemptId;
        if (!ownsAccount) throw new Error("복구 대상 계정의 소유권이 일치하지 않습니다.");
        ownershipVerified = true;
        await prisma.$executeRawUnsafe(
          `UPDATE "StaffInvitationAuthAttempt"
           SET "authUserId" = $1, status = 'RECOVERY_REQUIRED', "updatedAt" = NOW()
           WHERE id = $2 AND "invitationId" = $3 AND status IN ('CREATING', 'CREATED', 'RECOVERY_REQUIRED')`,
          authUserId,
          invitation.claimedAttemptId,
          invitationId,
        );
      }
      const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
      if (error) {
        const alreadyAbsent = /not found|does not exist|404/i.test(error.message);
        if (!alreadyAbsent) throw new Error(error.message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    await prisma.$executeRawUnsafe(
      `UPDATE "StaffInvitation"
       SET status = 'RECOVERY_REQUIRED', "recoveryAuthUserId" = COALESCE($3, "recoveryAuthUserId"),
           "recoveryError" = $4, "updatedAt" = NOW()
       WHERE id = $1 AND status = 'RECOVERING' AND "recoveryOperationId" = $2`,
      invitationId,
      operationId,
      ownershipVerified ? authUserId : null,
      message.slice(0, 1000),
    ).catch(() => undefined);
    await prisma.$executeRawUnsafe(
      `UPDATE "StaffInvitationAuthAttempt"
       SET "authUserId" = COALESCE($2, "authUserId"), status = 'RECOVERY_REQUIRED', error = $3, "updatedAt" = NOW()
       WHERE id = $1 AND status IN ('CREATING', 'CREATED', 'RECOVERY_REQUIRED')`,
      invitation.claimedAttemptId,
      ownershipVerified ? authUserId : null,
      message.slice(0, 1000),
    ).catch(() => undefined);
    console.error("[STAFF_INVITE_RECOVERY_CRITICAL] auth cleanup failed", {
      invitationId,
      operationId,
      authUserId,
      adminUserId: admin.id,
      error: message,
    });
    return { ok: false as const, message: "인증 계정 확인 또는 정리에 실패했습니다. 잠시 후 다시 시도해 주세요." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE "StaffInvitation"
         SET status = 'PENDING', "otpHash" = NULL, "otpExpiresAt" = NULL, "otpSentAt" = NULL,
             "otpAttempts" = 0, "otpVerifiedAt" = NULL, "otpConsumedAt" = NULL, "lockedAt" = NULL,
             "processingAttemptId" = NULL, "processingStartedAt" = NULL, "recoveryOperationId" = NULL,
             "recoveryAuthUserId" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND status = 'RECOVERING' AND "recoveryOperationId" = $2`,
        invitationId,
        operationId,
      );
      if (updated !== 1) throw new Error("초대 복구 상태가 변경되었습니다.");
      await tx.$executeRawUnsafe(
        `UPDATE "StaffInvitationAuthAttempt"
         SET status = 'DELETED', error = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND "invitationId" = $2 AND status IN ('CREATING', 'CREATED', 'RECOVERY_REQUIRED')`,
        invitation.claimedAttemptId,
        invitationId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "StaffInvitationRecoveryLog" (id, "invitationId", "adminUserId", action, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'RESET_TO_PENDING', NOW())`,
        invitationId,
        admin.id,
      );
    });
  } catch (error) {
    console.error("[STAFF_INVITE_RECOVERY_CRITICAL] database recovery failed", {
      invitationId,
      operationId,
      authUserId,
      adminUserId: admin.id,
      error: error instanceof Error ? error.message : "UNKNOWN",
    });
    return { ok: false as const, message: "인증 계정은 정리됐지만 초대 DB 복구에 실패했습니다. 관리자 로그를 확인해 주세요." };
  }

  // 스태프 화면은 태그 캐시(admin-staff, 60초)로 읽는다 — 경로만 비우면 복구된 초대가 1분 가까이 옛 상태로 보였다.
  revalidateTag("admin-staff", { expire: 0 });
  revalidatePath("/admin/staff");
  return { ok: true as const };
}
