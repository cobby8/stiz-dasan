/**
 * 공개 화면(학부모·방문자)에 오류 문장을 보여 주기 전에 거르는 도우미.
 *
 * 왜: 서버·외부 서비스가 던진 원문(영어 오류, "GEMINI_API_KEY 환경변수…" 같은 개발 문장)이
 * 그대로 화면에 찍히면 학부모에게는 «고장 난 화면»으로 보인다.
 * 그래서 «한국어로 쓴 업무 안내»만 통과시키고, 나머지는 화면별 쉬운 안내(fallback)로 바꾼다.
 * 원문은 개발자가 볼 수 있게 console.error 로만 남긴다.
 */

// 한국어 문장 안에 섞여도 개발 용어로 보는 단어들
const DEV_JARGON = /(api|\bdb\b|sql|prisma|supabase|vercel|postgres|pgbouncer|gemini|oauth|provider|redirect|callback|token|session|cookie|json|fetch|http|status|exception|error|failed|undefined|null|nan|\[object|서버|데이터베이스|쿼리|캐시|토큰|세션|환경변수|에러 코드|개발자)/i;

// 코드 식별자 모양: GEMINI_API_KEY, e.message, enrollmentDateId 같은 것
const CODE_SHAPE = /([A-Za-z]+_[A-Za-z_]+|[a-z]+\.[a-z]+[A-Za-z]*|\b[a-z]+[A-Z][A-Za-z]+|[{}<>])/;

export function publicErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.trim();
  if (!message) return fallback;
  // 한글이 하나도 없으면(영어 원문) 학부모용 안내가 아니다
  if (!/[가-힣]/.test(message)) return fallback;
  if (DEV_JARGON.test(message) || CODE_SHAPE.test(message)) return fallback;
  // 지나치게 긴 문장은 내부 덤프일 가능성이 크다
  if (message.length > 160) return fallback;
  return message;
}
