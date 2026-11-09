/**
 * 학부모 화면 이동 도우미 — 순수 함수(DB·React·브라우저 없음).
 *
 * 1) safeInternalHref: 알림 linkUrl 을 «우리 사이트 안 주소»일 때만 돌려준다.
 *    '/' 로 시작하고 '//'·'/\' 가 아닌 값만 — 브라우저는 '//x.com'·'/\x.com' 을 바깥 사이트로 연다.
 * 2) pickChildId: 아이 칩 «마지막 선택» 고르기 — 주소(?child=) > 기기 기억(localStorage) > 서버 기본값.
 *    ⚠️ 보안: 후보는 서버가 이미 «내 자녀만» 골라 온 목록(childIds) 안에서만 고른다. 남의 학생 id 는 무시.
 */

/** 알림 이동 주소 — 내부 경로만 허용, 아니면 null(이동하지 않음) */
export function safeInternalHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const href = raw.trim();
  if (!href.startsWith("/")) return null; // 'https://…'·'javascript:'·상대 경로 차단
  if (href.startsWith("//") || href.startsWith("/\\")) return null; // 다른 사이트로 가는 꼴
  if (/[\\\u0000-\u001f\u007f]/.test(href)) return null; // 역슬래시·제어 문자(줄바꿈 등)로 우회하는 꼴
  return href;
}

/** 아이 선택 — 주소 값 > 기억한 값 > 기본값. 목록에 없는 id 는 건너뛴다 */
export function pickChildId(
  childIds: readonly string[],
  fromUrl: string | null | undefined,
  fromStorage: string | null | undefined,
  fallback: string,
): string {
  if (fromUrl && childIds.includes(fromUrl)) return fromUrl;
  if (fromStorage && childIds.includes(fromStorage)) return fromStorage;
  if (childIds.includes(fallback)) return fallback;
  return childIds[0] ?? fallback;
}

/** 기기에 «마지막으로 본 아이»를 적어 두는 칸 이름(홈·수업·일정 화면이 같이 쓴다) */
export const REMEMBERED_CHILD_KEY = "stiz.mypage.child";
