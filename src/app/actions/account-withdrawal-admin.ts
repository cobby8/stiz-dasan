"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { executeAccountWithdrawal } from "@/app/actions/parent-account";
import { prisma } from "@/lib/prisma";

// 회원 탈퇴 신청 — 원장 확인·처리.
// 재학 중인 학부모의 탈퇴는 즉시 지우지 않고 여기로 모인다(원장 결정 2026-10-24).
// 모두 requireAdmin 게이트. $executeRawUnsafe (PgBouncer 트랜잭션 모드 호환).

export type WithdrawalRequestRow = {
  userId: string;
  name: string;
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
    `SELECT u.id AS "userId", u.name, u.email, u.phone,
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
  return rows;
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

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "User"
        SET "withdrawRequestedAt" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND "withdrawRequestedAt" IS NOT NULL AND "withdrawnAt" IS NULL`,
    target,
  );
  if (affected !== 1) return { error: "처리할 탈퇴 신청이 없습니다." };

  revalidatePath("/admin/withdrawals");
  revalidatePath("/admin");
  return { ok: true };
}
