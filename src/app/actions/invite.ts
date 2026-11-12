"use server";

import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { isSmsProviderConfigured } from "@/lib/sms";
import { sendAuthenticationSms } from "@/lib/message-dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkMatchingCoachProfileToUser } from "@/lib/staff-coach-link";
import {
  STAFF_PASSWORD_MIN,
  classifyAuthFailure,
  decideInviteFailureOutcome,
  explainClaimFailure,
  failureNeedsVerification,
  staffAuthFailureMessage,
  type AuthFailureKind,
  type InviteClaimState,
} from "@/lib/staff/inviteAuthFailure";

import { RETIRED_LOGIN_BAN_DURATION, isConvertibleStaffRole, staffAuthId, staffLoginKind } from "@/lib/staff/staffAccountLink";

const MAX_OTP_ATTEMPTS = 5;

type CoachLinkTx = Parameters<typeof linkMatchingCoachProfileToUser>[0] & {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => PromiseLike<T>;
};

/** 이미 있는 직원 기록에 붙는 가입 — 연결된 코치 프로필이 있으면 그대로 두고(승계), 없을 때만 자동 연결. */
async function linkCoachProfileIfNone(
  tx: CoachLinkTx,
  input: { userId: string; name: string; phone: string; role: string },
) {
  const linked = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Coach" WHERE "userId" = $1 LIMIT 1`, input.userId);
  if (linked.length > 0) return 0;
  return linkMatchingCoachProfileToUser(tx, input);
}

/**
 * 기존 직원 기록에 붙는 가입의 거래 첫머리(2026-11-12 검수) — 직원 기록 → 초대 순서로 잠근다.
 * 역할 변경(updateUserRole)·퇴사 처리(retireStaffMember)도 직원 기록을 먼저 잠그고 초대를 취소하므로 서로 기다린다.
 * 초대가 이 시도의 PROCESSING 이 아니면(그 사이 취소됨) 멈춘다. 잠근 시점의 역할을 돌려준다.
 */
async function lockTargetAndAssertInvitation(
  tx: CoachLinkTx,
  input: { userId: string; invitationId: string; attemptId: string },
): Promise<string> {
  const users = await tx.$queryRawUnsafe<Array<{ role: string }>>(
    `SELECT role::text AS role FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL FOR UPDATE`,
    input.userId,
  );
  if (!users[0]) throw new Error("초대 처리 상태가 변경되었습니다.");
  const live = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "StaffInvitation"
      WHERE id = $1 AND status = 'PROCESSING' AND "processingAttemptId" = $2 FOR UPDATE`,
    input.invitationId,
    input.attemptId,
  );
  if (!live[0]) throw new Error("초대가 취소되었습니다. 원장에게 문의해주세요.");
  return users[0].role;
}

/** 재입사 가입이 DB 에서 실패했을 때 다시 연 로그인을 다시 막는다(자기 자녀가 없을 때만). 실패는 기록만. */
async function reblockRetiredLogin(input: { authId: string; userId: string; invitationId: string; attemptId: string }) {
  try {
    const children = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM "Student" s WHERE s."parentId" = $1 AND s."mergedIntoStudentId" IS NULL LIMIT 1`,
      input.userId,
    );
    if (children.length > 0) return;
    const { error } = await createAdminClient().auth.admin.updateUserById(input.authId, { ban_duration: RETIRED_LOGIN_BAN_DURATION });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error("[STAFF_INVITE_CRITICAL] retired login re-block failed", {
      invitationId: input.invitationId,
      attemptId: input.attemptId,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
const SMS_TIMEOUT_MS = 10_000;

type InvitationRow = {
  id: string;
  token?: string;
  name: string;
  phone: string;
  role: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER";
  status: string;
  expiresAt: Date;
  createdAt?: Date;
  purpose?: string | null;
  targetUserId?: string | null;
  otpHash?: string | null;
  otpExpiresAt?: Date | null;
  otpAttempts?: number;
  otpVerifiedAt?: Date | null;
  lockedAt?: Date | null;
  isExpired?: boolean;
  lockRemainingSeconds?: number;
  cooldownRemainingSeconds?: number;
};

function getOtpSecret() {
  const secret = process.env.INVITE_OTP_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("초대 인증 전용 보안키가 설정되지 않았습니다.");
  }
  return "development-only-invite-otp-secret";
}

function generateCode() {
  return randomInt(100000, 1000000).toString();
}

function hmac(value: string) {
  return createHmac("sha256", getOtpSecret()).update(value).digest("hex");
}

function hashCode(token: string, phone: string, code: string) {
  return hmac(`otp:${token}:${phone}:${code}`);
}

function hashesMatch(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function invitationStateError(invitation?: InvitationRow) {
  if (!invitation) return "존재하지 않는 초대입니다.";
  if (invitation.role !== "INSTRUCTOR" && invitation.role !== "DRIVER") return "스태프 전용 초대가 아닙니다.";
  if (invitation.status === "ACCEPTED") return "이미 수락된 초대입니다.";
  if (invitation.status === "CANCELLED") return "취소된 초대입니다.";
  if (invitation.status === "PROCESSING" || invitation.status === "RECOVERY_REQUIRED") {
    return "가입 처리 상태를 확인 중입니다. 관리자에게 문의해주세요.";
  }
  if (invitation.status !== "PENDING") return "유효하지 않은 초대입니다.";
  if (invitation.isExpired) return "만료된 초대입니다. 원장에게 재발송을 요청해주세요.";
  return null;
}

async function requestFingerprint(token: string) {
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || requestHeaders.get("x-real-ip")?.trim() || `unknown:${token}`;
  return hmac(`request:${address}`);
}

async function sendSmsWithTimeout(phone: string, body: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), SMS_TIMEOUT_MS);
  });
  const result = await Promise.race([sendAuthenticationSms(phone, body), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function getInvitation(token: string) {
  try {
    const rows = await prisma.$queryRawUnsafe<InvitationRow[]>(
      `SELECT id, token, name, phone, role, status, "expiresAt", "createdAt",
              ("expiresAt" <= NOW()) AS "isExpired"
       FROM "StaffInvitation" WHERE token = $1 LIMIT 1`,
      token,
    );
    const invitation = rows[0];
    const stateError = invitationStateError(invitation);
    if (stateError) return { error: stateError };

    const phone = invitation.phone || "";
    return {
      data: {
        id: invitation.id,
        token: invitation.token,
        name: invitation.name,
        maskedPhone: phone.length >= 7 ? `${phone.slice(0, 3)}-****-${phone.slice(-4)}` : "***",
        role: invitation.role,
        expiresAt: new Date(invitation.expiresAt).toISOString(),
      },
    };
  } catch (error) {
    console.error("[getInvitation] failed:", error);
    return { error: "초대 정보를 불러올 수 없습니다." };
  }
}

export async function sendInviteVerification(token: string) {
  let reservedHash: string | null = null;
  let ledgerId: string | null = null;
  try {
    if (!isSmsProviderConfigured()) {
      throw new Error("문자 발송 설정이 완료되지 않았습니다.");
    }
    const requestHash = await requestFingerprint(token);
    const code = generateCode();
    const invitation = await prisma.$transaction(async (tx) => {
      const initialRows = await tx.$queryRawUnsafe<InvitationRow[]>(
        `SELECT id, phone, role, status, "expiresAt", purpose, ("expiresAt" <= NOW()) AS "isExpired"
         FROM "StaffInvitation" WHERE token = $1 LIMIT 1`,
        token,
      );
      const initial = initialRows[0];
      const initialError = invitationStateError(initial);
      if (initialError) throw new Error(initialError);

      const phoneHash = hmac(`phone:${initial.phone}`);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, phoneHash);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, requestHash);

      const rows = await tx.$queryRawUnsafe<InvitationRow[]>(
        `SELECT id, token, name, phone, role, status, "expiresAt", purpose, "otpSentAt", "lockedAt",
                ("expiresAt" <= NOW()) AS "isExpired",
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("lockedAt" + INTERVAL '15 minutes' - NOW()))))::int
                  AS "lockRemainingSeconds",
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("otpSentAt" + INTERVAL '60 seconds' - NOW()))))::int
                  AS "cooldownRemainingSeconds"
         FROM "StaffInvitation" WHERE token = $1 FOR UPDATE`,
        token,
      );
      const current = rows[0];
      const stateError = invitationStateError(current);
      if (stateError) throw new Error(stateError);
      if (Number(current.lockRemainingSeconds || 0) > 0) {
        throw new Error(`${current.lockRemainingSeconds}초 후 인증번호를 다시 요청해주세요.`);
      }
      if (Number(current.cooldownRemainingSeconds || 0) > 0) {
        throw new Error(`${current.cooldownRemainingSeconds}초 후 인증번호를 다시 요청해주세요.`);
      }

      const quotaRows = await tx.$queryRawUnsafe<Array<{ inviteHour: number; phoneDay: number; requestDay: number }>>(
        `SELECT
           COUNT(*) FILTER (WHERE "invitationId" = $1 AND "createdAt" > NOW() - INTERVAL '1 hour')::int AS "inviteHour",
           COUNT(*) FILTER (WHERE "phoneHash" = $2 AND "createdAt" > NOW() - INTERVAL '1 day')::int AS "phoneDay",
           COUNT(*) FILTER (WHERE "requestHash" = $3 AND "createdAt" > NOW() - INTERVAL '1 day')::int AS "requestDay"
         FROM "StaffInvitationOtpSend"`,
        current.id,
        phoneHash,
        requestHash,
      );
      const quota = quotaRows[0];
      if (Number(quota.inviteHour) >= 5) throw new Error("이 초대의 시간당 인증번호 발송 한도를 초과했습니다.");
      if (Number(quota.phoneDay) >= 10) throw new Error("이 전화번호의 일일 인증번호 발송 한도를 초과했습니다.");
      if (Number(quota.requestDay) >= 30) throw new Error("일일 인증번호 요청 한도를 초과했습니다.");

      ledgerId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO "StaffInvitationOtpSend" (id, "invitationId", "phoneHash", "requestHash", status, "createdAt")
         VALUES ($1, $2, $3, $4, 'RESERVED', NOW())`,
        ledgerId,
        current.id,
        phoneHash,
        requestHash,
      );
      reservedHash = hashCode(token, current.phone, code);
      await tx.$executeRawUnsafe(
        `UPDATE "StaffInvitation"
         SET "otpHash" = $1, "otpExpiresAt" = NOW() + INTERVAL '5 minutes', "otpSentAt" = NOW(),
             "otpAttempts" = 0, "otpVerifiedAt" = NULL, "otpConsumedAt" = NULL, "lockedAt" = NULL,
             "updatedAt" = NOW()
         WHERE id = $2`,
        reservedHash,
        current.id,
      );
      return current;
    });

    const result = await sendSmsWithTimeout(
      invitation.phone,
      invitation.purpose === "PASSWORD_RESET"
        ? `[STIZ 농구교실] 비밀번호 재설정 인증번호: ${code} (5분 내 입력)`
        : `[STIZ 농구교실] 스태프 가입 인증번호: ${code} (5분 내 입력)`,
    );
    if (result !== true) {
      const status = result === "TIMEOUT" ? "TIMEOUT" : "FAILED";
      throw Object.assign(new Error(result === "TIMEOUT" ? "문자 발송 시간이 초과되었습니다." : "인증번호 문자 발송에 실패했습니다."), { ledgerStatus: status });
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "StaffInvitationOtpSend" SET status = 'SENT' WHERE id = $1 AND status = 'RESERVED'`,
      ledgerId,
    );
    return { ok: true };
  } catch (error) {
    const ledgerStatus =
      error instanceof Error && "ledgerStatus" in error ? String(error.ledgerStatus) : "FAILED";
    if (ledgerId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "StaffInvitationOtpSend" SET status = $1 WHERE id = $2 AND status = 'RESERVED'`,
        ledgerStatus,
        ledgerId,
      ).catch(() => undefined);
    }
    if (reservedHash) {
      await prisma.$executeRawUnsafe(
        `UPDATE "StaffInvitation"
         SET "otpHash" = NULL, "otpExpiresAt" = NULL, "updatedAt" = NOW()
         WHERE token = $1 AND "otpHash" = $2 AND "otpVerifiedAt" IS NULL`,
        token,
        reservedHash,
      ).catch(() => undefined);
    }
    console.error("[sendInviteVerification] failed:", error);
    return { error: error instanceof Error ? error.message : "인증번호 발송 실패" };
  }
}

export async function verifyInviteCode(token: string, code: string) {
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) return { error: "6자리 인증번호를 입력해주세요." };

  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<InvitationRow[]>(
        `SELECT id, phone, role, status, "expiresAt", "otpHash", "otpExpiresAt", "otpAttempts",
                "otpVerifiedAt", "lockedAt", ("expiresAt" <= NOW()) AS "isExpired",
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("lockedAt" + INTERVAL '15 minutes' - NOW()))))::int
                  AS "lockRemainingSeconds"
         FROM "StaffInvitation" WHERE token = $1 FOR UPDATE`,
        token,
      );
      const invitation = rows[0];
      const stateError = invitationStateError(invitation);
      if (stateError) return { error: stateError };
      if (Number(invitation.lockRemainingSeconds || 0) > 0) {
        return { error: `${invitation.lockRemainingSeconds}초 후 다시 시도해주세요.` };
      }
      if (invitation.otpVerifiedAt) return { ok: true, verified: true };
      if (!invitation.otpHash || !invitation.otpExpiresAt) return { error: "인증번호를 먼저 요청해주세요." };

      const expiryRows = await tx.$queryRawUnsafe<Array<{ expired: boolean }>>(
        `SELECT ($1::timestamptz <= NOW()) AS expired`,
        invitation.otpExpiresAt,
      );
      if (expiryRows[0]?.expired) return { error: "인증번호가 만료되었습니다. 다시 요청해주세요." };

      const suppliedHash = hashCode(token, invitation.phone, normalizedCode);
      if (!hashesMatch(invitation.otpHash, suppliedHash)) {
        const attempts = Math.min((invitation.otpAttempts || 0) + 1, MAX_OTP_ATTEMPTS);
        await tx.$executeRawUnsafe(
          `UPDATE "StaffInvitation"
           SET "otpAttempts" = $1, "lockedAt" = CASE WHEN $1 >= $2 THEN NOW() ELSE NULL END, "updatedAt" = NOW()
           WHERE id = $3`,
          attempts,
          MAX_OTP_ATTEMPTS,
          invitation.id,
        );
        return { error: attempts >= MAX_OTP_ATTEMPTS ? "인증 시도가 잠겼습니다. 15분 후 새 인증번호를 요청해주세요." : `인증번호가 일치하지 않습니다. (${MAX_OTP_ATTEMPTS - attempts}회 남음)` };
      }

      await tx.$executeRawUnsafe(
        `UPDATE "StaffInvitation" SET "otpVerifiedAt" = NOW(), "otpHash" = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND "otpVerifiedAt" IS NULL`,
        invitation.id,
      );
      return { ok: true, verified: true };
    });
  } catch (error) {
    console.error("[verifyInviteCode] failed:", error);
    return { error: "인증번호를 확인할 수 없습니다." };
  }
}

export async function acceptInvitation(token: string, password: string) {
  if (!password || password.length < STAFF_PASSWORD_MIN) return { error: "비밀번호는 10자 이상이어야 합니다." };

  const attemptId = randomUUID();
  let authUserId: string | null = null;
  let invitationId: string | null = null;
  // createUser/updateUserById 실패 판정(2026-11-12 사고 뒤): 확실한 거절(4xx) vs 결과 모름(네트워크·5xx)
  let authFailure: AuthFailureKind | null = null;
  let authCreateStarted = false; // createUser 를 불렀는가(PASSWORD_RESET 은 부르지 않는다)
  try {
    const rows = await prisma.$queryRawUnsafe<InvitationRow[]>(
      `UPDATE "StaffInvitation"
       SET status = 'PROCESSING', "processingAttemptId" = $2, "processingStartedAt" = NOW(),
           "otpConsumedAt" = NOW(), "recoveryAuthUserId" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
       WHERE token = $1 AND role IN ('INSTRUCTOR'::"Role", 'DRIVER'::"Role") AND status = 'PENDING' AND "expiresAt" > NOW()
         AND "otpExpiresAt" > NOW() AND "otpVerifiedAt" IS NOT NULL AND "otpConsumedAt" IS NULL
         AND ("lockedAt" IS NULL OR "lockedAt" <= NOW() - INTERVAL '15 minutes')
       RETURNING id, name, phone, role, status, "expiresAt", purpose, "targetUserId"`,
      token,
      attemptId,
    );
    const invitation = rows[0];
    if (!invitation) {
      // 처리를 시작하지 못했다 — 왜인지 지금 상태를 읽어 나눈다(중복 클릭·복구 필요·가입 완료를 «인증 만료»로 말하지 않게).
      // 진짜 인증 만료일 때만 needsVerification → 화면이 본인 인증 단계로 돌아간다.
      const states = await prisma.$queryRawUnsafe<InviteClaimState[]>(
        `SELECT role::text AS role, status, ("expiresAt" <= NOW()) AS "isExpired",
                ("otpVerifiedAt" IS NOT NULL) AS "otpVerified",
                ("otpExpiresAt" IS NULL OR "otpExpiresAt" <= NOW()) AS "otpExpired",
                ("otpConsumedAt" IS NOT NULL) AS "otpConsumed",
                ("lockedAt" IS NOT NULL AND "lockedAt" > NOW() - INTERVAL '15 minutes') AS locked
           FROM "StaffInvitation" WHERE token = $1 LIMIT 1`,
        token,
      );
      return explainClaimFailure(states[0]);
    }
    invitationId = invitation.id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "StaffInvitationAuthAttempt" (id, "invitationId", status, "createdAt", "updatedAt")
       VALUES ($1, $2, 'CREATING', NOW(), NOW())`,
      attemptId,
      invitation.id,
    );

    if (invitation.purpose === "PASSWORD_RESET") {
      // 비밀번호 재설정(2026-11-12): 새 계정을 만들지 않는다. 초대 대상과 같은 번호·역할의 기존 직원 계정만 바꾼다.
      const targets = await prisma.$queryRawUnsafe<Array<{ id: string; authUserId: string | null; email: string | null }>>(
        `SELECT id, "authUserId", email FROM "User"
          WHERE id = $1 AND role = $2::"Role" AND "withdrawnAt" IS NULL
            AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = regexp_replace($3, '[^0-9]', '', 'g')`,
        invitation.targetUserId ?? "",
        invitation.role,
        invitation.phone,
      );
      const target = targets[0];
      if (!target) throw new Error("재설정할 직원 계정을 찾지 못했습니다. 원장에게 문의해주세요.");
      const { error: updateError } = await createAdminClient().auth.admin.updateUserById(target.authUserId ?? target.id, { password });
      if (updateError) {
        // 약한 비밀번호 등 4xx 거절이면 같은 화면에서 다른 비밀번호로 바로 다시 하게 한다(계정은 그대로)
        authFailure = classifyAuthFailure(updateError);
        throw new Error(authFailure === "uncertain" ? "비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요." : staffAuthFailureMessage(authFailure));
      }
      await prisma.$transaction(async (tx) => {
        const done = await tx.$executeRawUnsafe(
          `UPDATE "StaffInvitation"
           SET status = 'ACCEPTED', "acceptedAt" = NOW(), "acceptedUserId" = $1, "otpHash" = NULL,
               "processingAttemptId" = NULL, "processingStartedAt" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
           WHERE id = $2 AND status = 'PROCESSING' AND "processingAttemptId" = $3`,
          target.id,
          invitation.id,
          attemptId,
        );
        if (done !== 1) throw new Error("초대 처리 상태가 변경되었습니다.");
        await tx.$executeRawUnsafe(
          `UPDATE "StaffInvitationAuthAttempt" SET status = 'COMPLETED', "updatedAt" = NOW() WHERE id = $1`,
          attemptId,
        );
      });
      return { ok: true, email: target.email ?? `${invitation.phone}@staff.stiz.kr`, passwordReset: true };
    }

    const staffEmail = `${invitation.phone}@staff.stiz.kr`;

    // 2026-11-12: 이미 있는 직원 기록에 붙는 초대(SIGNUP + targetUserId) — 새 직원 기록을 만들지 않는다.
    //   · «직접 추가» 기록(로그인 없음) → 아래에서 로그인 계정을 만들어 그 기록에 붙인다(역할·코치 연결·수업 기록 그대로)
    //   · 퇴사 처리로 학부모가 된 직원 전용 계정 → 그 로그인을 다시 열고(차단 해제·새 비밀번호) 역할을 되돌린다
    let conversionTargetId: string | null = null;
    let conversionTargetRole: string | null = null;
    if (invitation.targetUserId) {
      const targets = await prisma.$queryRawUnsafe<Array<{ id: string; email: string | null; authUserId: string | null; role: string }>>(
        `SELECT id, email, "authUserId", role::text AS role FROM "User"
          WHERE id = $1 AND "withdrawnAt" IS NULL
            AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')`,
        invitation.targetUserId,
        invitation.phone,
      );
      const target = targets[0];
      if (!target) throw new Error("가입할 직원 기록을 찾지 못했습니다. 원장에게 문의해주세요.");
      const kind = staffLoginKind(target);
      if (kind === "staffLogin" && target.role === "PARENT") {
        const authId = staffAuthId(target);
        if (!authId) throw new Error("가입할 직원 기록을 찾지 못했습니다. 원장에게 문의해주세요.");
        const { error: reopenError } = await createAdminClient().auth.admin.updateUserById(authId, { password, ban_duration: "none" });
        if (reopenError) {
          authFailure = classifyAuthFailure(reopenError);
          throw new Error(authFailure === "uncertain" ? "계정을 다시 열지 못했습니다. 잠시 후 다시 시도해 주세요." : staffAuthFailureMessage(authFailure));
        }
        try {
          await prisma.$transaction(async (tx) => {
            // 직원 기록 → 초대 순서로 잠그고, 초대가 아직 «이 시도의 처리 중»인지 같은 거래에서 다시 본다
            // (그 사이 원장이 역할을 바꾸거나 퇴사 처리했으면 초대가 취소돼 여기서 멈춘다)
            const lockedRole = await lockTargetAndAssertInvitation(tx, { userId: target.id, invitationId: invitation.id, attemptId });
            if (lockedRole !== "PARENT") throw new Error("초대 처리 상태가 변경되었습니다.");
            const reopened = await tx.$executeRawUnsafe(
              `UPDATE "User" SET role = $2::"Role", "updatedAt" = NOW()
                WHERE id = $1 AND role = 'PARENT' AND "withdrawnAt" IS NULL`,
              target.id,
              invitation.role,
            );
            if (reopened !== 1) throw new Error("초대 처리 상태가 변경되었습니다.");
            await linkCoachProfileIfNone(tx, { userId: target.id, name: invitation.name, phone: invitation.phone, role: invitation.role });
            const done = await tx.$executeRawUnsafe(
              `UPDATE "StaffInvitation"
               SET status = 'ACCEPTED', "acceptedAt" = NOW(), "acceptedUserId" = $1, "otpHash" = NULL,
                   "processingAttemptId" = NULL, "processingStartedAt" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
               WHERE id = $2 AND status = 'PROCESSING' AND "processingAttemptId" = $3`,
              target.id,
              invitation.id,
              attemptId,
            );
            if (done !== 1) throw new Error("초대 처리 상태가 변경되었습니다.");
            await tx.$executeRawUnsafe(
              `UPDATE "StaffInvitationAuthAttempt" SET status = 'COMPLETED', "updatedAt" = NOW() WHERE id = $1`,
              attemptId,
            );
          });
        } catch (reopenTxError) {
          // 2026-11-12 검수: 로그인은 이미 다시 열었는데(차단 해제·새 비밀번호) DB 반영이 실패했다 → 다시 막는다.
          // 자기 자녀가 있으면(학부모 화면을 써야 하면) 퇴사 때처럼 막지 않는다. 다시 막기도 실패하면 기록만 남긴다.
          await reblockRetiredLogin({ authId, userId: target.id, invitationId: invitation.id, attemptId });
          throw reopenTxError;
        }
        return { ok: true, email: target.email ?? staffEmail };
      }
      if (kind !== "none") throw new Error("이미 로그인 계정이 있는 직원입니다. 원장에게 문의해주세요.");
      // 2026-11-12 재검수: 전환 가입은 «지금도 직원(코치/강사·셔틀 기사)인 기록»에만. 역할을 절대 올리지 않는다.
      // 초대를 만들 때 대상은 이미 직원이었다(convertDirectStaffToInvite 가 그 역할로 만든다 — invitation.role).
      // 지금 학부모라면 강등·퇴사된 것이므로 옛 링크로는 가입시키지 않는다(재입사는 위 다시 열기 경로·새 초대).
      if (!isConvertibleStaffRole(target.role) || !isConvertibleStaffRole(invitation.role)) {
        throw new Error("이 초대는 더 이상 쓸 수 없습니다. 원장에게 새 초대를 요청해주세요.");
      }
      conversionTargetId = target.id;
      conversionTargetRole = target.role;
    }

    const supabaseAdmin = createAdminClient();
    authCreateStarted = true; // 여기부터의 «결과 모름»은 계정이 남았을 수 있다
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: staffEmail,
      password,
      email_confirm: true,
      user_metadata: { name: invitation.name, role: invitation.role, invitationAttemptId: attemptId },
    });
    if (authError || !authData.user) {
      // 4xx 거절(약한 비밀번호·이미 있음·검증 실패)은 «안 만들어짐»이 확실하다 — 초대를 잠그지 않는다.
      // 네트워크·5xx·시간 초과만 «결과 모름»으로 보고 RECOVERY_REQUIRED 로 관리자 확인을 받는다.
      authFailure = classifyAuthFailure(authError);
      console.error("[acceptInvitation] createUser failed:", { kind: authFailure, status: authError?.status, code: authError?.code, message: authError?.message });
      throw new Error(authFailure === "uncertain" ? `계정 생성 실패: ${authError?.message || "알 수 없는 오류"}` : staffAuthFailureMessage(authFailure));
    }
    authUserId = authData.user.id;
    const ownershipRecorded = await prisma.$executeRawUnsafe(
      `UPDATE "StaffInvitationAuthAttempt"
       SET "authUserId" = $1, status = 'CREATED', "updatedAt" = NOW()
       WHERE id = $2 AND "invitationId" = $3 AND status = 'CREATING'`,
      authUserId,
      attemptId,
      invitation.id,
    );
    if (ownershipRecorded !== 1) throw new Error("생성 계정의 소유권 기록에 실패했습니다.");

    const invitationRecorded = await prisma.$executeRawUnsafe(
      `UPDATE "StaffInvitation" SET "recoveryAuthUserId" = $1, "updatedAt" = NOW()
       WHERE id = $2 AND status = 'PROCESSING' AND "processingAttemptId" = $3`,
      authUserId,
      invitation.id,
      attemptId,
    );
    if (invitationRecorded !== 1) throw new Error("초대 처리 상태가 변경되었습니다.");

    const createdStaffUserId = authUserId;
    await prisma.$transaction(async (tx) => {
      if (conversionTargetId) {
        // 직원 기록 → 초대 순서로 잠그고, 초대가 아직 이 시도의 «처리 중»인지·대상이 지금도 직원인지 다시 본다.
        // 학부모(강등·퇴사)면 멈춘다. 역할은 바꾸지 않는다 — 로그인만 붙인다(역할을 올리는 길이 없게).
        const lockedRole = await lockTargetAndAssertInvitation(tx, { userId: conversionTargetId, invitationId: invitation.id, attemptId });
        if (!isConvertibleStaffRole(lockedRole) || lockedRole !== conversionTargetRole) {
          throw new Error("이 초대는 더 이상 쓸 수 없습니다. 원장에게 새 초대를 요청해주세요.");
        }
        // 직접 추가 기록에 로그인을 붙인다 — 그 사이 다른 길로 로그인이 붙었거나 학부모가 됐으면(0건) 전부 되돌린다
        const attached = await tx.$executeRawUnsafe(
          `UPDATE "User"
              SET "authUserId" = $1, email = $2, "updatedAt" = NOW()
            WHERE id = $3 AND "authUserId" IS NULL AND "withdrawnAt" IS NULL AND lower(email) LIKE '%@staff.local'
              AND role IN ('INSTRUCTOR'::"Role", 'DRIVER'::"Role")`,
          authUserId,
          staffEmail,
          conversionTargetId,
        );
        if (attached !== 1) throw new Error("초대 처리 상태가 변경되었습니다.");
        // 이미 연결된 코치 프로필은 그대로(승계), 없을 때만 자동 연결
        await linkCoachProfileIfNone(tx, { userId: conversionTargetId, name: invitation.name, phone: invitation.phone, role: invitation.role });
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"Role", NOW(), NOW())`,
          authUserId,
          staffEmail,
          invitation.name,
          invitation.phone,
          invitation.role,
        );
        await linkMatchingCoachProfileToUser(tx, {
          userId: createdStaffUserId,
          name: invitation.name,
          phone: invitation.phone,
          role: invitation.role,
        });
      }
      const accepted = await tx.$executeRawUnsafe(
        `UPDATE "StaffInvitation"
         SET status = 'ACCEPTED', "acceptedAt" = NOW(), "acceptedUserId" = $1, "otpHash" = NULL,
             "processingAttemptId" = NULL, "processingStartedAt" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
         WHERE id = $2 AND status = 'PROCESSING' AND "processingAttemptId" = $3`,
        authUserId,
        invitation.id,
        attemptId,
      );
      if (accepted !== 1) throw new Error("초대 처리 상태가 변경되었습니다.");
      await tx.$executeRawUnsafe(
        `UPDATE "StaffInvitationAuthAttempt" SET status = 'COMPLETED', "updatedAt" = NOW() WHERE id = $1`,
        attemptId,
      );
    });
    return { ok: true, email: staffEmail };
  } catch (error) {
    let authDeleteError: string | null = null;
    if (authUserId) {
      try {
        const { error: deleteError } = await createAdminClient().auth.admin.deleteUser(authUserId);
        if (deleteError) authDeleteError = deleteError.message;
      } catch (deleteError) {
        authDeleteError = deleteError instanceof Error ? deleteError.message : "Auth 계정 삭제 실패";
      }
      await prisma.$executeRawUnsafe(
        `UPDATE "StaffInvitationAuthAttempt"
         SET status = $2, error = $3, "updatedAt" = NOW()
         WHERE id = $1`,
        attemptId,
        authDeleteError ? "RECOVERY_REQUIRED" : "DELETED",
        authDeleteError?.slice(0, 1000) ?? null,
      ).catch(() => undefined);
    }
    // 실패 뒤 초대 상태 판정(순수 함수 — tests/staff-invite-auth-failure.test.mjs 가 실행해 검증).
    // PASSWORD_RESET 의 updateUserById «결과 모름»은 새 계정이 생기지 않으므로 잠그지 않는다(기존 동작 유지).
    const outcome = decideInviteFailureOutcome({
      createdAuthUserId: authUserId,
      authDeleteFailed: Boolean(authDeleteError),
      authFailure: authFailure === "uncertain" && !authCreateStarted ? null : authFailure,
    });
    if (invitationId && !authUserId && outcome !== "RECOVERY_REQUIRED") {
      // 계정을 하나도 만들지 않은 시도는 닫는다. 시도 표의 CHECK 에 FAILED 가 없어
      // «남은 Auth 계정 없음» 뜻의 DELETED 로 두고, error 칸에 거절 사유를 남긴다.
      await prisma.$executeRawUnsafe(
        `UPDATE "StaffInvitationAuthAttempt" SET status = 'DELETED', error = $2, "updatedAt" = NOW()
         WHERE id = $1 AND status = 'CREATING'`,
        attemptId,
        `NOT_CREATED:${authFailure ?? "ERROR"}`,
      ).catch(() => undefined);
    }
    if (invitationId) {
      if (outcome === "RECOVERY_REQUIRED") {
        const recoveryRecorded = await prisma.$executeRawUnsafe(
          `UPDATE "StaffInvitation"
           SET status = 'RECOVERY_REQUIRED', "recoveryAuthUserId" = $1, "recoveryError" = $2,
               "processingAttemptId" = $4, "processingStartedAt" = COALESCE("processingStartedAt", NOW()), "updatedAt" = NOW()
           WHERE id = $3 AND (
             (status = 'PROCESSING' AND "processingAttemptId" = $4)
             OR (status = 'PENDING' AND "processingAttemptId" IS NULL)
             -- 2026-11-12 재검수: 처리 중에 역할 변경·퇴사로 취소된(CANCELLED) 대상 초대도 남은 계정 정리가 필요하면
             -- 복구 화면에 올린다. 복구가 끝나면 대상 초대는 다시 대기로 돌아가지 않고 취소로 끝난다(staff-invite-recovery).
             OR (status = 'CANCELLED' AND "processingAttemptId" = $4 AND "targetUserId" IS NOT NULL)
           )`,
          authUserId,
          (authDeleteError || "Auth 계정 생성 결과를 확인해야 합니다.").slice(0, 1000),
          invitationId,
          attemptId,
        ).catch(() => 0);
        if (recoveryRecorded !== 1) {
          console.error("[STAFF_INVITE_CRITICAL] orphan auth recovery record failed", {
            invitationId,
            attemptId,
            authUserId,
            stage: "RECOVERY_REQUIRED_RECORD",
          });
        }
      } else if (outcome === "RETRY_KEEP_OTP") {
        // 확실히 안 만들어짐 + 비밀번호 탓 → 문자 인증은 살려 두고 같은 링크·같은 화면에서 바로 다시 시도.
        // (인증 유효시간이 지났으면 다음 시도에서 needsVerification 으로 본인 인증부터 다시 한다)
        const retryRecorded = await prisma.$executeRawUnsafe(
          `UPDATE "StaffInvitation"
           SET status = 'PENDING', "otpConsumedAt" = NULL,
               "processingAttemptId" = NULL, "processingStartedAt" = NULL,
               "recoveryAuthUserId" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
           WHERE id = $1 AND status = 'PROCESSING' AND "processingAttemptId" = $2`,
          invitationId,
          attemptId,
        ).catch(() => 0);
        if (retryRecorded !== 1) {
          console.error("[STAFF_INVITE_CRITICAL] invitation retry reset failed", { invitationId, attemptId, stage: "PENDING_RETRY" });
        }
      } else {
        const resetRecorded = await prisma.$executeRawUnsafe(
          `UPDATE "StaffInvitation"
           SET status = 'PENDING', "otpHash" = NULL, "otpExpiresAt" = NULL, "otpVerifiedAt" = NULL,
               "otpConsumedAt" = NULL, "otpAttempts" = 0, "lockedAt" = NULL,
               "processingAttemptId" = NULL, "processingStartedAt" = NULL,
               "recoveryAuthUserId" = NULL, "recoveryError" = NULL, "updatedAt" = NOW()
           WHERE id = $1 AND status = 'PROCESSING' AND "processingAttemptId" = $2`,
          invitationId,
          attemptId,
        ).catch(() => 0);
        if (resetRecorded !== 1) {
          console.error("[STAFF_INVITE_CRITICAL] invitation reset failed", {
            invitationId,
            attemptId,
            authUserId,
            stage: "PENDING_RESET",
          });
        }
      }
    }
    console.error("[acceptInvitation] failed:", error);
    return {
      error: outcome === "RECOVERY_REQUIRED" ? "계정 생성 상태 확인이 필요합니다. 관리자에게 문의해주세요." : error instanceof Error ? error.message : "가입 처리 실패",
      // 문자 인증까지 지운 경우(RESET_PENDING)는 화면이 본인 인증 단계로 돌아간다 — 화면은 위 error 도 함께 보여 준다.
      // 이미 가입된 계정은 인증을 다시 해도 소용없으니 표식 없이 «로그인해 주세요» 문구만.
      needsVerification: invitationId && failureNeedsVerification(outcome, authFailure) ? true : undefined,
    };
  }
}
