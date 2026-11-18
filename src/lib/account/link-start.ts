import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 본인인증 직후 «같은 브라우저·같은 계정»이 이어서 간편로그인 연결을 시작한다는 1회용 표식(2026-11-17).
 *
 * 왜: 직원 계정은 주소(GET)만으로 연결을 시작하지 못하게 막아 두었다(관리자로 로그인한 브라우저에서 남이 보낸 링크로
 * 연결이 시작되는 것 방지). 그런데 «간편로그인 → 본인인증 → 기존 계정 연결»은 화면이 주소로 넘어가는 흐름이라 직원은
 * 여기서 막혔다. 서버가 본인인증을 확인한 응답에만 이 표식을 구워 주고, 연결 시작은 표식이 «지금 로그인한 계정·제공자»와
 * 맞을 때만 통과시킨다. 표식은 httpOnly 쿠키라 다른 사이트가 만들 수 없다.
 */
export const LINK_START_COOKIE = "stiz-link-start";
export const LINK_HINT_COOKIE = "stiz-link-hint";
export const LINK_START_COOKIE_MAX_AGE = 120;

function secret(): string {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error("서버 설정이 완료되지 않았습니다.");
  return value;
}
function sign(authUserId: string, provider: string, expiresAt: number): string {
  return createHmac("sha256", secret()).update(`link-start:${authUserId}:${provider}:${expiresAt}`).digest("base64url");
}
export function linkStartToken(authUserId: string, provider: string, now = Date.now()): string {
  const expiresAt = now + LINK_START_COOKIE_MAX_AGE * 1000;
  return `${expiresAt}.${sign(authUserId, provider, expiresAt)}`;
}
export function isLinkStartTokenFor(token: string | null | undefined, authUserId: string, provider: string, now = Date.now()): boolean {
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ""));
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!(expiresAt > now) || expiresAt - now > LINK_START_COOKIE_MAX_AGE * 1000 + 5_000) return false;
  const expected = Buffer.from(sign(authUserId, provider, expiresAt));
  const actual = Buffer.from(match[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
