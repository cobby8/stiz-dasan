import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 토스플레이스 웹훅 서명 검증 규칙 (docs.tossplace.com/reference/open-api/webhook.html, 2026-09-29 확인).
 *
 * ■ 왜 검증하는가
 *   이 주소는 인터넷에 열려 있다. 검증이 없으면 아무나 "결제됐다"는 가짜 요청을 보내
 *   우리 기록을 오염시킬 수 있다. 다음 단계에서 이 기록으로 청구서를 납부 처리할 예정이라
 *   여기서 막지 못하면 돈 문제로 번진다.
 *
 * ■ 서명 방식
 *   서명 대상 문자열 = `${x-toss-timestamp}.${요청 본문 원문}`
 *   HMAC-SHA256(서명 secret) → 16진수 → 앞에 `v1=` 을 붙인 값이 x-toss-signature.
 *   ⚠️ 본문은 **원문 그대로**여야 한다. JSON.parse 후 다시 stringify 하면
 *      공백·키 순서가 바뀌어 서명이 절대 맞지 않는다.
 *
 * ■ 시각 검사
 *   문서는 "현재 시각과 너무 크게 차이나는 요청은 거부하라"고만 하고 허용 폭을 정하지 않았다.
 *   가로챈 요청을 나중에 다시 보내는 공격(재전송)을 막기 위해 5분으로 잡았다.
 */

/** 재전송 공격 방지 허용 폭(밀리초). 문서에 값이 없어 5분으로 정했다. */
export const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "NO_SECRET" | "NO_SIGNATURE" | "NO_TIMESTAMP" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" };

/** 서명 대상 문자열을 만든다. 본문은 반드시 받은 원문 그대로 넣는다. */
export function buildSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** 우리 쪽에서 계산한 기대 서명(`v1=…` 형식). */
export function expectedSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(buildSignedPayload(timestamp, rawBody), "utf8").digest("hex")}`;
}

/** 길이가 달라도 시간차로 정답을 유추당하지 않도록 상수 시간 비교를 쓴다. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 헤더가 여러 서명을 공백으로 나열해 보낼 수 있으므로(키 교체 기간) 하나라도 맞으면 통과시킨다.
 * 단, 형식이 `v1=` 로 시작하지 않는 값은 후보로 치지 않는다.
 */
export function verifyWebhookSignature(input: {
  secret: string | undefined | null;
  signatureHeader: string | undefined | null;
  timestampHeader: string | undefined | null;
  rawBody: string;
  nowMs?: number;
  maxSkewMs?: number;
}): SignatureVerdict {
  const { secret, signatureHeader, timestampHeader, rawBody } = input;
  const nowMs = input.nowMs ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? WEBHOOK_MAX_SKEW_MS;

  // secret 이 없으면 "통과"가 아니라 "거부"다. 설정을 빠뜨린 채 열어두면 안 된다.
  if (!secret) return { ok: false, reason: "NO_SECRET" };
  if (!signatureHeader) return { ok: false, reason: "NO_SIGNATURE" };
  if (!timestampHeader) return { ok: false, reason: "NO_TIMESTAMP" };

  const sentAt = Number(timestampHeader);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "NO_TIMESTAMP" };
  if (Math.abs(nowMs - sentAt) > maxSkewMs) return { ok: false, reason: "STALE_TIMESTAMP" };

  const expected = expectedSignature(secret, timestampHeader, rawBody);
  const candidates = signatureHeader.split(/\s+/).filter((v) => v.startsWith("v1="));
  if (candidates.length === 0) return { ok: false, reason: "BAD_SIGNATURE" };
  return candidates.some((c) => safeEqual(c, expected)) ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
}

/** 거부 사유를 사람이 읽을 수 있게. 비밀값은 절대 넣지 않는다. */
export const SIGNATURE_REASON_LABEL: Record<Exclude<SignatureVerdict, { ok: true }>["reason"], string> = {
  NO_SECRET: "웹훅 서명 secret 이 설정되지 않았습니다(TOSS_PLACE_WEBHOOK_SECRET).",
  NO_SIGNATURE: "서명 헤더가 없습니다.",
  NO_TIMESTAMP: "전송 시각 헤더가 없거나 숫자가 아닙니다.",
  STALE_TIMESTAMP: "전송 시각이 현재와 너무 차이납니다(재전송 의심).",
  BAD_SIGNATURE: "서명이 일치하지 않습니다.",
};
