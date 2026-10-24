import "server-only";
import { userFacingError } from "@/lib/user-facing-error";
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendAuthenticationSms } from "@/lib/message-dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveRedirectForRole } from "@/lib/auth-routes";
import { isSyntheticParentEmail } from "@/lib/parent-synthetic-email";

const CLAIM_TTL_HOURS = 72;
const OTP_TTL_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 5;
const PROCESSING_LEASE_MINUTES = 5;
// 빈 보호자 계정 판정 규칙은 parent-synthetic-email.ts 한 곳에만 둔다(여기서는 다시 내보내기만).
export { isSyntheticParentEmail };

type ClaimRow = {
  id: string;
  parentId: string;
  phone: string;
  email: string;
  status: string;
  expiresAt: Date;
  otpHash: string | null;
  otpExpiresAt: Date | null;
  otpAttempts: number;
  lockedAt: Date | null;
  verifiedAt: Date | null;
  proofHash: string | null;
  proofExpiresAt: Date | null;
  redirectPath: string;
  processingAt: Date | null;
  processingAttemptId: string | null;
  authUserId: string | null;
};

function secret() {
  const value = process.env.PARENT_ACCOUNT_CLAIM_SECRET || process.env.INVITE_OTP_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("보호자 계정 활성화 보안키가 설정되지 않았습니다.");
  return "development-only-parent-account-claim-secret";
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function keyedHash(value: string) {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function otpHash(claimHash: string, phone: string, code: string) {
  return keyedHash(`otp:${claimHash}:${phone}:${code}`);
}

function safeEqual(expected: string, actual: string) {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function safeRedirect(value?: string | null) {
  return resolveRedirectForRole("PARENT", value);
}

export function parentClaimProofCookieName(rawToken: string) {
  return `stiz_parent_claim_${tokenHash(rawToken).slice(0, 20)}`;
}

function activationUrl(token: string) {
  return `/account/activate?token=${encodeURIComponent(token)}`;
}

async function claimByToken(rawToken: string, lock = false): Promise<ClaimRow | null> {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(rawToken)) return null;
  const suffix = lock ? " FOR UPDATE" : "";
  const rows = await prisma.$queryRawUnsafe<ClaimRow[]>(
    `SELECT c.id, c."parentId", u.phone, u.email, c.status, c."expiresAt", c."otpHash",
            c."otpExpiresAt", c."otpAttempts", c."lockedAt", c."verifiedAt", c."proofHash", c."proofExpiresAt",
            c."redirectPath", c."processingAt", c."processingAttemptId", c."authUserId"
       FROM "ParentAccountClaim" c JOIN "User" u ON u.id = c."parentId"
      WHERE c."tokenHash" = $1 LIMIT 1${suffix}`,
    tokenHash(rawToken),
  );
  return rows[0] ?? null;
}

async function recoverExpiredProcessingClaim(rawToken: string) {
  const hash = tokenHash(rawToken);
  const rows = await prisma.$queryRawUnsafe<ClaimRow[]>(
    `SELECT c.id, c."parentId", u.phone, u.email, c.status, c."expiresAt", c."otpHash",
            c."otpExpiresAt", c."otpAttempts", c."lockedAt", c."verifiedAt", c."proofHash", c."proofExpiresAt",
            c."redirectPath", c."processingAt", c."processingAttemptId", c."authUserId"
       FROM "ParentAccountClaim" c JOIN "User" u ON u.id = c."parentId"
      WHERE c."tokenHash" = $1 AND c.status = 'PROCESSING'
        AND c."processingAt" <= NOW() - INTERVAL '${PROCESSING_LEASE_MINUTES} minutes'
        AND (c."proofExpiresAt" IS NULL OR c."proofExpiresAt" <= NOW()) LIMIT 1`,
    hash,
  );
  const stale = rows[0];
  if (!stale) return;

  const adminAuth = createAdminClient();
  let ownedAuthId = stale.authUserId;
  if (!ownedAuthId && stale.processingAttemptId) {
    for (let page = 1; page <= 10 && !ownedAuthId; page += 1) {
      const listed = await adminAuth.auth.admin.listUsers({ page, perPage: 1000 });
      if (listed.error) throw new Error("중단된 로그인 계정의 소유권을 확인하지 못했습니다.");
      const owned = listed.data.users.find((user) =>
        user.user_metadata?.parentAccountClaimId === stale.id
        && user.user_metadata?.parentAccountClaimAttemptId === stale.processingAttemptId,
      );
      if (owned) ownedAuthId = owned.id;
      if (listed.data.users.length < 1000) break;
    }
  }
  if (ownedAuthId) {
    const owned = await adminAuth.auth.admin.getUserById(ownedAuthId);
    const metadata = owned.data.user?.user_metadata;
    if (owned.error || metadata?.parentAccountClaimId !== stale.id
        || metadata?.parentAccountClaimAttemptId !== stale.processingAttemptId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET status = 'RECOVERY_REQUIRED', "lastError" = 'AUTH_OWNERSHIP_UNVERIFIED', "updatedAt" = NOW() WHERE id = $1 AND status = 'PROCESSING'`,
        stale.id,
      );
      throw new Error("중단된 계정의 소유권을 확인하지 못했습니다. 관리자에게 문의해 주세요.");
    }
    const deleted = await adminAuth.auth.admin.deleteUser(ownedAuthId);
    if (deleted.error) {
      await prisma.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET status = 'RECOVERY_REQUIRED', "lastError" = $2, "updatedAt" = NOW() WHERE id = $1 AND status = 'PROCESSING'`,
        stale.id,
        deleted.error.message.slice(0, 1000),
      );
      throw new Error("중단된 계정을 정리하지 못했습니다. 관리자에게 문의해 주세요.");
    }
  }
  await prisma.$executeRawUnsafe(
    `UPDATE "ParentAccountClaim" SET status = 'PENDING', "verifiedAt" = NULL, "proofHash" = NULL,
            "proofExpiresAt" = NULL, "processingAt" = NULL, "processingAttemptId" = NULL, "authUserId" = NULL,
            "otpHash" = NULL, "otpExpiresAt" = NULL, "lastError" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND status = 'PROCESSING' AND "processingAttemptId" IS NOT DISTINCT FROM $2`,
    stale.id,
    stale.processingAttemptId,
  );
}

export async function issueParentAccountClaim(input: {
  parentId: string;
  applicationId?: string | null;
  invoiceId?: string | null;
  redirectPath?: string | null;
  enforceCooldown?: boolean;
}, externalTx?: Prisma.TransactionClient) {
  const db = externalTx ?? prisma;
  const parents = await db.$queryRawUnsafe<Array<{ id: string; email: string; phone: string | null; authUserId: string | null }>>(
    `SELECT id, email, phone, "authUserId" FROM "User" WHERE id = $1 AND role = 'PARENT' LIMIT 1`,
    input.parentId,
  );
  const parent = parents[0];
  // 간편로그인으로 이미 연결된 계정은 이메일이 합성 주소로 남아 있어도 활성화가 필요 없다.
  if (!parent || !isSyntheticParentEmail(parent.email) || parent.authUserId) return { activationUrl: null, activationRequired: false };

  const phone = normalizePhone(parent.phone || "");
  if (phone.length < 10 || phone.length > 11) throw new Error("보호자 연락처를 확인해 주세요.");
  const duplicates = await db.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS count FROM "User"
      WHERE role = 'PARENT' AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1`,
    phone,
  );
  if (Number(duplicates[0]?.count) !== 1) throw new Error("같은 연락처의 보호자 계정이 여러 개여서 관리자 확인이 필요합니다.");

  const rawToken = randomBytes(32).toString("base64url");
  const hash = tokenHash(rawToken);
  const reserve = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, parent.id);
    const cooldown = await tx.$queryRawUnsafe<Array<{ recent: number }>>(
      `SELECT COUNT(*)::int AS recent FROM "ParentAccountClaim"
        WHERE "parentId" = $1 AND "createdAt" > NOW() - INTERVAL '60 seconds'`,
      parent.id,
    );
    if (input.enforceCooldown && Number(cooldown[0]?.recent) > 0) throw new Error("활성화 링크는 60초 후 다시 발급할 수 있습니다.");
    await tx.$executeRawUnsafe(
      `UPDATE "ParentAccountClaim" SET status = 'CANCELLED', "updatedAt" = NOW()
        WHERE "parentId" = $1 AND status IN ('PENDING', 'VERIFIED')`,
      parent.id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "ParentAccountClaim" (
         id, "parentId", "applicationId", "invoiceId", "tokenHash", "phoneHash", status,
         "expiresAt", "redirectPath", "createdAt", "updatedAt"
       ) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'PENDING',
                 NOW() + INTERVAL '${CLAIM_TTL_HOURS} hours', $6, NOW(), NOW())`,
      parent.id,
      input.applicationId ?? null,
      input.invoiceId ?? null,
      hash,
      keyedHash(`phone:${phone}`),
      safeRedirect(input.redirectPath),
    );
  };
  if (externalTx) await reserve(externalTx);
  else await prisma.$transaction(reserve);
  return { activationUrl: activationUrl(rawToken), activationRequired: true };
}

export async function readParentAccountClaim(rawToken: string) {
  await recoverExpiredProcessingClaim(rawToken);
  const claim = await claimByToken(rawToken);
  if (!claim || !["PENDING", "VERIFIED"].includes(claim.status) || new Date(claim.expiresAt) <= new Date()) {
    return { error: "유효하지 않거나 만료된 활성화 링크입니다." };
  }
  const phone = normalizePhone(claim.phone || "");
  // 특강 신청·청구서 없이 만들어진 활성화 = 학부모가 회원가입 화면에서 직접 시작한 것
  const purposeRows = await prisma.$queryRawUnsafe<Array<{ selfService: boolean }>>(
    `SELECT ("applicationId" IS NULL AND "invoiceId" IS NULL) AS "selfService" FROM "ParentAccountClaim" WHERE id = $1`,
    claim.id,
  );
  return {
    data: {
      maskedPhone: phone.length >= 7 ? `${phone.slice(0, 3)}-****-${phone.slice(-4)}` : "***",
      expiresAt: new Date(claim.expiresAt).toISOString(),
      redirectPath: claim.redirectPath,
      status: claim.status,
      selfService: Boolean(purposeRows[0]?.selfService),
    },
  };
}

const SELF_CLAIM_TTL_MINUTES = 30;

/** issueVerifiedSelfParentClaim 이 학부모에게 그대로 보여 줘도 되는 안내 문구만 담는 오류 */
export class SelfClaimUserError extends Error {}

/**
 * 학부모가 회원가입 화면에서 직접 시작한 기존 계정 활성화.
 *
 * ⚠️ 호출 전제: 호출자가 **이 번호로 보낸 문자 인증번호를 방금 통과시켰다**(ParentSignupVerification 의
 * VERIFIED + proof 확인). 그래서 활성화 단계의 문자 인증을 다시 하지 않고 VERIFIED 상태로 바로 만든다.
 * 문자 인증 없이 이 함수를 부르는 길을 만들면 계정 탈취가 된다.
 *
 * - 링크 유효 30분, 증표(proof) 10분 — 관리자가 보내는 72시간 링크보다 훨씬 짧다.
 * - 관리자가 보낸 특강 활성화 링크는 취소하지 않는다(먼저 쓰는 쪽이 이기고, 나머지는
 *   "이미 로그인 계정과 연결된 보호자" 검사에서 막힌다).
 */
export async function issueVerifiedSelfParentClaim(
  input: { parentId: string; verifiedPhone: string; redirectPath?: string | null },
  tx: Prisma.TransactionClient,
) {
  const verifiedPhone = normalizePhone(input.verifiedPhone);
  const parents = await tx.$queryRawUnsafe<Array<{ id: string; email: string; phone: string | null; authUserId: string | null }>>(
    `SELECT id, email, phone, "authUserId" FROM "User" WHERE id = $1 AND role = 'PARENT' LIMIT 1 FOR UPDATE`,
    input.parentId,
  );
  const parent = parents[0];
  if (!parent || !isSyntheticParentEmail(parent.email) || parent.authUserId) throw new SelfClaimUserError("활성화할 수 있는 보호자 계정이 아닙니다.");
  // 인증한 번호와 계정 번호가 정확히 같아야 한다
  if (normalizePhone(parent.phone || "") !== verifiedPhone) throw new SelfClaimUserError("인증한 휴대폰 번호와 보호자 정보가 일치하지 않습니다.");
  const duplicates = await tx.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS count FROM "User"
      WHERE role = 'PARENT' AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1`,
    verifiedPhone,
  );
  if (Number(duplicates[0]?.count) !== 1) throw new SelfClaimUserError("같은 연락처의 보호자 계정이 여러 개여서 관리자 확인이 필요합니다.");

  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, parent.id);
  const rawToken = randomBytes(32).toString("base64url");
  const hash = tokenHash(rawToken);
  const proof = randomBytes(32).toString("base64url");
  await tx.$executeRawUnsafe(
    `INSERT INTO "ParentAccountClaim" (
       id, "parentId", "applicationId", "invoiceId", "tokenHash", "phoneHash", status,
       "expiresAt", "verifiedAt", "proofHash", "proofExpiresAt", "redirectPath", "createdAt", "updatedAt"
     ) VALUES (gen_random_uuid()::text, $1, NULL, NULL, $2, $3, 'VERIFIED',
               NOW() + INTERVAL '${SELF_CLAIM_TTL_MINUTES} minutes', NOW(), $4, NOW() + INTERVAL '10 minutes', $5, NOW(), NOW())`,
    parent.id,
    hash,
    keyedHash(`phone:${verifiedPhone}`),
    keyedHash(`proof:${hash}:${proof}`),
    safeRedirect(input.redirectPath),
  );
  return { token: rawToken, proof, activationUrl: activationUrl(rawToken) };
}

export async function sendParentClaimOtp(rawToken: string) {
  await recoverExpiredProcessingClaim(rawToken);
  const code = randomInt(100000, 1000000).toString();
  const hash = tokenHash(rawToken);
  let reservedOtpHash: string | null = null;
  let ledgerId: string | null = null;
  let ledgerClaimId: string | null = null;
  let ledgerPhoneHash: string | null = null;
  let phone = "";
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<ClaimRow[]>(
        `SELECT c.id, c."parentId", u.phone, u.email, c.status, c."expiresAt", c."otpHash",
                c."otpExpiresAt", c."otpAttempts", c."lockedAt", c."verifiedAt", c."proofHash", c."proofExpiresAt",
                c."redirectPath", c."processingAt", c."processingAttemptId"
           FROM "ParentAccountClaim" c JOIN "User" u ON u.id = c."parentId"
          WHERE c."tokenHash" = $1 FOR UPDATE`,
        hash,
      );
      const claim = rows[0];
      if (!claim || claim.status !== "PENDING" || new Date(claim.expiresAt) <= new Date()) throw new Error("유효하지 않거나 만료된 활성화 링크입니다.");
      if (claim.lockedAt && Date.now() - new Date(claim.lockedAt).getTime() < 15 * 60_000) throw new Error("인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요.");
      phone = normalizePhone(claim.phone || "");
      if (phone.length < 10 || phone.length > 11) throw new Error("보호자 연락처를 확인해 주세요.");
      const phoneHash = keyedHash(`phone:${phone}`);
      const quota = await tx.$queryRawUnsafe<Array<{ recent: number; daily: number }>>(
        `SELECT
           (SELECT COUNT(*) FROM "ParentAccountClaim" WHERE id = $1 AND "otpSentAt" > NOW() - INTERVAL '60 seconds')::int AS recent,
           (SELECT COUNT(*) FROM "ParentAccountClaimOtpSend" WHERE "phoneHash" = $2 AND status = 'RESERVED' AND "createdAt" > NOW() - INTERVAL '1 day')::int AS daily`,
        claim.id,
        phoneHash,
      );
      if (Number(quota[0]?.recent) > 0) throw new Error("인증번호는 60초 후 다시 요청할 수 있습니다.");
      if (Number(quota[0]?.daily) >= 10) throw new Error("오늘 인증번호 요청 횟수를 초과했습니다.");
      reservedOtpHash = otpHash(hash, phone, code);
      ledgerId = randomUUID();
      ledgerClaimId = claim.id;
      ledgerPhoneHash = phoneHash;
      await tx.$executeRawUnsafe(
        `INSERT INTO "ParentAccountClaimOtpSend" (id, "claimId", "phoneHash", status, "createdAt") VALUES ($1, $2, $3, 'RESERVED', NOW())`,
        ledgerId,
        claim.id,
        phoneHash,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET "otpHash" = $1, "otpExpiresAt" = NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes',
                "otpSentAt" = NOW(), "verifiedAt" = NULL, "proofHash" = NULL, "proofExpiresAt" = NULL, "updatedAt" = NOW()
          WHERE id = $2`,
        reservedOtpHash,
        claim.id,
      );
    });
    if (process.env.NODE_ENV === "test") {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ParentAccountClaimOtpSend" (id, "claimId", "phoneHash", status, "createdAt") VALUES ($1, $2, $3, 'SENT', NOW())`,
        randomUUID(), ledgerClaimId, ledgerPhoneHash,
      );
      return { ok: true };
    }
    const sent = await sendAuthenticationSms(phone, `[STIZ 농구교실] 보호자 계정 인증번호: ${code} (5분 이내 입력)`);
    if (!sent) throw new Error("인증번호 문자 발송에 실패했습니다.");
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ParentAccountClaimOtpSend" (id, "claimId", "phoneHash", status, "createdAt") VALUES ($1, $2, $3, 'SENT', NOW())`,
      randomUUID(), ledgerClaimId, ledgerPhoneHash,
    );
    return { ok: true };
  } catch (error) {
    if (ledgerId && ledgerClaimId && ledgerPhoneHash) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ParentAccountClaimOtpSend" (id, "claimId", "phoneHash", status, "createdAt") VALUES ($1, $2, $3, 'FAILED', NOW())`,
        randomUUID(), ledgerClaimId, ledgerPhoneHash,
      ).catch(() => undefined);
    }
    if (reservedOtpHash) {
      await prisma.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET "otpHash" = NULL, "otpExpiresAt" = NULL, "updatedAt" = NOW()
          WHERE "tokenHash" = $1 AND "otpHash" = $2 AND "verifiedAt" IS NULL`,
        hash,
        reservedOtpHash,
      ).catch(() => undefined);
    }
    return { error: userFacingError(error, "인증번호를 발송하지 못했습니다.") };
  }
}

export async function verifyParentClaimOtp(rawToken: string, code: string) {
  if (!/^\d{6}$/.test(code.trim())) return { error: "6자리 인증번호를 입력해 주세요." };
  const hash = tokenHash(rawToken);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<ClaimRow[]>(
      `SELECT c.id, c."parentId", u.phone, u.email, c.status, c."expiresAt", c."otpHash",
              c."otpExpiresAt", c."otpAttempts", c."lockedAt", c."verifiedAt", c."proofHash", c."proofExpiresAt",
              c."redirectPath", c."processingAt", c."processingAttemptId"
         FROM "ParentAccountClaim" c JOIN "User" u ON u.id = c."parentId"
        WHERE c."tokenHash" = $1 FOR UPDATE`,
      hash,
    );
    const claim = rows[0];
    if (!claim || claim.status !== "PENDING" || new Date(claim.expiresAt) <= new Date()) return { error: "유효하지 않거나 만료된 활성화 링크입니다." };
    if (claim.lockedAt && Date.now() - new Date(claim.lockedAt).getTime() < 15 * 60_000) return { error: "인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요." };
    if (!claim.otpHash || !claim.otpExpiresAt || new Date(claim.otpExpiresAt) <= new Date()) return { error: "인증번호를 다시 요청해 주세요." };
    const supplied = otpHash(hash, normalizePhone(claim.phone), code.trim());
    if (!safeEqual(claim.otpHash, supplied)) {
      const attempts = Math.min(Number(claim.otpAttempts) + 1, MAX_OTP_ATTEMPTS);
      await tx.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET "otpAttempts" = $1, "lockedAt" = CASE WHEN $1 >= $2 THEN NOW() ELSE NULL END, "updatedAt" = NOW() WHERE id = $3`,
        attempts,
        MAX_OTP_ATTEMPTS,
        claim.id,
      );
      return { error: attempts >= MAX_OTP_ATTEMPTS ? "인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요." : `인증번호가 일치하지 않습니다. (${MAX_OTP_ATTEMPTS - attempts}회 남음)` };
    }
    const proof = randomBytes(32).toString("base64url");
    await tx.$executeRawUnsafe(
      `UPDATE "ParentAccountClaim" SET status = 'VERIFIED', "verifiedAt" = NOW(), "otpHash" = NULL,
              "proofHash" = $2, "proofExpiresAt" = NOW() + INTERVAL '10 minutes', "updatedAt" = NOW() WHERE id = $1`,
      claim.id,
      keyedHash(`proof:${hash}:${proof}`),
    );
    return { ok: true, verified: true, proof };
  });
}

export async function consumeParentAccountClaim(rawToken: string, proof: string, emailInput: string, password: string) {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith(".local")) return { error: "실제로 사용하는 이메일을 입력해 주세요." };
  if (password.length < 10) return { error: "비밀번호는 10자 이상이어야 합니다." };
  const hash = tokenHash(rawToken);
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(proof)) return { error: "전화번호 인증 증표가 없거나 만료되었습니다." };
  const suppliedProofHash = keyedHash(`proof:${hash}:${proof}`);
  const processingAttemptId = randomUUID();
  let claim: ClaimRow | null = null;
  let authUserId: string | null = null;
  try {
    claim = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<ClaimRow[]>(
        `SELECT c.id, c."parentId", u.phone, u.email, c.status, c."expiresAt", c."otpHash",
                c."otpExpiresAt", c."otpAttempts", c."lockedAt", c."verifiedAt", c."proofHash", c."proofExpiresAt",
                c."redirectPath", c."processingAt", c."processingAttemptId"
           FROM "ParentAccountClaim" c JOIN "User" u ON u.id = c."parentId"
          WHERE c."tokenHash" = $1 FOR UPDATE`,
        hash,
      );
      const current = rows[0];
      const staleProcessing = current?.status === "PROCESSING" && current.processingAt
        && Date.now() - new Date(current.processingAt).getTime() >= PROCESSING_LEASE_MINUTES * 60_000;
      if (!current || (current.status !== "VERIFIED" && !staleProcessing) || !current.verifiedAt || new Date(current.expiresAt) <= new Date()) throw new Error("전화번호 인증을 먼저 완료해 주세요.");
      if (!current.proofHash || !current.proofExpiresAt || new Date(current.proofExpiresAt) <= new Date()
          || !safeEqual(current.proofHash, suppliedProofHash)) throw new Error("전화번호 인증 증표가 없거나 만료되었습니다.");
      const duplicates = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM "User" WHERE role = 'PARENT'
          AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1`,
        normalizePhone(current.phone),
      );
      if (Number(duplicates[0]?.count) !== 1) throw new Error("같은 연락처의 보호자 계정이 여러 개여서 관리자 확인이 필요합니다.");
      const emailOwners = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "User" WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1`, email, current.parentId);
      if (emailOwners.length > 0) throw new Error("이미 사용 중인 이메일입니다.");
      const authLinks = await tx.$queryRawUnsafe<Array<{ authUserId: string | null }>>(
        `SELECT "authUserId" FROM "User" WHERE id = $1 FOR UPDATE`, current.parentId,
      );
      if (authLinks[0]?.authUserId) throw new Error("이미 로그인 계정과 연결된 보호자입니다.");
      const claimed = await tx.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET status = 'PROCESSING', "processingAt" = NOW(), "processingAttemptId" = $2, "updatedAt" = NOW()
          WHERE id = $1 AND (status = 'VERIFIED' OR (status = 'PROCESSING' AND "processingAt" <= NOW() - INTERVAL '${PROCESSING_LEASE_MINUTES} minutes'))`,
        current.id,
        processingAttemptId,
      );
      if (claimed !== 1) throw new Error("계정 활성화가 이미 처리 중입니다.");
      return current;
    });

    const auth = createAdminClient();
    const created = await auth.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: "PARENT", parentAccountClaimId: claim.id, parentAccountClaimAttemptId: processingAttemptId },
    });
    if (!created.error && created.data.user) {
      authUserId = created.data.user.id;
    } else if (created.error?.message?.toLowerCase().includes("already") && claim.processingAttemptId) {
      // A worker may have died after Auth creation but before the DB transaction.
      // Reuse only an Auth user whose server-controlled metadata proves this claim owned it.
      for (let page = 1; page <= 10 && !authUserId; page += 1) {
        const listed = await auth.auth.admin.listUsers({ page, perPage: 1000 });
        if (listed.error) throw new Error("기존 로그인 계정의 소유권을 확인하지 못했습니다.");
        const owned = listed.data.users.find((user) =>
          user.email?.toLowerCase() === email
          && user.user_metadata?.parentAccountClaimId === claim!.id
          && user.user_metadata?.parentAccountClaimAttemptId === claim!.processingAttemptId,
        );
        if (owned) authUserId = owned.id;
        if (listed.data.users.length < 1000) break;
      }
      if (!authUserId) throw new Error("이미 가입된 이메일입니다.");
      const recovered = await auth.auth.admin.updateUserById(authUserId, {
        password,
        email_confirm: true,
        user_metadata: { role: "PARENT", parentAccountClaimId: claim.id, parentAccountClaimAttemptId: processingAttemptId },
      });
      if (recovered.error) throw new Error("중단된 계정 활성화를 복구하지 못했습니다.");
    } else {
      throw new Error("로그인 계정을 만들지 못했습니다.");
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "ParentAccountClaim" SET "authUserId" = $1, "updatedAt" = NOW()
        WHERE id = $2 AND status = 'PROCESSING' AND "processingAttemptId" = $3`,
      authUserId, claim.id, processingAttemptId,
    );

    await prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE "User" SET email = $1, "authUserId" = $4, "updatedAt" = NOW()
          WHERE id = $2 AND role = 'PARENT' AND email = $3 AND "authUserId" IS NULL`,
        email,
        claim!.parentId,
        claim!.email,
        authUserId,
      );
      if (updated !== 1) throw new Error("보호자 계정 정보가 변경되어 관리자 확인이 필요합니다.");
      const consumed = await tx.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET status = 'CONSUMED', "consumedAt" = NOW(), "authUserId" = $1,
                "proofHash" = NULL, "proofExpiresAt" = NULL, "lastError" = NULL, "updatedAt" = NOW()
          WHERE id = $2 AND status = 'PROCESSING' AND "processingAttemptId" = $3`,
        authUserId,
        claim!.id,
        processingAttemptId,
      );
      if (consumed !== 1) throw new Error("계정 활성화 상태가 변경되었습니다.");
    });
    return { ok: true, redirectPath: safeRedirect(claim.redirectPath) };
  } catch (error) {
    let recoveryRequired = false;
    if (authUserId) {
      try {
        const deleted = await createAdminClient().auth.admin.deleteUser(authUserId);
        recoveryRequired = Boolean(deleted.error);
      } catch {
        recoveryRequired = true;
      }
    }
    if (claim) {
      await prisma.$executeRawUnsafe(
        `UPDATE "ParentAccountClaim" SET status = $1, "processingAt" = NULL, "processingAttemptId" = NULL,
                "authUserId" = CASE WHEN $1 = 'RECOVERY_REQUIRED' THEN "authUserId" ELSE NULL END,
                "lastError" = $2, "updatedAt" = NOW()
          WHERE id = $3 AND status = 'PROCESSING' AND "processingAttemptId" = $4`,
        recoveryRequired ? "RECOVERY_REQUIRED" : "VERIFIED",
        error instanceof Error ? error.message.slice(0, 1000) : "ACCOUNT_ACTIVATION_FAILED",
        claim.id,
        processingAttemptId,
      ).catch(() => undefined);
    }
    return { error: userFacingError(error, "계정을 활성화하지 못했습니다.") };
  }
}
