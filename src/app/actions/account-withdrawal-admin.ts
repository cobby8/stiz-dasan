"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { executeAccountWithdrawal } from "@/app/actions/parent-account";
import { prisma } from "@/lib/prisma";
import { readWithdrawalRecord } from "@/lib/account/account-withdrawal-data";
import { accountWithdrawalPolicy } from "@/lib/account/account-withdrawal-policy";

import { createAdminClient } from "@/lib/supabase/admin";
import { OwnAccountError, requireOwnAccount } from "@/lib/account/own-account";

// 회원 탈퇴 신청 — 원장 확인·처리.
// 재학 중인 학부모의 탈퇴는 즉시 지우지 않고 여기로 모인다(원장 결정 2026-10-24).
// 모두 requireAdmin 게이트. $executeRawUnsafe (PgBouncer 트랜잭션 모드 호환).

export type WithdrawalRequestRow = {
  userId: string;
  name: string;
  role: string;
  activeWorkCount?: number;
  reviewMessage?: string | null;
  administrativeHold?: boolean;
  email: string;
  phone: string | null;
  requestedAt: Date | string;
  activeEnrollments: number;
  /** 자녀 이름 — 누구의 보호자인지 알아야 원장이 판단할 수 있다. */
  childNames: string;
};

/**
 * 처리 대기 중인 탈퇴 신청.
 * 신청했고 아직 처리되지 않은 계정만 — 부분 인덱스(User_withdraw_pending_idx)가 이 조건을 탄다.
 */
export async function getPendingWithdrawalRequests(): Promise<WithdrawalRequestRow[]> {
  await requireAdmin();

  const rows = await prisma.$queryRawUnsafe<WithdrawalRequestRow[]>(
    `SELECT u.id AS "userId", u.name, u.role::text AS role, u.email, u.phone,
            u."withdrawRequestedAt" AS "requestedAt",
            (SELECT COUNT(*)::int
               FROM "Enrollment" e
               JOIN "Student" s ON s.id = e."studentId"
              WHERE s."parentId" = u.id AND e.status = 'ACTIVE') AS "activeEnrollments",
            COALESCE(
              (SELECT STRING_AGG(s.name, ', ' ORDER BY s.name)
                 FROM "Student" s
                WHERE s."parentId" = u.id AND s."mergedIntoStudentId" IS NULL),
              ''
            ) AS "childNames"
       FROM "User" u
      WHERE u."withdrawRequestedAt" IS NOT NULL
        AND u."withdrawnAt" IS NULL
      ORDER BY u."withdrawRequestedAt" ASC`,
  );
  return Promise.all(rows.map(async (row) => {
    const context = await readWithdrawalRecord(row.userId);
    if (!context) return { ...row, administrativeHold: true, reviewMessage: "계정 상태를 다시 확인해 주세요." };
    const policy = accountWithdrawalPolicy({
      role: context.role,
      activeEnrollmentCount: context.activeEnrollments,
      activeStaffGrantCount: context.activeStaffGrantCount,
      activeWorkCount: context.activeWorkCount,
    });
    return {
      ...row,
      role: context.role,
      activeEnrollments: context.activeEnrollments,
      activeWorkCount: context.activeWorkCount,
      reviewMessage: policy.reviewMessage,
      administrativeHold: policy.reviewReason === "ADMIN_HANDOFF" || Number(context.activeWorkCount) !== 0,
    };
  }));
}

/**
 * 원장이 탈퇴를 처리한다.
 * 학부모의 즉시 탈퇴와 **같은 함수**(executeAccountWithdrawal)를 쓴다 —
 * 두 경로가 갈리면 한쪽만 고쳐지는 사고가 난다(이 프로젝트에서 이미 겪었다).
 */
export async function approveWithdrawalRequest(userId: string) {
  await requireAdmin();

  const target = String(userId ?? "").trim();
  if (!target) return { error: "대상 계정이 지정되지 않았습니다." };

  // 신청하지 않은 계정을 원장 화면에서 지울 수는 없다 — 목록이 낡았을 때의 오조작을 막는다.
  const rows = await prisma.$queryRawUnsafe<{ withdrawRequestedAt: Date | null; withdrawnAt: Date | null }[]>(
    `SELECT "withdrawRequestedAt", "withdrawnAt" FROM "User" WHERE id = $1 LIMIT 1`,
    target,
  );
  const row = rows[0];
  if (!row) return { error: "계정을 찾을 수 없습니다." };
  if (row.withdrawnAt) return { error: "이미 탈퇴 처리된 계정입니다." };
  if (!row.withdrawRequestedAt) return { error: "탈퇴를 신청하지 않은 계정입니다." };

  const result = await executeAccountWithdrawal(target);
  if ("error" in result) return result;

  revalidatePath("/admin/withdrawals");
  revalidatePath("/admin");
  return { ok: true };
}

/**
 * 원장이 신청을 반려한다(학부모와 이야기해 계속 다니기로 한 경우).
 * 계정은 그대로 남고 신청 표시만 지운다.
 */
export async function rejectWithdrawalRequest(userId: string) {
  await requireAdmin();

  const target = String(userId ?? "").trim();
  if (!target) return { error: "대상 계정이 지정되지 않았습니다." };

  try {
    const account = await requireOwnAccount();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [target, account.appUserId]);
      const current = await requireOwnAccount();
      if (current.appUserId !== account.appUserId || !["ADMIN", "VICE_ADMIN"].includes(current.appUserRole)) {
        throw new OwnAccountError("현재 계정의 처리 권한을 확인하지 못했습니다.", 403);
      }
      const rows = await tx.$queryRawUnsafe<Array<{ authUserId: string | null; withdrawnAt: Date | null; withdrawRequestedAt: Date | null }>>(
        `SELECT "authUserId", "withdrawnAt", "withdrawRequestedAt" FROM "User" WHERE id = $1`, target,
      );
      const row = rows[0];
      if (!row || row.withdrawnAt || !row.withdrawRequestedAt) throw new OwnAccountError("처리할 탈퇴 신청이 없습니다.", 409);
      // Auth가 이미 삭제됐거나 직접 연결을 확인할 수 없으면 삭제 정리를 재시도해야 한다.
      // 접수 표시를 먼저 지우면 옛 JWT가 일반 인증 경계를 다시 통과할 수 있다.
      if (!row.authUserId) throw new OwnAccountError("로그인 연결을 확인할 수 없습니다. 탈퇴 정리 상태를 먼저 확인해 주세요.", 409);
      const existing = await createAdminClient().auth.admin.getUserById(row.authUserId);
      if (existing.error || existing.data?.user?.id !== row.authUserId) {
        throw new OwnAccountError("로그인 계정의 탈퇴 정리가 필요합니다. 신청을 반려하지 말고 삭제 처리를 다시 확인해 주세요.", 409);
      }
      const affected = await tx.$executeRawUnsafe(
        `UPDATE "User"
            SET "withdrawRequestedAt" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND "withdrawRequestedAt" IS NOT NULL AND "withdrawnAt" IS NULL`, target,
      );
      if (affected !== 1) throw new OwnAccountError("처리할 탈퇴 신청이 없습니다.", 409);
    }, { isolationLevel: "Serializable", timeout: 30000 });
  } catch (error) {
    return { error: error instanceof OwnAccountError ? error.message : "신청 상태를 확인하지 못했습니다. 다시 시도해 주세요." };
  }

  revalidatePath("/admin/withdrawals");
  revalidatePath("/admin");
  return { ok: true };
}
