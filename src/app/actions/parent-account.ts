"use server";

import { anonymizeChildConnections } from "@/lib/account/child-withdrawal";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { OwnAccountError, requireOwnAccount } from "@/lib/account/own-account";
import { readWithdrawalRecord } from "@/lib/account/account-withdrawal-data";
import { accountWithdrawalPolicy } from "@/lib/account/account-withdrawal-policy";
import {
  ANONYMIZED_NAME,
  CLEARED_USER_COLUMNS,
  anonymizedEmail,
  canCancelWithdrawalRequest,
  canRequestWithdrawal,
  withdrawalState,
} from "@/lib/account/withdrawal";
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

export async function acceptParentAccountClaim(
  token: string,
  email: string,
  password: string,
) {
  const normalizedToken = token.trim();
  const cookieStore = await cookies();
  const cookieName = parentClaimProofCookieName(normalizedToken);
  const proof = cookieStore.get(cookieName)?.value || "";
  const result = await consumeParentAccountClaim(
    normalizedToken,
    proof,
    email,
    password,
  );
  if (!("ok" in result) || !result.ok) return result;

  cookieStore.delete(cookieName);
  const supabase = await createClient();
  const signedIn = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
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

/** 계정 관리 작업은 이름·이메일이 아니라 현재 로그인에 직접 연결된 본인 계정을 기준으로 한다. */
function withdrawalFailure(error: unknown) {
  return {
    error:
      error instanceof OwnAccountError
        ? error.message
        : "계정 처리를 완료하지 못했습니다. 다시 확인해 주세요.",
  };
}
function policyFor(
  row: NonNullable<Awaited<ReturnType<typeof readWithdrawalRecord>>>,
) {
  return accountWithdrawalPolicy({
    role: row.role,
    activeEnrollmentCount: row.activeEnrollments,
    activeStaffGrantCount: row.activeStaffGrantCount,
    activeWorkCount: row.activeWorkCount,
  });
}
export async function getAccountWithdrawalStatus() {
  const account = await requireOwnAccount();
  const row = await readWithdrawalRecord(account.appUserId);
  if (!row || row.withdrawnAt)
    throw new OwnAccountError("현재 계정을 확인하지 못했습니다.");
  return {
    state: withdrawalState(row),
    activeEnrollmentCount: Number(row.activeEnrollments),
    activeWorkCount: Number(row.activeWorkCount),
    ...policyFor(row),
  };
}

/** 모든 역할은 본인의 탈퇴를 요청할 수 있다. 관리 권한·담당 업무가 있으면 자동 삭제하지 않는다. */
export async function requestAccountWithdrawal() {
  try {
    const account = await requireOwnAccount();
    const row = await readWithdrawalRecord(account.appUserId);
    if (!row || !canRequestWithdrawal(row))
      return {
        error: row?.withdrawRequestedAt
          ? "이미 탈퇴를 신청하셨습니다. 처리 상태를 확인해 주세요."
          : "현재 계정을 확인하지 못했습니다.",
      };
    const policy = policyFor(row);
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE "User" SET "withdrawRequestedAt"=NOW(),"updatedAt"=NOW()
      WHERE id=$1 AND "withdrawRequestedAt" IS NULL AND "withdrawnAt" IS NULL`,
      account.appUserId,
    );
    if (changed !== 1)
      return { error: "계정 상태가 변경되었습니다. 다시 확인해 주세요." };
    if (policy.immediate) {
      const result = await executeAccountWithdrawal(account.appUserId);
      if ("error" in result) return result;
      return { ok: true, withdrawn: true };
    }
    // 외부 문자·푸시는 보내지 않는다. 관리자 신청 목록에서 같은 접수 원장을 확인한다.
    revalidatePath("/account");
    revalidatePath("/account/withdraw");
    revalidatePath("/mypage");
    revalidatePath("/admin/withdrawals");
    return {
      ok: true,
      withdrawn: false,
      activeEnrollmentCount: Number(row.activeEnrollments),
      reviewReason: policy.reviewReason,
    };
  } catch (error) {
    return withdrawalFailure(error);
  }
}

export async function cancelAccountWithdrawalRequest() {
  try {
    const account = await requireOwnAccount();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = $1 FOR UPDATE`, account.appUserId);
      // 삭제 처리의 행 잠금을 기다리는 사이 Auth가 사라졌다면 접수 표시를 지우지 않는다.
      const current = await requireOwnAccount();
      if (current.appUserId !== account.appUserId || current.authUserId !== account.authUserId) {
        throw new OwnAccountError("현재 계정을 다시 확인해 주세요.", 403);
      }
      const row = await readWithdrawalRecord(account.appUserId, tx);
      if (!row || !canCancelWithdrawalRequest(row)) throw new OwnAccountError("취소할 탈퇴 신청이 없습니다.", 409);
      const count = await tx.$executeRawUnsafe(
        `UPDATE "User" SET "withdrawRequestedAt" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND "withdrawRequestedAt" IS NOT NULL AND "withdrawnAt" IS NULL`,
        account.appUserId,
      );
      if (count !== 1) throw new OwnAccountError("처리 상태가 변경되었습니다. 다시 확인해 주세요.", 409);
    }, { isolationLevel: "Serializable", timeout: 30000 });
    revalidatePath("/account/withdraw");
    revalidatePath("/mypage");
    revalidatePath("/admin/withdrawals");
    return { ok: true };
  } catch (error) {
    return withdrawalFailure(error);
  }
}

/** 공개 Server Action 자체에서 대상·권한을 재검사하므로 다른 계정 ID를 직접 보내도 삭제할 수 없다. */
export async function executeAccountWithdrawal(userId: string) {
  try {
    const account = await requireOwnAccount();
    const target = typeof userId === "string" ? userId.trim() : "";
    if (!target || target.length > 100)
      return { error: "대상 계정을 확인해 주세요." };
    const self = target === account.appUserId;
    if (!self && !["ADMIN", "VICE_ADMIN"].includes(account.appUserRole))
      return { error: "본인 계정만 처리할 수 있습니다." };
    const result = await prisma.$transaction(
      async (tx) => {
        // 관리자·대상 계정의 역할 변경과 탈퇴 처리가 동시에 진행되지 않도록 같은 행을 잠근다.
        await tx.$queryRawUnsafe(
          `SELECT id FROM "User" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
          [target, account.appUserId],
        );
        const actorRows = await tx.$queryRawUnsafe<{ role: string }[]>(
          `SELECT role::text AS role FROM "User" WHERE id=$1
        AND ("authUserId"=$2 OR ("authUserId" IS NULL AND id=$2)) AND "withdrawnAt" IS NULL`,
          account.appUserId,
          account.authUserId,
        );
        if (
          !actorRows[0] ||
          (!self && !["ADMIN", "VICE_ADMIN"].includes(actorRows[0].role))
        )
          throw new OwnAccountError(
            "현재 계정의 처리 권한을 확인하지 못했습니다.",
            403,
          );
        const row = await readWithdrawalRecord(target, tx);
        if (!row) throw new OwnAccountError("계정을 찾을 수 없습니다.", 404);
        if (row.withdrawnAt) return { ok: true, alreadyWithdrawn: true };
        if (!row.withdrawRequestedAt)
          throw new OwnAccountError("탈퇴 신청을 먼저 접수해 주세요.", 409);
        const policy = policyFor(row);
        if (policy.reviewReason === "ADMIN_HANDOFF")
          throw new OwnAccountError(policy.reviewMessage!, 409);
        if (self && !policy.immediate)
          throw new OwnAccountError(
            "관리자 확인이 필요한 계정은 직접 삭제할 수 없습니다.",
            409,
          );
        if (Number(row.activeWorkCount) !== 0)
          throw new OwnAccountError(
            "담당 수업·운행·지도자 정보를 먼저 이관한 뒤 처리해 주세요.",
            409,
          );
        // Auth 삭제 → 개인정보 익명화 순서를 유지한다. 로그인 계정만 지워지고 DB 정리가 실패하면 오류로 남겨 재확인한다.
        const authId = row.authUserId || (self ? account.authUserId : row.id);
        const removed = await createAdminClient().auth.admin.deleteUser(authId);
        if (
          removed.error &&
          !/not found|user_not_found/i.test(removed.error.message)
        )
          throw new OwnAccountError(
            "로그인 계정을 삭제하지 못했습니다. 다시 시도해 주세요.",
            503,
          );
        const clearList = CLEARED_USER_COLUMNS.map(
          (column) => `"${column}" = NULL`,
        ).join(", ");
        await tx.$executeRawUnsafe(
          `UPDATE "User"
        SET email = $2, name = $3, ${clearList},
        "withdrawRequestedAt" = COALESCE("withdrawRequestedAt", NOW()),"withdrawnAt"=NOW(),"updatedAt"=NOW() WHERE id=$1`,
          target,
          anonymizedEmail(target),
          ANONYMIZED_NAME,
        );
        await anonymizeChildConnections(tx, target);
        await tx.$executeRawUnsafe(
          `DELETE FROM "PushSubscription" WHERE "userId" = $1`,
          target,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "UserRoleGrant"
        SET status = 'REVOKED', "decidedAt" = NOW(), note = COALESCE(note, '회원 탈퇴'), "updatedAt" = NOW()
        WHERE "userId" = $1 AND status IN ('PENDING', 'ACTIVE')`,
          target,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "KakaoParentIdentity" SET "parentUserId" = NULL, status = 'REVOKED',
        "revokedAt"=COALESCE("revokedAt",NOW()),"updatedAt"=NOW() WHERE "parentUserId"=$1`,
          target,
        );
        // 기존 대표 보호자의 좌표 정리 범위만 유지한다. 다른 가족의 학생·출결·수납 기록은 삭제하지 않는다.
        await tx.$executeRawUnsafe(
          `DELETE FROM "StudentShuttleLocation" WHERE "studentId" IN (SELECT id FROM "Student" WHERE "parentId" = $1)`,
          target,
        );
        return { ok: true };
      },
      { isolationLevel: "Serializable", timeout: 30000 },
    );
    if (self && result.ok) {
      const supabase = await createClient();
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    }
    revalidatePath("/account");
    revalidatePath("/mypage");
    revalidatePath("/admin/withdrawals");
    return result;
  } catch (error) {
    return withdrawalFailure(error);
  }
}
