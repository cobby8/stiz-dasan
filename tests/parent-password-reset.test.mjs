// 학부모 아이디·비밀번호 찾기(2026-11-13) — 학부모 아이디는 `아이디@member.stiz.kr`(받을 수 없는 주소)라
// 메일 재설정이 닿지 않는다. 가입 휴대폰 문자 인증으로 본인을 확인하고 비밀번호만 새로 정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const LIB = "src/lib/parent-password-reset.ts";
const MIGRATION = "prisma/migrations/20261113100000_parent_password_reset/migration.sql";

function slice(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `${start} 없음`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  return src.slice(a, b < 0 ? src.length : b);
}

test("대상은 이 번호의 로그인 가능한 학부모 계정뿐 — 직원·탈퇴·빈 보호자 계정은 고르지 않는다", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = slice(src, "async function parentAccountsForPhone", "const SOCIAL_LABELS");
  assert.match(fn, /role = 'PARENT'/);
  assert.match(fn, /"withdrawnAt" IS NULL/);
  assert.match(fn, /"authUserId" IS NOT NULL/, "가져오기로 만든 빈 계정(로그인 수단 없음)은 활성화 흐름으로 보낸다");
  assert.match(fn, /regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\) = \$1/);
});

test("시작: 남용 제한(번호 60초·하루 5회, IP 시간당 5회) 뒤에만 문자를 보내고, 로그인 수단 없는 번호는 같은 문구로 답한다", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = slice(src, "export async function startParentPasswordReset", "export async function verifyParentPasswordResetOtp");
  assert.match(fn, /INTERVAL '60 seconds'/);
  assert.match(fn, /daily\) >= 5/);
  // 같은 IP 한도는 회원가입 인증과 같은 상수(시간당 40·하루 200, 2026-11-13 a6)
  assert.match(fn, /hourlyRequest\) >= SIGNUP_OTP_IP_HOURLY_LIMIT/);
  assert.match(fn, /dailyRequest\) >= SIGNUP_OTP_IP_DAILY_LIMIT/);
  assert.match(fn, /NO_PARENT_ACCOUNT_MESSAGE/);
  assert.ok(fn.indexOf("quota") < fn.indexOf("sendAuthenticationSms"), "한도 확인이 발송보다 먼저");
  assert.match(fn, /status='CANCELLED'/, "같은 번호의 이전 요청은 닫는다");
  assert.match(fn, /keyed\(`otp:\$\{hash\(token\)\}:\$\{phone\}:\$\{code\}`\)/, "인증번호 원문은 저장하지 않는다");
  const route = await readFile("src/app/api/auth/parent-password-reset/start/route.ts", "utf8");
  assert.match(route, /x-vercel-forwarded-for/, "요청 IP로 남용을 제한한다");
});

test("확인: 5회 틀리면 15분 잠금, 맞으면 10분짜리 일회용 증표와 아이디 목록", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = slice(src, "export async function verifyParentPasswordResetOtp", "export async function completeParentPasswordReset");
  assert.match(fn, /const MAX_ATTEMPTS|MAX_ATTEMPTS/);
  assert.match(fn, /"lockedAt"=CASE WHEN \$1 >= \$2 THEN NOW\(\)/);
  assert.match(fn, /15 \* 60_000/);
  assert.match(fn, /"proofExpiresAt"=NOW\(\)\+INTERVAL '10 minutes'/);
  assert.match(fn, /timingSafeEqual|equalHex/);
  // 틀린 시도 횟수는 throw 로 되돌리지 않는다 — 값으로 돌려준 뒤 저장된 상태로 안내
  assert.doesNotMatch(slice(fn, "if (!equalHex(row.otpHash", "const proof ="), /throw/);
});

test("완료: 증표 확인 → 고른 계정이 그 번호의 학부모인지 재확인 → 1회 사용 예약 → 비밀번호 변경", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = slice(src, "export async function completeParentPasswordReset");
  assert.match(fn, /status !== "VERIFIED"/);
  assert.match(fn, /equalHex\(row\.proofHash, keyed\(`proof:/);
  assert.match(fn, /parentAccountsForPhone\(tx, row\.phone\)\)\.find\(\(account\) => account\.id === input\.accountId\)/);
  assert.match(fn, /status='PROCESSING'[\s\S]*WHERE id=\$1 AND status='VERIFIED'/, "같은 증표로 두 번 바꾸지 못한다");
  assert.ok(fn.indexOf("status='PROCESSING'") < fn.indexOf("updateUserById"));
  // 간편로그인 전용 계정은 로그인 메일이 없으면 아이디 주소를 함께 붙인다(planSocialPasswordLogin)
  assert.match(fn, /updateUserById\(\s*target\.authUserId,\s*setAuthEmail \? \{ password, email: setAuthEmail, email_confirm: true \} : \{ password \},?\s*\)/);
  assert.match(fn, /status='CONSUMED'/);
  // 간편로그인 전용 계정도 비밀번호를 만든다(2026-11-13 a1) — 단 무엇으로 로그인하는지 정해지는 계정만
  assert.match(fn, /if \(!hasPassword\) \{\s*const plan = planSocialPasswordLogin\(/);
  assert.match(fn, /if \(!plan\) throw new ResetUserError\(/);
  assert.ok(fn.indexOf("parentAccountsForPhone(tx, row.phone)") < fn.indexOf("planSocialPasswordLogin"), "문자 인증·번호의 계정 확인을 통과한 뒤에만");
  assert.doesNotMatch(fn, /createUser|INSERT INTO "User"/);
});

test("거절 사유는 값으로 돌려준다(운영 빌드의 throw 문구 가림 방지)", async () => {
  const src = await readFile(LIB, "utf8");
  assert.match(src, /class ResetUserError extends Error/);
  assert.match(src, /if \(error instanceof ResetUserError\) return \{ error: error\.message \}/);
  assert.doesNotMatch(src, /^"use server"/m, "라우트 처리기가 부르는 서버 전용 모듈");
  for (const step of ["start", "verify-otp", "complete"]) {
    const route = await readFile(`src/app/api/auth/parent-password-reset/${step}/route.ts`, "utf8");
    assert.match(route, /NextResponse\.json\(/);
  }
});

test("간편로그인 판정: email identity 가 있어야 비밀번호 계정", async () => {
  const src = await readFile(LIB, "utf8");
  const fn = slice(src, "export function describeAuthIdentities", "async function describeAccounts");
  assert.match(fn, /providers\.includes\("email"\)/);
  assert.match(fn, /oauthProviderMethod\(provider\)/);
});

test("화면: 로그인 화면에 찾기 링크, 찾기 화면은 공개 경로", async () => {
  const login = await readFile("src/app/login/page.tsx", "utf8");
  assert.match(login, /href="\/login\/forgot"/);
  const proxy = await readFile("src/proxy.ts", "utf8");
  assert.doesNotMatch(proxy, /"\/login\/:path\*"/, "/login/forgot 은 로그인 없이 열려야 한다");
  const client = await readFile("src/components/auth/ParentPasswordResetClient.tsx", "utf8");
  for (const step of ["start", "verify-otp", "complete"]) assert.match(client, new RegExp(`/api/auth/parent-password-reset/${step}`));
  const signup = await readFile("src/components/auth/ParentSignupClient.tsx", "utf8");
  assert.match(signup, /registeredPhone && \(/, "이미 가입된 번호면 찾기 버튼");
});

test("마이그레이션: 두 테이블, 상태 제한, 공개 API 차단", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "ParentPasswordReset"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "ParentPasswordResetOtpSend"/);
  assert.match(sql, /CHECK \("status" IN \('PENDING', 'VERIFIED', 'PROCESSING', 'CONSUMED', 'CANCELLED'\)\)/);
  assert.match(sql, /"tokenHash" text NOT NULL UNIQUE/);
  assert.match(sql, /REVOKE ALL ON TABLE "ParentPasswordReset" FROM anon, authenticated/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  const schema = await readFile("prisma/schema.prisma", "utf8");
  assert.match(schema, /model ParentPasswordReset \{/);
  assert.match(schema, /model ParentPasswordResetOtpSend \{/);
});
