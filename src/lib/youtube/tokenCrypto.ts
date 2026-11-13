/**
 * 유튜브 refresh token 암호화(AES-256-GCM) — 2026-11-14.
 *
 * 왜: refresh token 하나면 원장 채널에 영상을 올리고 지울 수 있다. DB 백업·로그로 새도 쓸 수 없게
 * 서버 비밀값(YOUTUBE_TOKEN_ENCRYPTION_KEY)으로 잠가서만 저장한다. 키가 없으면 연결 기능 자체를 끈다.
 *
 * 키 형식은 앱 간편로그인(NATIVE_AUTH_ENCRYPTION_KEY)과 같다: 32바이트를 base64url 로(43자).
 *   만들기: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 * 암호문 형식: v1.<iv>.<tag>.<ciphertext> (각 base64url). AAD 로 용도를 묶어 다른 암호문과 섞이지 않게 한다.
 *
 * ⚠️ 순수 모듈(node:crypto 만). 테스트가 그대로 불러 실행한다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const AAD = Buffer.from("stiz-youtube-refresh-v1");

/** 키 문자열 → 32바이트 키(형식이 틀리면 null). 값 자체는 어디에도 남기지 않는다. */
export function readYoutubeTokenKey(encoded: string | undefined | null): Buffer | null {
  const value = (encoded || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const key = Buffer.from(value, "base64url");
  return key.length === 32 && key.toString("base64url") === value ? key : null;
}

export function sealYoutubeToken(plain: string, key: Buffer): string {
  if (!plain) throw new Error("EMPTY_TOKEN");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openYoutubeToken(sealed: string, key: Buffer): string {
  const parts = String(sealed || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("INVALID_SEALED_TOKEN");
  const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 8192) throw new Error("INVALID_SEALED_TOKEN");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
