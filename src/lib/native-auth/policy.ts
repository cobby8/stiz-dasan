import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type NativePlatform = "ios" | "android";
export type NativeProvider = "google" | "kakao" | "naver" | "apple";
export const FLOW_TTL_MS = 5 * 60_000;
export const CODE_TTL_MS = 60_000;
export const NATIVE_ORIGIN = "https://www.stiz-dasan.kr";
/**
 * 앱 복귀 주소(2026-11-13 운영 전환).
 * - 운영: 스토어 앱 ID(도메인을 거꾸로 쓴 이름)를 그대로 쓴 전용 주소(RFC 8252 권장 형식). 안드로이드·아이폰 모두 같은 이름이다.
 *   이 주소에는 토큰·쿠키가 없고 1회용 code+state 만 실린다. code 는 앱 메모리의 PKCE 비밀값(verifier)
 *   없이는 교환할 수 없어, 다른 앱이 주소를 가로채도 로그인할 수 없다.
 * - 개발: 기존 개발 주소. 개발 서버(NODE_ENV≠production)에서 개발 스위치를 켤 때만 쓴다.
 */
export const PRODUCTION_CALLBACK_SCHEME = "kr.co.upturnlabs.stizdasan";
const productionCallbacks = { ios: `${PRODUCTION_CALLBACK_SCHEME}://auth/return`, android: `${PRODUCTION_CALLBACK_SCHEME}://auth/return` } as const;
const developmentCallbacks = { ios: "stiz-academy-dev://auth/return", android: "stiz-academy-android-dev://auth/return" } as const;

export class NativeAuthError extends Error {
  constructor(public status = 400, message = "로그인을 완료하지 못했습니다. 앱에서 다시 시도해 주세요.") { super(message); }
}
export type NativeConfig = { origin: string; encryptionKey: Buffer; development: boolean; callback(platform: NativePlatform): string };

/** 암호화 키 형식 확인(32바이트 base64url). 값 자체는 어디에도 남기지 않는다. */
function readEncryptionKey(encoded: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64url");
  return key.length === 32 && key.toString("base64url") === encoded ? key : null;
}

/**
 * 앱 간편로그인 켜짐 여부 — 웹 화면(앱 안 간편로그인 버튼 표시)과 서버 경로가 같은 판정을 쓴다.
 * 켜는 조건: NATIVE_AUTH_ENABLED=true + 올바른 암호화 키. 외부 설정(Supabase 제공자·허용 주소) 전에는 꺼 둔다.
 */
export function nativeAuthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NATIVE_AUTH_ENABLED === "true" && readEncryptionKey(env.NATIVE_AUTH_ENCRYPTION_KEY || "") !== null;
}

/**
 * 운영 스위치(NATIVE_AUTH_ENABLED)가 꺼져 있으면 모든 앱 로그인 경로를 503 으로 닫는다.
 * 개발 복귀 주소는 개발 서버에서 개발 스위치를 켤 때만 — 운영(production)에서는 스위치가 있어도 항상 운영 주소다.
 */
export function nativeConfig(env: Record<string, string | undefined> = process.env): NativeConfig {
  if (env.NATIVE_AUTH_ENABLED !== "true") {
    throw new NativeAuthError(503, "앱 간편로그인을 준비 중입니다. 아이디·비밀번호로 로그인해 주세요.");
  }
  const encryptionKey = readEncryptionKey(env.NATIVE_AUTH_ENCRYPTION_KEY || "");
  if (!encryptionKey) throw new NativeAuthError(503);
  const development = env.NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED === "true" && env.NODE_ENV !== "production";
  const callbacks = development ? developmentCallbacks : productionCallbacks;
  return { origin: NATIVE_ORIGIN, encryptionKey, development, callback: platform => callbacks[platform] };
}
export function opaqueToken() { return randomBytes(32).toString("base64url"); }
export function digest(value: string) { return createHash("sha256").update(value).digest("base64url"); }
export function equalToken(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function validToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value); }
export function validVerifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value); }
export function validFlow(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function parseStart(input: Record<string, unknown>) {
  if (input.intent !== undefined && input.intent !== "login") throw new NativeAuthError();
  if (Object.keys(input).some(key => !["intent", "provider", "platform", "codeChallenge", "state"].includes(key))) throw new NativeAuthError();
  if (input.platform !== "ios" && input.platform !== "android") throw new NativeAuthError();
  if (!["google", "kakao", "naver", "apple"].includes(String(input.provider))) throw new NativeAuthError();
  if (!validFlow(input.codeChallenge) || !validToken(input.state)) throw new NativeAuthError();
  return { platform: input.platform as NativePlatform, provider: input.provider as NativeProvider, challenge: input.codeChallenge, state: input.state };
}

/** 세션은 URL·앱 JavaScript에 전달하지 않고, 단기 원장에도 암호화해 보관한다. */
export function sealSession(value: unknown, flowId: string, key: Buffer): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`stiz-native-v1:${flowId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(x => x.toString("base64url")).join(".");
}
export function openSession(value: string, flowId: string, key: Buffer): unknown {
  const parts = value.split("."); if (parts.length !== 3) throw new NativeAuthError();
  try {
    const [iv, tag, ciphertext] = parts.map(x => Buffer.from(x, "base64url"));
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 32_768) throw new NativeAuthError();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`stiz-native-v1:${flowId}`)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch { throw new NativeAuthError(); }
}
