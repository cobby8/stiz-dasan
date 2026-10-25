import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 2026-10-26: Apple 로그인을 켰는데 「간편가입 방식」 판정이 세 곳에 따로 적혀 있었고 하나도 apple 을 몰라,
// 애플 학부모가 휴대폰 인증 단계에서 「간편가입 연결이 만료」로 막혔다. DB CHECK 도 네 가지 방식만 허락했다.
// → 판정은 oauthProviderMethod 한 곳, 코드의 방식 목록 = 최신 마이그레이션의 CHECK.

const lib = fs.readFileSync("src/lib/parent-signup-verification.ts", "utf8");
const route = fs.readFileSync("src/app/api/auth/parent-signup/start/route.ts", "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} 가 없다`);
  return source.slice(start, source.indexOf("\n}\n", start));
}

test("간편로그인 제공자 판정은 켤 수 있는 모든 제공자를 알아본다", () => {
  const body = functionBody(lib, "oauthProviderMethod");
  for (const [provider, method] of [["google", "GOOGLE"], ["kakao", "KAKAO"], ["naver", "NAVER"], ["apple", "APPLE"]]) {
    assert.match(body, new RegExp(`name === "${provider}"\\) return "${method}"`), `${provider} → ${method} 판정이 없다`);
  }
  // 버튼으로 켤 수 있는 제공자(parent-oauth)가 판정에서 빠지면, 그 제공자로 들어온 학부모는 가입하지 못한다.
  const oauth = fs.readFileSync("src/lib/parent-oauth.ts", "utf8");
  const list = oauth.match(/PARENT_OAUTH_PROVIDERS\s*=\s*\[([^\]]*)\]/);
  assert.ok(list, "PARENT_OAUTH_PROVIDERS 목록을 찾지 못했다");
  for (const provider of list[1].match(/"([a-z:]+)"/g).map((value) => value.slice(1, -1))) {
    assert.ok(body.includes(`"${provider}"`), `켤 수 있는 제공자 ${provider} 를 가입 방식 판정이 모른다`);
  }
});

test("가입 방식 판정은 한 곳에서만 한다(다른 곳에 따로 적지 않는다)", () => {
  assert.match(route, /oauthProviderMethod\(rawProvider\) \?\? "PASSWORD"/);
  const outside = lib.replace(functionBody(lib, "oauthProviderMethod"), "");
  const providerCompare = /=== "(google|kakao|naver|custom:naver|apple)"/;
  assert.doesNotMatch(outside, providerCompare, "제공자 이름 비교가 판정 함수 밖에 또 생겼다");
  // 같은 흐름의 다른 단계(휴대폰 인증 확인·가입 완료)도 따로 비교하지 않는다.
  for (const file of [
    "src/app/api/auth/parent-signup/start/route.ts",
    "src/app/api/auth/parent-signup/verify-otp/route.ts",
    "src/app/api/auth/parent-signup/complete/route.ts",
  ]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), providerCompare, `${file} 에 제공자 비교가 따로 생겼다`);
  }
});

test("코드의 가입 방식 목록 = 운영 DB CHECK(최신 마이그레이션)", () => {
  const codeList = lib.match(/PARENT_SIGNUP_METHODS = \[([^\]]*)\]/)[1].match(/"([A-Z]+)"/g).map((value) => value.slice(1, -1));
  const dirs = fs.readdirSync("prisma/migrations").sort();
  let latest = null;
  for (const dir of dirs) {
    const file = path.join("prisma/migrations", dir, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/ParentSignupVerification_signupMethod_check"\s*CHECK \("signupMethod" IN \(([^)]*)\)\)/);
    if (match) latest = match[1].match(/'([A-Z]+)'/g).map((value) => value.slice(1, -1));
  }
  assert.ok(latest, "signupMethod CHECK 를 거는 마이그레이션을 찾지 못했다");
  assert.deepEqual([...codeList].sort(), [...latest].sort(), "코드가 저장하려는 방식을 DB 가 거절하거나, 그 반대다");
});
