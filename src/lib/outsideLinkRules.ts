/**
 * 바깥 주소 판정 규칙(순수 함수 — 테스트에서 바로 부른다). d2, 2026-11-13.
 *
 * `data-outside-link` 가 붙은 링크라도, 우리 사이트 안 주소면 앱 안에서 그대로 연다.
 * 공지 본문처럼 «글 속 주소에 전부 표시»하는 곳에서 우리 사이트 링크까지 막지 않으려고.
 * 단, 우리 주소지만 서버가 곧바로 바깥(쇼핑몰)으로 보내는 경로는 바깥 주소로 본다.
 */

/** 우리 주소지만 바깥으로 넘기는 경로(정확히 일치). /apply/uniform → stiz.kr 본사 상품(permanentRedirect) */
export const SAME_SITE_OUTSIDE_REDIRECT_PATHS = ["/apply/uniform"];

/** 이 주소를 스토어 앱에서 «열 수 없는 바깥 주소»로 다뤄야 하나 */
export function isOutsideHref(href: string, currentOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return false;
  }
  // 전화·문자·메일 같은 주소는 여기서 다루지 않는다(각 화면이 따로 처리)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== currentOrigin) return true;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return SAME_SITE_OUTSIDE_REDIRECT_PATHS.includes(path);
}
