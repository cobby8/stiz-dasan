// 선생님 앱·기사님 화면에 오류 문구를 보여 주기 전에 거르는 작은 도우미.
// 왜: 서버가 "invalid body", "token, serviceDate, type 필수" 같은 개발용 문구를 돌려주거나,
//     인터넷이 끊기면 브라우저가 "Failed to fetch" 를 던진다. 그 원문을 그대로 띄우면
//     선생님·기사님은 뜻을 알 수 없다. 한국어 안내문이면 그대로 쓰고, 아니면 준비한 쉬운 문장으로 바꾼다.

// 화면에 남아도 괜찮은 영어(고유명사·일반화된 말)
const ALLOWED_LATIN = new Set(["GPS", "STIZ", "SMS", "PC"]);

// 한국어 문장이어도 개발 용어가 섞이면 쉬운 문장으로 바꾼다
const JARGON = /(서버|쿼리|캐시|토큰|동기화|에러 코드|스택|트랜잭션|\(\s*[45]\d\d\s*\))/; // 「(503)」 같은 HTTP 코드 노출

/** 화면에 그대로 보여도 되는 안내문인지 판단한다(한글 포함 + 개발 용어·영어 식별자 없음). */
export function isFriendlyMessage(text: string): boolean {
  if (!/[가-힣]/.test(text)) return false; // 한글이 하나도 없으면 영어 원문이다
  if (JARGON.test(text)) return false;
  const latinWords = text.match(/[A-Za-z_]{2,}/g) ?? [];
  return latinWords.every((word) => ALLOWED_LATIN.has(word.toUpperCase()));
}

/**
 * 잡은 오류(또는 서버가 준 문구)를 사용자용 한국어 문장으로 바꾼다.
 * 원문은 화면 대신 console.error 로만 남긴다.
 */
export function userErrorMessage(source: unknown, fallback: string): string {
  const raw = source instanceof Error ? source.message : typeof source === "string" ? source : "";
  const text = raw.trim();
  if (text && isFriendlyMessage(text)) return text;
  if (text) console.error("[화면 오류 원문]", text); // 원문은 개발자 도구에서만 본다
  return fallback;
}
