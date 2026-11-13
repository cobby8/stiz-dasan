/**
 * 유튜브 연결 설정(2026-11-14) — 환경변수 읽기·구글 로그인 주소 만들기.
 *
 * 필요한 환경변수(값은 Vercel 에만):
 *   YOUTUBE_OAUTH_CLIENT_ID / YOUTUBE_OAUTH_CLIENT_SECRET : 구글 클라우드 «OAuth 클라이언트(웹)»
 *   YOUTUBE_TOKEN_ENCRYPTION_KEY                          : refresh token 암호화 키(32바이트 base64url)
 * 셋 중 하나라도 없으면 «설정 대기» — 연결 버튼을 막고, cron 도 아무것도 하지 않는다.
 *
 * ⚠️ 순수 모듈(env 는 인자로 받는다). 테스트가 그대로 불러 실행한다.
 */
import { readYoutubeTokenKey } from "@/lib/youtube/tokenCrypto";

/** 업로드 + 채널 확인(내 채널 이름 읽기)만. 그 밖의 권한은 받지 않는다. */
export const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const YOUTUBE_STATE_COOKIE = "stiz_yt_oauth_state";
export const DEFAULT_SITE_ORIGIN = "https://www.stiz-dasan.kr";

type Env = Record<string, string | undefined>;

export type YoutubeConfig =
  | { ready: true; clientId: string; clientSecret: string; encryptionKey: Buffer; redirectUri: string }
  | { ready: false; missing: string[] };

/** 사이트 주소(끝 / 제거) — 구글 콘솔 «승인된 리디렉션 URI» 와 글자 하나까지 같아야 한다 */
export function siteOrigin(env: Env): string {
  return (env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_ORIGIN).replace(/\/+$/, "");
}

export function youtubeRedirectUri(env: Env): string {
  return `${siteOrigin(env)}/api/admin/youtube/callback`;
}

export function readYoutubeConfig(env: Env = process.env): YoutubeConfig {
  const missing: string[] = [];
  const clientId = env.YOUTUBE_OAUTH_CLIENT_ID?.trim() || "";
  const clientSecret = env.YOUTUBE_OAUTH_CLIENT_SECRET?.trim() || "";
  const encryptionKey = readYoutubeTokenKey(env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  if (!clientId) missing.push("YOUTUBE_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("YOUTUBE_OAUTH_CLIENT_SECRET");
  if (!encryptionKey) missing.push("YOUTUBE_TOKEN_ENCRYPTION_KEY");
  if (missing.length > 0 || !encryptionKey) return { ready: false, missing };
  return { ready: true, clientId, clientSecret, encryptionKey, redirectUri: youtubeRedirectUri(env) };
}

/**
 * 구글 동의 화면 주소.
 * access_type=offline + prompt=consent: 매번 refresh token 을 새로 받는다(다시 연결해도 토큰이 빠지지 않게).
 * state: 우리가 만든 1회용 값 — 콜백에서 쿠키와 같은지 확인해 다른 사이트가 연결을 꾸며내지 못하게 한다.
 */
export function buildYoutubeAuthUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** 콜백의 state 와 쿠키 값 비교(길이·형식 확인 후 상수 시간 비교) */
export function youtubeStateMatches(fromQuery: string | null, fromCookie: string | null | undefined): boolean {
  if (!fromQuery || !fromCookie) return false;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(fromQuery) || fromQuery.length !== fromCookie.length) return false;
  let diff = 0;
  for (let i = 0; i < fromQuery.length; i += 1) diff |= fromQuery.charCodeAt(i) ^ fromCookie.charCodeAt(i);
  return diff === 0;
}

/** 받은 권한에 업로드 권한이 들어 있나(사용자가 체크를 빼고 동의할 수 있다) */
export function grantedUploadScope(scope: string | null | undefined): boolean {
  return (scope || "").split(/\s+/).includes("https://www.googleapis.com/auth/youtube.upload");
}
