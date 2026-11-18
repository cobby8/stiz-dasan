/**
 * 로그인하지 않은 사람의 본인인증(포트원) 시작·확인 (2026-11-18 원장 결정 «가입·본인인증 통일» 4단계).
 *
 * ■ 왜 따로 두는가
 *   간편가입의 본인인증은 «로그인된 간편로그인 사용자 표식»을 건 번호에 넣어 남의 인증 건을 못 쓰게 했다
 *   (social-link.ts createLinkVerificationId). 아이디 가입·기존 계정 활성화·아이디/비밀번호 찾기는 로그인 전이라
 *   그 표식이 없다. 대신 «이 브라우저»에만 있는 1회용 비밀값(nonce, httpOnly 쿠키 10분)으로 표식을 만든다:
 *     - 건 번호 = stizanon_<HMAC(목적·nonce) 앞 20자>_<무작위 12자>
 *     - 확인 때 쿠키의 nonce 로 표식을 다시 계산해 맞아야만 포트원에 다시 묻는다 → 남이 끝낸 건 번호를 가져와도 통과 못 함
 *     - 서버 장부(IdentityVerificationStart)의 그 줄을 «한 번만» 소진한다 → 같은 쿠키·건 번호 재사용 차단
 *     - 장부 줄은 10분 안에만 소진된다 → 오래된 건 번호로 다시 들어오지 못함
 *   본인인증은 건당 비용이 들어 시작 때 같은 IP 한도·전체 하루 한도를 센다.
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db·포트원 조회를 인자로 받아 `node --test` 에서 가짜로 실행 검증한다.
 *   (실행 테스트: tests/anonymous-identity.test.mjs)
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isFreshVerification } from "@/lib/account/social-link";
import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import { cleanVerifiedName, identityVerifiedAtOf } from "./verified-identity";
import { isOwnIdentityVerification, type PortoneLookupResult } from "./portone";
import { SMS_FALLBACK_HINT } from "./sms-fallback-label";

/** 무엇을 하려고 시작한 본인인증인가 — 목적이 다르면 표식도 달라 서로 섞어 쓸 수 없다. DB CHECK 와 같은 목록. */
export const ANON_IDENTITY_PURPOSES = ["SIGNUP", "RESET"] as const;
export type AnonIdentityPurpose = (typeof ANON_IDENTITY_PURPOSES)[number];

/** nonce 쿠키·장부 줄의 유효 시간(초) — 포트원 결과 신선도(10분)와 같다 */
export const ANON_IDENTITY_TTL_SECONDS = 10 * 60;
/** 같은 IP 한도 — 학원·아파트 공용 와이파이를 생각해 넉넉히, 그래도 건당 비용이라 문자 인증(시간당 100)보다 낮게 */
export const ANON_IDENTITY_IP_HOURLY_LIMIT = 30;
export const ANON_IDENTITY_IP_DAILY_LIMIT = 100;
/** 전체 하루 한도 — 비정상 폭주 때 비용이 끝없이 늘지 않게. «소진된 줄»(실제로 인증을 마친 건)으로 센다(검수 권장) —
 *  시작 요청만 되풀이해 한도를 채워 다른 사람을 막는 일을 막는다. IP 한도는 시작 기준 그대로. */
export const ANON_IDENTITY_GLOBAL_DAILY_LIMIT = 1500;

/** 쿠키는 /api/auth 아래(가입·찾기 확인 API)에서만 보낸다 */
export const ANON_IDENTITY_COOKIE_PATH = "/api/auth";
export function anonIdentityCookieName(purpose: AnonIdentityPurpose): string {
  return purpose === "SIGNUP" ? "stiz_idv_signup" : "stiz_idv_reset";
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^stizanon_([0-9a-f]{20})_[A-Za-z0-9_-]{12}$/;

function anonSecret(): string {
  const value = process.env.PARENT_SIGNUP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("ANON_IDENTITY_SECRET_MISSING");
  return "development-only-anon-identity-secret";
}

function hmacHex(value: string): string {
  return createHmac("sha256", anonSecret()).update(value).digest("hex");
}

function nonceTag(purpose: AnonIdentityPurpose, nonce: string): string {
  return hmacHex(`anon-identity:${purpose}:${nonce}`).slice(0, 20);
}

/** 건 번호 만들기 — 표식은 이 브라우저의 nonce 와 목적으로만 만들 수 있다 */
export function createAnonIdentityVerificationId(purpose: AnonIdentityPurpose, nonce: string): string {
  return `stizanon_${nonceTag(purpose, nonce)}_${randomBytes(9).toString("base64url")}`;
}

/** 건 번호의 표식이 이 nonce·목적의 것인가(시간 차 공격 없게 timingSafeEqual) */
export function isAnonIdentityVerificationIdFor(identityVerificationId: string, purpose: AnonIdentityPurpose, nonce: string): boolean {
  if (!NONCE_PATTERN.test(nonce || "")) return false;
  const match = ID_PATTERN.exec(identityVerificationId || "");
  if (!match) return false;
  const expected = Buffer.from(nonceTag(purpose, nonce));
  const actual = Buffer.from(match[1]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

type Db = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

export type AnonIdentityFailure = { ok: false; status: number; error: string };

export const ANON_IDENTITY_TOO_MANY_MESSAGE = `본인인증 요청이 너무 많아요. 잠시 후 다시 시도하거나 ${SMS_FALLBACK_HINT}`;
export const ANON_IDENTITY_BUSY_MESSAGE = `지금 본인인증 요청이 많아요. 잠시 후 다시 시도하거나 ${SMS_FALLBACK_HINT}`;
export const ANON_IDENTITY_MISMATCH_MESSAGE = "본인인증 정보를 확인하지 못했어요. 처음부터 다시 시도해 주세요.";
export const ANON_IDENTITY_USED_MESSAGE = "이미 사용했거나 시간이 지난 본인인증이에요. 처음부터 다시 인증해 주세요.";

/**
 * 시작 — IP 한도를 센 뒤 nonce·건 번호를 만들고 장부에 한 줄 적는다.
 * 부르는 쪽이 거래(tx) 안에서 부르면 같은 IP 의 동시 요청이 한 줄씩 차례로 센다(advisory lock).
 * requestKey = 요청 IP(원문은 저장하지 않고 HMAC 만).
 */
export async function startAnonIdentity(
  db: Db,
  input: { purpose: AnonIdentityPurpose; requestKey: string },
): Promise<{ ok: true; identityVerificationId: string; nonce: string } | AnonIdentityFailure> {
  if (!ANON_IDENTITY_PURPOSES.includes(input.purpose)) return { ok: false, status: 400, error: "요청 방법을 확인해 주세요." };
  const requestHash = hmacHex(`anon-identity-request:${input.requestKey || "unknown"}`);
  // 오래된 장부 줄 정리(7일) — 따로 도는 정리 작업 없이 시작할 때마다 조금씩
  await db.$executeRawUnsafe(`DELETE FROM "IdentityVerificationStart" WHERE "createdAt" < NOW() - INTERVAL '7 days'`);
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `anon-identity-request:${requestHash}`);
  const quota = await db.$queryRawUnsafe<Array<{ hourly: number; daily: number; globalDaily: number }>>(
    `SELECT
       (SELECT COUNT(*) FROM "IdentityVerificationStart" WHERE "requestHash" = $1 AND "createdAt" > NOW() - INTERVAL '1 hour')::int AS hourly,
       (SELECT COUNT(*) FROM "IdentityVerificationStart" WHERE "requestHash" = $1 AND "createdAt" > NOW() - INTERVAL '1 day')::int AS daily,
       (SELECT COUNT(*) FROM "IdentityVerificationStart" WHERE "consumedAt" > NOW() - INTERVAL '1 day')::int AS "globalDaily"`,
    requestHash,
  );
  const row = quota[0];
  if (Number(row?.hourly) >= ANON_IDENTITY_IP_HOURLY_LIMIT || Number(row?.daily) >= ANON_IDENTITY_IP_DAILY_LIMIT) {
    return { ok: false, status: 429, error: ANON_IDENTITY_TOO_MANY_MESSAGE };
  }
  if (Number(row?.globalDaily) >= ANON_IDENTITY_GLOBAL_DAILY_LIMIT) return { ok: false, status: 429, error: ANON_IDENTITY_BUSY_MESSAGE };

  const nonce = randomBytes(32).toString("base64url");
  const identityVerificationId = createAnonIdentityVerificationId(input.purpose, nonce);
  await db.$executeRawUnsafe(
    `INSERT INTO "IdentityVerificationStart" (id, purpose, "requestHash", "createdAt") VALUES ($1, $2, $3, NOW())`,
    identityVerificationId, input.purpose, requestHash,
  );
  return { ok: true, identityVerificationId, nonce };
}

export type AnonIdentityConfirmed = { ok: true; phone: string; verifiedName: string; verifiedAt: Date };

/**
 * 확인 — 순서가 중요하다:
 *  1. 쿠키 nonce 로 건 번호 표식 대조(포트원에 묻기 전에 — 위조 번호로 외부 조회를 일으키지 않게)
 *  2. 포트원 재조회: VERIFIED · 10분 안
 *  3. 명의 번호·실명이 온전한지
 *  4. 장부 줄을 «한 번만» 소진(10분 안·같은 목적·아직 안 씀). 동시에 두 번 들어와도 하나만 통과한다
 * 포트원 조회가 잠깐 실패하면(502) 소진하지 않는다 — 같은 인증으로 다시 시도할 수 있게.
 */
export async function confirmAnonIdentity(
  db: Db,
  input: {
    purpose: AnonIdentityPurpose;
    identityVerificationId: string;
    nonce: string;
    lookup: (identityVerificationId: string) => Promise<PortoneLookupResult | null>;
    now?: number;
  },
): Promise<AnonIdentityConfirmed | AnonIdentityFailure> {
  if (!isAnonIdentityVerificationIdFor(input.identityVerificationId, input.purpose, input.nonce)) {
    return { ok: false, status: 400, error: ANON_IDENTITY_MISMATCH_MESSAGE };
  }
  const lookup = await input.lookup(input.identityVerificationId).catch(() => null);
  if (!lookup || !lookup.ok) return { ok: false, status: 502, error: "본인인증 결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
  const verification = lookup.data;
  // 우리가 물은 그 건 + 우리 본인인증 채널 결과만(포트원 스토어를 MyBDR 과 공유 — 보안 검수 HIGH-1)
  if (!isOwnIdentityVerification(verification, input.identityVerificationId)) {
    return { ok: false, status: 400, error: "본인인증 정보를 확인하지 못했어요. 처음부터 다시 시도해 주세요." };
  }
  const verifiedAtText = verification.verifiedAt ?? verification.statusChangedAt;
  if (verification.status !== "VERIFIED" || !isFreshVerification(verifiedAtText, input.now)) {
    return { ok: false, status: 400, error: "본인인증이 완료되지 않았거나 시간이 지났어요. 다시 인증해 주세요." };
  }
  const phone = parentPhoneDigits(verification.verifiedCustomer?.phoneNumber);
  if (!isUsablePhoneKey(phone) || !/^01[016789]\d{7,8}$/.test(phone)) {
    return { ok: false, status: 400, error: "본인인증 휴대폰 번호를 확인하지 못했어요. 학원에 문의해 주세요." };
  }
  const verifiedName = cleanVerifiedName(verification.verifiedCustomer?.name);
  if (!verifiedName) return { ok: false, status: 400, error: "본인인증 이름을 확인하지 못했어요. 다시 인증해 주세요." };

  const consumed = await db.$executeRawUnsafe(
    `UPDATE "IdentityVerificationStart" SET "consumedAt" = NOW()
      WHERE id = $1 AND purpose = $2 AND "consumedAt" IS NULL
        AND "createdAt" > NOW() - INTERVAL '${ANON_IDENTITY_TTL_SECONDS} seconds'`,
    input.identityVerificationId, input.purpose,
  );
  if (Number(consumed) !== 1) return { ok: false, status: 409, error: ANON_IDENTITY_USED_MESSAGE };
  return { ok: true, phone, verifiedName, verifiedAt: identityVerifiedAtOf(verification) };
}

/** 요청 IP — 가입 문자 인증(start 라우트)과 같은 순서로 읽는다 */
export function anonIdentityRequestKey(headers: Headers): string {
  const forwarded = headers.get("x-vercel-forwarded-for") || headers.get("x-forwarded-for") || headers.get("x-real-ip") || "unknown";
  return forwarded.split(",")[0]?.trim().slice(0, 100) || "unknown";
}
