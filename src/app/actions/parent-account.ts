"use server";

import { anonymizeChildConnections } from "@/lib/account/child-withdrawal";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  ANONYMIZED_NAME,
  CLEARED_USER_COLUMNS,
  anonymizedEmail,
  canCancelWithdrawalRequest,
  canRequestWithdrawal,
  decideWithdrawal,
  withdrawalState,
} from "@/lib/account/withdrawal";
import { notifyAdmins } from "@/lib/notification";
import {
  consumeParentAccountClaim,
  parentClaimProofCookieName,
  readParentAccountClaim,
  sendParentClaimOtp,
  verifyParentClaimOtp,
} from "@/lib/parent-account-claim";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function getParentAccountClaim(token: string) {
  return readParentAccountClaim(token.trim());
}

export async function sendParentAccountOtp(token: string) {
  return sendParentClaimOtp(token.trim());
}

export async function verifyParentAccountOtp(token: string, code: string) {
  const normalizedToken = token.trim();
  const result = await verifyParentClaimOtp(normalizedToken, code);
  if ("error" in result) return { error: result.error };
  const cookieStore = await cookies();
  cookieStore.set(parentClaimProofCookieName(normalizedToken), result.proof, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return { ok: true, verified: true };
}

export async function acceptParentAccountClaim(token: string, email: string, password: string) {
  const normalizedToken = token.trim();
  const cookieStore = await cookies();
  const cookieName = parentClaimProofCookieName(normalizedToken);
  const proof = cookieStore.get(cookieName)?.value || "";
  const result = await consumeParentAccountClaim(normalizedToken, proof, email, password);
  if (!("ok" in result) || !result.ok) return result;

  cookieStore.delete(cookieName);
  const supabase = await createClient();
  const signedIn = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (signedIn.error) {
    const loginRedirect = `/login?redirect=${encodeURIComponent(result.redirectPath)}`;
    return { ...result, sessionEstablished: false, loginRedirect };
  }
  return { ...result, sessionEstablished: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 회원 탈퇴(계정 삭제)
//
// 구글플레이는 계정을 만들 수 있는 앱에 앱 내 계정 삭제를 요구한다. 그보다 중요한 건
// 개인정보처리방침에 이미 "회원 탈퇴 시: 즉시 파기"를 적어 두고도 탈퇴할 방법이 없었다는 점이다.
//
// 지우는 것 — Auth 계정, 이메일·전화·이름, 카카오 연결, 푸시 구독, 셔틀 좌표
// 남기는 것 — 학생·출결·결제. 학원 장부이고 전자상거래법상 5년 보관 대상이며,
//             방침도 "법령에 따른 보존 기간은 예외"를 이미 두고 있다.
// ─────────────────────────────────────────────────────────────────────────────

/** 탈퇴 화면이 쓰는 현재 상태 — 재학 중이면 즉시 처리되지 않는다는 것을 미리 알려야 한다. */
export async function getAccountWithdrawalStatus() {
  const parent = await requireVerifiedParent();
  const rows = await prisma.$queryRawUnsafe<
    { withdrawRequestedAt: Date | null; withdrawnAt: Date | null; activeEnrollments: number }[]
  >(
    `SELECT u."withdrawRequestedAt", u."withdrawnAt",
            (SELECT COUNT(*)::int
               FROM "Enrollment" e
               JOIN "Student" s ON s.id = e."studentId"
              WHERE s."parentId" = u.id AND e.status = 'ACTIVE') AS "activeEnrollments"
       FROM "User" u
      WHERE u.id = $1
      LIMIT 1`,
    parent.appUserId,
  );
  const row = rows[0];
  if (!row) throw new Error("계정을 찾을 수 없습니다.");

  const activeEnrollmentCount = Number(row.activeEnrollments ?? 0);
  return {
    state: withdrawalState(row),
    activeEnrollmentCount,
    // 재학 중이면 신청만 접수되고 원장 확인을 기다린다.
    immediate: decideWithdrawal({ activeEnrollmentCount }).action === "EXECUTE_NOW",
  };
}

/**
 * 학부모가 탈퇴를 신청한다.
 * 재학 중이 아니면 그 자리에서 처리하고, 재학 중이면 신청만 받아 원장에게 알린다.
 */
export async function requestAccountWithdrawal() {
  const parent = await requireVerifiedParent();

  const rows = await prisma.$queryRawUnsafe<
    { name: string; withdrawRequestedAt: Date | null; withdrawnAt: Date | null; activeEnrollments: number }[]
  >(
    `SELECT u.name, u."withdrawRequestedAt", u."withdrawnAt",
            (SELECT COUNT(*)::int
               FROM "Enrollment" e
               JOIN "Student" s ON s.id = e."studentId"
              WHERE s."parentId" = u.id AND e.status = 'ACTIVE') AS "activeEnrollments"
       FROM "User" u
      WHERE u.id = $1
      LIMIT 1`,
    parent.appUserId,
  );
  const row = rows[0];
  if (!row) return { error: "계정을 찾을 수 없습니다." };
  if (!canRequestWithdrawal(row)) {
    return {
      error: withdrawalState(row) === "PENDING"
        ? "이미 탈퇴를 신청하셨습니다. 원장님 확인을 기다리고 있습니다."
        : "이미 탈퇴 처리된 계정입니다.",
    };
  }

  const decision = decideWithdrawal({ activeEnrollmentCount: Number(row.activeEnrollments ?? 0) });

  // 신청 시각은 어느 쪽이든 먼저 남긴다. 즉시 처리가 중간에 실패해도 신청이 사라지지 않는다.
  await prisma.$executeRawUnsafe(
    `UPDATE "User" SET "withdrawRequestedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = $1 AND "withdrawRequestedAt" IS NULL AND "withdrawnAt" IS NULL`,
    parent.appUserId,
  );

  if (decision.action === "EXECUTE_NOW") {
    const result = await executeAccountWithdrawal(parent.appUserId);
    if ("error" in result) return result;
    revalidatePath("/mypage");
    return { ok: true, withdrawn: true };
  }

  // 재학 중 — 원장이 확인해야 한다. 알림이 실패해도 신청은 이미 접수됐다.
  try {
    await notifyAdmins(
      "ACCOUNT_WITHDRAWAL_REQUEST",
      "회원 탈퇴 신청",
      `${row.name} 학부모님이 탈퇴를 신청했습니다. 수강 중인 반 ${decision.activeEnrollmentCount}건이 있어 확인이 필요합니다.`,
      "/admin/withdrawals",
      { notifyCoaches: false, eventId: `withdrawal:${parent.appUserId}` },
    );
  } catch (error) {
    console.error("[requestAccountWithdrawal] 원장 알림 실패:", error);
  }

  revalidatePath("/mypage");
  return { ok: true, withdrawn: false, activeEnrollmentCount: decision.activeEnrollmentCount };
}

/** 학부모가 신청을 취소한다. 이미 처리된 탈퇴는 되돌릴 수 없다. */
export async function cancelAccountWithdrawalRequest() {
  const parent = await requireVerifiedParent();
  const rows = await prisma.$queryRawUnsafe<{ withdrawRequestedAt: Date | null; withdrawnAt: Date | null }[]>(
    `SELECT "withdrawRequestedAt", "withdrawnAt" FROM "User" WHERE id = $1 LIMIT 1`,
    parent.appUserId,
  );
  const row = rows[0];
  if (!row) return { error: "계정을 찾을 수 없습니다." };
  if (!canCancelWithdrawalRequest(row)) {
    return {
      error: withdrawalState(row) === "WITHDRAWN"
        ? "이미 탈퇴 처리된 계정은 되돌릴 수 없습니다."
        : "취소할 탈퇴 신청이 없습니다.",
    };
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "User" SET "withdrawRequestedAt" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND "withdrawnAt" IS NULL`,
    parent.appUserId,
  );
  revalidatePath("/mypage");
  return { ok: true };
}

/**
 * 실제 탈퇴 처리. 학부모의 즉시 탈퇴와 원장의 승인이 **같은 함수**를 쓴다
 * (두 경로가 갈리면 한쪽만 고쳐지는 사고가 난다 — 이 프로젝트에서 이미 겪었다).
 *
 * ⚠️ 순서가 중요하다. Auth 계정을 **먼저** 지운다.
 *    DB 를 먼저 익명화하고 Auth 삭제가 실패하면 «이름·이메일은 익명인데 로그인은 되는» 상태가 되어
 *    자녀 정보를 계속 볼 수 있다. Auth 를 먼저 지우면 실패해도 로그인이 막힌 것뿐이라 다시 시도하면 된다.
 */
export async function executeAccountWithdrawal(userId: string) {
  const rows = await prisma.$queryRawUnsafe<{ authUserId: string | null; withdrawnAt: Date | null }[]>(
    `SELECT "authUserId", "withdrawnAt" FROM "User" WHERE id = $1 LIMIT 1`,
    userId,
  );
  const row = rows[0];
  if (!row) return { error: "계정을 찾을 수 없습니다." };
  if (row.withdrawnAt) return { ok: true, alreadyWithdrawn: true };

  // 1) 로그인 수단부터 없앤다. authUserId 가 없는 계정(아직 Auth 연결 전)은 건너뛴다.
  if (row.authUserId) {
    const { error } = await createAdminClient().auth.admin.deleteUser(row.authUserId);
    // 이미 지워져 있으면(not found) 계속 진행한다 — 재시도 중일 수 있다.
    if (error && !/not found|User not found/i.test(error.message)) {
      console.error("[executeAccountWithdrawal] Auth 계정 삭제 실패:", error.message);
      return { error: "로그인 계정을 삭제하지 못했습니다. 잠시 후 다시 시도해주세요." };
    }
  }

  // 2) 개인정보 익명화 — 여기까지 오면 로그인은 이미 불가능하다.
  try {
    await prisma.$transaction(async (tx) => {
      const clearList = CLEARED_USER_COLUMNS.map((column) => `"${column}" = NULL`).join(", ");
      await tx.$executeRawUnsafe(
        `UPDATE "User"
            SET email = $2, name = $3, ${clearList},
                "withdrawRequestedAt" = COALESCE("withdrawRequestedAt", NOW()),
                "withdrawnAt" = NOW(), "updatedAt" = NOW()
          WHERE id = $1`,
        userId,
        anonymizedEmail(userId),
        ANONYMIZED_NAME,
      );

      await anonymizeChildConnections(tx, userId);

      // 푸시 알림을 계속 받으면 탈퇴한 사람에게 학원 소식이 간다.
      await tx.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE "userId" = $1`, userId);

      // 추가 역할(선생님·기사님)과 대기 중인 신청도 회수한다. 탈퇴는 행을 지우지 않고 익명화하므로
      // ON DELETE CASCADE 가 걸리지 않는다 — 여기서 직접 닫지 않으면 «탈퇴한 회원»에게 권한 기록이 남는다.
      // 행은 지우지 않고 REVOKED 로 남긴다: 누가 언제 어떤 권한을 가졌었는지는 기록으로 필요하다.
      await tx.$executeRawUnsafe(
        `UPDATE "UserRoleGrant"
            SET status = 'REVOKED', "decidedAt" = NOW(), note = COALESCE(note, '회원 탈퇴'), "updatedAt" = NOW()
          WHERE "userId" = $1 AND status IN ('PENDING', 'ACTIVE')`,
        userId,
      );

      // 카카오 연결은 행을 지우지 않고 끊는다 — KakaoParentIntake 가 Cascade 라서
      // 지우면 결석 신고 같은 운영 기록이 함께 사라진다. userKeyHash 는 복원 불가한 해시이고
      // 소유자 연결이 끊기면 누구인지 알 수 없다.
      await tx.$executeRawUnsafe(
        `UPDATE "KakaoParentIdentity"
            SET "parentUserId" = NULL, status = 'REVOKED',
                "revokedAt" = COALESCE("revokedAt", NOW()), "updatedAt" = NOW()
          WHERE "parentUserId" = $1`,
        userId,
      );

      // 셔틀 승·하차 좌표는 위치정보다. 수업을 안 다니면 보관할 근거가 없다.
      await tx.$executeRawUnsafe(
        `DELETE FROM "StudentShuttleLocation"
          WHERE "studentId" IN (SELECT id FROM "Student" WHERE "parentId" = $1)`,
        userId,
      );
    });
  } catch (error) {
    console.error("[executeAccountWithdrawal] 개인정보 익명화 실패:", error);
    // 로그인은 이미 막혔으므로 피해는 없다. 다시 실행하면 이어서 처리된다.
    return { error: "탈퇴 처리 중 오류가 발생했습니다. 다시 시도해주세요." };
  }

  revalidatePath("/mypage");
  revalidatePath("/admin");
  return { ok: true };
}
