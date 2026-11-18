import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const middlewareSource = await readFile("src/lib/supabase/middleware.ts", "utf8");
const configSource = await readFile("next.config.ts", "utf8");
const loginSource = await readFile("src/app/login/page.tsx", "utf8");

test("교사용 로그인은 설치 앱의 /staff 범위 안에서 공용 로그인 화면을 재사용한다", async () => {
  assert.match(configSource, /source:\s*["']\/staff\/login["']/);
  // 2026-11-17: 직원 전용 화면을 없앴다 — 같은 로그인 화면을 /staff 범위 주소로 보여 줄 뿐(mode=staff 없음)
  assert.match(configSource, /source:\s*["']\/staff\/login["'],\s*(?:\/\/[^\n]*\n\s*)*destination:\s*["']\/login["']/);
  assert.doesNotMatch(configSource, /mode=staff/);
  // 로그인 화면은 직원 전용 갈래를 그리지 않는다 · 로그아웃·관리자 미로그인도 같은 화면으로
  assert.match(loginSource, /const isStaffMode = false as boolean;/);
  assert.doesNotMatch(loginSource, /searchParams\.get\("mode"\) === "staff"/);
  assert.doesNotMatch(await readFile("src/app/actions/auth.ts", "utf8"), /redirect\("\/staff\/login"\)/);
  assert.doesNotMatch(await readFile("src/app/admin/layout.tsx", "utf8"), /mode=staff/);
  assert.doesNotMatch(await readFile("src/app/invite/[token]/InviteAcceptForm.tsx", "utf8"), /mode=staff/);
  assert.doesNotMatch(middlewareSource, /searchParams\.set\("mode", "staff"\)/);
  assert.match(middlewareSource, /pathname === ["']\/staff\/login["']/);
  assert.match(middlewareSource, /isStaffPath && !isStaffLogin/);
  assert.match(loginSource, /pathname === ["']\/staff\/login["']/);
});

test("미인증 staff 요청은 /staff/login으로 보내고 로그인 후 원래 경로를 유지한다", () => {
  assert.match(
    middlewareSource,
    /pathname\.startsWith\(["']\/staff["']\) \? ["']\/staff\/login["'] : ["']\/login["']/,
  );
  assert.match(
    middlewareSource,
    /const requestedPath = `\$\{pathname\}\$\{request\.nextUrl\.search\}`/,
  );
  assert.match(middlewareSource, /url\.search = ["']["']/);
  assert.match(middlewareSource, /url\.searchParams\.set\(["']redirect["'], requestedPath\)/);
  assert.match(loginSource, /\(isStaffMode \|\| staffEntry \? ["']\/staff["'] : null\)/);
});

test("미인증 admin 요청도 같은 로그인 화면으로 보낸다(2026-11-17 — 직원 전용 화면을 없앴다)", () => {
  assert.doesNotMatch(middlewareSource, /url\.searchParams\.set\(["']mode["'], ["']staff["']\)/);
  assert.match(middlewareSource, /isStaffModeLogin/);
  assert.match(loginSource, /STIZ 관리자\/선생님 로그인/);
  // 직원 아이디 = 휴대폰 번호(초대 가입 로그인 메일이 «번호@staff.stiz.kr»), 이메일도 그대로 된다(2026-11-13 b3)
  assert.match(loginSource, /휴대폰 번호 또는 이메일/);
  assert.match(loginSource, /가입한 휴대폰 번호\(또는 이메일\)로 로그인해 주세요\./);
});

test("보호 경로의 검색 조건을 로그인 후에도 보존하고 로그인 URL에는 중복하지 않는다", () => {
  assert.match(
    middlewareSource,
    /const requestedPath = `\$\{pathname\}\$\{request\.nextUrl\.search\}`/,
  );
  assert.match(
    middlewareSource,
    /url\.pathname = pathname\.startsWith\(["']\/staff["']\) \? ["']\/staff\/login["'] : ["']\/login["'];\s*url\.search = ["']["'];[\s\S]*url\.searchParams\.set\(["']redirect["'], requestedPath\)/,
  );
});
