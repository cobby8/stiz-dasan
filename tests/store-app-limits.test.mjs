// 스토어 앱 «못 하는 일» 우회 실행·정적 테스트 + 마이페이지 통신 실패 안내(d1·d2·d5, 2026-11-13)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOutsideHref, SAME_SITE_OUTSIDE_REDIRECT_PATHS } from "../src/lib/outsideLinkRules.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// storeApp.ts 는 window 를 쓰므로 가짜 sessionStorage 를 끼워 실제 함수를 실행한다
function withSession(entries, fn) {
  const store = new Map(Object.entries(entries));
  globalThis.window = { sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } };
  try { return fn(store); } finally { delete globalThis.window; }
}
const storeApp = await import("../src/lib/storeApp.ts");

test("브라우저(표식 없음)에서는 아무것도 숨기지 않는다", () => {
  withSession({}, () => {
    for (const cap of ["push", "links", "geolocation", "voice", "install", "sms"]) assert.equal(storeApp.storeAppLacks(cap), false, cap);
  });
});

test("스토어 앱 + 신호 없음 = 전부 우회", () => {
  withSession({ "stiz-store-app": "1" }, () => {
    for (const cap of ["push", "links", "geolocation", "voice", "install", "sms"]) assert.equal(storeApp.storeAppLacks(cap), true, cap);
  });
});

test("앱 새 버전이 caps 를 보내면 그 기능의 우회만 자동으로 꺼진다", () => {
  withSession({ "stiz-store-app": "1" }, (store) => {
    storeApp.recordStoreAppCapabilities(" push, links ,모름");
    assert.equal(store.get("stiz-store-app-caps"), "push,links");
    assert.equal(storeApp.storeAppLacks("push"), false);
    assert.equal(storeApp.storeAppLacks("links"), false);
    assert.equal(storeApp.storeAppLacks("geolocation"), true);
    // 빈 신호는 기존 기억을 지우지 않는다
    storeApp.recordStoreAppCapabilities(null);
    assert.equal(store.get("stiz-store-app-caps"), "push,links");
  });
});

test("바깥 주소 판정: 다른 사이트만 바깥, 우리 사이트는 앱 안(쇼핑몰로 넘기는 /apply/uniform 만 예외)", () => {
  const origin = "https://stiz-academy.example";
  assert.equal(isOutsideHref("https://pf.kakao.com/_abc", origin), true);
  assert.equal(isOutsideHref("https://www.instagram.com/stiz", origin), true);
  assert.equal(isOutsideHref("https://xyz.supabase.co/storage/v1/object/public/a.pdf", origin), true);
  assert.equal(isOutsideHref("https://stiz.kr/product/detail.html?product_no=1", origin), true);
  assert.equal(isOutsideHref(`${origin}/schedule`, origin), false);
  assert.equal(isOutsideHref("/notices/1", origin), false);
  assert.equal(isOutsideHref(`${origin}/apply/uniform`, origin), true);
  assert.equal(isOutsideHref(`${origin}/apply/uniform/`, origin), true);
  assert.equal(isOutsideHref(`${origin}/apply/uniform/free/tok`, origin), false);
  assert.equal(isOutsideHref("tel:01012345678", origin), false);
  assert.equal(isOutsideHref("sms:01012345678", origin), false);
  assert.ok(SAME_SITE_OUTSIDE_REDIRECT_PATHS.includes("/apply/uniform"));
  // /apply/uniform 이 정말 바깥으로 넘기는지(넘기지 않게 바뀌면 이 예외도 지운다)
  assert.match(read("src/app/apply/uniform/page.tsx"), /permanentRedirect\("https:\/\/stiz\.kr/);
});

test("바깥 링크 적용 위치 — data-outside-link(또는 영역 표시)가 붙어 있다", () => {
  const marked = [
    "src/app/mypage/payments/PaymentRequestClient.tsx",
    "src/components/PublicFooter.tsx",
    "src/app/mypage/news/[id]/page.tsx",
    "src/app/notices/[id]/page.tsx",
    "src/app/annual/EventDetailPanel.tsx",
    "src/app/staff/quick-post/QuickPostClient.tsx",
    "src/app/shop/product/[productNo]/ShopProductFrame.tsx",
  ];
  for (const file of marked) assert.match(read(file), /data-outside-link\b/, file);
  // 공지 본문(리치 에디터·옛 글) 영역 표시
  for (const file of ["src/app/notices/[id]/page.tsx", "src/app/mypage/news/[id]/page.tsx"]) {
    assert.equal((read(file).match(/data-outside-links\b/g) ?? []).length, 2, file);
  }
  assert.match(read("src/lib/noticeContent.ts"), /rel="noopener noreferrer" data-outside-link /);
  // 루트 레이아웃이 듣는다
  assert.match(read("src/app/layout.tsx"), /<OutsideLinkListener \/>/);
  // 쇼핑몰 구매 화면은 앱에서 iframe 대신 주소 복사
  assert.match(read("src/app/shop/product/[productNo]/ShopProductFrame.tsx"), /appCannotOpen = useStoreAppLacks\("links"\)/);
});

test("안 되는 버튼은 한 곳의 판정(useStoreAppLacks)으로 숨기거나 바꾼다", () => {
  const cases = [
    ["src/app/mypage/settings/SettingsClient.tsx", "push", /앱 알림은 준비 중이에요\. 중요한 안내는 문자·카카오톡으로 보내드려요/],
    ["src/components/push/StaffPushControls.tsx", "push", /앱 알림은 준비 중이에요/],
    ["src/app/staff/StaffProfileMenu.tsx", "install", /!hideInstallGuide && <Link href="\/staff\/install"/],
    ["src/app/invite/[token]/InviteAcceptForm.tsx", "install", /showInstall \? "스태프 앱 설치하기" : "로그인하러 가기"/],
    ["src/components/maps/LocationPickerModal.tsx", "geolocation", /!appLacksGeolocation && <button type="button" onClick=\{useCurrentLocation\}/],
    ["src/components/staff/VoiceToTextButton.tsx", "voice", /if \(appLacksVoice\) return null;/],
    ["src/app/staff/students/StaffStudentsClient.tsx", "sms", /번호 복사/],
  ];
  for (const [file, cap, pattern] of cases) {
    const src = read(file);
    assert.match(src, new RegExp(`useStoreAppLacks\\("${cap}"\\)`), file);
    assert.match(src, pattern, file);
    // 화면마다 따로 판정하지 않는다(isStoreApp 직접 호출 금지 — 앱 신호로 한 번에 끌 수 없게 된다)
    assert.doesNotMatch(src, /isStoreApp\(\)/, file);
  }
});

test("마이페이지 통신 실패는 그 자리 안내(d1)·첫 화면 부분 실패는 빈 값(d5)", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /catch \{[\s\S]*?setReqError\("보내지 못했습니다\. 다시 시도해 주세요\."\);\s*return;/);
  assert.match(home, /학원에 메시지를 보냈어요/);
  const settings = read("src/app/mypage/settings/SettingsClient.tsx");
  assert.equal((settings.match(/\.catch\(\(\) => \(\{ ok: false as const, error: "보내지 못했습니다\. 다시 시도해 주세요\." \}\)\)/g) ?? []).length, 3);
  const bell = read("src/app/mypage/ParentNotificationBell.tsx");
  assert.match(bell, /await markAllMyNotificationsRead\(\);\s*\} catch \{/);
  assert.match(bell, /await markMyNotificationRead\(id\);\s*\} catch \{/);
  const roles = read("src/app/mypage/roles/RolesClient.tsx");
  assert.equal((roles.match(/\.catch\(\(\) => \(\{ error: "NETWORK" as const \}\)\)/g) ?? []).length, 2);
  const page = read("src/app/mypage/page.tsx");
  for (const call of ["getNoticesByClassIds(classIds, 10)", "getMyRequests(data.parent.id)", "getParentShuttleOverview(parentAuth.appUserId)", "getShuttleDriverContact()"]) {
    assert.ok(page.includes(`${call}.catch(`), call);
  }
  // 오류 화면: 마이페이지(레이아웃 안 — 하단 탭 유지) + 전체(html/body 포함·한국어)
  const err = read("src/app/mypage/error.tsx");
  assert.match(err, /^"use client";/);
  assert.match(err, /다시 시도/);
  const globalErr = read("src/app/global-error.tsx");
  assert.match(globalErr, /<html lang="ko">/);
  assert.match(globalErr, /<body/);
  assert.match(globalErr, /다시 시도/);
  assert.doesNotMatch(globalErr, /^import /m, "global-error 는 다른 모듈을 쓰지 않는다(레이아웃이 깨진 상황용)");
});

test("검수 권장 반영: 문의 2,000자 제한·남은 글자, 오류 화면 다시 시도 = refresh+reset, 관리자 확인 요청당 한 번", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /maxLength=\{2000\}/);
  assert.match(home, /\{reqContent\.length\.toLocaleString\("ko-KR"\)\} \/ 2,000자/);
  const err = read("src/app/mypage/error.tsx");
  assert.match(err, /startTransition\(\(\) => \{ router\.refresh\(\); reset\(\); \}\)/);
  const guard = read("src/lib/auth-guard.ts");
  assert.match(guard, /import \{ cache \} from "react";/);
  assert.match(guard, /export const requireAdmin: \(\) => Promise<AdminAuthUser> = cache\(requireAdminUncached\);/);
  assert.match(guard, /export const requireOwner\b[^\n]*= cache\(requireOwnerUncached\);/);
  // 쿠키를 읽는 확인은 unstable_cache(여러 요청이 공유) 안에 두면 안 된다 — 주석 속 낱말은 빼고 본다
  assert.doesNotMatch(guard.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""), /unstable_cache/);
});
