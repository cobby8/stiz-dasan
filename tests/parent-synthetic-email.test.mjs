import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 빈 보호자 계정(합성 이메일) 판정 규칙 — 운영 실측(2026-10-08, 로그인 없는 학부모 308명) 형식을 고정한다.
const { isSyntheticParentEmail } = await loadTsModule("src/lib/parent-synthetic-email.ts");

test("운영에 있는 빈 계정 형식은 모두 맞는다", () => {
  for (const email of [
    "parent_1759900000000@stiz.local", // 옛 규칙 132명
    "parent_1759900000000_12@stiz.local", // 163명(다니는 학부모 78명) — 옛 규칙이 놓친 형식
    "parent_01012345678@stiz.local",
    "parent_3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e@stiz.local",
    "rallyz-parent-3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e@stiz.local",
    "01012345678@import.local",
    "010-1234-5678@import.local",
    "PARENT_123@STIZ.LOCAL",
  ]) assert.equal(isSyntheticParentEmail(email), true, email);
});

test("실제 이메일·팀 재연결 계정·비슷한 가짜는 맞지 않는다", () => {
  for (const email of [
    "team_3f2a9c1e@stiz.local", // 팀 재연결용 — 일부러 제외
    "team_parent_1@stiz.local",
    "mom@gmail.com",
    "parent_123@stiz.kr",
    "parent_123@stiz.local.evil.com",
    "xparent_123@stiz.local",
    "parent_@stiz.local",
    "parent_12 3@stiz.local",
    "rallyz-parent-@stiz.local",
    "kim@import.local",
    "user@member.stiz.kr",
    "",
    null,
    undefined,
  ]) assert.equal(isSyntheticParentEmail(email), false, String(email));
});

test("판정 규칙은 parent-synthetic-email.ts 한 곳에만 있다(다른 파일에 정규식 사본 금지)", () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const copies = walk("src")
    .filter((file) => /\.(ts|tsx|mjs)$/.test(file) && !file.endsWith("parent-synthetic-email.ts"))
    // 정규식·SQL 패턴 안의 `stiz\.local` / `import\.local` (이메일 "만드는" 템플릿 문자열은 해당 없음)
    .filter((file) => /stiz\\\\?\.local|import\\\\?\.local|~\*?\s*'[^']*\\.local/.test(readFileSync(file, "utf8")));
  assert.deepEqual(copies, []);
});
