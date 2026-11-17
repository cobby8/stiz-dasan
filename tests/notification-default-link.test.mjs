// 주소 없는 개별 알림(푸시)이 여는 화면(2026-11-17 화면 이동 전수 조사) — 실행·정적 테스트
//
// 지키려는 것: 예전 기본값 "/admin" 은 학부모·선생님에게도 갔다. 이제는 받는 사람 역할의 홈으로 넘겨 주는 주소로 보낸다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const { NOTIFICATION_DEFAULT_PUSH_PATH, resolveNotificationPushUrl } = await loadTsModule("src/lib/notification-link.ts");

test("알림에 주소가 있으면 그대로, 없으면 역할 홈으로 넘겨 주는 주소", () => {
  assert.equal(NOTIFICATION_DEFAULT_PUSH_PATH, "/auth/continue");
  for (const link of ["/admin/requests", "/mypage/rental", "/staff", "/admin"]) assert.equal(resolveNotificationPushUrl(link), link);
  for (const empty of [undefined, null, "", "   "]) assert.equal(resolveNotificationPushUrl(empty), "/auth/continue", JSON.stringify(empty));
});

test("개별 알림 발송은 이 규칙을 쓰고, 기본값으로 관리자 화면을 박아 두지 않는다", () => {
  const notification = stripComments(read("src/lib/notification.ts"));
  assert.match(notification, /url: resolveNotificationPushUrl\(data\.linkUrl\),/);
  assert.doesNotMatch(notification, /linkUrl \|\| "\/admin"/);
});

test("기본 주소는 받는 쪽이 열 수 있는 주소다 — 역할 판별 화면이 있고, 스토어 앱 표식을 찍지 않으며, 앱·서비스워커가 거르지 않는다", () => {
  // 화면이 실제로 있고, 역할 홈을 정하는 공용 함수로 보낸다
  const page = read("src/app/auth/continue/page.tsx");
  assert.match(page, /resolveContinueDestination\(/);
  // 스토어 앱 표식(/store-app 이 찍는 것)을 이 화면·판정 함수는 건드리지 않는다
  const flow = stripComments(page + read("src/lib/auth/continue-destination.ts"));
  assert.match(read("src/app/store-app/StoreAppStart.tsx"), /markStoreApp\(\)/, "표식 함수 이름이 바뀌었다 — 검사식을 고친다");
  assert.doesNotMatch(flow, /markStoreApp|buildStoreAppStartScript|@\/lib\/storeApp/);
  // 앱(FCM) 주소 검사를 그대로 통과한다(기본 화면 /store-app 으로 바뀌지 않는다)
  return loadTsModule("src/lib/push/nativePushPolicy.ts").then(({ safeNativePushPath }) => {
    assert.equal(safeNativePushPath(NOTIFICATION_DEFAULT_PUSH_PATH), "/auth/continue");
    // 아이폰·안드로이드 앱의 주소 정책도 /auth/continue 는 막지 않는다(그 밖의 /auth/… 만 막는다)
    assert.match(read("apps/stiz-ios/STIZ/NavigationPolicy.swift"), /path\.hasPrefix\("\/auth\/"\) && path != "\/auth\/continue"/);
    assert.match(read("apps/driver-android/app/src/main/java/kr/stiz/driver/AppNavigationPolicy.java"), /path\.startsWith\("\/auth\/oauth\/"\) \|\| path\.startsWith\("\/auth\/native\/"\)/);
  });
});
