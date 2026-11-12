import "server-only";

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendAuthenticationSms } from "@/lib/message-dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeParentPhone } from "@/lib/parent-signup-verification";
import { oauthProviderMethod } from "@/lib/parent-signup-verification";
import { SIGNUP_OTP_IP_DAILY_LIMIT, SIGNUP_OTP_IP_HOURLY_LIMIT } from "@/lib/parent-signup-verification";
import {
  PARENT_WEAK_PASSWORD_MESSAGE,
  SOCIAL_PASSWORD_CONTACT_MESSAGE,
  isWeakPasswordRejection,
  planSocialPasswordLogin,
  socialPasswordCreationAllowed,
} from "@/lib/parent-password-rules";

/**
 * 학부모 아이디·비밀번호 찾기(2026-11-13).
 *
 * 왜 문자 인증인가 — 학부모 아이디 가입은 로그인 메일이 `아이디@member.stiz.kr`(받을 수 없는 주소)라
 * Supabase 메일 재설정이 닿지 않는다. 가입 때 문자 인증을 거친 User.phone 이 유일한 본인 확인 수단이다.
 *
 * 흐름: 번호 입력(start) → 문자 6자리(verify, 5회 틀리면 15분 잠금) → 그 번호의 학부모 계정 아이디 표시
 *       → 비밀번호로 로그인하는 계정만 새 비밀번호 저장(complete, 증표 1회 사용).
 *
 * 규칙
 * - 화면에 보여 줄 거절 사유는 throw 하지 않고 값({ error })으로 돌려준다(운영 빌드는 throw 문구를 가린다).
 * - 로그인 수단이 없는 번호(처음 보는 번호, 학원이 가져오기로 만든 빈 보호자 계정)는 같은 문구로 답한다 —
 *   가입 화면과 마찬가지로 문자 인증 전에는 «빈 계정이 있다»는 사실을 드러내지 않는다.
 * - 직원(선생님·기사·관리자) 계정은 대상이 아니다. 직원은 원장이 보내는 재설정 링크를 쓴다.
 * - 간편로그인(카카오·네이버·구글·Apple)만으로 가입한 계정도 비밀번호를 새로 만들 수 있다(2026-11-13 a1 —
 *   스토어 앱에서는 간편로그인 버튼을 숨겨 아이디·비밀번호가 유일한 로그인 수단이다). 조건은 같다:
 *   그 번호로 문자 인증 통과 + 고른 계정이 그 번호의 학부모 계정. 무엇으로 로그인하는지는 planSocialPasswordLogin 이 정한다.
 */

const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

export const NO_PARENT_ACCOUNT_MESSAGE =
  "이 번호로 로그인할 수 있는 학부모 계정이 없어요. 처음이시거나 학원에만 등록돼 있다면 회원가입에서 휴대폰 인증을 진행해 주세요.";

type Row = {
  id: string; phone: string; phoneHash: string; status: string; expiresAt: Date;
  otpHash: string | null; otpExpiresAt: Date | null; otpAttempts: number; lockedAt: Date | null;
  proofHash: string | null; proofExpiresAt: Date | null;
};

export type ParentResetAccount = {
  id: string;
  /** 로그인 화면에 넣는 값 — 아이디가 있으면 아이디, 없으면(이메일로 활성화한 계정) 이메일 */
  loginId: string;
  /** PASSWORD = 비밀번호로 로그인, SOCIAL = 간편로그인 전용 */
  kind: "PASSWORD" | "SOCIAL";
  /** 이 계정에 새 비밀번호를 정할 수 있는가(SOCIAL 인데 아이디도 로그인 메일도 없으면 false — 학원 문의) */
  canSetPassword: boolean;
  /** SOCIAL 일 때 연결된 간편로그인 이름(카카오·네이버·Google·Apple) */
  socialLabels: string[];
};

type Result<T extends object = Record<never, never>> = ({ ok: true } & T) | { error: string };

function secret() {
  const value = process.env.PARENT_SIGNUP_SECRET || process.env.PARENT_ACCOUNT_CLAIM_SECRET || process.env.INVITE_OTP_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("PARENT_RESET_SECRET_MISSING");
  return "development-only-parent-signup-secret";
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function keyed(value: string) { return createHmac("sha256", secret()).update(`password-reset:${value}`).digest("hex"); }
function equalHex(a: string, b: string) {
  const left = Buffer.from(a, "hex"); const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,200}$/;

/** 화면에 그대로 보여 줘도 되는 안내만 담는다. 이 밖의 오류는 일반 안내로 바꾼다. */
class ResetUserError extends Error {}

function failure(error: unknown, fallback: string): { error: string } {
  if (error instanceof ResetUserError) return { error: error.message };
  console.error("[parent-password-reset]", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
  return { error: fallback };
}

async function findRow(token: string, tx: Prisma.TransactionClient | typeof prisma, lock = false) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const rows = await tx.$queryRawUnsafe<Row[]>(
    `SELECT id, phone, "phoneHash", status, "expiresAt", "otpHash", "otpExpiresAt", "otpAttempts",
            "lockedAt", "proofHash", "proofExpiresAt"
       FROM "ParentPasswordReset" WHERE "tokenHash" = $1${lock ? " FOR UPDATE" : ""}`,
    hash(token),
  );
  return rows[0] ?? null;
}

/** 이 번호를 쓰는, 로그인 수단이 있는 학부모 계정(탈퇴 제외). 직원 역할은 고르지 않는다. */
async function parentAccountsForPhone(tx: Prisma.TransactionClient | typeof prisma, phone: string) {
  // phoneVerifiedAt·hasStaffGrant 는 간편로그인 전용 계정의 비밀번호 만들기 허용 판정용(socialPasswordCreationAllowed)
  return tx.$queryRawUnsafe<Array<{ id: string; username: string | null; email: string; authUserId: string; phoneVerifiedAt: Date | null; hasStaffGrant: boolean }>>(
    `SELECT id, username, email, "authUserId", "phoneVerifiedAt",
            EXISTS(SELECT 1 FROM "UserRoleGrant" g
                    WHERE g."userId" = "User".id AND g.status = 'ACTIVE' AND g.role::text IN ('INSTRUCTOR','DRIVER')) AS "hasStaffGrant"
       FROM "User"
      WHERE role = 'PARENT' AND "withdrawnAt" IS NULL AND "authUserId" IS NOT NULL
        AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
      ORDER BY "createdAt" ASC
      LIMIT 5`,
    phone,
  );
}

const SOCIAL_LABELS: Record<string, string> = { GOOGLE: "Google", KAKAO: "카카오", NAVER: "네이버", APPLE: "Apple" };

/** Supabase 로그인 계정에 비밀번호 로그인(email identity)이 있는지, 간편로그인은 무엇이 붙었는지 */
export function describeAuthIdentities(identities: Array<{ provider?: string | null }> | null | undefined) {
  const providers = (identities ?? []).map((identity) => String(identity.provider || "").toLowerCase());
  const hasPassword = providers.includes("email");
  const socialLabels = Array.from(new Set(
    providers.map((provider) => oauthProviderMethod(provider)).filter(Boolean).map((method) => SOCIAL_LABELS[method!]),
  ));
  return { hasPassword, socialLabels };
}

async function describeAccounts(rows: Awaited<ReturnType<typeof parentAccountsForPhone>>): Promise<ParentResetAccount[]> {
  const admin = createAdminClient();
  const accounts: ParentResetAccount[] = [];
  for (const row of rows) {
    const { data, error } = await admin.auth.admin.getUserById(row.authUserId);
    if (error || !data.user) continue; // 로그인 계정이 지워진 행은 고를 수 없다
    const { hasPassword, socialLabels } = describeAuthIdentities(data.user.identities);
    // 간편로그인 전용 계정은 비밀번호를 만들면 무엇으로 로그인하게 되는지 미리 보여 준다
    // 인증된 번호가 아니거나 직원 추가 역할이 있으면 만들 수 없다(완료 단계에서 서버가 다시 확인한다)
    const allowed = hasPassword || socialPasswordCreationAllowed({ phoneVerifiedAt: row.phoneVerifiedAt, hasStaffGrant: Boolean(row.hasStaffGrant) });
    const plan = hasPassword || !allowed ? null : planSocialPasswordLogin({ username: row.username, appEmail: row.email, authEmail: data.user.email });
    accounts.push({
      id: row.id,
      loginId: plan?.loginId || row.username || row.email,
      kind: hasPassword ? "PASSWORD" : "SOCIAL",
      canSetPassword: hasPassword || Boolean(plan),
      socialLabels,
    });
  }
  return accounts;
}

/** 번호를 받아 인증번호를 보낸다. requestKey 는 요청 IP(남용 제한용, 해시로만 저장). */
export async function startParentPasswordReset(phoneInput: string, requestKey = "unknown"): Promise<Result<{ token: string }>> {
  const phone = normalizeParentPhone(phoneInput || "");
  if (!/^01[016789]\d{7,8}$/.test(phone)) return { error: "올바른 휴대폰 번호를 입력해 주세요." };
  const token = randomBytes(32).toString("base64url");
  const code = randomInt(100000, 1000000).toString();
  let resetId: string | null = null;
  try {
    const phoneHash = keyed(`phone:${phone}`);
    const requestHash = keyed(`request:${requestKey}`);
    resetId = await prisma.$transaction(async (tx) => {
      // 7일 지난 요청은 지운다(번호 원문을 오래 두지 않는다)
      await tx.$executeRawUnsafe(`DELETE FROM "ParentPasswordReset" WHERE "createdAt" < NOW() - INTERVAL '7 days'`);
      await tx.$executeRawUnsafe(`DELETE FROM "ParentPasswordResetOtpSend" WHERE "createdAt" < NOW() - INTERVAL '7 days'`);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `parent-reset:${phoneHash}`);
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `parent-reset-request:${requestHash}`);

      const quota = await tx.$queryRawUnsafe<Array<{ recent: number; daily: number; hourlyRequest: number; dailyRequest: number; dailyGlobal: number }>>(
        `SELECT
          (SELECT COUNT(*) FROM "ParentPasswordResetOtpSend" WHERE "phoneHash"=$1 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '60 seconds')::int AS recent,
          (SELECT COUNT(*) FROM "ParentPasswordResetOtpSend" WHERE "phoneHash"=$1 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 day')::int AS daily,
          (SELECT COUNT(*) FROM "ParentPasswordResetOtpSend" WHERE "requestHash"=$2 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 hour')::int AS "hourlyRequest",
          (SELECT COUNT(*) FROM "ParentPasswordResetOtpSend" WHERE "requestHash"=$2 AND status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 day')::int AS "dailyRequest",
          (SELECT COUNT(*) FROM "ParentPasswordResetOtpSend" WHERE status IN ('RESERVED','SENT') AND "createdAt">NOW()-INTERVAL '1 day')::int AS "dailyGlobal"`,
        phoneHash, requestHash,
      );
      if (Number(quota[0]?.recent) > 0) throw new ResetUserError("인증번호는 60초 후 다시 요청할 수 있습니다.");
      if (Number(quota[0]?.daily) >= 5) throw new ResetUserError("오늘 인증번호 요청 횟수를 초과했습니다. 내일 다시 시도하거나 학원에 문의해 주세요.");
      // 같은 IP 한도는 회원가입 인증과 같은 값(시간당 40·하루 200, a6). 번호당·전체·오답 잠금은 그대로.
      if (Number(quota[0]?.hourlyRequest) >= SIGNUP_OTP_IP_HOURLY_LIMIT || Number(quota[0]?.dailyRequest) >= SIGNUP_OTP_IP_DAILY_LIMIT) throw new ResetUserError("인증 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
      if (Number(quota[0]?.dailyGlobal) >= 2000) throw new ResetUserError("현재 인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.");

      const accounts = await parentAccountsForPhone(tx, phone);
      if (accounts.length === 0) throw new ResetUserError(NO_PARENT_ACCOUNT_MESSAGE);

      await tx.$executeRawUnsafe(
        `UPDATE "ParentPasswordReset" SET status='CANCELLED', "proofHash"=NULL, "updatedAt"=NOW()
          WHERE "phoneHash"=$1 AND status IN ('PENDING','VERIFIED')`,
        phoneHash,
      );
      const id = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO "ParentPasswordReset"
           (id, "tokenHash", phone, "phoneHash", status, "expiresAt", "otpHash", "otpExpiresAt", "otpSentAt", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,'PENDING',NOW()+INTERVAL '30 minutes',$5,NOW()+INTERVAL '${OTP_TTL_MINUTES} minutes',NOW(),NOW(),NOW())`,
        id, hash(token), phone, phoneHash, keyed(`otp:${hash(token)}:${phone}:${code}`),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ParentPasswordResetOtpSend" (id, "resetId", "phoneHash", "requestHash", status, "createdAt")
         VALUES ($1,$2,$3,$4,'RESERVED',NOW())`,
        randomUUID(), id, phoneHash, requestHash,
      );
      return id;
    });

    const sent = process.env.NODE_ENV === "test"
      || await sendAuthenticationSms(phone, `[스티즈농구교실] 아이디·비밀번호 찾기 인증번호: ${code} (5분 이내 입력)`);
    if (!sent) throw new ResetUserError("인증번호 문자를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
    await prisma.$executeRawUnsafe(`UPDATE "ParentPasswordResetOtpSend" SET status='SENT' WHERE "resetId"=$1 AND status='RESERVED'`, resetId);
    return { ok: true, token };
  } catch (error) {
    if (resetId) {
      const failedId = resetId;
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`UPDATE "ParentPasswordResetOtpSend" SET status='FAILED' WHERE "resetId"=$1 AND status='RESERVED'`, failedId),
        prisma.$executeRawUnsafe(`UPDATE "ParentPasswordReset" SET status='CANCELLED', "otpHash"=NULL, "updatedAt"=NOW() WHERE id=$1`, failedId),
      ]).catch(() => undefined);
    }
    return failure(error, "인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

/** 6자리 확인. 맞으면 일회용 증표와 그 번호의 학부모 계정(아이디) 목록을 돌려준다. */
export async function verifyParentPasswordResetOtp(token: string, codeInput: string): Promise<Result<{ proof: string; accounts: ParentResetAccount[] }>> {
  const code = String(codeInput || "").trim();
  if (!/^\d{6}$/.test(code)) return { error: "6자리 인증번호를 입력해 주세요." };
  try {
    const verified = await prisma.$transaction(async (tx) => {
      const row = await findRow(token, tx, true);
      if (!row || row.status !== "PENDING" || row.expiresAt <= new Date()) throw new ResetUserError("인증 요청이 만료되었습니다. 처음부터 다시 시도해 주세요.");
      if (row.lockedAt && Date.now() - row.lockedAt.getTime() < 15 * 60_000) throw new ResetUserError("인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요.");
      if (!row.otpHash || !row.otpExpiresAt || row.otpExpiresAt <= new Date()) throw new ResetUserError("인증번호 유효시간이 지났습니다. 처음부터 다시 요청해 주세요.");
      if (!equalHex(row.otpHash, keyed(`otp:${hash(token)}:${row.phone}:${code}`))) {
        const attempts = Math.min(row.otpAttempts + 1, MAX_ATTEMPTS);
        await tx.$executeRawUnsafe(
          `UPDATE "ParentPasswordReset" SET "otpAttempts"=$1, "lockedAt"=CASE WHEN $1 >= $2 THEN NOW() ELSE NULL END, "updatedAt"=NOW() WHERE id=$3`,
          attempts, MAX_ATTEMPTS, row.id,
        );
        return { wrong: attempts as number, proof: null, phone: null };
      }
      const proof = randomBytes(32).toString("base64url");
      await tx.$executeRawUnsafe(
        `UPDATE "ParentPasswordReset" SET status='VERIFIED', "verifiedAt"=NOW(), "otpHash"=NULL,
                "proofHash"=$2, "proofExpiresAt"=NOW()+INTERVAL '10 minutes', "updatedAt"=NOW()
          WHERE id=$1`,
        row.id, keyed(`proof:${hash(token)}:${proof}`),
      );
      return { wrong: 0, proof, phone: row.phone };
    });
    // 틀린 번호의 시도 횟수는 위 트랜잭션에서 저장된 뒤에 안내한다(throw 하면 되돌아간다).
    if (!verified.proof || !verified.phone) {
      const left = MAX_ATTEMPTS - verified.wrong;
      return { error: left <= 0 ? "인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요." : `인증번호가 일치하지 않습니다. (${left}회 남음)` };
    }
    const accounts = await describeAccounts(await parentAccountsForPhone(prisma, verified.phone));
    if (accounts.length === 0) return { error: NO_PARENT_ACCOUNT_MESSAGE };
    return { ok: true, proof: verified.proof, accounts };
  } catch (error) {
    return failure(error, "인증을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

/** 인증한 번호의 학부모 계정 하나에 새 비밀번호를 저장한다. 증표는 한 번만 쓸 수 있다. */
export async function completeParentPasswordReset(input: {
  token: string; proof: string; accountId: string; password: string;
}): Promise<Result<{ loginId: string }>> {
  const password = String(input.password || "");
  if (password.length < MIN_PASSWORD_LENGTH) return { error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상 입력해 주세요.` };
  if (password.length > 72) return { error: "비밀번호는 72자 이하로 입력해 주세요." };
  if (!TOKEN_PATTERN.test(input.proof || "")) return { error: "휴대폰 인증이 만료되었습니다. 처음부터 다시 시도해 주세요." };
  let rowId: string | null = null;
  let passwordChanged = false;
  try {
    const target = await prisma.$transaction(async (tx) => {
      const row = await findRow(input.token, tx, true);
      if (!row || row.status !== "VERIFIED" || row.expiresAt <= new Date()) throw new ResetUserError("휴대폰 인증이 만료되었습니다. 처음부터 다시 시도해 주세요.");
      if (!row.proofHash || !row.proofExpiresAt || row.proofExpiresAt <= new Date()
          || !equalHex(row.proofHash, keyed(`proof:${hash(input.token)}:${input.proof}`))) {
        throw new ResetUserError("휴대폰 인증이 만료되었습니다. 처음부터 다시 시도해 주세요.");
      }
      // 고른 계정이 지금도 «인증한 번호의 학부모 계정»인지 다시 확인한다(번호가 바뀌었거나 다른 사람 id 를 넣은 경우 차단).
      const owned = (await parentAccountsForPhone(tx, row.phone)).find((account) => account.id === input.accountId);
      if (!owned) throw new ResetUserError("이 번호로 인증한 계정이 아닙니다. 처음부터 다시 시도해 주세요.");
      const reserved = await tx.$executeRawUnsafe(
        `UPDATE "ParentPasswordReset" SET status='PROCESSING', "targetUserId"=$2, "updatedAt"=NOW()
          WHERE id=$1 AND status='VERIFIED'`,
        row.id, owned.id,
      );
      if (reserved !== 1) throw new ResetUserError("이미 처리 중입니다. 잠시 후 다시 시도해 주세요.");
      rowId = row.id;
      return owned;
    });

    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(target.authUserId);
    if (error || !data.user) throw new Error("AUTH_USER_LOOKUP_FAILED");
    const { hasPassword } = describeAuthIdentities(data.user.identities);
    // 간편로그인 전용 계정: 문자 인증(이 번호) + 그 번호의 계정 확인을 위에서 통과했으므로 비밀번호 로그인을 새로 만든다.
    // 로그인 메일이 없는 계정(아이디 가입 주소 없이 간편로그인만)은 아이디 주소를 로그인 메일로 붙여 아이디로 로그인되게 한다.
    let loginId = target.username || target.email;
    let setAuthEmail: string | null = null;
    if (!hasPassword) {
      // 보안: 화면 판정을 믿지 않고 여기서 다시 본다 — 인증된 번호(phoneVerifiedAt)이고 직원 추가 역할이 없을 때만
      if (!socialPasswordCreationAllowed({ phoneVerifiedAt: target.phoneVerifiedAt, hasStaffGrant: Boolean(target.hasStaffGrant) })) {
        throw new ResetUserError(SOCIAL_PASSWORD_CONTACT_MESSAGE);
      }
      const plan = planSocialPasswordLogin({ username: target.username, appEmail: target.email, authEmail: data.user.email });
      if (!plan) throw new ResetUserError("이 계정은 로그인 아이디가 없어 비밀번호를 만들 수 없어요. 학원에 문의해 주세요.");
      loginId = plan.loginId;
      setAuthEmail = plan.setAuthEmail;
    }
    const updated = await admin.auth.admin.updateUserById(
      target.authUserId,
      setAuthEmail ? { password, email: setAuthEmail, email_confirm: true } : { password },
    );
    if (updated.error) {
      // 너무 쉬운 비밀번호 등 Supabase 비밀번호 규칙 거절만 안내하고, 원문은 내보내지 않는다.
      if (isWeakPasswordRejection(updated.error)
          || (/password/i.test(updated.error.message) && /weak|short|length|character/i.test(updated.error.message))) {
        throw new ResetUserError(PARENT_WEAK_PASSWORD_MESSAGE);
      }
      throw new Error("PASSWORD_UPDATE_FAILED");
    }
    // 여기부터는 비밀번호가 이미 바뀌었다 — 소진 기록이 실패해도 VERIFIED 로 되돌리지 않는다(같은 증표 재사용 방지).
    // 행은 PROCESSING 으로 남아 완료 단계(VERIFIED 만 받음)에 다시 들어올 수 없다.
    passwordChanged = true;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "ParentPasswordReset" SET status='CONSUMED', "consumedAt"=NOW(), "proofHash"=NULL, "proofExpiresAt"=NULL, "updatedAt"=NOW()
          WHERE id=$1 AND status='PROCESSING'`,
        rowId,
      );
    } catch (consumeError) {
      console.error("[parent-password-reset] 소진 기록 실패(비밀번호는 바뀜, 행은 PROCESSING 유지)", consumeError instanceof Error ? consumeError.message.slice(0, 200) : "UNKNOWN");
    }
    return { ok: true, loginId };
  } catch (error) {
    // 비밀번호를 못 바꿨으면 같은 인증으로 다시 시도할 수 있게 VERIFIED 로 되돌린다(증표 유효시간은 그대로).
    // 비밀번호가 이미 바뀐 뒤의 오류라면 되돌리지 않는다.
    if (rowId && !passwordChanged) {
      await prisma.$executeRawUnsafe(
        `UPDATE "ParentPasswordReset" SET status='VERIFIED', "targetUserId"=NULL, "updatedAt"=NOW() WHERE id=$1 AND status='PROCESSING'`,
        rowId,
      ).catch(() => undefined);
    }
    return failure(error, "비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
