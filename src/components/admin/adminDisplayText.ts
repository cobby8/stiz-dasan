/**
 * 관리자 화면에 보여줄 문구를 «원장·직원이 읽는 한국어»로 다듬는 공용 모듈.
 *
 * 왜 필요한가: 서버나 외부 서비스가 돌려준 오류 원문(영어 문장·DB 오류·상태코드)이
 * 그대로 알림창에 뜨면 비개발자는 무슨 일인지 알 수 없다. 화면에는 한국어 안내만 내보내고,
 * 원문은 개발자가 볼 수 있도록 console 에만 남긴다.
 *
 * 한국어 업무 안내(예: «이미 등록된 학생입니다.»)는 그대로 통과시킨다.
 */

// 한글이 한 글자라도 있어야 «사람에게 쓴 문장»으로 본다.
const HANGUL = /[가-힣]/;

// 개발 용어·기술 오류가 섞인 문장은 사람에게 보여주지 않는다.
const DEV_TEXT = new RegExp(
  [
    // 데이터·서버 내부 용어(영문)
    "\\b(prisma|postgres|sql|select|insert|relation|column|constraint|violates|duplicate key|foreign key)\\b",
    "\\b(null|undefined|nan|object object|typeerror|syntaxerror|referenceerror|stack)\\b",
    "\\b(fetch|network|json|token|payload|webhook|cron|supabase|vercel|api|db|http|https?:\\/\\/|econn\\w*|etimedout)\\b",
    // 영어 상태값 코드(PENDING 등)와 대문자_대문자 형태의 내부 코드
    "\\b(PENDING|PAID|REFUNDED|CANCELED|CANCELLED|BOOKED|IN_PROGRESS|HELD|SUCCEEDED|ACTIVE|FAILED|COMPLETED|RUNNING)\\b",
    "\\b[A-Z]{2,}_[A-Z_]{2,}\\b",
    // Prisma 오류 번호(P2002 등)·HTTP 상태코드 노출
    "\\bP\\d{4}\\b",
    "(오류|에러|error|status|코드)\\s*[:(]?\\s*[45]\\d\\d\\b",
    // 한국어로 쓴 개발 용어
    "데이터베이스|서버 액션|쿼리|캐시|스키마|마이그레이션|웹훅|파싱|에러 코드",
  ].join("|"),
  "i",
);

// «(ADMIN만 가능)» 처럼 권한 코드를 괄호로 덧붙인 부분은 떼어낸다.
const ROLE_CODE_HINT = /\s*\((?:ADMIN|VICE_ADMIN|INSTRUCTOR|DRIVER|STAFF|PARENT)[^)]*\)/g;

/** 문자열 안내를 화면용으로 거른다. 개발 언어가 섞이면 fallback(작업별 한국어 안내)을 쓴다. */
export function adminMessageText(message: string | null | undefined, fallback: string): string {
  const text = (message ?? "").replace(ROLE_CODE_HINT, "").trim();
  if (!text || !HANGUL.test(text) || DEV_TEXT.test(text)) return fallback;
  return text;
}

/** catch 로 받은 오류를 화면용 한국어로 바꾼다. 원문은 console 에만 남긴다. */
export function adminErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = adminMessageText(message, fallback);
  // 원문을 숨긴 경우에만 개발자 확인용으로 기록한다.
  if (text === fallback && message) console.error("[admin] 화면에는 안내 문구로 바꿔 보여준 오류:", error);
  return text;
}

// 결제 수단 값 → 화면 이름. 저장된 값 자체는 바꾸지 않고 보여줄 때만 바꾼다.
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  RALLYZ: "랠리즈",
  CARD: "카드",
  CASH: "현금",
  BANK_TRANSFER: "계좌이체",
  TRANSFER: "계좌이체",
  TOSS: "토스",
  MANUAL: "직접 처리",
  UNPAID: "미납",
};

/** 결제 수단을 한국어로. 이미 한국어로 저장된 값은 그대로, 모르는 영문 코드는 «수단 미확인». */
export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return "";
  if (PAYMENT_METHOD_LABEL[method]) return PAYMENT_METHOD_LABEL[method];
  return HANGUL.test(method) ? method : "수단 미확인";
}
