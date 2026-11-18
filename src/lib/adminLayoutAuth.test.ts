import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node 내장 테스트 러너는 실행할 TypeScript 확장자가 필요합니다.
import { classifyAdminLayoutAuthFailure, forbiddenAdminDestination } from "./adminLayoutAuth.ts";
import { readFileSync } from "node:fs";

test("관리자 권한이 없는 계정은 그 계정의 화면으로 보낸다 — 다시 관리자 화면이면 보내지 않는다(반복 방지)", () => {
  assert.equal(forbiddenAdminDestination("/mypage"), "/mypage");
  assert.equal(forbiddenAdminDestination("/staff"), "/staff");
  assert.equal(forbiddenAdminDestination("/signup/parent?social=1"), "/signup/parent?social=1");
  // 다시 관리자 화면 → 거절 → 이동 → 거절 반복이 되므로 null(오류 화면에서 멈춘다)
  for (const loop of ["/admin", "/admin/", "/admin/students", "/admin?x=1", "/admin#top"]) {
    assert.equal(forbiddenAdminDestination(loop), null, loop);
  }
  // 이름만 비슷한 주소는 관리자 화면이 아니다
  assert.equal(forbiddenAdminDestination("/administrator"), "/administrator");
  // 사이트 밖·이상한 값은 받지 않는다
  for (const bad of [null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", 3]) {
    assert.equal(forbiddenAdminDestination(bad), null, String(bad));
  }
});

test("관리자 레이아웃: 권한 부족이면 로그인 뒤와 같은 함수로 목적지를 정해 보내고, 못 정하면 오류를 그대로 던진다", () => {
  const layout = readFileSync(new URL("../app/admin/layout.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(
    layout,
    /if \(failure === "FORBIDDEN"\) \{[\s\S]*?forbiddenAdminDestination\(\s*await resolveContinueDestination\(\{ bounced: true \}\)\.catch\(\(\) => null\),\s*\);\s*if \(destination\) redirect\(destination\);\s*\}[\s\S]*?throw error;/,
  );
  // 로그인이 필요한 경우의 이동은 그대로
  assert.match(layout, /if \(failure === "LOGIN_REQUIRED"\) \{\s*redirect\("\/login\?redirect=\/admin"\);/);
});

test("로그인이 필요한 오류만 로그인 이동 대상으로 분류한다", () => {
  assert.equal(
    classifyAdminLayoutAuthFailure(new Error("인증이 필요합니다. 로그인해주세요.")),
    "LOGIN_REQUIRED",
  );
});

test("관리자 권한 부족은 로그인 실패와 구분한다", () => {
  assert.equal(
    classifyAdminLayoutAuthFailure(new Error("관리자 권한이 필요합니다.")),
    "FORBIDDEN",
  );
});

test("DB 장애는 인증 오류로 숨기지 않는다", () => {
  assert.equal(classifyAdminLayoutAuthFailure(new Error("database connection failed")), null);
  assert.equal(classifyAdminLayoutAuthFailure("unknown failure"), null);
});
