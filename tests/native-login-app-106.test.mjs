// 앱 1.0.6 간편로그인 수리(2026-11-17 운영 사고) 검사
// 1.0.5 는 같은 사이트 안의 화면 변화에도 진행 중인 로그인을 취소해, 크롬 탭이 뜨기 전에 요청이 끝나
// «로그인을 완료하지 못했습니다» 맨글자 화면이 떴다(카카오 15건 중 8건). 이 파일은 그 수리가 되돌아가지 않게 막는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (path) => fs.readFileSync(path, "utf8");
const android = read("apps/driver-android/app/src/main/java/kr/stiz/driver/NativeAuthController.java");
const androidPolicy = read("apps/driver-android/app/src/main/java/kr/stiz/driver/NativeAuthPolicy.java");
const mainActivity = read("apps/driver-android/app/src/main/java/kr/stiz/driver/MainActivity.java");
const ios = read("apps/stiz-ios/STIZ/NativeAuthCoordinator.swift");
const iosPolicy = read("apps/stiz-ios/STIZ/NativeAuthPolicy.swift");
const iosWeb = read("apps/stiz-ios/STIZ/WebViewController.swift");

test("취소 이유 목록이 서버·안드로이드·아이폰에서 같다", async () => {
  const service = await loadTsModule("src/lib/native-auth/service.ts", { "server-only": {} });
  const reasons = [...service.NATIVE_CANCEL_REASONS];
  assert.equal(reasons.length, 8);
  const listed = (source, pattern) => [...source.match(pattern)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed(androidPolicy, /CANCEL_REASONS = \{([^}]*)\}/), reasons);
  assert.deepEqual(listed(iosPolicy, /cancelReasons: Set<String> = \[([^\]]*)\]/), reasons);
  // 알 수 없는 값은 기록에 그대로 남기지 않는다
  assert.equal(service.nativeCancelReason("page_left"), "page_left");
  assert.equal(service.nativeCancelReason("<script>"), "unknown");
  assert.equal(service.nativeCancelReason(undefined), "unknown");
});

test("서버 취소 경로: 이유 한 단어만 기록하고 flow·state·비밀값은 남기지 않는다", () => {
  const route = read("src/app/auth/native/cancel/route.ts");
  assert.match(route, /nativeCancelReason\(body\.reason\)/);
  const logs = [...route.matchAll(/console\.\w+\(([^;]*)\);/g)].map((m) => m[1]);
  assert.ok(logs.length >= 1);
  for (const line of logs) assert.doesNotMatch(line, /flow|state|codeVerifier|body\b/);
});

test("안드로이드: 같은 사이트 안 화면 변화로는 취소하지 않고, 사이트 밖일 때만 취소한다", () => {
  assert.match(android, /void documentStarted\(String url\) \{\s*if \(pending != null && !trustedWebPage\(url\)\) cancel\("page_left"\);/);
  assert.match(android, /void navigation\(String url\) \{ if \(pending != null && !pending\.page\.equals\(url\) && !trustedWebPage\(url\)\) cancel\("page_left"\); \}/);
  // 복귀 때 «버튼 누른 그 주소» 일치 대신 «우리 사이트 화면»이면 이어서 로그인
  assert.doesNotMatch(android, /!attempt\.page\.equals\(web\.getUrl\(\)\)/);
  assert.match(android, /if \(!trustedWebPage\(web\.getUrl\(\)\)\) \{ cancel\("page_left"\)/);
  assert.match(androidPolicy, /static boolean cancelsAttempt\(String origin, String url\) \{ return url == null \|\| !AppNavigationPolicy\.sameOrigin\(origin, url\); \}/);
  // 복귀 검증(flow·state·5분·code 모양)은 그대로
  assert.match(androidPolicy, /elapsedMs > LIFETIME_MS/);
});

test("안드로이드: 맞춤 탭을 닫고 복귀 주소 없이 돌아오면 «취소» 창을 남기지 않고 정리한다", () => {
  assert.match(android, /if \(NativeAuthBrowser\.open\(activity, Uri\.parse\(browser\)\)\) attempt\.browserOpened = true;/);
  assert.match(android, /void paused\(\) \{ if \(pending != null && pending\.browserOpened\) pending\.leftApp = true; \}/);
  assert.match(android, /if \(pending == attempt && !destroyed\) cancel\("returned_empty"\); \}, RETURN_GRACE_MS\);/);
  assert.match(mainActivity, /protected void onResume\(\) \{ super\.onResume\(\); visible = true; if \(nativeAuth != null\) nativeAuth\.resumed\(\);/);
  assert.match(mainActivity, /protected void onPause\(\) \{ visible = false; if \(nativeAuth != null\) nativeAuth\.paused\(\);/);
  // 취소 이유는 정해진 목록 밖이면 app_closed 로 바꿔 보낸다
  assert.match(android, /\.put\("reason", known\)/);
});

test("아이폰: 15분 동안 창을 열어 두고, 사이트 안 이동으로는 취소하지 않는다", () => {
  assert.match(ios, /static let lifetime: TimeInterval = 15 \* 60/);
  assert.doesNotMatch(ios, /withTimeInterval: 300/);
  assert.doesNotMatch(ios, /func cancelIfPageChanged/);
  assert.doesNotMatch(iosWeb, /cancelIfPageChanged/);
  assert.match(ios, /guard let current = pending, let page = page, page != current\.page, !Self\.isWebsite\(page\) else \{ return \}/);
  assert.match(iosWeb, /case \.paymentStart:\s*paymentActive = true\s*nativeAuth\.cancelForExternalFlow\(\)/);
  assert.match(ios, /guard Self\.isWebsite\(current\.currentPage\(\)\),/);
  assert.match(ios, /"reason": known/);
  assert.match(iosPolicy, /가입을 마치셨다면 앱에서 다시 로그인해 주세요/);
});

test("버전: 안드로이드 1.0.6(빌드 9) · 아이폰 1.0.6", () => {
  assert.match(read("apps/driver-android/app/build.gradle"), /versionCode 9; versionName '1\.0\.6'/);
  assert.match(read("apps/stiz-ios/STIZ.xcodeproj/project.pbxproj"), /MARKETING_VERSION = 1\.0\.6; PRODUCT_BUNDLE_IDENTIFIER = kr\.co\.upturnlabs\.stizdasan/);
});

test("웹 가입: 앱에서 넘어온 가입은 완료 뒤 웹으로 이어 가지 않고 «앱으로 돌아가기»를 안내한다", () => {
  const client = read("src/components/auth/ParentSignupClient.tsx");
  assert.match(client, /const fromApp = searchParams\.get\("fromApp"\) === "1";/);
  assert.match(client, /if \(data\.sessionEstablished && !fromApp\) \{/);
  // 학원에 이미 등록된 보호자가 간편로그인으로 바로 연결된 경우(LINKED)도 웹으로 넘어가지 않는다
  assert.match(client, /if \(data\.existingParent === "LINKED"\) \{[\s\S]{0,200}if \(fromApp\) \{ setStep\("done"\); return; \}/);
  assert.match(client, /이제 앱으로 돌아가 주세요/);
  // 앱 주소(복귀 주소)를 여는 버튼은 두지 않는다 — 진행 중 요청 없이 열면 앱이 막는다
  assert.doesNotMatch(client, /kr\.co\.upturnlabs\.stizdasan:\/\//);
});
