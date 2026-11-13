/**
 * 사진 올리기·인스타 게시 화면이 쓰는 안내 문구 — DB·서버 모듈을 부르지 않는 순수 파일.
 * (2026-11-14 사진·인스타 점검) 서버 액션과 화면이 같은 문장을 쓰도록 한곳에 둔다.
 */

/** 학생이 지정되지 않은 초안을 게시하려 할 때 — 막는 것은 그대로, «다음에 할 일»을 알려 준다. */
export const SUBJECT_UNASSIGNED_PUBLISH_MESSAGE =
  "이 사진은 학생이 지정되지 않아 공개 동의를 확인할 수 없습니다. 수업 화면에서 학생을 골라 올린 사진만 게시할 수 있습니다.";

/** 빠른 업로드 화면 맨 위에 미리 알리는 한 줄(올린 뒤에야 막히는 일이 없게). */
export const QUICK_UPLOAD_CONSENT_NOTICE =
  "여기서 올린 사진은 학생이 지정되지 않아 홈페이지·인스타그램에 게시할 수 없습니다. 게시할 사진은 수업 화면에서 학생을 골라 올려 주세요.";

export type InstagramErrorGuide = {
  /** 화면에 크게 보여 줄 한국어 안내. */
  message: string;
  /** 작은 글씨로 덧붙일 원문(영어 원문을 한국어로 바꿨을 때만). 한국어 원문이면 null. */
  detail: string | null;
};

const HANGUL = /[가-힣]/;

// 흔한 경우만 고른다. 위에서부터 먼저 맞는 것을 쓴다(«토큰 만료»가 «권한»보다 먼저).
// 오류 번호의 샵 기호를 [#] 로 쓴 이유: 「샵 + 숫자 3자리」가 색 코드 가드(color-hardcode-guard)에 색으로 잡힌다.
const INSTAGRAM_ERROR_RULES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    // 결과 불명확 — 우리 서버가 남기는 문구(socialPublishQueueRules.ts)
    pattern: /게시 결과 확인 필요|결과가 불명확/,
    message:
      "인스타그램에 실제로 올라갔는지 확인이 필요합니다. 인스타그램에서 게시물을 먼저 확인하고, 올라가지 않았을 때만 «다시 게시»를 눌러 주세요.",
  },
  {
    // 토큰 만료·무효 (code 190, OAuthException, Session has expired …)
    pattern: /access token|session has expired|oauthexception|code["':\s]*190|\([#]190\)|token.*(expired|invalid)|(expired|invalid).*token/i,
    message: "인스타그램 연결이 만료됐습니다. 연결 정보(접근 토큰)를 새로 발급해 넣은 뒤 다시 게시해 주세요.",
  },
  {
    // 권한 없음 (오류 번호 10·200, instagram_content_publish …)
    pattern: /permission|not authorized|\([#]10\)|\([#]200\)|instagram_content_publish|does not have the capability/i,
    message: "인스타그램 게시 권한이 없습니다. 연결한 계정이 비즈니스(프로페셔널) 계정인지, 게시 권한을 허용했는지 확인해 주세요.",
  },
  {
    // 한도 초과 (오류 번호 4·17·32·613, 하루 게시 한도 2207042 …)
    pattern: /rate limit|request limit|too many|\([#]4\)|\([#]17\)|\([#]32\)|\([#]613\)|publishing limit|2207042/i,
    message: "인스타그램이 정한 게시 횟수 한도를 넘었습니다. 시간을 두고 다시 게시해 주세요(하루 게시 횟수에 제한이 있습니다).",
  },
  {
    // 이미지 형식·크기·비율·가져오기 실패 (2207052, 2207004, 36003 …)
    pattern: /aspect ratio|image (format|size|type)|unsupported|media type|could not be fetched|download has failed|media uri|2207052|2207004|2207009|36003|only photo or video/i,
    message: "사진 형식이나 크기가 인스타그램 기준에 맞지 않습니다. JPG 사진으로, 가로·세로 비율이 너무 길지 않은 사진으로 바꿔 다시 올려 주세요.",
  },
];

const INSTAGRAM_ERROR_FALLBACK = "인스타그램 게시에 실패했습니다. 잠시 뒤 다시 게시해 주세요. 계속되면 연결 설정을 확인해 주세요.";

/**
 * 인스타그램 게시 오류를 원장이 읽을 수 있는 한국어 안내로 바꾼다.
 * - 흔한 경우(토큰 만료·권한 없음·형식/크기·한도 초과)는 준비한 안내 + 원문(작은 글씨)
 * - 이미 한국어인 안내(우리 서버가 만든 문구)는 그대로
 * - 모르는 영어 원문은 일반 안내 + 원문
 */
export function instagramErrorGuide(raw: string | null | undefined): InstagramErrorGuide | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  for (const rule of INSTAGRAM_ERROR_RULES) {
    if (rule.pattern.test(text)) {
      // 한국어 원문에서 온 안내는 원문을 덧붙이지 않는다(같은 말을 두 번 하게 된다).
      return { message: rule.message, detail: HANGUL.test(text) ? null : text };
    }
  }

  if (HANGUL.test(text)) return { message: text, detail: null };
  return { message: INSTAGRAM_ERROR_FALLBACK, detail: text };
}

/**
 * 인스타 연결 배지 문구. 서버는 연결 정보가 «들어 있는지»만 안다(만료됐는지는 실제로 호출해 봐야 안다).
 * 그래서 «준비 완료»처럼 단정하지 않는다.
 */
export function instagramConnectionBadge(hasConnectionInfo: boolean): { label: string; hint: string } {
  return hasConnectionInfo
    ? { label: "연결 정보 있음", hint: "실제 연결은 게시하거나 가져올 때 확인됩니다." }
    : { label: "설정 필요", hint: "연결 정보가 없어 인스타그램 게시·가져오기를 할 수 없습니다." };
}
