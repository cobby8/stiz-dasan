import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutSource = await readFile("src/app/staff/layout.tsx", "utf8");
const menuSource = await readFile("src/app/staff/StaffProfileMenu.tsx", "utf8");
const homeLinkSource = await readFile("src/app/staff/StaffHomeLink.tsx", "utf8");
const navigationSource = await readFile("src/app/staff/staffNavigation.ts", "utf8");
const sessionSource = await readFile("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", "utf8");
const manifest = JSON.parse(await readFile("public/manifest-staff.json", "utf8"));
const middlewareSource = await readFile("src/lib/supabase/middleware.ts", "utf8");
const nextConfigSource = await readFile("next.config.ts", "utf8");

test("교사용 상단 프로필은 앱 설치 안내와 로그아웃만 제공한다", () => {
  assert.match(layoutSource, /<StaffProfileMenu staffName=\{staff\.appUserName\}/);
  assert.ok(menuSource.includes('href="/staff/install"'), "설치 안내 바로가기가 있어야 합니다.");
  assert.match(menuSource, /action=\{logoutStaff\}/);
  // 선생님 앱의 manifest scope 는 /staff 다. 공개 홈페이지로 나가면 설치된 앱을
  // 벗어나 브라우저로 튕기므로 프로필 메뉴에 공개 홈페이지 링크를 두지 않는다.
  for (const href of ["/notices", "/programs", "/schedule", "/gallery"]) {
    assert.ok(
      !menuSource.includes(`href="${href}"`) && !menuSource.includes(`href: "${href}"`),
      `${href} 링크는 선생님 앱을 벗어나므로 없어야 합니다.`,
    );
  }
});

test("로그인 직후 역할 판별도 staff scope 안에서 이뤄진다", () => {
  // /auth/continue 는 scope(/staff) 밖이라 설치된 앱이 그 순간 브라우저로 튕긴다.
  assert.match(middlewareSource, /isStaffLogin \? "\/staff\/continue" : "\/auth\/continue"/);
  assert.match(nextConfigSource, /source: "\/staff\/continue"/);
  assert.match(nextConfigSource, /destination: "\/auth\/continue"/);
  // continue 경로가 redirect 목적지로 되돌아오면 무한 리다이렉트가 된다.
  assert.match(middlewareSource, /!isContinuePath\(requestedPath\)/);
});

test("수업 중 다른 화면으로 이동할 때 자동 저장 확인을 거친다", () => {
  assert.match(menuSource, /pathname\.startsWith\("\/staff\/sessions\/"\)/);
  assert.match(menuSource, /event\.preventDefault\(\)/);
  assert.match(menuSource, /prepareStaffNavigation/);
  assert.match(navigationSource, /staff:prepare-navigation/);
  assert.match(menuSource, /저장이 완료되지 않으면 현재 화면에 머무릅니다/);
  assert.match(menuSource, /role="alertdialog"/);
  assert.match(sessionSource, /staff:prepare-navigation/);
  assert.match(sessionSource, /await persistMemo\(memoRef\.current\)/);
  assert.match(menuSource, /수업 종료 후 로그아웃/);
});

test("교사용 PWA 범위는 staff 내부로 유지한다", () => {
  assert.equal(manifest.scope, "/staff");
});

test("수업 중 교사용 로고도 메모 저장 확인 뒤 홈으로 이동한다", () => {
  assert.match(layoutSource, /<StaffHomeLink\b[^>]*\/>/);
  assert.match(homeLinkSource, /pathname\.startsWith\("\/staff\/sessions\/"\)/);
  assert.match(homeLinkSource, /await prepareStaffNavigation\(\)/);
  assert.match(homeLinkSource, /저장 후 홈 이동/);
  assert.match(homeLinkSource, /role="alert"/);
});

test("시스템 뒤로가기도 수업 기록 저장 성공 뒤에만 허용한다", () => {
  assert.match(sessionSource, /history\.pushState\(/);
  assert.match(sessionSource, /addEventListener\("popstate"/);
  assert.match(sessionSource, /window\.confirm\("수업이 진행 중입니다/);
  assert.match(sessionSource, /voiceBusyRef\.current/);
  assert.match(sessionSource, /await persistMemo\(memoRef\.current\)/);
  assert.match(sessionSource, /history\.go\(-2\)/);
  assert.match(sessionSource, /else window\.location\.assign\("\/staff"\)/);
  assert.match(sessionSource, /removeEventListener\("popstate"/);
});

test("전체 출석은 학생별 성공 결과를 즉시 반영하고 부분 실패를 안내한다", () => {
  assert.match(sessionSource, /for \(const \[index, student\] of unchecked\.entries\(\)\)/);
  assert.match(sessionSource, /row\.id === student\.id \? \{ \.\.\.row, status: "PRESENT" \}/);
  assert.match(sessionSource, /화면에 반영된 학생은 저장됐으니 남은 학생만 다시 처리해 주세요/);
  assert.match(sessionSource, /aria-busy=\{pending && Boolean\(bulkAttendanceProgress\)\}/);
});

test("개별 출석 네트워크 예외와 전체 처리 결과를 버튼 가까이 안내한다", () => {
  assert.match(sessionSource, /출석을 저장하지 못했습니다\. 네트워크를 확인한 뒤 다시 시도해 주세요/);
  assert.match(sessionSource, /role="alert" aria-live="assertive"/);
});
