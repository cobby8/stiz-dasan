import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type NativePlatform = "ios" | "android";
export type NativeProvider = "google" | "kakao" | "naver" | "apple";
export const FLOW_TTL_MS = 5 * 60_000;
export const CODE_TTL_MS = 60_000;
export const NATIVE_ORIGIN = "https://www.stiz-dasan.kr";
const callbacks = { ios: "stiz-academy-dev://auth/return", android: "stiz-academy-android-dev://auth/return" } as const;

export class NativeAuthError extends Error {
  constructor(public status = 400, message = "로그인을 완료하지 못했습니다. 앱에서 다시 시도해 주세요.") { super(message); }
}
export type NativeConfig = { origin: string; encryptionKey: Buffer; callback(platform: NativePlatform): string };

/** 개발 복귀 주소는 정식 앱 소유권 검증을 대신하지 않는다. 운영에서는 반드시 닫는다. */
export function nativeConfig(env: Record<string, string | undefined> = process.env): NativeConfig {
  if (env.NATIVE_AUTH_ENABLED !== "true" || env.NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED !== "true" || env.NODE_ENV === "production") {
    throw new NativeAuthError(503, "앱 간편로그인을 준비 중입니다. 이메일·비밀번호 로그인을 이용해 주세요.");
  }
  const encoded = env.NATIVE_AUTH_ENCRYPTION_KEY || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new NativeAuthError(503);
  const encryptionKey = Buffer.from(encoded, "base64url");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64url") !== encoded) throw new NativeAuthError(503);
  return { origin: NATIVE_ORIGIN, encryptionKey, callback: platform => callbacks[platform] };
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
