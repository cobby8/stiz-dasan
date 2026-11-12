/**
 * 바깥 주소 링크 — 스토어 앱에서 열 수 없는 주소를 «복사 + 안내»로 바꾸는 공용 도구(d2, 2026-11-13).
 *
 * 쓰는 법: 바깥으로 나가는 <a> 에 `data-outside-link` 속성만 붙인다.
 *   <a href="https://pf.kakao.com/..." target="_blank" rel="noopener noreferrer" data-outside-link>
 * 루트 레이아웃의 OutsideLinkListener 가 이 속성이 붙은 링크의 누름만 가로챈다(그 밖의 링크는 손대지 않는다).
 * 서버 컴포넌트·HTML 문자열(공지 본문)에서도 그대로 쓸 수 있게 «속성 + 위임 듣기» 방식으로 만들었다.
 *
 * 브라우저·기존 설치 앱에서는 아무 일도 하지 않는다(그대로 열린다).
 * 판정은 storeAppLacks("links") 한 곳 — 앱 새 버전이 caps=links 를 보내면 자동으로 꺼진다.
 */
import { storeAppLacks } from "@/lib/storeApp";
import { isOutsideHref } from "@/lib/outsideLinkRules";

export const OUTSIDE_LINK_ATTR = "data-outside-link";
/** 이 속성이 붙은 영역(공지 본문 등) 안의 링크 전부를 같은 규칙으로 다룬다 — 리치 에디터 링크는 속성을 못 달아서 */
export const OUTSIDE_LINK_AREA_ATTR = "data-outside-links";

export const OUTSIDE_LINK_COPIED_MESSAGE =
  "앱에서는 열 수 없는 주소예요. 주소를 복사했어요 — 휴대폰 브라우저에 붙여 넣어 주세요.";
export const OUTSIDE_LINK_COPY_FAILED_MESSAGE =
  "앱에서는 열 수 없는 주소예요. 휴대폰 브라우저에서 아래 주소를 열어 주세요.";

/** 글을 클립보드에 복사. 성공하면 true. (WebView 에서 clipboard API 가 막혀 있으면 옛 방식으로 한 번 더) */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 아래 옛 방식으로
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 화면 아래쪽에 잠깐 뜨는 안내 한 줄(4초). React 밖(위임 듣기)에서도 쓰려고 DOM 으로 직접 만든다.
 * 색은 테마 변수만 쓴다.
 */
export function showAppToast(message: string, detail?: string) {
  const id = "stiz-app-toast";
  document.getElementById(id)?.remove();
  const box = document.createElement("div");
  box.id = id;
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  box.style.cssText = [
    "position:fixed", "left:12px", "right:12px", "bottom:calc(76px + env(safe-area-inset-bottom))", "z-index:9999",
    "margin:0 auto", "max-width:480px", "padding:12px 14px", "border-radius:12px",
    "background:var(--color-academy-ink)", "color:var(--color-academy-surface)",
    "font-size:14px", "line-height:1.45", "font-weight:600", "box-shadow:0 6px 20px var(--color-academy-shadow)",
    "word-break:break-all",
  ].join(";");
  box.textContent = message;
  if (detail) {
    const small = document.createElement("div");
    small.style.cssText = "margin-top:4px;font-size:12px;font-weight:400;opacity:.85";
    small.textContent = detail;
    box.appendChild(small);
  }
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), detail ? 8000 : 4000);
}

/** 바깥 주소를 «열 수 없으니 복사» 처리 + 안내 한 줄(복사가 막히면 주소를 안내에 같이 보여 준다). */
export async function copyInsteadOfOpening(url: string): Promise<void> {
  const copied = await copyText(url);
  if (copied) showAppToast(OUTSIDE_LINK_COPIED_MESSAGE);
  else showAppToast(OUTSIDE_LINK_COPY_FAILED_MESSAGE, url);
}

/** 링크를 누른 순간: 스토어 앱이고 바깥 주소를 못 열면 이동을 막고 복사 안내. 처리했으면 true. */
export function interceptOutsideLinkClick(event: MouseEvent | { preventDefault(): void }, href: string): boolean {
  if (!href || !storeAppLacks("links")) return false;
  // 우리 사이트 안 주소는 앱 안에서 그대로 연다(바깥으로 넘기는 경로만 예외 — outsideLinkRules)
  if (!isOutsideHref(href, window.location.origin)) return false;
  event.preventDefault();
  void copyInsteadOfOpening(href);
  return true;
}
