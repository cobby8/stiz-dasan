import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 슬랙 요청 서명 검증 (https://api.slack.com/authentication/verifying-requests-from-slack)
 *
 * ■ 왜 검증하는가
 *   /api/slack/interactions 는 인터넷에 열린 주소다. 검증이 없으면 누구나 "원장이 [납부 반영]을
 *   눌렀다"는 가짜 요청을 보내 사이트 청구서를 납부 처리하게 만들 수 있다. 돈이 걸린 문이다.
 *
 * ■ 방식
 *   서명 대상 = `v0:${x-slack-request-timestamp}:${본문 원문}`
 *   HMAC-SHA256(SLACK_SIGNING_SECRET) → 16진수 → 앞에 `v0=` → x-slack-signature 와 비교.
 *   ⚠️ 본문은 받은 **원문 그대로**여야 한다. 폼을 파싱한 뒤 다시 만들면 절대 맞지 않는다.
 *
 * ■ 재전송 방지
 *   슬랙 권고대로 현재 시각과 5분(300초) 넘게 차이 나면 거부한다.
 *
 * 이 파일은 순수 모듈이다(DB·네트워크·환경변수 없음). 테스트가 실제로 실행해서 검증한다.
 */

/** 허용 시각 차이(초). 슬랙 권고값. */
export const SLACK_MAX_SKEW_SEC = 300;

export type SlackSignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "NO_SECRET" | "NO_SIGNATURE" | "NO_TIMESTAMP" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" };

/** 서명 대상 문자열. 본문은 원문 그대로 넣는다. */
export function buildSlackBaseString(timestamp: string, rawBody: string): string {
  return `v0:${timestamp}:${rawBody}`;
}

/** 우리 쪽에서 계산한 기대 서명(`v0=<hex>`). */
export function expectedSlackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(buildSlackBaseString(timestamp, rawBody), "utf8").digest("hex")}`;
}

/** 시간차로 정답을 유추당하지 않도록 상수 시간 비교. 길이가 다르면 바로 거짓. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifySlackSignature(input: {
  secret: string | undefined | null;
  signatureHeader: string | undefined | null;
  timestampHeader: string | undefined | null;
  rawBody: string;
  /** 테스트용 현재 시각(초). 기본은 지금. */
  nowSec?: number;
}): SlackSignatureVerdict {
  const { secret, signatureHeader, timestampHeader, rawBody } = input;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  // secret 이 없으면 "통과"가 아니라 "거부"다. 설정을 빠뜨린 채 열리면 검증 없는 문이 된다.
  if (!secret) return { ok: false, reason: "NO_SECRET" };
  if (!signatureHeader) return { ok: false, reason: "NO_SIGNATURE" };
  if (!timestampHeader || !/^\d+$/.test(timestampHeader)) return { ok: false, reason: "NO_TIMESTAMP" };

  const sentAt = Number(timestampHeader);
  if (Math.abs(nowSec - sentAt) > SLACK_MAX_SKEW_SEC) return { ok: false, reason: "STALE_TIMESTAMP" };

  // `v0=` 로 시작하지 않는 값은 비교조차 하지 않는다.
  if (!signatureHeader.startsWith("v0=")) return { ok: false, reason: "BAD_SIGNATURE" };
  const expected = expectedSlackSignature(secret, timestampHeader, rawBody);
  return safeEqual(signatureHeader, expected) ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
}
