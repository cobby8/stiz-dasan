// 스토어 앱 설치 링크 — 가입 안내 문자의 «앱 설치» 짧은 주소(/install)가 기기별로 어디로 보낼지 정한다(2026-11-13 f10).
//
// 왜 한 곳에: 문자에는 주소 하나만 넣고(안드로이드·아이폰 링크를 둘 다 넣으면 문자가 길어지고 헷갈린다),
// 그 주소가 기기를 보고 Play 스토어 / App Store 로 나눠 보낸다. 스토어 주소가 바뀌면 이 파일만 고친다.
// ⚠️ import 가 없는 순수 모듈 — tests/app-install-links.test.mjs 가 그대로 실행한다.

/** 안드로이드·iOS 공통 앱 ID(스토어 release) — docs/store-release.md */
export const STORE_APP_PACKAGE = "kr.co.upturnlabs.stizdasan";

/** Play 스토어 앱 상세 주소 */
export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${STORE_APP_PACKAGE}`;

/**
 * App Store 앱 번호(apps.apple.com/kr/app/id«숫자» 의 숫자).
 * 2026-11-13 App Store 승인·공개(스티즈농구교실 1.0) → 채웠다. 비우면 아이폰은 «곧 출시» 안내 + 웹으로 쓰기 버튼을 본다.
 */
export const IOS_APP_STORE_ID = "6832261596";

/** 짧은 설치 주소(문자에 넣는 주소). 페이지는 src/app/install/page.tsx */
export const APP_INSTALL_PATH = "/install";

/** App Store 주소 — 앱 번호가 없으면 null */
export function appStoreUrl(appStoreId: string = IOS_APP_STORE_ID): string | null {
  const id = String(appStoreId ?? "").trim();
  // 숫자만 허용 — 잘못 넣은 값으로 엉뚱한 곳에 보내지 않게
  return /^\d+$/.test(id) ? `https://apps.apple.com/kr/app/id${id}` : null;
}

/**
 * 안드로이드 Play 스토어 «앱»을 직접 여는 intent 주소.
 * 카카오톡 등 인앱 브라우저는 https Play 주소를 자기 창 안의 웹 페이지로 열어 버려 설치 버튼이 안 먹는 경우가 있다.
 * intent 로 Play 스토어 앱(com.android.vending)을 열고, 못 열면 https Play 주소로 돌아간다(browser_fallback_url).
 */
export const PLAY_STORE_INTENT_URL =
  `intent://details?id=${STORE_APP_PACKAGE}#Intent;scheme=market;package=com.android.vending;`
  + `S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;

export type AppInstallTarget =
  | { kind: "redirect"; url: string } // 바로 스토어로 보낸다
  | { kind: "android-in-app"; intentUrl: string; url: string } // 안드로이드 인앱 브라우저 → 버튼(intent)으로 Play 스토어 앱 열기
  | { kind: "ios-coming-soon" } // 아이폰인데 App Store 출시 전 → 안내 화면
  | { kind: "choose" }; // PC 등 기기를 모름 → 두 스토어 버튼을 보여 준다

/**
 * 기기 종류(platform)로 갈 곳을 정한다. 기기 판별 자체는 @/lib/pwa/installEnvironment 한 곳에서 하고
 * 그 결과(platform·인앱 브라우저 여부)만 받는다 — 판별 규칙이 두 군데로 갈라지지 않게.
 */
export function resolveAppInstallTarget(
  platform: "ios" | "android" | "other",
  appStoreId: string = IOS_APP_STORE_ID,
  options: { inAppBrowser?: string | null } = {},
): AppInstallTarget {
  if (platform === "android") {
    // 인앱 브라우저는 서버 리다이렉트로 intent 를 보내면 무시되는 경우가 있어, 사람이 누르는 버튼으로 연다(확실한 쪽)
    if (options.inAppBrowser) return { kind: "android-in-app", intentUrl: PLAY_STORE_INTENT_URL, url: PLAY_STORE_URL };
    return { kind: "redirect", url: PLAY_STORE_URL };
  }
  if (platform === "ios") {
    const url = appStoreUrl(appStoreId);
    return url ? { kind: "redirect", url } : { kind: "ios-coming-soon" };
  }
  return { kind: "choose" };
}
