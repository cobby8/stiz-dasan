import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const signupUi = readFileSync("src/components/auth/ParentSignupClient.tsx", "utf8");
const startRoute = readFileSync("src/app/api/auth/parent-signup/start/route.ts", "utf8");
const verifyRoute = readFileSync("src/app/api/auth/parent-signup/verify-otp/route.ts", "utf8");
const completeRoute = readFileSync("src/app/api/auth/parent-signup/complete/route.ts", "utf8");
const verification = readFileSync("src/lib/parent-signup-verification.ts", "utf8");
const authActions = readFileSync("src/app/actions/auth.ts", "utf8");
const oauthCallback = readFileSync("src/app/auth/callback/route.ts", "utf8");
const authContinue = readFileSync("src/app/auth/continue/page.tsx", "utf8");
const authGuard = readFileSync("src/lib/auth-guard.ts", "utf8");
const mypageLayout = readFileSync("src/app/mypage/layout.tsx", "utf8");
const paymentPage = readFileSync("src/app/payments/[invoiceId]/page.tsx", "utf8");
const checkoutRoute = readFileSync("src/app/api/payments/checkout/route.ts", "utf8");
const confirmRoute = readFileSync("src/app/api/payments/toss/confirm/route.ts", "utf8");
const signupMigration = readFileSync(
  "prisma/migrations/20260723110000_add_parent_signup_verification/migration.sql",
  "utf8",
);

test("the first parent signup screen offers password and all requested social methods", () => {
  // 2026-10-25: 링크를 세 줄로 하드코딩하던 것을 표 + 「Supabase 에서 켜진 것만 표시」로 바꿨다
  // (꺼진 버튼을 누르면 Supabase JSON 오류 화면이 떴다). 지켜야 할 것은 그대로 —
  // 요청한 간편가입 방식이 모두 표에 있고, 모두 parent-signup 의도로 시작한다.
  for (const provider of ["google", "kakao", "naver"]) {
    assert.match(signupUi, new RegExp(`provider: "${provider}"`), `${provider} 간편가입이 표에서 사라졌다`);
  }
  assert.match(signupUi, /\/auth\/oauth\/\$\{option\.provider\}\?intent=parent-signup/);
  assert.match(signupUi, /setStep\("phone"\)/);
});

test("signup API exchanges phone, OTP, proof, account data, and explicit consents", () => {
  assert.match(startRoute, /startParentSignup/);
  assert.match(startRoute, /sendParentSignupOtp\(result\.token,\s*requestKey\)/);
  assert.match(startRoute, /challengeToken:\s*result\.token/);

  assert.match(verifyRoute, /body\?\.challengeToken/);
  assert.match(verifyRoute, /body\?\.otp/);
  assert.match(verifyRoute, /verifyParentSignupOtp/);

  for (const field of ["challengeToken", "proof", "username", "name", "consents"]) {
    assert.match(completeRoute, new RegExp(field));
  }
  assert.match(completeRoute, /terms:\s*Boolean/);
  assert.match(completeRoute, /privacy:\s*Boolean/);
  assert.match(completeRoute, /age:\s*Boolean/);
});

test("phone OTP uses keyed hashes and enforces expiry, attempts, resend, and daily limits", () => {
  assert.match(verification, /createHmac\("sha256"/);
  assert.match(verification, /timingSafeEqual/);
  assert.match(verification, /OTP_TTL_MINUTES\s*=\s*5/);
  assert.match(verification, /MAX_ATTEMPTS\s*=\s*5/);
  assert.match(verification, /INTERVAL '60 seconds'/);
  assert.match(verification, />=\s*10/);
  assert.match(verification, /otpExpiresAt\s*<=\s*new Date\(\)/);
  assert.match(verification, /hourlyRequest\)\s*>=\s*5/);
  assert.match(verification, /dailyRequest\)\s*>=\s*20/);
  assert.match(verification, /dailyGlobal\)\s*>=\s*5000/);
  assert.match(verification, /DELETE FROM "ParentSignupVerification"[^`]*INTERVAL '7 days'/s);
  assert.match(signupMigration, /CREATE TABLE IF NOT EXISTS "ParentSignupOtpSend"[\s\S]*?"requestHash" TEXT/);
});

test("concurrent SMS requests are serialized before quota is counted", () => {
  const globalLock = verification.indexOf('"parent-signup-sms-global"');
  const requestLock = verification.indexOf('`parent-signup-sms-request:${requestHash}`');
  const quotaQuery = verification.indexOf('const quota = await tx.$queryRawUnsafe');

  assert.ok(globalLock >= 0, "global SMS quota needs an advisory lock");
  assert.ok(requestLock > globalLock, "request fingerprint quota needs its own advisory lock");
  assert.ok(quotaQuery > requestLock, "both locks must be acquired before quota counting");
});

test("seven-day cleanup deletes unfinished rows but preserves completed consent evidence", () => {
  assert.match(
    verification,
    /DELETE FROM "ParentSignupVerification"[\s\S]*?status <> 'CONSUMED'[\s\S]*?INTERVAL '7 days'/,
  );
  assert.match(
    verification,
    /UPDATE "ParentSignupVerification"[\s\S]*?username=NULL[\s\S]*?phone=''[\s\S]*?status='CONSUMED'[\s\S]*?INTERVAL '7 days'/,
  );
  assert.match(verification, /"termsAgreedAt"=NOW\(\), "termsVersion"=\$5/);
  assert.match(verification, /"privacyAgreedAt"=NOW\(\), "privacyVersion"=\$6/);
  assert.match(verification, /const TERMS_VERSION = "\d{4}-\d{2}-\d{2}"/);
  assert.match(verification, /const PRIVACY_VERSION = "\d{4}-\d{2}-\d{2}"/);
  assert.match(signupMigration, /"termsVersion" TEXT/);
  assert.match(signupMigration, /"privacyVersion" TEXT/);
});

test("application parent membership is created only after verified proof", () => {
  const verifiedGuard = verification.indexOf('current.status !== "VERIFIED"');
  const proofGuard = verification.indexOf("current.proofHash");
  const userInsert = verification.indexOf('INSERT INTO "User"');

  assert.ok(verifiedGuard >= 0, "completion must require VERIFIED status");
  assert.ok(proofGuard > verifiedGuard, "completion must validate the one-time proof");
  assert.ok(userInsert > proofGuard, "User insertion must occur after verification checks");
  assert.match(verification, /"phoneVerifiedAt"[^\n]*NOW\(\)/);
  assert.match(verification, /status='CONSUMED'/);
});

test("username login is added without removing staff email login", () => {
  assert.match(authActions, /formData\.get\("email"\)\s*\|\|\s*formData\.get\("username"\)/);
  assert.match(authActions, /loginContext\s*!==\s*"staff"\s*&&\s*!identifier\.includes\("@"\)/);
  assert.match(authActions, /LOWER\(username\).*role = 'PARENT'/s);
  assert.match(authActions, /signInWithPassword\(\{\s*email:\s*authEmail/s);
});

test("an OAuth session cannot bypass phone-verified application membership", () => {
  assert.match(oauthCallback, /appUser\?\.role === "PARENT" && \(appUser\.phoneVerifiedAt \|\| appUser\.username === null\)/);
  assert.match(oauthCallback, /\/signup\/parent/);
  assert.doesNotMatch(oauthCallback, /user_metadata/);

  assert.match(authContinue, /!role \|\| \(role === "PARENT" && rows\[0\]\?\.username !== null && !rows\[0\]\?\.phoneVerifiedAt\)/);
  assert.match(authContinue, /redirect\(`\/signup\/parent/);
});

test("OAuth completion binds the same provider and rejects an existing account collision", () => {
  assert.match(verification, /actualMethod !== current\.signupMethod/);
  assert.match(verification, /"authUserId" = \$1 OR id = \$1/);
  assert.match(verification, /LOWER\(email\) = LOWER\(\$2\)/);
});

test("the shared verified-parent guard protects mypage and payment entry points", () => {
  assert.match(authGuard, /export async function requireVerifiedParent/);
  assert.match(authGuard, /"authUserId" = \$1 OR \("authUserId" IS NULL AND id = \$1\)/);
  // 레거시로 직접 연결된 학부모(username 없음)는 휴대폰 인증 없이 통과해야 한다.
  // (가드가 appUser 없음을 먼저 걸러내도록 바뀌어 옵셔널 체이닝은 선택 사항이다)
  assert.match(authGuard, /appUser\??\.?username === null/);
  for (const consumer of [mypageLayout, paymentPage, checkoutRoute, confirmRoute]) {
    assert.match(consumer, /requireVerifiedParent/);
  }
});

test("consent values come from the checked form controls", () => {
  for (const consent of ["terms", "privacy", "age"]) {
    assert.match(signupUi, new RegExp(`name=["']${consent}["']`));
    assert.match(signupUi, new RegExp(`form\\.get\\(["']${consent}["']\\) === ["']on["']`));
  }
});
