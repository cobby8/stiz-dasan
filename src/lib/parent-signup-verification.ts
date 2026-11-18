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
import { PARENT_PRIVACY_VERSION, PARENT_TERMS_VERSION, PARENT_CONSENT_REQUIRED_MESSAGE, hasAllParentConsents } from "@/lib/parent-consent";
import { PARENT_PASSWORD_MIN, PARENT_WEAK_PASSWORD_MESSAGE, isWeakPasswordRejection } from "@/lib/parent-password-rules";
// 본인인증 실명·시각 규칙은 한 곳(2026-11-18) — 문자 인증(SMS)은 실명을 적지 않는다
import { cleanVerifiedName, recordIdentityVerification, signupRowIdentity } from "@/lib/identity/verified-identity";
// 원장이 번호에 미리 붙여 둔 선생님·기사님 역할 — 가입·연결이 끝나는 거래 안에서 적용(2026-11-18 5단계)
import { applyRolePresetsForUser, type RolePresetOutcome } from "@/lib/staff/rolePreset";
import { notifyRolePresetOutcomes } from "@/lib/staff/rolePresetNotify";
// 아이디 규칙·로그인 메일 매핑은 기존 학부모 계정 활성화와 같은 모듈 한 곳(2026-11-13 f7)
import {
  PARENT_USERNAME_PATTERN,
  PARENT_USERNAME_RULE_MESSAGE,
  PARENT_USERNAME_TAKEN_MESSAGE,
  normalizeParentUsername,
  parentUsernameAuthEmail,
} from "@/lib/parent-username";
// 예전부터 이 파일에서 가져가던 곳(가입 완료 라우트 등)을 위해 그대로 다시 내보낸다
export { normalizeParentUsername, parentUsernameAuthEmail };

const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
// 동의 버전은 기존 계정 활성화와 같은 값을 쓴다(@/lib/parent-consent 한 곳)
const TERMS_VERSION = PARENT_TERMS_VERSION;
const PRIVACY_VERSION = PARENT_PRIVACY_VERSION;
// 같은 요청 IP 의 인증번호 한도(2026-11-13 완화 a6) — 학원·아파트 공용 와이파이에서 여러 학부모가 몰려 막히던 것.
// 1차 40/200 → 2차(원장 점검표 a6) 시간당 100·하루 500 — 가입 안내 문자를 한꺼번에 보내면 같은 와이파이에서 몰린다.
// 번호당(하루 10회)·전체(하루 5000)·오답 잠금(5회 15분)은 그대로다.
export const SIGNUP_OTP_IP_HOURLY_LIMIT = 100;
export const SIGNUP_OTP_IP_DAILY_LIMIT = 500;
// DB CHECK(ParentSignupVerification_signupMethod_check)와 같은 목록이어야 한다 — 테스트가 마이그레이션과 대조한다.
export const PARENT_SIGNUP_METHODS = ["PASSWORD", "GOOGLE", "KAKAO", "NAVER", "APPLE"] as const;
export type ParentSignupMethod = (typeof PARENT_SIGNUP_METHODS)[number];

type Row = {
  id: string; username: string | null; name: string | null; phone: string; phoneHash: string;
  signupMethod: ParentSignupMethod; email: string | null; pendingAuthUserId: string | null;
  status: string; expiresAt: Date; otpHash: string | null; otpExpiresAt: Date | null;
  otpAttempts: number; lockedAt: Date | null; proofHash: string | null; proofExpiresAt: Date | null;
  // 2026-11-18: 통과한 인증 방식(SMS/IDENTITY)·본인인증 실명·통과 시각 — User 로 옮길 때 signupRowIdentity 가 고른다
  verificationMethod: string | null; verifiedName: string | null; verifiedAt: Date | null;
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
export function normalizeParentPhone(value: string) { return value.replace(/\D/g, ""); }

async function find(token: string, tx: Prisma.TransactionClient | typeof prisma, lock = false) {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) return null;
  const rows = await tx.$queryRawUnsafe<Row[]>(
    `SELECT id, username, name, phone, "phoneHash", "signupMethod", email, "pendingAuthUserId", status,
      "expiresAt", "otpHash", "otpExpiresAt", "otpAttempts", "lockedAt", "proofHash", "proofExpiresAt",
      "verificationMethod", "verifiedName", "verifiedAt"
     FROM "ParentSignupVerification" WHERE "tokenHash" = $1${lock ? " FOR UPDATE" : ""}`,
    hash(token),
  );
  return rows[0] ?? null;
}

// 화면은 문구가 아니라 phoneRegistered 표식으로 판단한다(start 라우트) — 문구를 바꿔도 버튼이 사라지지 않게.
export const REGISTERED_PHONE_MESSAGE = "이미 가입된 휴대폰 번호입니다. 기존 아이디로 로그인해 주세요. 아이디·비밀번호가 기억나지 않으면 「아이디·비밀번호 찾기」를, 간편로그인은 로그인 뒤 마이페이지 → 간편로그인 연결을 이용해 주세요.";

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
 * - 빈 계정 1개(그 밖): 문자 인증이 끝난 상태의 활성화 링크를 만들어 아이디·비밀번호만 정하게 한다(ACTIVATE_EXISTING)
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
  // 빈 계정에 간편로그인을 바로 붙인 경우(LINKED) 미리 붙인 역할 적용 결과 — 알림은 거래 뒤에 보낸다
  let linkedPreset: { userId: string; outcomes: RolePresetOutcome[] } | null = null;
  try {
    const result = await prisma.$transaction(async (tx): Promise<VerifiedSignupPhoneResult> => {
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
          // 본인인증으로 들어왔으면 실명·시각을 같은 거래에서 적는다(문자 인증이면 identity=null → 적지 않음)
          const identity = signupRowIdentity(row);
          if (identity) await recordIdentityVerification(tx, { userId: ownership.parentId, ...identity });
          // 원장이 이 번호에 미리 붙여 둔 역할 — 연결과 같은 거래에서 적용(본인인증+이름 일치면 바로, 아니면 원장 확인)
          linkedPreset = { userId: ownership.parentId, outcomes: await applyRolePresetsForUser(tx, { userId: ownership.parentId, verifiedName: identity?.verifiedName ?? null }) };
          await markConsumed(oauth!.id);
          return { kind: "LINKED_EXISTING", redirectPath: resolveRedirectForRole("PARENT", input.redirectPath) };
        }
      }

      // 비밀번호 활성화: 문자 인증은 방금 끝났으므로 VERIFIED 상태의 활성화 링크를 만든다.
      const claim = await issueVerifiedSelfParentClaim(
        // 본인인증으로 들어왔으면 활성화 대상 계정에 실명·시각을 함께 적는다(문자 인증이면 null)
        { parentId: ownership.parentId, verifiedPhone: row.phone, redirectPath: input.redirectPath, identity: signupRowIdentity(row) },
        tx,
      );
      // 가입 증표는 여기서 다 썼다 — 같은 증표로 신규 가입·재활성화를 다시 시도할 수 없게 닫는다.
      await markConsumed(null);
      // 미리 붙인 역할은 활성화가 «끝나는» 거래(consumeParentAccountClaim)에서 적용한다 — 여기서는 아직 로그인이 없다
      return { kind: "ACTIVATE_EXISTING", activationUrl: claim.activationUrl, claimToken: claim.token, claimProof: claim.proof };
    });
    const applied = linkedPreset as { userId: string; outcomes: RolePresetOutcome[] } | null;
    if (applied && applied.outcomes.length > 0) await notifyRolePresetOutcomes(applied.userId, applied.outcomes);
    return result;
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
  if (rows[0]?.usernameTaken) throw new Error(PARENT_USERNAME_TAKEN_MESSAGE);
  if (rows[0]?.phoneTaken) throw new Error(REGISTERED_PHONE_MESSAGE);
}

/**
 * 가입 요청 개인정보 정리(7일) — 가입 시작 두 길(문자 인증 startParentSignup · 본인인증 issueIdentityVerifiedSignup)이
 * 같은 거래 안에서 부른다(검수 N-3: 예전엔 문자 가입 시작 때만 돌아, 본인인증만 쓰면 실명이 오래 남을 수 있었다).
 *  - 끝나지 않은 요청은 7일 뒤 지운다
 *  - 끝난(CONSUMED) 요청은 감사용 줄만 남기고 개인정보(번호·이메일·본인인증 실명 등)를 비운다
 *  - 만료된 활성화 증표(ParentAccountClaim)에 실어 둔 본인인증 실명·시각도 비운다(활성화를 끝내지 않은 경우)
 */
async function purgeStaleSignupPersonalData(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe(
    `DELETE FROM "ParentSignupVerification"
      WHERE status <> 'CONSUMED' AND "createdAt" < NOW() - INTERVAL '7 days'`,
  );
  await tx.$executeRawUnsafe(
    `UPDATE "ParentSignupVerification"
        SET username=NULL, name=NULL, phone='', email=NULL, "pendingAuthUserId"=NULL, "verifiedName"=NULL,
            "phoneHash"=repeat('0',64), "lastError"=NULL, "updatedAt"=NOW()
      WHERE status='CONSUMED' AND "createdAt" < NOW() - INTERVAL '7 days' AND phone <> ''`,
  );
  await tx.$executeRawUnsafe(
    `UPDATE "ParentAccountClaim" SET "verifiedName"=NULL, "identityVerifiedAt"=NULL, "updatedAt"=NOW()
      WHERE "verifiedName" IS NOT NULL AND "expiresAt" < NOW()`,
  );
}

/**
 * 7일 정리를 매일 한 번 따로 돌린다(2026-11-18 4단계 D) — 매일 백업 cron 이 부른다.
 * 가입 시작이 며칠 없으면 정리도 멈춰 실명이 7일보다 오래 남을 수 있었다. 예외를 던지지 않는다(백업을 막지 않게).
 */
export async function runSignupPersonalDataPurge(): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => { await purgeStaleSignupPersonalData(tx); });
    return true;
  } catch (error) {
    console.error("[signup purge] failed:", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
    return false;
  }
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
      await purgeStaleSignupPersonalData(tx);
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
         (id, "tokenHash", username, name, phone, "phoneHash", "signupMethod", email, "pendingAuthUserId", status, "verificationMethod", "expiresAt", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING','SMS',NOW()+INTERVAL '30 minutes',NOW(),NOW())`,
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
      if (Number(quota[0]?.hourlyRequest) >= SIGNUP_OTP_IP_HOURLY_LIMIT || Number(quota[0]?.dailyRequest) >= SIGNUP_OTP_IP_DAILY_LIMIT) throw new Error("인증 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
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
    if (process.env.NODE_ENV !== "test" && !(await sendAuthenticationSms(row!.phone, `[스티즈농구교실] 회원가입 인증번호: ${code} (5분 이내 입력)`))) {
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

/**
 * 본인인증(통신사 명의 확인)을 통과한 번호로 «문자 인증을 마친 것과 같은» 가입 요청을 만든다(2026-11-17 원장 지시
 * «본인인증 하나로 통일»). 문자는 보내지 않는다 — 본인인증이 «이 번호의 명의자»까지 확인했으므로 문자 인증보다 강하다.
 * 부르는 쪽이 포트원 재조회(VERIFIED·10분 안)와 건 번호 표식 대조를 끝낸 뒤에만 부른다:
 *  - 간편가입: parent-link/verify (이 간편로그인 사용자의 건 번호)
 *  - 아이디 가입·기존 계정 활성화: parent-signup/identity/verify (이 브라우저 nonce 쿠키의 건 번호, 1회 소진 — 2026-11-18 4단계)
 * 로그인 수단이 있는 번호(REGISTERED)는 여기로 오지 않는다 — 그쪽은 기존 계정 연결(selectLinkTarget)이 맡는다.
 */
export async function issueIdentityVerifiedSignup(input: {
  /** PASSWORD = 아이디 가입·기존 계정 활성화(로그인 전 본인인증, 2026-11-18 4단계) / 그 밖 = 간편가입 */
  phone: string; signupMethod: ParentSignupMethod;
  /** 간편가입이면 필수(그 간편로그인 사용자), 아이디 가입이면 없다 */
  email?: string | null; pendingAuthUserId?: string | null;
  /** 본인인증 실명·인증 시각(2026-11-18) — 계정이 만들어지거나 연결될 때 User 로 옮긴다 */
  verifiedName: string; verifiedAt: Date;
}): Promise<{ ok: true; token: string; proof: string } | { error: string }> {
  const phone = normalizeParentPhone(input.phone);
  if (!/^01[016789]\d{7,8}$/.test(phone)) return { error: "본인인증 휴대폰 번호를 확인하지 못했어요. 학원에 문의해 주세요." };
  if (!PARENT_SIGNUP_METHODS.includes(input.signupMethod)) return { error: "가입 방법을 확인해 주세요." };
  // 간편가입은 «인증을 시작한 그 간편로그인 사용자»가 있어야 한다. 아이디 가입은 로그인 전이라 없다(문자 가입과 같다)
  if (input.signupMethod !== "PASSWORD" && !input.pendingAuthUserId) return { error: "간편가입 계정을 먼저 확인해 주세요." };
  const pendingAuthUserId = input.signupMethod === "PASSWORD" ? null : input.pendingAuthUserId!;
  const email = input.signupMethod === "PASSWORD" ? null : input.email?.trim().toLowerCase() || null;
  // 실명이 비어 오면 본인인증 결과가 온전하지 않은 것 — 이름 없는 «본인인증 통과» 줄을 만들지 않는다(이름은 문구에 넣지 않는다)
  const verifiedName = cleanVerifiedName(input.verifiedName);
  if (!verifiedName) return { error: "본인인증 이름을 확인하지 못했어요. 다시 인증해 주세요." };
  const token = randomBytes(32).toString("base64url");
  const proof = randomBytes(32).toString("base64url");
  const phoneHash = keyed(`phone:${phone}`);
  try {
    await prisma.$transaction(async (tx) => {
      // 7일 정리 — 문자 가입 시작과 같은 함수(검수 N-3)
      await purgeStaleSignupPersonalData(tx);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text`, `signup:${phoneHash}`);
      const ownership = await classifyPhoneOwnership(tx, phone);
      if (ownership.kind === "REGISTERED") throw new Error(REGISTERED_PHONE_MESSAGE);
      // 같은 번호로 진행 중이던 가입 요청은 닫는다(문자 인증 시작과 같은 규칙)
      await tx.$executeRawUnsafe(
        `UPDATE "ParentSignupVerification" SET status = 'CANCELLED', "updatedAt" = NOW()
         WHERE "phoneHash" = $1 AND status IN ('PENDING', 'VERIFIED')`, phoneHash,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ParentSignupVerification"
         (id, "tokenHash", username, name, phone, "phoneHash", "signupMethod", email, "pendingAuthUserId", status,
          "verificationMethod", "verifiedName", "verifiedAt", "proofHash", "proofExpiresAt", "expiresAt", "createdAt", "updatedAt")
         VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6,$7,'VERIFIED','IDENTITY',$9,$10,$8,NOW()+INTERVAL '10 minutes',NOW()+INTERVAL '30 minutes',NOW(),NOW())`,
        randomUUID(), hash(token), phone, phoneHash, input.signupMethod,
        email, pendingAuthUserId, keyed(`proof:${hash(token)}:${proof}`),
        verifiedName, input.verifiedAt,
      );
    });
    return { ok: true, token, proof };
  } catch (error) { return { error: userFacingError(error, "가입 인증을 시작하지 못했습니다.") }; }
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
  if (!PARENT_USERNAME_PATTERN.test(username)) return { error: PARENT_USERNAME_RULE_MESSAGE };
  if (name.length < 2 || name.length > 40) return { error: "닉네임은 2~40자로 입력해 주세요." };
  if (!hasAllParentConsents(input.consents)) return { error: PARENT_CONSENT_REQUIRED_MESSAGE };
  const attemptId = randomUUID(); let row: Row | null = null; let authUserId: string | null = null; let createdAuth = false;
  try {
    row = await prisma.$transaction(async (tx) => {
      const current = await find(input.token, tx, true);
      if (!current || current.status !== "VERIFIED" || current.expiresAt <= new Date()) throw new Error("휴대폰 인증을 먼저 완료해 주세요.");
      if (!current.proofHash || !current.proofExpiresAt || current.proofExpiresAt <= new Date() || !equalHex(current.proofHash, keyed(`proof:${hash(input.token)}:${input.proof}`))) throw new Error("휴대폰 인증 증표가 없거나 만료되었습니다.");
      await rejectExisting(tx, username, current.phone);
      if (current.signupMethod === "PASSWORD" && (!input.password || input.password.length < PARENT_PASSWORD_MIN)) throw new Error("비밀번호는 8자 이상 입력해 주세요.");
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
      // 약한 비밀번호 거절은 이유를 알려 준다(예전엔 «로그인 계정을 만들지 못했습니다»만 떠서 무엇을 고칠지 몰랐다)
      if (created.error && isWeakPasswordRejection(created.error)) throw new Error(PARENT_WEAK_PASSWORD_MESSAGE);
      if (created.error || !created.data.user) throw new Error(created.error?.message?.toLowerCase().includes("already") ? PARENT_USERNAME_TAKEN_MESSAGE : "로그인 계정을 만들지 못했습니다.");
      authUserId = created.data.user.id; createdAuth = true;
    } else {
      authUserId = input.authenticatedOAuthUser!.id;
    }
    let presetOutcomes: RolePresetOutcome[] = [];
    await prisma.$transaction(async (tx) => {
      await rejectExisting(tx, row!.username!, row!.phone);
      const email = row!.signupMethod === "PASSWORD" ? parentUsernameAuthEmail(row!.username!) : (row!.email || input.authenticatedOAuthUser?.email || parentUsernameAuthEmail(row!.username!));
      // 본인인증으로 통과한 가입이면 실명·시각을 함께 넣는다. 문자 인증(SMS)이면 둘 다 NULL(signupRowIdentity 가 null)
      const identity = signupRowIdentity(row!);
      await tx.$executeRawUnsafe(
        `INSERT INTO "User" (id,email,username,name,phone,"phoneVerifiedAt","authUserId",role,"identityVerifiedName","identityVerifiedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW(),$1,'PARENT'::"Role",$6,$7,NOW(),NOW())`,
        authUserId, email, row!.username!, row!.name!, row!.phone,
        identity?.verifiedName ?? null, identity?.verifiedAt ?? null,
      );
      if (input.enrollmentHandoff) {
        await linkEnrollmentAccount(
          { token: input.enrollmentHandoff, parentUserId: authUserId! },
          tx,
        );
      }
      // 원장이 이 번호에 미리 붙여 둔 선생님·기사님 역할(ROLE_PRESET)을 같은 거래에서 적용한다(2026-11-18 5단계).
      // 본인인증 + 초대 이름 일치면 바로 열리고, 문자 인증·이름 다름이면 원장 신청함으로 간다(rolePreset.ts 한 곳).
      presetOutcomes = await applyRolePresetsForUser(tx, { userId: authUserId!, verifiedName: identity?.verifiedName ?? null });
      const consumed = await tx.$executeRawUnsafe(`UPDATE "ParentSignupVerification" SET status='CONSUMED',"consumedAt"=NOW(),"authUserId"=$2,"proofHash"=NULL,"proofExpiresAt"=NULL WHERE id=$1 AND status='PROCESSING' AND "processingAttemptId"=$3`, row!.id, authUserId, attemptId);
      if (consumed !== 1) throw new Error("회원가입 처리 상태가 변경되었습니다.");
    });
    // 알림은 거래가 끝난 뒤(실패해도 가입은 그대로)
    if (presetOutcomes.length > 0) await notifyRolePresetOutcomes(authUserId!, presetOutcomes);
    return { ok: true, username: row.username, staffRoles: presetOutcomes.filter((outcome) => outcome.status !== "ALREADY").map((outcome) => ({ role: outcome.role, status: outcome.status })) };
  } catch (error) {
    if (createdAuth && authUserId) await createAdminClient().auth.admin.deleteUser(authUserId).catch(() => undefined);
    if (row) await prisma.$executeRawUnsafe(`UPDATE "ParentSignupVerification" SET status='VERIFIED',"processingAt"=NULL,"processingAttemptId"=NULL,"lastError"=$2 WHERE id=$1 AND status='PROCESSING' AND "processingAttemptId"=$3`, row.id, error instanceof Error ? error.message.slice(0, 1000) : "SIGNUP_FAILED", attemptId).catch(() => undefined);
    return { error: userFacingError(error, "회원가입을 완료하지 못했습니다.") };
  }
}
