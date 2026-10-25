/**
 * 스토어 앱(구글플레이·앱스토어에 올린 통합 앱)으로 열렸는지 — 브라우저 전용 판정.
 *
 * 왜 따로 알아야 하나: 기존 설치 앱(학부모·선생님·기사님 PWA)은 제 영역(/mypage·/staff·/driver)을
 * 벗어나면 브라우저로 새어 나가서, 그 밖으로 가는 링크를 막거나 숨긴다(useInstalledApp).
 * 스토어 앱은 **사이트 전체가 앱 영역**이라 이 제한이 필요 없고, 남겨 두면 「앱 밖으로 이동」 같은
 * 틀린 안내가 뜨거나 쓸 수 있는 링크가 사라진다.
 *
 * ⚠️ 표식은 sessionStorage 에 둔다. 안드로이드 스토어 앱(TWA)은 휴대폰의 크롬과 저장소를 공유한다.
 *    localStorage 에 두면 스토어 앱을 한 번 연 뒤 크롬·기존 설치 앱에서도 제한이 풀려, 2026-08 처럼
 *    설치 앱이 영역 밖으로 새는 사고가 다시 난다. sessionStorage 는 탭(앱 화면)마다 따로라 섞이지 않는다.
 *    스토어 앱은 실행할 때마다 시작 주소(/store-app)를 거치므로 그때 다시 찍힌다.
 */
export const STORE_APP_FLAG_KEY = "stiz-store-app";

export function markStoreApp() {
  try {
    window.sessionStorage.setItem(STORE_APP_FLAG_KEY, "1");
  } catch {
    // 저장소를 못 쓰면(사생활 보호 모드 등) 기존 설치 앱처럼 동작한다 — 링크가 덜 보일 뿐 새지는 않는다.
  }
}

export function isStoreApp(): boolean {
  try {
    return window.sessionStorage.getItem(STORE_APP_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
