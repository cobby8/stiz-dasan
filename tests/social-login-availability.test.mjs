import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 간편로그인 버튼은 **Supabase 에서 실제로 켜진 것만** 보인다.
//
// 2026-10-25 운영 실측 — 구글·카카오가 Supabase 에서 꺼져 있었는데 로그인 화면에는 버튼이
// 늘 보였다. 학부모가 누르면 Supabase 의 JSON 오류 화면
// `{"msg":"Unsupported provider: provider is not enabled"}` 가 그대로 떴다.
// 빌드·타입검사·테스트가 모두 통과해 아무 신호가 없었다.
//
// 그래서 «켜졌는지»의 원본을 Supabase 설정 하나로 두고, 버튼 표시와 로그인 시작이 모두 그것을 본다.
// (환경변수 스위치를 따로 두면 「Supabase 는 꺼졌는데 스위치는 켜짐」이 다시 생긴다 — Apple 용으로
//  잠깐 두었던 NEXT_PUBLIC_APPLE_LOGIN_ENABLED 를 없앤 이유.)
//
// Apple 은 앱스토어 필수 요건(심사지침 4.8)이다. Supabase 에서 켜는 순간 버튼이 나타난다.

const {
  PARENT_OAUTH_PROVIDERS,
  PARENT_OAUTH_LABELS,
  parseParentOAuthProvider,
  toSupabaseProvider,
  enabledParentOAuthProviders,
  parentOAuthNotReadyMessage,
} = await loadTsModule("src/lib/parent-oauth.ts");

const loginPage = fs.readFileSync("src/app/login/page.tsx", "utf8");
const signupUi = fs.readFileSync("src/components/auth/ParentSignupClient.tsx", "utf8");
const route = fs.readFileSync("src/app/auth/oauth/[provider]/route.ts", "utf8");
const fetcher = fs.readFileSync("src/lib/auth-providers.ts", "utf8");
const hook = fs.readFileSync("src/hooks/useEnabledOAuthProviders.ts", "utf8");

const NO_NAVER = {};

// ── 판정(실제 실행) ──────────────────────────────────────────────────────────
test("Supabase 에서 켜진 제공자만 고른다", () => {
  // 운영에서 실제로 받은 응답 모양 — 전부 꺼짐.
  assert.deepEqual(
    enabledParentOAuthProviders({ external: { apple: false, google: false, kakao: false } }, NO_NAVER),
    [],
    "전부 꺼졌으면 버튼이 하나도 없어야 한다",
  );
  assert.deepEqual(
    enabledParentOAuthProviders({ external: { google: true, kakao: false, apple: true } }, NO_NAVER),
    ["google", "apple"],
  );
  // 표시 순서는 우리가 정한 순서를 따른다(응답 키 순서가 아니라).
  assert.deepEqual(
    enabledParentOAuthProviders({ external: { apple: true, kakao: true, google: true } }, NO_NAVER),
    ["google", "kakao", "apple"],
  );
});

test("true 가 아니면 꺼진 것으로 본다", () => {
  // 눌러도 안 되는 버튼은 안 보이는 편이 낫다 — 애매하면 끈다.
  for (const value of [undefined, null, "true", 1, "yes", {}]) {
    assert.deepEqual(
      enabledParentOAuthProviders({ external: { google: value } }, NO_NAVER),
      [],
      `${JSON.stringify(value)} 를 켜짐으로 봤다`,
    );
  }
  // 설정 조회가 실패해 응답이 없을 때도 마찬가지.
  assert.deepEqual(enabledParentOAuthProviders(null, NO_NAVER), []);
  assert.deepEqual(enabledParentOAuthProviders(undefined, NO_NAVER), []);
  assert.deepEqual(enabledParentOAuthProviders({}, NO_NAVER), []);
});

test("네이버는 커스텀 제공자라 기존 플래그를 따른다", () => {
  // settings 의 external 목록에는 커스텀 제공자가 나오지 않는다.
  assert.deepEqual(enabledParentOAuthProviders({ external: {} }, { SUPABASE_NAVER_PROVIDER_ENABLED: "true" }), ["naver"]);
  assert.deepEqual(enabledParentOAuthProviders({ external: {} }, { SUPABASE_NAVER_PROVIDER_ENABLED: "1" }), []);
  // 응답에 naver 가 들어와도 플래그가 없으면 켜지 않는다.
  assert.deepEqual(enabledParentOAuthProviders({ external: { naver: true } }, NO_NAVER), []);
});

test("apple 은 허용 목록에 있고 Supabase 빌트인 이름 그대로 쓴다", () => {
  assert.ok(PARENT_OAUTH_PROVIDERS.includes("apple"));
  assert.equal(parseParentOAuthProvider("apple"), "apple");
  assert.equal(parseParentOAuthProvider("facebook"), null);
  assert.equal(toSupabaseProvider("apple"), "apple");
  assert.equal(toSupabaseProvider("naver"), "custom:naver");
});

test("꺼진 제공자 안내 문구가 그 이름을 넣는다", () => {
  // 라우트에 네이버 문구가 하드코딩돼 있어 Apple 을 눌렀는데 네이버 안내가 나갈 뻔했다.
  assert.match(parentOAuthNotReadyMessage("apple"), /^Apple 간편가입을 준비 중입니다/);
  assert.match(parentOAuthNotReadyMessage("google"), /^Google 간편가입을 준비 중입니다/);
  for (const provider of PARENT_OAUTH_PROVIDERS) assert.ok(PARENT_OAUTH_LABELS[provider]);
});

// ── 연결 계약 ────────────────────────────────────────────────────────────────
test("버튼 표시와 로그인 시작이 같은 판정을 쓴다", () => {
  // 화면이 낡았거나 주소를 직접 쳐도 Supabase 오류 화면 대신 우리 안내가 나가야 한다.
  assert.match(route, /await getEnabledParentOAuthProviders\(\)\)\.includes\(provider\)/);
  assert.match(route, /parentOAuthNotReadyMessage\(provider\)/);
  // 판정의 원본은 Supabase 설정 엔드포인트 하나.
  assert.match(fetcher, /\/auth\/v1\/settings/);
  assert.match(fetcher, /enabledParentOAuthProviders\(await response\.json\(\)\)/);
  // 환경변수 스위치가 다시 생기면 「Supabase 는 꺼졌는데 스위치는 켜짐」이 된다.
  for (const source of [loginPage, signupUi, route, fetcher, hook]) {
    assert.doesNotMatch(source, /NEXT_PUBLIC_APPLE_LOGIN_ENABLED/);
  }
});

test("설정 조회가 실패해도 화면은 깨지지 않고 버튼만 사라진다", () => {
  assert.match(fetcher, /catch \(error\)[\s\S]*?return enabledParentOAuthProviders\(null\)/);
  assert.match(fetcher, /AbortSignal\.timeout/);
  // 원장이 Supabase 에서 켜면 오래 기다리지 않게 캐시는 짧게.
  const match = /revalidate: (\d+)/.exec(fetcher);
  assert.ok(match && Number(match[1]) <= 300, "캐시가 너무 길면 켜도 버튼이 늦게 나타난다");
});

test("두 화면 모두 켜진 것만 그리고, 모르는 동안은 그리지 않는다", () => {
  // 먼저 다 그렸다가 꺼진 것을 지우면, 그 사이 누른 학부모는 오류 화면을 본다.
  assert.match(hook, /useState<ParentOAuthProvider\[\] \| null>\(null\)/);
  // 서버가 준 값 중 우리가 아는 이름만 받는다(엉뚱한 /auth/oauth/<값> 링크 방지).
  assert.match(hook, /PARENT_OAUTH_PROVIDERS\.filter\(\(provider\) => list\.includes\(provider\)\)/);

  assert.match(loginPage, /useEnabledOAuthProviders\(\)/);
  assert.match(loginPage, /visibleSocialLoginOptions\.map/);
  assert.doesNotMatch(loginPage, /parentSocialLoginOptions\.map/, "거르지 않은 표를 그대로 그리고 있다");

  assert.match(signupUi, /useEnabledOAuthProviders\(\)/);
  assert.match(signupUi, /visibleSignupOptions\.map/);
  // 하드코딩 링크가 남아 있으면 그 버튼은 꺼져도 보인다.
  assert.doesNotMatch(signupUi, /href=\{`\/auth\/oauth\/(google|kakao|naver)\?/);
});

test("Apple 버튼은 애플 가이드라인대로 로고를 붙인다", () => {
  for (const source of [loginPage, signupUi]) {
    assert.match(source, /import AppleLogo from "@\/components\/auth\/AppleLogo"/);
    assert.match(source, /option\.provider === "apple" && <AppleLogo \/>/);
  }
  // 로그인 화면은 검정 스타일(다크 모드에선 흰색) — 애플이 허용하는 두 가지 중 하나.
  assert.match(loginPage, /provider: "apple", label: "Apple로 로그인", tone: "border-black bg-black text-white/);
});
