import "server-only";
import { userFacingError } from "@/lib/user-facing-error";

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendAuthenticationSms } from "@/lib/message-dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkEnrollmentAccount } from "@/lib/enrollment-account-handoff";
import { issueVerifiedSelfParentClaim, SelfClaimUserError } from "@/lib/parent-account-claim";
import { isSyntheticParentEmail } from "@/lib/parent-synthetic-email";
import { resolveRedirectForRole } from "@/lib/auth-routes";

const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const TERMS_VERSION = "2026-07-23";
const PRIVACY_VERSION = "2026-07-23";
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{3,19}$/;
// DB CHECK(ParentSignupVerification_signupMethod_check)와 같은 목록이어야 한다 — 테스트가 마이그레이션과 대조한다.
export const PARENT_SIGNUP_METHODS = ["PASSWORD", "GOOGLE", "KAKAO", "NAVER", "APPLE"] as const;
export type ParentSignupMethod = (typeof PARENT_SIGNUP_METHODS)[number];

type Row = {
  id: string; username: string | null; name: string | null; phone: string; phoneHash: string;
  signupMethod: ParentSignupMethod; email: string | null; pendingAuthUserId: string | null;
  status: string; expiresAt: Date; otpHash: string | null; otpExpiresAt: Date | null;
  otpAttempts: number; lockedAt: Date | null; proofHash: string | null; proofExpiresAt: Date | null;
};

function secret() {
  const value = process.env.PARENT_SIGNUP_SECRET || process.env.PARENT_ACCOUNT_CLAIM_SECRET || process.env.INVITE_OTP_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("회원가입 인증 보안키가 설정되지 않았습니다.");
  return "development-only-parent-signup-secret";
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function keyed(value: string) { return createHmac("sha256", secret()).update(value).digest("hex"); }
function equalHex(a: string, b: string) {
  const left = Buffer.from(a, "hex"); const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
export function normalizeParentUsername(value: string) { return value.trim().toLowerCase(); }
export function normalizeParentPhone(value: string) { return value.replace(/\D/g, ""); }
export function parentUsernameAuthEmail(username: string) { return `${normalizeParentUsername(username)}@member.stiz.kr`; }

async function find(token: string, tx: Prisma.TransactionClient | typeof prisma, lock = false) {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) return null;
  const rows = await tx.$queryRawUnsafe<Row[]>(
    `SELECT id, username, name, phone, "phoneHash", "signupMethod", email, "pendingAuthUserId", status,
      "expiresAt", "otpHash", "otpExpiresAt", "otpAttempts", "lockedAt", "proofHash", "proofExpiresAt"
     FROM "ParentSignupVerification" WHERE "tokenHash" = $1${lock ? " FOR UPDATE" : ""}`,
    hash(token),
  );
  return rows[0] ?? null;
}

// 화면은 문구가 아니라 phoneRegistered 표식으로 판단한다(start 라우트) — 문구를 바꿔도 버튼이 사라지지 않게.
export const REGISTERED_PHONE_MESSAGE = "이미 가입된 휴대폰 번호입니다. 기존 아이디로 로그인한 뒤 마이페이지 → 간편로그인 연결에서 Apple·Google 을 연결해 주세요.";

type PhoneOwnership =
  | { kind: "NONE" } // 처음 보는 번호 → 신규 가입
  | { kind: "REGISTERED" } // 로그인 수단이 있거나 직원 등 다른 계정이 쓰는 번호 → 기존처럼 로그인 안내
  | { kind: "CLAIMABLE"; parentId: string; email: string } // 빈 보호자 계정 딱 1개 → 기존 계정 활성화
  | { kind: "MULTIPLE_CLAIMABLE" }; // 빈 보호자 계정이 여러 개 → 자동으로 고르지 않고 학원 문의

/** 이 번호를 쓰는 앱 계정이 어떤 상태인지. 번호 원문은 응답으로 내보내지 않는다. */
async function classifyPhoneOwnership(tx: Prisma.TransactionClient, phone: string): Promise<PhoneOwnership> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; role: string; email: string | null; authUserId: string | null }>>(
    `SELECT id, role::text AS role, email, "authUserId" FROM "User"
      WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1 LIMIT 20`,
    phone,
  );
  if (rows.length === 0) return { kind: "NONE" };
  // "빈 계정" = 학부모 + 합성 이메일 + 로그인 연결 없음. 하나라도 아니면 로그인 가능한 계정이 있는 번호로 본다.
  const claimable = rows.filter((row) => row.role === "PARENT" && !row.authUserId && isSyntheticParentEmail(row.email));
  if (claimable.length !== rows.length) return { kind: "REGISTERED" };
  if (claimable.length > 1) return { kind: "MULTIPLE_CLAIMABLE" };
  return { kind: "CLAIMABLE", parentId: claimable[0].id, email: claimable[0].email! };
}

/**
 * Supabase 로그인 제공자 이름 → 가입 방식. 간편로그인 판정은 **여기 한 곳**에서만 한다.
 * 2026-10-26: 세 곳에 따로 적혀 있어 Apple 을 켰을 때 하나도 고쳐지지 않았고, 애플 학부모가 휴대폰 인증에서 막혔다.
 */
export function oauthProviderMethod(provider?: string | null): Exclude<ParentSignupMethod, "PASSWORD"> | null {
  const name = String(provider || "").toLowerCase();
  if (name === "google") return "GOOGLE";
  if (name === "kakao") return "KAKAO";
  if (name === "custom:naver" || name === "naver") return "NAVER";
  if (name === "apple") return "APPLE";
  return null;
}

export type VerifiedSignupPhoneResult =
  | { kind: "NEW_SIGNUP" }
  | { kind: "ACTIVATE_EXISTING"; activationUrl: string; claimToken: string; claimProof: string }
  | { kind: "LINKED_EXISTING"; redirectPath: string }
  | { kind: "CONTACT_ACADEMY"; error: string }
  | { kind: "REGISTERED"; error: string }
  | { error: string };

/**
 * 문자 인증을 막 통과한 가입 요청이 "학원에 이미 등록된 보호자(빈 계정)"인지 확인하고 넘길 곳을 정한다.
 *
 * - 처음 보는 번호: 지금처럼 계정 정보 입력(NEW_SIGNUP)
 * - 빈 계정 1개 + 간편가입 세션이 그대로 살아 있음: 그 간편로그인 계정을 빈 계정에 바로 연결(LINKED_EXISTING)
 * - 빈 계정 1개(그 밖): 문자 인증이 끝난 상태의 활성화 링크를 만들어 이메일·비밀번호만 정하게 한다(ACTIVATE_EXISTING)
 * - 빈 계정 여러 개: 자동으로 고르지 않는다(CONTACT_ACADEMY)
 *
 * 계정이 넘어가는 길은 모두 이 번호로 보낸 문자 인증(VERIFIED + 일회용 proof)을 통과해야만 열린다.
 */
export async function resolveVerifiedSignupPhone(input: {
  token: string;
  proof: string;
  redirectPath?: string | null;
  authenticatedOAuthUser?: { id: string; email?: string | null; provider?: string | null } | null;
}): Promise<VerifiedSignupPhoneResult> {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(input.proof)) return { error: "휴대폰 인증이 만료되었습니다." };
  try {
    return await prisma.$transaction(async (tx): Promise<VerifiedSignupPhoneResult> => {
      const row = await find(input.token, tx, true);
      if (!row || row.status !== "VERIFIED" || row.expiresAt <= new Date()) throw new SignupHandoffError("휴대폰 인증을 먼저 완료해 주세요.");
      if (!row.proofHash || !row.proofExpiresAt || row.proofExpiresAt <= new Date()
          || !equalHex(row.proofHash, keyed(`proof:${hash(input.token)}:${input.proof}`))) throw new SignupHandoffError("휴대폰 인증 증표가 없거나 만료되었습니다.");
      // 같은 번호의 가입 시작과 겹치지 않게 같은 잠금을 잡는다
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `signup:${row.phoneHash}`);
      const ownership = await classifyPhoneOwnership(tx, row.phone);
      if (ownership.kind === "NONE") return { kind: "NEW_SIGNUP" };
      if (ownership.kind === "REGISTERED") return { kind: "REGISTERED", error: REGISTERED_PHONE_MESSAGE };
      if (ownership.kind === "MULTIPLE_CLAIMABLE") {
        return { kind: "CONTACT_ACADEMY", error: "이 번호로 등록된 보호자 정보가 여러 개라 자동으로 연결하지 않았어요. 학원에 문의해 주세요." };
      }

      const markConsumed = (authUserId: string | null) => tx.$executeRawUnsafe(
        `UPDATE "ParentSignupVerification" SET status='CONSUMED',"consumedAt"=NOW(),"authUserId"=$2,
                "proofHash"=NULL,"proofExpiresAt"=NULL,"updatedAt"=NOW()
          WHERE id=$1 AND status='VERIFIED'`,
        row.id, authUserId,
      );

      // 간편가입: 인증을 시작한 그 간편로그인 계정(같은 제공자)이 지금도 로그인돼 있을 때만 바로 연결한다.
      const oauth = input.authenticatedOAuthUser;
      const sameOAuthUser = row.signupMethod !== "PASSWORD" && Boolean(oauth?.id)
        && oauth!.id === row.pendingAuthUserId && oauthProviderMethod(oauth!.provider) === row.signupMethod;
      if (sameOAuthUser) {
        const collision = await tx.$queryRawUnsafe<Array<{ found: boolean }>>(
          `SELECT EXISTS(
             SELECT 1 FROM "User"
              WHERE "authUserId" = $1 OR id = $1
                 OR ($2 <> '' AND LOWER(email) = LOWER($2))
           ) AS found`,
          oauth!.id,
          oauth!.email || "",
        );
        // 이 간편로그인 계정이 이미 다른 앱 계정과 겹치면 연결하지 않고 아래 비밀번호 활성화로 보낸다.
        if (!collision[0]?.found) {
          const updated = await tx.$executeRawUnsafe(
            `UPDATE "User" SET "authUserId" = $1, email = CASE WHEN $2 <> '' THEN LOWER($2) ELSE email END,
                    "phoneVerifiedAt" = NOW(), "updatedAt" = NOW()
              WHERE id = $3 AND role = 'PARENT' AND "authUserId" IS NULL AND email = $4`,
            oauth!.id, oauth!.email || "", ownership.parentId, ownership.email,
          );
          if (updated !== 1) throw new SignupHandoffError("보호자 계정 정보가 바뀌었습니다. 처음부터 다시 시도해 주세요.");
          await markConsumed(oauth!.id);
          return { kind: "LINKED_EXISTING", redirectPath: resolveRedirectForRole("PARENT", input.redirectPath) };
        }
      }

      // 비밀번호 활성화: 문자 인증은 방금 끝났으므로 VERIFIED 상태의 활성화 링크를 만든다.
      const claim = await issueVerifiedSelfParentClaim(
        { parentId: ownership.parentId, verifiedPhone: row.phone, redirectPath: input.redirectPath },
        tx,
      );
      // 가입 증표는 여기서 다 썼다 — 같은 증표로 신규 가입·재활성화를 다시 시도할 수 없게 닫는다.
      await markConsumed(null);
      return { kind: "ACTIVATE_EXISTING", activationUrl: claim.activationUrl, claimToken: claim.token, claimProof: claim.proof };
    });
  } catch (error) {
    // 직접 정해 둔 안내만 그대로 보여 주고, DB·내부 오류 원문은 화면에 내보내지 않는다.
    if (error instanceof SignupHandoffError || error instanceof SelfClaimUserError) return { error: error.message };
    console.error("[resolveVerifiedSignupPhone] failed:", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
    return { error: "처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." };
  }
}

/** resolveVerifiedSignupPhone 이 학부모에게 그대로 보여 줘도 되는 안내 문구만 담는 오류 */
class SignupHandoffError extends Error {}

async function rejectExisting(tx: Prisma.TransactionClient, username: string, phone: string) {
  const rows = await tx.$queryRawUnsafe<Array<{ usernameTaken: boolean; phoneTaken: boolean }>>(
    `SELECT
      EXISTS(SELECT 1 FROM "User" WHERE LOWER(COALESCE(username, '')) = LOWER($1)) AS "usernameTaken",
      EXISTS(SELECT 1 FROM "User" WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2) AS "phoneTaken"`,
    username, phone,
  );
  if (rows[0]?.usernameTaken) throw new Error("이미 사용 중인 로그인 아이디입니다.");
  if (rows[0]?.phoneTaken) throw new Error("이미 가입된 휴대폰 번호입니다. 기존 아이디로 로그인한 뒤 마이페이지 → 간편로그인 연결에서 Apple·Google 을 연결해 주세요.");
}

export async function startParentSignup(input: {
  phone: string; signupMethod?: ParentSignupMethod;
  email?: string | null; pendingAuthUserId?: string | null;
}) {
  const phone = normalizeParentPhone(input.phone);
  const method = input.signupMethod ?? "PASSWORD";
  if (!/^01[016789]\d{7,8}$/.test(phone)) return { error: "올바른 휴대폰 번호를 입력해 주세요." };
  if (method !== "PASSWORD" && !input.pendingAuthUserId) return { error: "간편가입 계정을 먼저 확인해 주세요." };
  const token = randomBytes(32).toString("base64url");
  const phoneHash = keyed(`phone:${phone}`);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM "ParentSignupVerification"
          WHERE status <> 'CONSUMED' AND "createdAt" < NOW() - INTERVAL '7 days'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "ParentSignupVerification"
            SET username=NULL, name=NULL, phone='', email=NULL, "pendingAuthUserId"=NULL,
                "phoneHash"=repeat('0',64), "lastError"=NULL, "updatedAt"=NOW()
          WHERE status='CONSUMED' AND "createdAt" < NOW() - INTERVAL '7 days' AND phone <> ''`,
      );
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `signup:${phoneHash}`);
      // 로그인 수단이 있는 번호만 지금처럼 거절한다. 학원이 가져오기로 만든 빈 계정의 번호는
      // 신규 번호와 똑같이 문자를 보낸다 — 문자 인증 전에는 "빈 계정이 있다"는 사실을 응답 문구나
      // 응답 시간으로 드러내지 않기 위해서다. 기존 계정 안내는 인증을 통과한 뒤에만 한다.
      const ownership = await classifyPhoneOwnership(tx, phone);
      if (ownership.kind === "REGISTERED") throw new Error(REGISTERED_PHONE_MESSAGE);
      const recent = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM "ParentSignupVerification"
         WHERE "phoneHash" = $1 AND "createdAt" > NOW() - INTERVAL '60 seconds'`, phoneHash,
      );
      if (Number(recent[0]?.count) > 0) throw new Error("가입 인증은 60초 후 다시 요청할 수 있습니다.");
      await tx.$executeRawUnsafe(
        `UPDATE "ParentSignupVerification" SET status = 'CANCELLED', "updatedAt" = NOW()
         WHERE "phoneHash" = $1 AND status IN ('PENDING', 'VERIFIED')`, phoneHash,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ParentSignupVerification"
         (id, "tokenHash", username, name, phone, "phoneHash", "signupMethod", email, "pendingAuthUserId", status, "expiresAt", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',NOW()+INTERVAL '30 minutes',NOW(),NOW())`,
        randomUUID(), hash(token), null, null, phone, phoneHash, method,
        input.email?.trim().toLowerCase() || null, input.pendingAuthUserId ?? null,
      );
    });
    return { ok: true, token };
  } catch (error) { return { error: userFacingError(error, "가입 인증을 시작하지 못했습니다.") }; }
}

export async function sendParentSignupOtp(token: string, requestKey = "unknown") {
  const code = randomInt(100000, 1000000).toString();
  const requestHash = keyed(`request:${requestKey}`);
  let row: Row | null = null; let reserved: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      row = await find(token, tx, true);
      const current = row as Row | null;
      if (!current || current.status !== "PENDING" || current.expiresAt <= new Date()) throw new Error("가입 인증 요청이 만료되었습니다.");
      if (current.lockedAt && Date.now() - current.lockedAt.getTime() < 15 * 60_000) throw new Error("인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요.");
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        "parent-signup-sms-global",
      );
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        `parent-signup-sms-request:${requestHash}`,
      );
      const quota = await tx.$queryRawUnsafe<Array<{ recent: number; daily: number; hourlyRequest: number; dailyRequest: number; dailyGlobal: number }>>(
        `SELECT
         (SELECT COUNT(*) FROM "ParentSignupVerification" WHERE id=$1 AND "otpSentAt">NOW()-INTERVAL '60 seconds')::int AS recent,
         (SELECT COUNT(*) FROM "ParentSignupOtpSend" WHERE "phoneHash"=$2 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 day')::int AS daily,
         (SELECT COUNT(*) FROM "ParentSignupOtpSend" WHERE "requestHash"=$3 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 hour')::int AS "hourlyRequest",
         (SELECT COUNT(*) FROM "ParentSignupOtpSend" WHERE "requestHash"=$3 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 day')::int AS "dailyRequest",
         (SELECT COUNT(*) FROM "ParentSignupOtpSend" WHERE status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 day')::int AS "dailyGlobal"`,
        current.id, current.phoneHash, requestHash,
      );
      if (Number(quota[0]?.recent) > 0) throw new Error("인증번호는 60초 후 다시 요청할 수 있습니다.");
      if (Number(quota[0]?.daily) >= 10) throw new Error("오늘 인증번호 요청 횟수를 초과했습니다.");
      if (Number(quota[0]?.hourlyRequest) >= 5 || Number(quota[0]?.dailyRequest) >= 20) throw new Error("인증 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
      if (Number(quota[0]?.dailyGlobal) >= 5000) throw new Error("현재 인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.");
      reserved = keyed(`otp:${hash(token)}:${current.phone}:${code}`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "ParentSignupOtpSend" (id,"verificationId","phoneHash","requestHash",status,"createdAt") VALUES ($1,$2,$3,$4,'RESERVED',NOW())`,
        randomUUID(), current.id, current.phoneHash, requestHash,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "ParentSignupVerification" SET "otpHash"=$1,"otpExpiresAt"=NOW()+INTERVAL '${OTP_TTL_MINUTES} minutes',
         "otpSentAt"=NOW(),"otpAttempts"=0,"lockedAt"=NULL,"proofHash"=NULL,"proofExpiresAt"=NULL,"updatedAt"=NOW() WHERE id=$2`,
        reserved, current.id,
      );
    });
    if (process.env.NODE_ENV !== "test" && !(await sendAuthenticationSms(row!.phone, `[STIZ 농구교실] 회원가입 인증번호: ${code} (5분 이내 입력)`))) {
      throw new Error("인증번호 문자 발송에 실패했습니다.");
    }
    await prisma.$executeRawUnsafe(`UPDATE "ParentSignupOtpSend" SET status='SENT' WHERE "verificationId"=$1 AND status='RESERVED'`, row!.id);
    return { ok: true };
  } catch (error) {
    const failedRow = row as Row | null;
    if (failedRow && reserved) await prisma.$transaction([
      prisma.$executeRawUnsafe(`UPDATE "ParentSignupOtpSend" SET status='FAILED' WHERE "verificationId"=$1 AND status='RESERVED'`, failedRow.id),
      prisma.$executeRawUnsafe(`UPDATE "ParentSignupVerification" SET "otpHash"=NULL,"otpExpiresAt"=NULL WHERE id=$1 AND "otpHash"=$2`, failedRow.id, reserved),
    ]).catch(() => undefined);
    return { error: userFacingError(error, "인증번호를 보내지 못했습니다.") };
  }
}

export async function verifyParentSignupOtp(token: string, code: string) {
  if (!/^\d{6}$/.test(code.trim())) return { error: "6자리 인증번호를 입력해 주세요." };
  return prisma.$transaction(async (tx) => {
    const row = await find(token, tx, true);
    if (!row || row.status !== "PENDING" || row.expiresAt <= new Date()) return { error: "가입 인증 요청이 만료되었습니다." };
    if (row.lockedAt && Date.now() - row.lockedAt.getTime() < 15 * 60_000) return { error: "인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요." };
    if (!row.otpHash || !row.otpExpiresAt || row.otpExpiresAt <= new Date()) return { error: "인증번호를 다시 요청해 주세요." };
    const supplied = keyed(`otp:${hash(token)}:${row.phone}:${code.trim()}`);
    if (!equalHex(row.otpHash, supplied)) {
      const attempts = Math.min(row.otpAttempts + 1, MAX_ATTEMPTS);
      await tx.$executeRawUnsafe(`UPDATE "ParentSignupVerification" SET "otpAttempts"=$1,"lockedAt"=CASE WHEN $1 >= $2 THEN NOW() ELSE NULL END WHERE id=$3`, attempts, MAX_ATTEMPTS, row.id);
      return { error: attempts >= MAX_ATTEMPTS ? "인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요." : `인증번호가 일치하지 않습니다. (${MAX_ATTEMPTS - attempts}회 남음)` };
    }
    const proof = randomBytes(32).toString("base64url");
    await tx.$executeRawUnsafe(
      `UPDATE "ParentSignupVerification" SET status='VERIFIED',"verifiedAt"=NOW(),"otpHash"=NULL,"proofHash"=$2,"proofExpiresAt"=NOW()+INTERVAL '10 minutes',"updatedAt"=NOW() WHERE id=$1`,
      row.id, keyed(`proof:${hash(token)}:${proof}`),
    );
    return { ok: true, proof };
  });
}

export async function completeParentSignup(input: {
  token: string; proof: string; username: string; name: string; password?: string;
  enrollmentHandoff?: string | null;
  consents: { terms: boolean; privacy: boolean; age: boolean };
  authenticatedOAuthUser?: { id: string; email?: string | null; provider?: string | null } | null;
}) {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(input.proof)) return { error: "휴대폰 인증이 만료되었습니다." };
  const username = normalizeParentUsername(input.username);
  const name = input.name.trim();
  if (!USERNAME_PATTERN.test(username)) return { error: "아이디는 영문 소문자로 시작하고 영문·숫자·밑줄 조합의 4~20자로 입력해 주세요." };
  if (name.length < 2 || name.length > 40) return { error: "이름은 2~40자로 입력해 주세요." };
  if (!input.consents.terms || !input.consents.privacy || !input.consents.age) return { error: "필수 약관과 만 14세 이상 확인에 모두 동의해 주세요." };
  const attemptId = randomUUID(); let row: Row | null = null; let authUserId: string | null = null; let createdAuth = false;
  try {
    row = await prisma.$transaction(async (tx) => {
      const current = await find(input.token, tx, true);
      if (!current || current.status !== "VERIFIED" || current.expiresAt <= new Date()) throw new Error("휴대폰 인증을 먼저 완료해 주세요.");
      if (!current.proofHash || !current.proofExpiresAt || current.proofExpiresAt <= new Date() || !equalHex(current.proofHash, keyed(`proof:${hash(input.token)}:${input.proof}`))) throw new Error("휴대폰 인증 증표가 없거나 만료되었습니다.");
      await rejectExisting(tx, username, current.phone);
      if (current.signupMethod === "PASSWORD" && (!input.password || input.password.length < 8)) throw new Error("비밀번호는 8자 이상 입력해 주세요.");
      if (current.signupMethod !== "PASSWORD" && input.authenticatedOAuthUser?.id !== current.pendingAuthUserId) throw new Error("간편가입 계정을 다시 확인해 주세요.");
      if (current.signupMethod !== "PASSWORD") {
        const actualMethod = oauthProviderMethod(input.authenticatedOAuthUser?.provider);
        if (actualMethod !== current.signupMethod) throw new Error("간편가입 제공자 정보가 일치하지 않습니다.");
        const linked = await tx.$queryRawUnsafe<Array<{ found: boolean }>>(
          `SELECT EXISTS(
             SELECT 1 FROM "User"
              WHERE "authUserId" = $1 OR id = $1
                 OR ($2 <> '' AND LOWER(email) = LOWER($2))
           ) AS found`,
          input.authenticatedOAuthUser!.id,
          input.authenticatedOAuthUser?.email || "",
        );
        if (linked[0]?.found) throw new Error("이미 연결된 계정입니다. 기존 계정으로 로그인해 주세요.");
      }
      const changed = await tx.$executeRawUnsafe(
        `UPDATE "ParentSignupVerification" SET status='PROCESSING', username=$2, name=$3,
         "termsAgreedAt"=NOW(), "termsVersion"=$5,
         "privacyAgreedAt"=NOW(), "privacyVersion"=$6, "ageConfirmedAt"=NOW(),
         "processingAt"=NOW(),"processingAttemptId"=$4,"updatedAt"=NOW()
         WHERE id=$1 AND status='VERIFIED'`,
        current.id, username, name, attemptId, TERMS_VERSION, PRIVACY_VERSION,
      );
      if (changed !== 1) throw new Error("회원가입이 이미 처리 중입니다.");
      return { ...current, username, name };
    });
    const admin = createAdminClient();
    if (row.signupMethod === "PASSWORD") {
      const created = await admin.auth.admin.createUser({ email: parentUsernameAuthEmail(row.username!), password: input.password!, email_confirm: true, app_metadata: { role: "PARENT" }, user_metadata: { name: row.name!, username: row.username! } });
      if (created.error || !created.data.user) throw new Error(created.error?.message?.toLowerCase().includes("already") ? "이미 사용 중인 로그인 아이디입니다." : "로그인 계정을 만들지 못했습니다.");
      authUserId = created.data.user.id; createdAuth = true;
    } else {
      authUserId = input.authenticatedOAuthUser!.id;
    }
    await prisma.$transaction(async (tx) => {
      await rejectExisting(tx, row!.username!, row!.phone);
      const email = row!.signupMethod === "PASSWORD" ? parentUsernameAuthEmail(row!.username!) : (row!.email || input.authenticatedOAuthUser?.email || parentUsernameAuthEmail(row!.username!));
      await tx.$executeRawUnsafe(
        `INSERT INTO "User" (id,email,username,name,phone,"phoneVerifiedAt","authUserId",role,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW(),$1,'PARENT'::"Role",NOW(),NOW())`,
        authUserId, email, row!.username!, row!.name!, row!.phone,
      );
      if (input.enrollmentHandoff) {
        await linkEnrollmentAccount(
          { token: input.enrollmentHandoff, parentUserId: authUserId! },
          tx,
        );
      }
      const consumed = await tx.$executeRawUnsafe(`UPDATE "ParentSignupVerification" SET status='CONSUMED',"consumedAt"=NOW(),"authUserId"=$2,"proofHash"=NULL,"proofExpiresAt"=NULL WHERE id=$1 AND status='PROCESSING' AND "processingAttemptId"=$3`, row!.id, authUserId, attemptId);
      if (consumed !== 1) throw new Error("회원가입 처리 상태가 변경되었습니다.");
    });
    return { ok: true, username: row.username };
  } catch (error) {
    if (createdAuth && authUserId) await createAdminClient().auth.admin.deleteUser(authUserId).catch(() => undefined);
    if (row) await prisma.$executeRawUnsafe(`UPDATE "ParentSignupVerification" SET status='VERIFIED',"processingAt"=NULL,"processingAttemptId"=NULL,"lastError"=$2 WHERE id=$1 AND status='PROCESSING' AND "processingAttemptId"=$3`, row.id, error instanceof Error ? error.message.slice(0, 1000) : "SIGNUP_FAILED", attemptId).catch(() => undefined);
    return { error: userFacingError(error, "회원가입을 완료하지 못했습니다.") };
  }
}
