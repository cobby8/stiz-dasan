import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// 2026-10-26: 이미 가입한 학부모(휴대폰 인증 완료)가 Apple·Google 을 누르면 간편가입이 「이미 가입된 번호」로
// 끝나 연결할 길이 없었다. → 마이페이지 「간편로그인 연결」. 원장 결정: 비밀번호로 로그인한 본인만 연결한다.

const start = fs.readFileSync("src/app/auth/oauth/[provider]/route.ts", "utf8");
const callback = fs.readFileSync("src/app/auth/callback/route.ts", "utf8");
const page = fs.readFileSync("src/app/mypage/login-methods/page.tsx", "utf8");
const accountLayout = fs.readFileSync("src/app/mypage/layout.tsx", "utf8");
const mypage = fs.readFileSync("src/components/account/AccountLinks.tsx", "utf8");

test("연결은 휴대폰 인증까지 마친 학부모 본인만 시작할 수 있다", () => {
  const getAt = start.indexOf("export async function GET(");
  const linkAt = start.indexOf('if (intent === "link") {', getAt);
  assert.ok(linkAt > 0, "연결 모드가 없다");
  const block = start.slice(linkAt, start.indexOf("return NextResponse.redirect(data.url);", linkAt));
  const guardAt = block.indexOf("requireVerifiedParent()");
  const linkCallAt = block.indexOf("supabase.auth.linkIdentity(");
  assert.ok(guardAt > 0 && linkCallAt > guardAt, "학부모 확인보다 연결 호출이 먼저 온다");
  assert.match(block, /if \(!parent\) return loginError\(/);
  // 연결 모드에서 새 로그인(signInWithOAuth)을 하면 다른 계정으로 바뀌어 버린다.
  assert.doesNotMatch(block, /signInWithOAuth/);
  // 켜지지 않은 제공자 거절은 연결보다 먼저(Supabase 오류 화면 대신 우리 안내).
  const enabledAt = start.indexOf("getEnabledParentOAuthProviders()", getAt);
  assert.ok(enabledAt > getAt && enabledAt < linkAt);
});

test("연결을 마치면 연결 화면으로 돌아가고, 학부모 가입 흐름을 타지 않는다", () => {
  const getAt = callback.indexOf("export async function GET(");
  const linkBranch = callback.indexOf('if (request.nextUrl.searchParams.get("intent") === "link") return finishLink(', getAt);
  assert.ok(linkBranch > getAt, "연결 분기가 없다");
  // 가입·계정 찾기 쿼리보다 앞에서 갈라져야 한다.
  assert.ok(linkBranch < callback.indexOf('FROM "User"', getAt));
  const finish = callback.slice(callback.indexOf("async function finishLink("), getAt);
  assert.match(finish, /exchangeCodeForSession\(code\)/);
  assert.match(finish, /identity_already_exists/);
  assert.doesNotMatch(finish, /signup\/parent|linkEnrollmentAccount/);
});

test("연결 화면: 학부모만 열고, 연결 버튼은 일반 링크(<Link> 미리 불러오기 금지)", () => {
  assert.match(page, /requireVerifiedParent\(\)\.catch\(\(\) => null\)/);
  assert.match(page, /if \(!parent\) redirect\("\/mypage\/continue\?bounced=1"\)/);
  assert.match(page, /<a\s+href=\{`\/auth\/oauth\/\$\{provider\}\?intent=link`\}/);
  assert.doesNotMatch(page, /<Link[^>]*?href=\{`\/auth\/oauth\//);
  // 마이페이지에서 들어가는 길
  assert.match(mypage, /href="\/mypage\/login-methods"/);
  assert.match(accountLayout, /\{children\}\s*<AccountLinks\s*\/>/);
});

test("이미 가입된 번호 안내가 실제로 있는 연결 방법을 알려 준다(없는 「계정 찾기」 안내 금지)", () => {
  const lib = fs.readFileSync("src/lib/parent-signup-verification.ts", "utf8");
  assert.doesNotMatch(lib, /계정 찾기/);
  assert.match(lib, /마이페이지 → 간편로그인 연결/);
});
