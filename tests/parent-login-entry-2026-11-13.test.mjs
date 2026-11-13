// 가입·로그인 입구 출시 전 수정(2026-11-13 원장 승인 a1~a7·B9·b3).
// 순수 규칙(비밀번호 사전 경고·약한 비밀번호 판정·간편로그인 계정의 로그인 아이디·직원 번호 로그인·동의)은
// 실제로 실행하고, 화면·서버 연결부는 소스 모양으로 못박는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/parent-password-rules.ts");
const staffId = await loadTsModule("src/lib/staff-login-id.ts");
const consent = await loadTsModule("src/lib/parent-consent.ts");
const read = (path) => readFile(path, "utf8");

// ── a2 약한 비밀번호 ─────────────────────────────────────────────────────────
test("a2 사전 경고: 같은 숫자 반복·연속 숫자·qwer 류·전화번호는 막고, 섞인 비밀번호는 통과", () => {
  for (const weak of ["11111111", "12345678", "87654321", "qwer1234", "qwerty12", "1q2w3e4r", "password1", "abcdefgh"]) {
    assert.ok(rules.parentPasswordWarning(weak), `${weak} 는 경고해야 한다`);
  }
  assert.ok(rules.parentPasswordWarning("kim01012345678", { phone: "01012345678" }), "자기 전화번호가 들어간 비밀번호");
  for (const ok of ["bluefox83river", "Hoop-Dasan-7", "stizMom2026!"]) {
    assert.equal(rules.parentPasswordWarning(ok), null, `${ok} 는 통과해야 한다`);
  }
  // 최소 길이 전에는 길이 안내가 먼저 — 경고하지 않는다
  assert.equal(rules.parentPasswordWarning("1111"), null);
  assert.equal(rules.parentPasswordWarning("aaaaaaaa", { minLength: 10 }), null, "활성화(10자)에서는 10자 전까지 경고 없음");
  assert.ok(rules.parentPasswordWarning("aaaaaaaaaa", { minLength: 10 }));
});

test("a2 서버 판정: Supabase 약한 비밀번호 거절만 «더 길거나 복잡한 비밀번호» 문장으로", () => {
  const WEAK = { name: "AuthWeakPasswordError", status: 422, code: "weak_password", message: "Password is known to be weak and easy to guess, please choose a different one." };
  assert.equal(rules.isWeakPasswordRejection(WEAK), true);
  assert.equal(rules.isWeakPasswordRejection({ message: "Password should be weak?? pwned" }), true, "상태값 없이 문구만 와도");
  assert.equal(rules.isWeakPasswordRejection({ status: 422, code: "email_exists", message: "already registered" }), false);
  assert.equal(rules.isWeakPasswordRejection({ status: 500, message: "server error" }), false);
  assert.equal(rules.isWeakPasswordRejection(null), false);
  assert.match(rules.PARENT_WEAK_PASSWORD_MESSAGE, /더 길거나 복잡한 비밀번호로 정해 주세요/);
});

test("a2 연결부: 가입·활성화·마이페이지·비밀번호 찾기 4곳이 같은 판정과 문장을 쓴다", async () => {
  const signup = await read("src/lib/parent-signup-verification.ts");
  assert.match(signup, /if \(created\.error && isWeakPasswordRejection\(created\.error\)\) throw new Error\(PARENT_WEAK_PASSWORD_MESSAGE\)/);
  const claim = await read("src/lib/parent-account-claim.ts");
  assert.match(claim, /else if \(isWeakPasswordRejection\(created\.error\)\) \{[\s\S]*?throw new Error\(PARENT_WEAK_PASSWORD_MESSAGE\)/);
  const settings = await read("src/app/actions/parent-settings.ts");
  assert.match(settings, /if \(isWeakPasswordRejection\(updated\.error\)\) return \{ ok: false, error: PARENT_WEAK_PASSWORD_MESSAGE \}/);
  const reset = await read("src/lib/parent-password-reset.ts");
  assert.match(reset, /throw new ResetUserError\(PARENT_WEAK_PASSWORD_MESSAGE\)/);
  // 가입·활성화는 오류를 userFacingError 로 거른다 — 허용 목록에 같은 문장이 있어야 화면에 보인다
  const allowed = await read("src/lib/user-facing-error.ts");
  assert.ok(allowed.includes(`"${rules.PARENT_WEAK_PASSWORD_MESSAGE}"`), "user-facing-error 허용 목록에 약한 비밀번호 문장");
  // 입력 화면 3곳이 사전 경고를 쓰고, 경고가 있으면 보내지 않는다
  for (const file of ["src/components/auth/ParentSignupClient.tsx", "src/app/account/activate/ParentAccountActivateClient.tsx", "src/components/auth/ParentPasswordResetClient.tsx"]) {
    const ui = await read(file);
    assert.match(ui, /parentPasswordWarning\(/, `${file} 사전 경고`);
    assert.match(ui, /if \((?:!socialSignup && )?weakWarning\) \{/, `${file} 경고 시 제출 막기`);
  }
});

// ── a1 간편로그인 전용 계정 비밀번호 만들기 ─────────────────────────────────
test("a1 간편로그인 계정이 비밀번호를 만들면 무엇으로 로그인하는지", () => {
  const plan = rules.planSocialPasswordLogin;
  // 아이디가 있고 앱 메일 = 로그인 메일 → 아이디로 로그인(로그인 화면이 아이디 → User.email 로 찾는다)
  assert.deepEqual(plan({ username: "kimmom", appEmail: "Kim@Kakao.com", authEmail: "kim@kakao.com" }), { loginId: "kimmom", setAuthEmail: null });
  // 앱 메일과 로그인 메일이 다르면 아이디로는 안 된다 → 로그인 메일(기존 이메일)
  assert.deepEqual(plan({ username: "kimmom", appEmail: "kimmom@member.stiz.kr", authEmail: "kim@kakao.com" }), { loginId: "kim@kakao.com", setAuthEmail: null });
  // 아이디 없이 간편로그인만(빈 계정에 연결된 경우) → 기존 이메일
  assert.deepEqual(plan({ username: null, appEmail: "kim@gmail.com", authEmail: "kim@gmail.com" }), { loginId: "kim@gmail.com", setAuthEmail: null });
  // 로그인 메일이 없는 간편로그인(카카오 메일 미동의) + 아이디 주소 → 그 주소를 로그인 메일로 붙인다
  assert.deepEqual(plan({ username: "kimmom", appEmail: "kimmom@member.stiz.kr", authEmail: "" }), { loginId: "kimmom", setAuthEmail: "kimmom@member.stiz.kr" });
  // 아이디도 로그인 메일도 없으면 만들 수 없다(학원 문의)
  assert.equal(plan({ username: null, appEmail: "parent_1@stiz.local", authEmail: null }), null);
  assert.equal(plan({ username: "kimmom", appEmail: "other@x.com", authEmail: "" }), null);
});

test("a1 비밀번호 찾기: 문자 인증 + 그 번호의 계정일 때만, 간편로그인 계정도 비밀번호를 만든다", async () => {
  const src = await read("src/lib/parent-password-reset.ts");
  const fn = src.slice(src.indexOf("export async function completeParentPasswordReset"));
  assert.ok(fn.indexOf('row.status !== "VERIFIED"') < fn.indexOf("planSocialPasswordLogin"));
  assert.ok(fn.indexOf("equalHex(row.proofHash") < fn.indexOf("planSocialPasswordLogin"));
  assert.ok(fn.indexOf("account.id === input.accountId") < fn.indexOf("planSocialPasswordLogin"));
  assert.doesNotMatch(fn, /비밀번호가 없어요\. 로그인 화면의/, "예전 «간편로그인 버튼으로» 되돌려 보내기는 없다");
  assert.match(fn, /return \{ ok: true, loginId \}/, "만든 뒤 무엇으로 로그인하는지 알려 준다");
  const ui = await read("src/components/auth/ParentPasswordResetClient.tsx");
  assert.match(ui, /account\.kind === "PASSWORD" \|\| account\.canSetPassword/);
});

// ── a1 스토어 앱에서 간편로그인 숨김 ───────────────────────────────────────
test("a1 스토어 앱: 로그인·가입·연결 화면 모두 브라우저로 확인된 때만 간편로그인을 그린다", async () => {
  const hook = await read("src/hooks/useStoreApp.ts");
  assert.match(hook, /useSyncExternalStore<boolean \| null>\(subscribe, isStoreApp, \(\) => null\)/, "서버 그림·첫 하이드레이션은 null(불일치 없음)");
  assert.match(hook, /앱에서는 아이디·비밀번호로 로그인해 주세요\./);
  const login = await read("src/app/login/page.tsx");
  // 2026-11-13 a1 운영 전환: 스토어 앱은 앱 간편로그인이 켜졌을 때만 버튼(앱 전용 링크), 아니면 안내 + 비밀번호 만들기
  assert.match(login, /storeApp === true && appSocialLogin === "password-only" && \(\s*<div[^>]*>\s*<p>\{STORE_APP_PASSWORD_LOGIN_NOTICE\}/);
  assert.match(login, /storeApp === true && appSocialLogin === "buttons"/);
  assert.match(login, /storeApp === false && visibleSocialLoginOptions\.length > 0/);
  const signup = await read("src/components/auth/ParentSignupClient.tsx");
  assert.match(signup, /storeApp === false && visibleSignupOptions\.length > 0/);
  assert.match(signup, /\{STORE_APP_PASSWORD_LOGIN_NOTICE\}/);
  const linkButton = await read("src/app/mypage/login-methods/LinkProviderButton.tsx");
  assert.match(linkButton, /if \(storeApp !== false\) return null;/);
  const page = await read("src/app/mypage/login-methods/page.tsx");
  assert.match(page, /<LinkProviderButton provider=\{provider\} \/>/);
  assert.match(page, /<StoreAppLinkNotice \/>/);
});

// ── a3 활성화 약관 동의 · a4 번호 인증 시각 ──────────────────────────────────
test("a3 동의 판정: 세 가지 모두 있어야 한다", () => {
  assert.equal(consent.hasAllParentConsents({ terms: true, privacy: true, age: true }), true);
  assert.equal(consent.hasAllParentConsents({ terms: true, privacy: true }), false);
  assert.equal(consent.hasAllParentConsents(null), false);
  assert.equal(consent.hasAllParentConsents(undefined), false);
});

test("a3 활성화: 동의 없으면 서버가 거절하고, 처리 시작과 함께 시각·버전을 가입과 같은 칸에 기록", async () => {
  const claim = await read("src/lib/parent-account-claim.ts");
  const fn = claim.slice(claim.indexOf("export async function consumeParentAccountClaim"));
  assert.ok(fn.indexOf("if (!hasAllParentConsents(consents)) return { error: PARENT_CONSENT_REQUIRED_MESSAGE }") >= 0);
  assert.ok(fn.indexOf("hasAllParentConsents") < fn.indexOf("createUser"), "동의 확인이 계정 만들기보다 먼저");
  assert.match(fn, /"termsAgreedAt" = NOW\(\), "termsVersion" = \$3,\s*"privacyAgreedAt" = NOW\(\), "privacyVersion" = \$4, "ageConfirmedAt" = NOW\(\)/);
  assert.match(fn, /PARENT_TERMS_VERSION,\s*PARENT_PRIVACY_VERSION,/);
  const action = await read("src/app/actions/parent-account.ts");
  assert.match(action, /terms: consents\?\.terms === true,\s*privacy: consents\?\.privacy === true,\s*age: consents\?\.age === true,/);
  const migration = await read("prisma/migrations/20261113120000_parent_account_claim_consents/migration.sql");
  for (const column of ['"termsAgreedAt" TIMESTAMPTZ', '"termsVersion" TEXT', '"privacyAgreedAt" TIMESTAMPTZ', '"privacyVersion" TEXT', '"ageConfirmedAt" TIMESTAMPTZ']) {
    assert.ok(migration.includes(`ADD COLUMN IF NOT EXISTS ${column}`), column);
  }
  const schema = await read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model ParentAccountClaim {"), schema.indexOf("model ParentAccountClaimOtpSend"));
  for (const column of ["termsAgreedAt", "termsVersion", "privacyAgreedAt", "privacyVersion", "ageConfirmedAt"]) assert.match(model, new RegExp(`\\b${column}\\b`));
  // 가입과 활성화가 같은 버전 값을 쓴다
  const signup = await read("src/lib/parent-signup-verification.ts");
  assert.match(signup, /const TERMS_VERSION = PARENT_TERMS_VERSION;/);
});

test("a4 활성화하면 번호 인증 시각을 남긴다(이미 있으면 보존)", async () => {
  const claim = await read("src/lib/parent-account-claim.ts");
  assert.match(claim, /UPDATE "User" SET email = \$1, "authUserId" = \$4, "phoneVerifiedAt" = COALESCE\("phoneVerifiedAt", NOW\(\)\)/);
});

// ── a5 약관 창 ───────────────────────────────────────────────────────────────
test("a5 가입·활성화 화면의 약관은 같은 화면 안의 창으로, 본문은 /terms·/privacy 와 같은 원천", async () => {
  const sheet = await read("src/components/auth/ParentConsentChecks.tsx");
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /policies\.terms : policies\.privacy/);
  const texts = await read("src/lib/policy-texts.ts");
  assert.match(texts, /settings\.termsOfService/);
  assert.match(texts, /settings\.privacyPolicy\?\.trim\(\) \|\| DEFAULT_PRIVACY_POLICY/, "/privacy 와 같은 기본 방침");
  const signupUi = await read("src/components/auth/ParentSignupClient.tsx");
  assert.doesNotMatch(signupUi, /href="\/terms" target="_blank"/, "가입 중 새 탭으로 나가지 않는다");
  assert.match(signupUi, /<ParentConsentChecks policies=\{policies\} \/>/);
  assert.match(await read("src/app/signup/parent/page.tsx"), /<ParentSignupClient policies=\{policies\} \/>/);
  assert.match(await read("src/app/account/activate/page.tsx"), /policies=\{policies\}/);
});

// ── a6 IP 한도 ───────────────────────────────────────────────────────────────
test("a6 같은 IP 인증 한도: 시간당 100·하루 500(2차 완화), 가입·비밀번호 찾기 같은 값", async () => {
  const signup = await read("src/lib/parent-signup-verification.ts");
  assert.match(signup, /export const SIGNUP_OTP_IP_HOURLY_LIMIT = 100;/);
  assert.match(signup, /export const SIGNUP_OTP_IP_DAILY_LIMIT = 500;/);
  // 번호당·전체 한도는 그대로
  assert.match(signup, /daily\) >= 10\)/);
  assert.match(signup, /dailyGlobal\) >= 5000\)/);
  const reset = await read("src/lib/parent-password-reset.ts");
  assert.match(reset, /hourlyRequest\) >= SIGNUP_OTP_IP_HOURLY_LIMIT \|\| Number\(quota\[0\]\?\.dailyRequest\) >= SIGNUP_OTP_IP_DAILY_LIMIT/);
  assert.match(reset, /daily\) >= 5\)/);
});

// ── a7 가입 후 자동 로그인 ───────────────────────────────────────────────────
test("a7 아이디 가입은 서버에서 바로 로그인하고, 실패하면 지금처럼 로그인 안내", async () => {
  const route = await read("src/app/api/auth/parent-signup/complete/route.ts");
  assert.match(route, /signInWithPassword\(\{\s*email: parentUsernameAuthEmail\(result\.username\),\s*password,\s*\}\)/);
  assert.match(route, /sessionEstablished = !signedIn\.error && Boolean\(signedIn\.data\.session\)/);
  assert.ok(route.indexOf('if ("error" in result)') < route.indexOf("signInWithPassword"), "가입이 끝난 뒤에만 로그인");
  const ui = await read("src/components/auth/ParentSignupClient.tsx");
  assert.match(ui, /if \(data\.sessionEstablished\) \{\s*window\.location\.assign\(safeInternalRedirect\(next\)\);/);
  assert.match(ui, /setStep\("done"\)/, "폴백: 완료 화면의 «로그인하기»");
});

// ── B9 로그인 화면 잔손질 · b3 직원 번호 로그인 ─────────────────────────────
test("B9 로그인 화면: 실제 비밀번호 규칙 안내·보기 버튼 44px·입력칸 44px·빈칸 문구", async () => {
  const login = await read("src/app/login/page.tsx");
  assert.doesNotMatch(login, /placeholder="6자 이상"/);
  assert.match(login, /비밀번호 \(10자 이상\)/);
  assert.match(login, /비밀번호 \(8자 이상\)/);
  // 2026-11-14 아이콘 완전 제거: 눈 아이콘 → 글자 «보기»/«숨기기». 폭 고정만 풀고 높이 44px(h-11)는 그대로.
  assert.match(login, /absolute right-0 top-1\/2 flex h-11 -translate-y-1\/2 items-center justify-center px-3/);
  assert.match(login, /\{showPassword \? "숨기기" : "보기"\}/);
  assert.equal((login.match(/className="min-h-11 w-full px-4 py-2\.5/g) || []).length, 3, "이름·아이디·비밀번호 입력칸");
  assert.match(login, /className="h-5 w-5 shrink-0 rounded/);
  const auth = await read("src/app/actions/auth.ts");
  assert.match(auth, /아이디\(또는 이메일\)와 비밀번호를 입력해 주세요\./);
});

test("b3 직원 로그인: 숫자(하이픈 허용)만 넣으면 «번호@staff.stiz.kr»", () => {
  assert.equal(staffId.staffLoginEmail("010-1234-5678"), "01012345678@staff.stiz.kr");
  assert.equal(staffId.staffLoginEmail(" 01012345678 "), "01012345678@staff.stiz.kr");
  assert.equal(staffId.staffLoginEmail("010 1234 5678"), "01012345678@staff.stiz.kr");
  assert.equal(staffId.staffLoginEmail("admin@stiz.kr"), "admin@stiz.kr", "이메일은 그대로");
  assert.equal(staffId.staffLoginEmail("12345"), "12345", "번호 길이가 아니면 그대로");
  assert.equal(staffId.staffLoginEmail("coach01"), "coach01");
});

test("b3 로그인 화면 직원 모드: 번호 입력(이메일 형식 검사 없음)·안내 문구", async () => {
  const login = await read("src/app/login/page.tsx");
  assert.match(login, /isStaffMode \? "휴대폰 번호 또는 이메일"/);
  assert.match(login, /placeholder=\{isStaffMode \? "01012345678"/);
  assert.doesNotMatch(login, /type=\{isStaffMode \? "email" : "text"\}/);
  const auth = await read("src/app/actions/auth.ts");
  assert.match(auth, /authEmail = staffLoginEmail\(identifier\)/);
});

// ── 검수 반영(2026-11-13 2차) ───────────────────────────────────────────────
test("보안: 간편로그인 전용 계정 비밀번호 만들기는 인증된 번호 + 직원 추가 역할 없음일 때만", () => {
  assert.equal(rules.socialPasswordCreationAllowed({ phoneVerifiedAt: new Date(), hasStaffGrant: false }), true);
  assert.equal(rules.socialPasswordCreationAllowed({ phoneVerifiedAt: null, hasStaffGrant: false }), false, "번호 인증 기록 없음");
  assert.equal(rules.socialPasswordCreationAllowed({ phoneVerifiedAt: new Date(), hasStaffGrant: true }), false, "선생님·기사님 추가 역할");
  assert.match(rules.SOCIAL_PASSWORD_CONTACT_MESSAGE, /학원에 문의해 주세요/);
});

test("보안: 화면 목록(describeAccounts)과 완료 단계(서버) 두 곳 모두 같은 판정을 쓴다", async () => {
  const src = await read("src/lib/parent-password-reset.ts");
  const query = src.slice(src.indexOf("async function parentAccountsForPhone"), src.indexOf("const SOCIAL_LABELS"));
  assert.match(query, /"phoneVerifiedAt"/);
  assert.match(query, /FROM "UserRoleGrant" g\s+WHERE g\."userId" = "User"\.id AND g\.status = 'ACTIVE' AND g\.role::text IN \('INSTRUCTOR','DRIVER'\)/);
  const describe = src.slice(src.indexOf("async function describeAccounts"), src.indexOf("export async function startParentPasswordReset"));
  assert.match(describe, /socialPasswordCreationAllowed\(\{ phoneVerifiedAt: row\.phoneVerifiedAt, hasStaffGrant: Boolean\(row\.hasStaffGrant\) \}\)/);
  assert.match(describe, /hasPassword \|\| !allowed \? null : planSocialPasswordLogin/);
  const complete = src.slice(src.indexOf("export async function completeParentPasswordReset"));
  assert.match(complete, /if \(!socialPasswordCreationAllowed\(\{ phoneVerifiedAt: target\.phoneVerifiedAt, hasStaffGrant: Boolean\(target\.hasStaffGrant\) \}\)\) \{\s*throw new ResetUserError\(SOCIAL_PASSWORD_CONTACT_MESSAGE\)/);
  assert.ok(complete.indexOf("socialPasswordCreationAllowed") < complete.indexOf("updateUserById"), "판정이 비밀번호 변경보다 먼저");
});

test("보안: 비밀번호를 바꾼 뒤 소진 기록만 실패해도 VERIFIED 로 되돌리지 않는다(증표 재사용 방지)", async () => {
  const src = await read("src/lib/parent-password-reset.ts");
  const complete = src.slice(src.indexOf("export async function completeParentPasswordReset"));
  assert.ok(complete.indexOf("passwordChanged = true") > complete.indexOf("updateUserById"));
  assert.ok(complete.indexOf("passwordChanged = true") < complete.indexOf("status='CONSUMED'"));
  assert.match(complete, /if \(rowId && !passwordChanged\) \{[\s\S]*?status='VERIFIED'/);
});

test("스토어 앱 판정: 표식이 없어도 사용자 에이전트 « STIZApp/» 나 android-app:// referrer 로 알아본다", async () => {
  const storeApp = await loadTsModule("src/lib/storeApp.ts");
  assert.equal(storeApp.looksLikeStoreApp({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 STIZApp/1.0.1", referrer: "" }), true);
  assert.equal(storeApp.looksLikeStoreApp({ userAgent: "Mozilla/5.0 Chrome/130", referrer: "android-app://kr.stiz.app/" }), true);
  assert.equal(storeApp.looksLikeStoreApp({ userAgent: "Mozilla/5.0 Chrome/130", referrer: "https://www.google.com/" }), false);
  assert.equal(storeApp.looksLikeStoreApp({}), false);
  // 기존 내보내기는 그대로
  for (const name of ["STORE_APP_FLAG_KEY", "markStoreApp", "isStoreApp"]) assert.ok(name in storeApp, name);
  const src = await read("src/lib/storeApp.ts");
  assert.match(src, /looksLikeStoreApp\(\{ userAgent: window\.navigator\.userAgent, referrer: document\.referrer \}\)\) \{\s*markStoreApp\(\);/);
});

test("약관 창: 안전 영역·dvh·포커스 복귀·Tab 순환·앱에서 새 탭 링크 숨김", async () => {
  const sheet = await read("src/components/auth/ParentConsentChecks.tsx");
  assert.match(sheet, /max-h-\[85dvh\]/);
  assert.doesNotMatch(sheet, /85vh/);
  assert.match(sheet, /env\(safe-area-inset-bottom\)/);
  assert.match(sheet, /opener\?\.focus\(\)/);
  assert.match(sheet, /event\.key !== "Tab"/);
  assert.match(sheet, /\{storeApp === false && \(\s*<a href=\{fullHref\} target="_blank"/);
});

test("비밀번호 경고: 입력칸을 벗어날 때·제출할 때 보이고, 문장은 서버 거절과 하나", async () => {
  assert.equal(rules.parentPasswordWarning("11111111"), `${rules.PARENT_WEAK_PASSWORD_MESSAGE} (숫자·영문 섞어 8자 이상)`);
  assert.equal(rules.parentPasswordWarning("aaaaaaaaaa", { minLength: 10 }), `${rules.PARENT_WEAK_PASSWORD_MESSAGE} (숫자·영문 섞어 10자 이상)`);
  for (const file of ["src/components/auth/ParentSignupClient.tsx", "src/app/account/activate/ParentAccountActivateClient.tsx", "src/components/auth/ParentPasswordResetClient.tsx"]) {
    const ui = await read(file);
    assert.match(ui, /onBlur=\{\(\) => setPasswordChecked\(true\)\}/, `${file} 칸을 벗어날 때`);
    assert.match(ui, /passwordChecked && weakWarning && <p role="alert"/, `${file} 확인 뒤에만 표시`);
    // 다크 모드에서도 대비 — 옅은 위험 바탕 + 진한 위험 글자(토큰)
    assert.match(ui, /bg-\[var\(--color-academy-danger-soft\)\][^"]*text-\[var\(--color-academy-danger\)\]/, `${file} 경고 대비`);
  }
});

test("활성화: 동의 칸이 없는 DB(42703)면 일반 오류 대신 «잠시 후 다시» + 서버 로그", async () => {
  const claim = await read("src/lib/parent-account-claim.ts");
  assert.match(claim, /if \(isMissingColumnError\(error\)\) \{\s*console\.error\([\s\S]*?return \{ error: ACTIVATION_TEMPORARILY_UNAVAILABLE_MESSAGE \}/);
  assert.match(claim, /String\(meta\.code\) === "42703"/);
  assert.match(claim, /ACTIVATION_TEMPORARILY_UNAVAILABLE_MESSAGE = "[^"]*잠시 후 다시 시도해 주세요\."/);
});
