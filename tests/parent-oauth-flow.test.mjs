import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const startRoute = readFileSync("src/app/auth/oauth/[provider]/route.ts", "utf8");
const callbackRoute = readFileSync("src/app/auth/callback/route.ts", "utf8");
const helper = readFileSync("src/lib/parent-oauth.ts", "utf8");
const continuePage = readFileSync("src/app/auth/continue/page.tsx", "utf8");
const loginPage = readFileSync("src/app/login/page.tsx", "utf8");

test("parent OAuth only permits the configured providers and internal redirects", () => {
  // 2026-10-25: 배열 전문을 단정하고 있어 provider 를 추가하기만 해도 깨졌다(apple 추가 시).
  // 지켜야 할 것은 "허용 목록이 코드에 못박혀 있고 모르는 값은 거절한다"는 성질이다.
  // 목록의 실제 판정은 tests/apple-signin-readiness.test.mjs 가 모듈을 돌려서 확인한다.
  assert.match(helper, /export const PARENT_OAUTH_PROVIDERS = \[[^\]]+\] as const;/);
  for (const provider of ["google", "kakao", "naver"]) {
    assert.match(helper, new RegExp(`"${provider}"`), `${provider} 가 허용 목록에서 사라졌다`);
  }
  assert.match(helper, /value\.startsWith\("\/\/"\)/);
  assert.match(startRoute, /safeInternalRedirect/);
});

test("Naver OAuth stays closed until the custom provider is configured", () => {
  assert.match(helper, /SUPABASE_NAVER_PROVIDER_ENABLED/);
  assert.match(helper, /custom:naver/);
  // 안내 문구는 모듈이 provider 이름을 넣어 만든다 — 라우트에 네이버 문구를 하드코딩해 두면
  // provider 를 늘릴 때 엉뚱한 이름이 나간다(2026-10-25 apple 추가에서 실제로 드러났다).
  assert.match(helper, /간편가입을 준비 중입니다/);
  assert.match(startRoute, /parentOAuthNotReadyMessage\(provider\)/);
});

test("parent login screen exposes social login without showing it in staff mode", () => {
  assert.match(loginPage, /parentSocialLoginOptions/);
  assert.match(loginPage, /Google로 로그인/);
  assert.match(loginPage, /카카오로 로그인/);
  assert.match(loginPage, /네이버로 로그인/);
  assert.match(loginPage, /socialLoginParams\.set\("intent", "login"\)/);
  // 직원 모드에서는 여전히 숨긴다. 켜진 간편로그인이 하나도 없으면 구역 자체를 숨긴다(2026-10-25).
  assert.match(loginPage, /!isStaffMode && mode === "login" && visibleSocialLoginOptions\.length > 0/);
});

test("OAuth errors return to the flow that started the provider handoff", () => {
  // 모르는 값은 가입 흐름으로(로그인·연결은 이름이 정확할 때만). 2026-10-26 연결(link) 추가로 함수로 뺐다.
  assert.match(startRoute, /function parseIntent\(value: string \| null\): OAuthIntent \{\s*if \(value === "login" \|\| value === "link"\) return value;\s*return "parent-signup";\s*\}/);
  assert.match(startRoute, /const intent = parseIntent\(request\.nextUrl\.searchParams\.get\("intent"\)\)/);
  assert.match(startRoute, /new URL\(intent === "login" \? "\/login" : "\/signup\/parent"/);
  assert.match(startRoute, /callbackUrl\.searchParams\.set\("intent", intent\)/);
  assert.match(callbackRoute, /authFailureRedirect/);
  assert.match(callbackRoute, /new URL\("\/login"/);
});

test("OAuth callback requires application membership and phone verification", () => {
  assert.match(callbackRoute, /exchangeCodeForSession/);
  assert.match(callbackRoute, /"phoneVerifiedAt"/);
  assert.match(callbackRoute, /appUser\?\.role === "PARENT" && \(appUser\.phoneVerifiedAt \|\| appUser\.username === null\)/);
  assert.match(callbackRoute, /"authUserId" = \$1 OR \("authUserId" IS NULL AND id = \$1\)/);
  assert.match(callbackRoute, /\/signup\/parent/);
  assert.doesNotMatch(callbackRoute, /user_metadata/);
});

test("authenticated identities cannot bypass parent phone onboarding", () => {
  assert.match(continuePage, /parseAppRole/);
  assert.match(continuePage, /LOWER\(email\) = LOWER\(\$2\)/);
  assert.match(continuePage, /user\.email \|\| ""/);
  assert.match(continuePage, /role === "PARENT" && rows\[0\]\?\.username !== null && !rows\[0\]\?\.phoneVerifiedAt/);
  assert.match(continuePage, /\/signup\/parent/);
});
