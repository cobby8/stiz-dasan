// 게슈탈트 디자인 점검(관리자 영역) 적용 약속을 소스 수준에서 못박는다.
// 근접성(위험은 멀리) · 유사성(주인공 하나·위험은 빨강) · 전경과 배경(확인 창) — 되돌아가면 깨진다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const quickMenu = read("../src/components/admin/AdminQuickActionMenu.tsx");

test("C-A1 ⚡ 메뉴: 위험 항목은 구분선 아래로 모이고 학원 위험색을 쓴다", () => {
  assert.match(quickMenu, /export function splitQuickActions/);
  assert.match(quickMenu, /action\.tone !== "danger"/);
  assert.match(quickMenu, /role="separator"/);
  assert.match(quickMenu, /\{danger\.map\(renderAction\)\}/);
  // 일반 항목이 위험 항목보다 먼저 그려진다
  assert.ok(quickMenu.indexOf("{safe.map(renderAction)}") < quickMenu.indexOf("{danger.map(renderAction)}"));
  assert.match(quickMenu, /text-\[var\(--color-academy-danger\)\]/);
  assert.doesNotMatch(quickMenu, /text-red-700|bg-red-50b/);
});

test("C-A1 ⚡ 메뉴: primary 는 흰 글씨, 항목 44px, 대상 이름 줄, 누르는 영역 44px", () => {
  assert.match(quickMenu, /text-\[var\(--color-academy-on-primary\)\]/);
  assert.doesNotMatch(quickMenu, /bg-brand-neon-lime text-brand-navy-900 shadow-sm hover:brightness-95"/);
  assert.match(quickMenu, /min-h-11/);
  assert.doesNotMatch(quickMenu, /flex h-9 w-full/);
  assert.match(quickMenu, /title=\{label\}>\{label\}<\/p>/);
  assert.match(quickMenu, /h-9 w-9[^"]*before:-inset-1/);
  // 위치 계산이 44px 항목·머리줄·구분선을 반영한다
  assert.match(quickMenu, /ACTION_HEIGHT = 48/);
  assert.match(quickMenu, /HEADER_HEIGHT \+ actionCount \* ACTION_HEIGHT/);
  // 열린 동안 그 행 옅은 강조, 닫히면 복원
  assert.match(quickMenu, /row\.style\.backgroundColor = "var\(--color-academy-primary-soft\)"/);
  assert.match(quickMenu, /row\.style\.backgroundColor = previousRowBackground/);
});
