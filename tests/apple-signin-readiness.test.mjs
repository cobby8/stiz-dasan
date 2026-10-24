import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 애플 앱스토어는 제3자 소셜 로그인을 제공하는 앱에 **Apple 로그인도** 요구한다(심사지침 4.8).
// 없으면 거부된다. 다만 Service ID·Key 설정 전에 버튼만 띄우면 눌러도 안 되고,
// 그 상태로 제출하면 "Apple 로그인이 작동하지 않음"으로 또 거부된다.
// 그래서 **버튼과 서버가 같은 스위치를 봐야** 한다 — 한쪽만 켜지면 그게 바로 거부 사유다.

const {
  PARENT_OAUTH_PROVIDERS,
  PARENT_OAUTH_LABELS,
  parseParentOAuthProvider,
  toSupabaseProvider,
  isParentOAuthProviderReady,
  parentOAuthNotReadyMessage,
} = await loadTsModule("src/lib/parent-oauth.ts");

const loginPage = fs.readFileSync("src/app/login/page.tsx", "utf8");
const route = fs.readFileSync("src/app/auth/oauth/[provider]/route.ts", "utf8");

const APPLE_FLAG = "NEXT_PUBLIC_APPLE_LOGIN_ENABLED";

test("apple 이 허용 provider 로 등록돼 있다", () => {
  assert.ok(PARENT_OAUTH_PROVIDERS.includes("apple"));
  assert.equal(parseParentOAuthProvider("apple"), "apple");
  // 모르는 값은 그대로 거절해야 한다(provider 를 늘리면서 느슨해지기 쉽다).
  assert.equal(parseParentOAuthProvider("facebook"), null);
  assert.equal(parseParentOAuthProvider(""), null);
});

test("apple 은 Supabase 빌트인이라 custom 접두사를 붙이지 않는다", () => {
  assert.equal(toSupabaseProvider("apple"), "apple");
  // 네이버만 커스텀 등록이다 — 여기 섞이면 로그인이 시작조차 안 된다.
  assert.equal(toSupabaseProvider("naver"), "custom:naver");
  assert.equal(toSupabaseProvider("google"), "google");
});

test("스위치가 꺼져 있으면 서버가 apple 로그인을 시작하지 않는다", () => {
  const saved = process.env[APPLE_FLAG];
  try {
    delete process.env[APPLE_FLAG];
    assert.equal(isParentOAuthProviderReady("apple"), false);
    process.env[APPLE_FLAG] = "false";
    assert.equal(isParentOAuthProviderReady("apple"), false);
    // "true" 가 아닌 아무 값도 켜진 것으로 보지 않는다(1·yes 로 오해해 반쯤 켜면 안 된다).
    process.env[APPLE_FLAG] = "1";
    assert.equal(isParentOAuthProviderReady("apple"), false);
    process.env[APPLE_FLAG] = "true";
    assert.equal(isParentOAuthProviderReady("apple"), true);
  } finally {
    if (saved === undefined) delete process.env[APPLE_FLAG];
    else process.env[APPLE_FLAG] = saved;
  }
});

test("구글·카카오는 스위치와 무관하게 늘 켜져 있다", () => {
  // 기존 동작을 바꾸지 않았는지 확인한다.
  assert.equal(isParentOAuthProviderReady("google"), true);
  assert.equal(isParentOAuthProviderReady("kakao"), true);
});

test("안내 문구가 provider 이름을 제대로 넣는다", () => {
  // 네이버 문구가 라우트에 하드코딩돼 있어 apple 을 추가하자 "네이버 간편가입을 준비 중"이
  // 뜰 뻔했다(2026-10-25). 문구는 모듈이 만들고 라우트는 그것만 쓴다.
  assert.match(parentOAuthNotReadyMessage("apple"), /^Apple 간편가입을 준비 중입니다/);
  assert.match(parentOAuthNotReadyMessage("naver"), /^네이버 간편가입을 준비 중입니다/);
  for (const provider of PARENT_OAUTH_PROVIDERS) {
    assert.ok(PARENT_OAUTH_LABELS[provider], `${provider} 의 이름이 없다`);
  }
  assert.match(route, /parentOAuthNotReadyMessage\(provider\)/);
  assert.doesNotMatch(route, /네이버 간편가입을 준비 중입니다/);
});

test("버튼과 서버가 같은 스위치를 본다", () => {
  // 한쪽만 켜지면 「버튼은 보이는데 눌러도 거절」이 되고, 그게 바로 애플 거부 사유다.
  assert.match(loginPage, new RegExp(`process\\.env\\.${APPLE_FLAG} === "true"`));
  const mod = fs.readFileSync("src/lib/parent-oauth.ts", "utf8");
  assert.match(mod, new RegExp(`process\\.env\\.${APPLE_FLAG} === "true"`));
  // 클라이언트에서 읽히려면 NEXT_PUBLIC_ 접두사여야 한다 — 빠지면 버튼이 영원히 안 보인다.
  assert.ok(APPLE_FLAG.startsWith("NEXT_PUBLIC_"));
});

test("스위치가 꺼진 동안에는 로그인 화면에 Apple 버튼이 없다", () => {
  // 조건부 전개여야 한다. 배열에 그냥 넣으면 설정 전에도 버튼이 보인다.
  assert.match(loginPage, /\.\.\.\(process\.env\.NEXT_PUBLIC_APPLE_LOGIN_ENABLED === "true"\s*\n?\s*\?\s*\[\{ provider: "apple"/);
  // 기존 세 개는 조건 없이 그대로 남아 있어야 한다(기존 기능 보존).
  for (const provider of ["google", "kakao", "naver"]) {
    assert.match(loginPage, new RegExp(`\\{ provider: "${provider}", label:`));
  }
});
