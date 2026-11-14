import { createHash, randomBytes } from "node:crypto";

// 앱 «연결하기» 1회용 표(토큰) — 서버 전용 계산(node:crypto). 화면 부품에서 import 하지 않는다.

/** 32바이트 무작위 → base64url 43글자. 원문은 앱 화면 링크에만 실리고 DB 에는 저장하지 않는다. */
export function newLinkHandoffToken(): string {
  return randomBytes(32).toString("base64url");
}

/** DB 에 저장하는 값 = 토큰의 SHA-256(base64url). DB 가 새어도 원문 토큰을 되살릴 수 없다. */
export function linkHandoffTokenId(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** 토큰 모양 검사 — 43글자 base64url 만. 이상한 값은 DB 를 묻기 전에 버린다. */
export function isLinkHandoffToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
