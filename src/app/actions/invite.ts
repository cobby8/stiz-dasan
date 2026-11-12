"use server";

import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { isSmsProviderConfigured } from "@/lib/sms";
import { sendAuthenticationSms } from "@/lib/message-dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkMatchingCoachProfileToUser } from "@/lib/staff-coach-link";

const MAX_OTP_ATTEMPTS = 5;
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
  if (!password || password.length < 10) return { error: "비밀번호는 10자 이상이어야 합니다." };

  const attemptId = randomUUID();
  let authUserId: string | null = null;
  let invitationId: string | null = null;
  let authCreationUncertain = false;
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
    if (!invitation) return { error: "전화번호 인증이 필요하거나 이미 처리 중인 초대입니다." };
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
      if (updateError) throw new Error(`비밀번호를 바꾸지 못했습니다: ${updateError.message}`);
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
    const supabaseAdmin = createAdminClient();
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: staffEmail,
      password,
      email_confirm: true,
      user_metadata: { name: invitation.name, role: invitation.role, invitationAttemptId: attemptId },
    });
    if (authError || !authData.user) {
      const alreadyExists = authError?.message?.toLowerCase().includes("already") ?? false;
      authCreationUncertain = !alreadyExists;
      throw new Error(alreadyExists ? "이미 가입된 계정입니다. 로그인 페이지에서 로그인해주세요." : `계정 생성 실패: ${authError?.message || "알 수 없는 오류"}`);
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
    if (invitationId) {
      if ((authUserId && authDeleteError) || authCreationUncertain) {
        const recoveryRecorded = await prisma.$executeRawUnsafe(
          `UPDATE "StaffInvitation"
           SET status = 'RECOVERY_REQUIRED', "recoveryAuthUserId" = $1, "recoveryError" = $2,
               "processingAttemptId" = $4, "processingStartedAt" = COALESCE("processingStartedAt", NOW()), "updatedAt" = NOW()
           WHERE id = $3 AND (
             (status = 'PROCESSING' AND "processingAttemptId" = $4)
             OR (status = 'PENDING' AND "processingAttemptId" IS NULL)
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
    return { error: authDeleteError || authCreationUncertain ? "계정 생성 상태 확인이 필요합니다. 관리자에게 문의해주세요." : error instanceof Error ? error.message : "가입 처리 실패" };
  }
}
