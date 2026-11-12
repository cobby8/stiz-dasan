import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/account/activate/page.tsx", "utf8");
const client = readFileSync("src/app/account/activate/ParentAccountActivateClient.tsx", "utf8");

test("활성화 페이지는 토큰 상태와 만료·잠금·완료 상태를 안내한다", () => {
  assert.match(page, /getParentAccountClaim\(token\)/);
  assert.match(page, /EXPIRED/);
  assert.match(page, /LOCKED/);
  assert.match(page, /ACCEPTED/);
  assert.match(page, /활성화 링크가 만료되었습니다/);
});

test("보호자는 OTP 확인 후 실제 이메일과 비밀번호를 설정한다", () => {
  assert.match(client, /sendParentAccountOtp\(token\)/);
  assert.match(client, /verifyParentAccountOtp\(token, otp\)/);
  // 필수 동의 3개도 함께 보낸다(2026-11-13 a3) — 서버가 다시 확인하고 기록한다
  assert.match(client, /acceptParentAccountClaim\(token, cleanEmail, password, consents\)/);
  assert.match(client, /<ParentConsentChecks policies=\{policies\} tone="academy" \/>/);
  assert.match(client, /password\.length < 10/);
  assert.match(client, /password !== passwordConfirm/);
});

test("활성화 3단계는 server action reject를 공통 오류로 복구한다", () => {
  assert.match(client, /function runServerAction\(action: \(\) => Promise<void>, fallbackMessage: string\)/);
  assert.match(client, /try \{\s*await action\(\)/);
  assert.match(client, /catch \{\s*setMessage\(\{ kind: "error", text: fallbackMessage \}\)/);
  assert.match(client, /runServerAction\(async \(\) => \{[\s\S]*sendParentAccountOtp\(token\)/);
  assert.match(client, /runServerAction\(async \(\) => \{[\s\S]*verifyParentAccountOtp\(token, otp\)/);
  assert.match(client, /runServerAction\(async \(\) => \{[\s\S]*acceptParentAccountClaim\(token, cleanEmail, password, consents\)/);
});

test("성공하면 서버가 허용한 결제 경로로 이동하고 접근성 상태를 알린다", () => {
  assert.match(client, /safeInternalPath\(result\.redirectPath \|\| redirectPath\)/);
  assert.match(client, /result\.sessionEstablished/);
  assert.match(client, /result\.loginRedirect/);
  assert.match(client, /`\/login\?redirect=\$\{encodeURIComponent\(destination\)\}`/);
  assert.match(client, /role=\{message\.kind === "error" \? "alert" : "status"\}/);
  assert.match(client, /aria-live=\{message\.kind === "error" \? "assertive" : "polite"\}/);
  assert.match(client, /autoComplete="one-time-code"/);
  assert.match(client, /htmlFor=\{id\}/);
});

test("활성화 토큰을 주소에서 제거하고 referrer 전송을 차단한다", () => {
  assert.match(page, /referrer: "no-referrer"/);
  assert.match(client, /cleanUrl\.searchParams\.delete\("token"\)/);
  assert.match(client, /window\.history\.replaceState/);
  assert.match(client, /decoded\.includes\("\\\\"\)/);
});
