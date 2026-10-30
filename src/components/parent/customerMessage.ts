/**
 * 학부모(고객) 화면에 띄울 오류 문장을 고른다.
 *
 * 왜 필요한가: 서버가 준 한국어 안내는 그대로 보여 주면 되지만,
 * 네트워크가 끊기면 브라우저가 "Failed to fetch" 같은 영어 원문을 던지고,
 * 응답이 깨지면 "Unexpected token" 같은 개발자용 문장이 그대로 화면에 뜬다.
 * 이런 문장은 고객이 이해할 수 없으므로, 원문은 개발자 도구(console)에만 남기고
 * 화면에는 미리 정한 쉬운 한국어 문장(fallback)을 보여 준다.
 */

// 한글이 한 글자라도 있어야 "사람에게 쓴 안내"로 본다.
const HANGUL = /[가-힣]/;

// 한국어 문장이어도 개발 용어가 섞이면 고객에게 보이지 않게 막는다.
const DEV_JARGON = /(Error|undefined|null|NaN|\[object|fetch|JSON|token|API|HTTP|Prisma|Supabase|서버|토큰|세션|쿼리|\bDB\b|(status|code)\s*\d{3})/i;

/** 고객에게 보여도 되는 문장인지 판정한다(테스트에서도 쓴다). */
export function isCustomerFriendly(text: string): boolean {
  return HANGUL.test(text) && !DEV_JARGON.test(text);
}

/**
 * raw(오류 객체·서버 메시지)가 고객용 한국어 문장이면 그대로, 아니면 fallback 을 돌려준다.
 * 바꿔 치울 때는 원문을 console.error 로 남겨 원인 추적은 그대로 가능하게 한다.
 */
export function customerMessage(raw: unknown, fallback: string): string {
  // Error 객체든 { message } 모양이든 message 글자만 꺼낸다(다른 창·실행 환경에서 만든 Error 도 받는다)
  const text = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
      ? (raw as { message: string }).message
      : "";
  const trimmed = text.trim();
  if (trimmed && isCustomerFriendly(trimmed)) return trimmed;
  if (raw && typeof console !== "undefined") console.error("[학부모 화면] 고객용으로 바꾼 오류 원문:", raw);
  return fallback;
}
