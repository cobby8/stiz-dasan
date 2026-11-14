import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backButtonSource = await readFile("src/components/AppBackButton.tsx", "utf8");
const standaloneBackButtonSource = await readFile("src/components/StandaloneBackButton.tsx", "utf8");
const rootLayoutSource = await readFile("src/app/layout.tsx", "utf8");
const publicHeaderSource = await readFile("src/components/PublicHeader.tsx", "utf8");
const adminShellSource = await readFile("src/app/admin/AdminShellClient.tsx", "utf8");
const staffLayoutSource = await readFile("src/app/staff/layout.tsx", "utf8");
const mypageLayoutSource = await readFile("src/app/mypage/layout.tsx", "utf8");

test("공통 뒤로가기 버튼은 앱 내부 이력 우선, 없으면 fallback으로 이동한다", () => {
  assert.match(backButtonSource, /router\.back\(\)/);
  assert.match(backButtonSource, /router\.push\(action\.href\)/);
  assert.match(backButtonSource, /document\.referrer/);
  assert.match(backButtonSource, /window\.history\.state\?\.idx/);
  // 어디로 갈지 정하는 규칙은 순수 모듈로 옮겼다. 조합별 동작은 실제로 실행해서
  // 검증한다 → tests/app-back-button-scope.test.mjs
  assert.match(backButtonSource, /resolveBackAction/);
});

test("공개, 관리자, 스태프, 마이페이지 헤더에 뒤로가기 버튼이 배치된다", () => {
  // 속성이 늘어도 깨지지 않게 fallbackHref 값만 확인한다(설치 앱용 scopeHref 등이 붙는다).
  assert.match(publicHeaderSource, /<AppBackButton[^>]*fallbackHref="\/"[^>]*size="sm"/);
  assert.match(adminShellSource, /<AppBackButton[^>]*fallbackHref="\/admin"/);
  assert.match(staffLayoutSource, /<AppBackButton[^>]*fallbackHref="\/staff"/);
  // 2026-11-15 원장 결정: 학부모 화면은 돌아갈 기록이 없으면 학부모 홈(/mypage)으로
  assert.match(mypageLayoutSource, /<AppBackButton[^>]*fallbackHref="\/mypage"[^>]*size="sm"/);
  assert.equal((mypageLayoutSource.match(/<AppBackButton/g) || []).length, 2, "모바일·데스크탑 헤더 둘 다");
});

test("헤더가 없는 단독 화면은 전역 보조 뒤로가기 버튼으로 보완한다", () => {
  assert.match(rootLayoutSource, /<StandaloneBackButton \/>/);
  for (const prefix of ["/login", "/invite", "/payments", "/account/activate", "/auth/continue", "/signup/parent", "/teacher-app"]) {
    assert.ok(standaloneBackButtonSource.includes(prefix), `${prefix} should render standalone back button`);
  }
});
