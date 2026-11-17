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
  // 2026-11-17: 옛 선생님 앱 설치 안내(/staff/install) 대신 스토어 앱 설치 안내(/install) 하나로 간다.
  assert.ok(menuSource.includes('href="/install"'), "앱 설치 안내 바로가기가 있어야 합니다.");
  assert.ok(!menuSource.includes('href="/staff/install"'), "옛 설치 안내 주소로 보내지 않습니다.");
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

test("선생님 홈에서 수업 진행 중일 때도 메뉴 이동은 저장 확인을 거친다 — 수업이 없으면 바로 이동", async () => {
  // 순수 판단을 실제로 돌려 본다
  const { loadTsModule } = await import("./_ts-module.mjs");
  const { shouldConfirmStaffLeave } = await loadTsModule("src/app/staff/staffNavigation.ts");
  // 수업 주소는 표시와 무관하게 늘 확인(예전과 같다)
  assert.equal(shouldConfirmStaffLeave("/staff/sessions/abc", false), true);
  assert.equal(shouldConfirmStaffLeave("/staff/sessions/abc", true), true);
  // 홈: 진행 중 수업 칸이 펼쳐져 있을 때만
  assert.equal(shouldConfirmStaffLeave("/staff", true), true);
  assert.equal(shouldConfirmStaffLeave("/staff", false), false, "진행 중 수업이 없으면 확인 창이 뜨지 않는다");
  // 그 밖의 화면은 표시가 남아 있어도 확인하지 않는다
  for (const path of ["/staff/students", "/staff/mypage", "/staff/annual", "/staff/sessions", "/staffx", "/admin", "", null, undefined]) {
    assert.equal(shouldConfirmStaffLeave(path, true), false, String(path));
    assert.equal(shouldConfirmStaffLeave(path, false), false, String(path));
  }
  // 메뉴: 홈의 «수업 중» 표시를 듣고(서버에서는 false), 그 판단으로 이동을 보류한다
  assert.match(menuSource, /useSyncExternalStore\(subscribeStaffLiveLesson, isStaffLiveLessonOpen, \(\) => false\)/);
  assert.match(menuSource, /const needsLeaveConfirm = shouldConfirmStaffLeave\(pathname, liveLessonOpen\);/);
  assert.match(menuSource, /if \(!needsLeaveConfirm\) \{\s*setIsOpen\(false\);\s*return;\s*\}\s*event\.preventDefault\(\);/);
});

test("확인 창을 거친 화면 전환도 «마지막 화면»으로 기억한다 — 저장이 끝나 이동이 확정될 때만", async () => {
  const { loadTsModule } = await import("./_ts-module.mjs");
  const { parseLastViewKey } = await loadTsModule("src/lib/auth/last-view.ts");
  // 화면 전환 항목의 키만 남고, 가족 연결·내 계정·없는 값은 기억하지 않는다
  for (const key of ["admin", "teacher", "driver", "parent"]) assert.equal(parseLastViewKey(key), key);
  for (const key of ["family", "account", "", undefined, null]) assert.equal(parseLastViewKey(key), null, String(key));
  // 보류할 때 화면 키를 같이 들고, 화면 전환 목록만 키를 넘긴다(마이페이지·설치 안내는 넘기지 않는다)
  assert.match(menuSource, /setPendingHref\(href\);\s*setPendingViewKey\(parseLastViewKey\(viewKey\)\);/);
  assert.match(menuSource, /requestPublicNavigation\(event, view\.href, view\.key\)/);
  assert.match(menuSource, /requestPublicNavigation\(event, "\/staff\/mypage"\)\}/);
  assert.match(menuSource, /requestPublicNavigation\(event, "\/install"\)\}/);
  // 기억은 저장 성공 뒤·이동 직전에만: 저장 실패(return)보다 뒤, assign 바로 앞
  const leave = /const leaveSession = async \(\) => \{([\s\S]*?)\n  \};/.exec(menuSource)[1];
  assert.match(leave, /if \(pendingViewKey\) rememberLastView\(pendingViewKey\);\s*window\.location\.assign\(pendingHref\);/);
  // 화면이 떠나지 않았을 때(스토어 앱으로 넘어감 등) 확인 창이 굳지 않게 잠금을 푼다
  assert.match(leave, /window\.setTimeout\(\(\) => setLeaving\(false\), 4000\);\s*$/);
  assert.ok(leave.indexOf("if (!result.ok)") < leave.indexOf("rememberLastView"), "저장 실패면 기억하지 않는다");
  // 취소(닫기·Esc)하면 키를 버린다
  assert.equal((menuSource.match(/setPendingViewKey\(null\)/g) || []).length, 2);
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
  assert.match(sessionSource, /askConfirm\("수업이 진행 중입니다/);
  assert.match(sessionSource, /voiceBusyRef\.current/);
  assert.match(sessionSource, /await persistMemo\(memoRef\.current\)/);
  assert.match(sessionSource, /history\.go\(-2\)/);
  assert.match(sessionSource, /else window\.location\.assign\("\/staff"\)/);
  assert.match(sessionSource, /removeEventListener\("popstate"/);
});

test("전체 출석은 학생별 성공 결과를 즉시 반영하고 부분 실패를 안내한다", () => {
  // 2026-11-13 b1: 대상은 결석 신고 아이를 뺀 targets, 서버에도 bulk 표시를 보내 한 번 더 거른다.
  assert.match(sessionSource, /for \(const \[index, student\] of targets\.entries\(\)\)/);
  assert.match(sessionSource, /status: "PRESENT",\s*bulk: true,/);
  assert.match(sessionSource, /row\.id === student\.id\s*\?\s*\{ \.\.\.row, status: "PRESENT"/);
  assert.match(sessionSource, /화면에 반영된 학생은 저장됐으니 남은 학생만 다시 처리해 주세요/);
  assert.match(sessionSource, /aria-busy=\{pending && bulkBusy\}/);
  // 결석 신고 아이 수를 버튼 바로 아래에 안내한다.
  assert.match(sessionSource, /bulkReportedNotice\(bulkSplit\.reported\.length\)/);
});

test("개별 출석 네트워크 예외와 전체 처리 결과를 버튼 가까이 안내한다", () => {
  // 2026-11-13 b5: 개별 저장 실패는 맨 위 한 칸이 아니라 그 아이 줄 아래에 보인다.
  assert.match(sessionSource, /setRowNotice\(rowId, "저장하지 못했습니다\. 연결을 확인하고 다시 눌러 주세요\."\)/);
  assert.match(sessionSource, /rowNotices\[student\.id\]\.tone === "error" \? \(\s*<p role="alert"/);
  // 건너뜀·참고 안내는 오류색이 아니라 주의색(검수 4). 2026-11-13 UI 통일: 장식 아이콘(info·error)은 뺐다 — 역할(status/alert)·색으로 구분한다
  assert.match(sessionSource, /<p role="status" className="mt-1 text-xs text-\[var\(--color-academy-warning\)\]">\s*\{rowNotices\[student\.id\]\.text\}/);
  assert.match(sessionSource, /<p role="alert" className="mt-1 text-xs font-semibold text-\[var\(--color-academy-danger\)\]">\s*\{rowNotices\[student\.id\]\.text\}/);
  assert.match(sessionSource, /setRowNotice\(student\.id, result\.message \?\? "", "notice"\)/);
  // 특강 정규 기록 실패는 그 줄에 «다시 눌러 주세요»(검수 2)
  assert.match(sessionSource, /if \(recordWarning\) setRowNotice\(rowId, recordWarning, "error"\)/);
  assert.match(sessionSource, /role="alert" aria-live="assertive"/);
});
