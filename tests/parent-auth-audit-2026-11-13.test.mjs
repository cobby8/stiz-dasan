// 학부모 가입·로그인 점검(2026-11-13)에서 고친 것들을 지킨다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("직원 권한: 이 로그인 계정에 묶인 앱 계정만 인정한다(이메일만 같으면 안 됨)", async () => {
  const src = await readFile("src/lib/auth-guard.ts", "utf8");
  assert.match(src, /async function getAppUserRole\(email: string, authUserId: string\)/);
  assert.match(src, /AND \("authUserId" = \$2 OR \("authUserId" IS NULL AND id = \$2\)\)/);
  assert.doesNotMatch(src, /"authUserId" IS NULL OR "authUserId" = \$2/, "묶이지 않은 계정을 이메일만으로 인정하지 않는다");
  assert.match(src, /const cacheKey = `\$\{authUserId\}\|\$\{normalized\}`/, "캐시도 로그인 계정별로 나눈다");
  assert.doesNotMatch(src, /getAppUserRole\(email\)/);
  assert.equal(src.split("getAppUserRole(email, user.id)").length - 1, 3);
});

test("보호자 관리(관리자): 거절 사유를 throw 대신 값으로 돌려줘 운영 화면에도 보인다", async () => {
  const src = await readFile("src/app/actions/guardians.ts", "utf8");
  assert.match(src, /class GuardianUserError extends Error/);
  assert.doesNotMatch(src, /throw new Error\(/, "사유 throw 는 모두 GuardianUserError");
  for (const name of ["addStudentGuardian", "updateStudentGuardian", "deleteStudentGuardian", "setPrimaryGuardian"]) {
    assert.match(src, new RegExp(`export async function ${name}\\([\\s\\S]*?\\): Promise<GuardianMutationResult> \\{\\n  await requireAdmin\\(\\);\\n  return asResult\\(`));
  }
  const panel = await readFile("src/app/admin/students/[id]/GuardianPanel.tsx", "utf8");
  assert.match(panel, /if \("error" in result\)/);
  assert.match(panel, /setGuardians\(result\.guardians\)/);
});

test("가입: 화면에 보여야 할 사유가 일반 안내로 바뀌지 않게 허용 목록에 있다", async () => {
  const allow = await readFile("src/lib/user-facing-error.ts", "utf8");
  for (const message of [
    "간편가입 제공자 정보가 일치하지 않습니다.",
    "인증번호 문자 발송에 실패했습니다.",
    "회원가입 처리 상태가 변경되었습니다.",
    "계정 활성화 상태가 변경되었습니다.",
  ]) assert.ok(allow.includes(`"${message}"`), message);
  const verification = await readFile("src/lib/parent-signup-verification.ts", "utf8");
  assert.match(verification, /if \(rows\[0\]\?\.phoneTaken\) throw new Error\(REGISTERED_PHONE_MESSAGE\)/, "문구를 한 곳(상수)에서만 관리");
  assert.match(verification, /아이디·비밀번호 찾기/);
});

test("가입: 간편가입 완료 화면은 아이디 로그인으로 보내지 않는다(비밀번호가 없다)", async () => {
  const ui = await readFile("src/components/auth/ParentSignupClient.tsx", "utf8");
  assert.match(ui, /socialSignup \? \(\n\s*<a href=\{safeInternalRedirect\(next\)\}/);
  assert.match(ui, /publicErrorText\(new Error\(raw\)/, "주소의 ?error= 는 거른 뒤 보여 준다");
});

test("가입: 인증번호 재요청 라우트도 요청 IP 로 한도를 센다", async () => {
  const route = await readFile("src/app/api/auth/parent-signup/send-otp/route.ts", "utf8");
  assert.match(route, /sendParentSignupOtp\(String\(body\?\.token \|\| ""\), forwarded/);
  const start = await readFile("src/app/api/auth/parent-signup/start/route.ts", "utf8");
  assert.match(start, /registeredPhone: true/);
});

test("로그인: 학부모가 틀리면 아이디·비밀번호 찾기로 안내", async () => {
  const src = await readFile("src/app/actions/auth.ts", "utf8");
  assert.match(src, /아이디 또는 비밀번호가 올바르지 않습니다\. 기억나지 않으면/);
  // 직원은 휴대폰 번호로도 로그인한다(2026-11-13 b3) — 틀렸을 때 안내도 번호를 함께 말한다
  assert.match(src, /loginContext === "staff"\n\s*\? "휴대폰 번호\(또는 이메일\) 또는 비밀번호가 올바르지 않습니다\."/);
});
