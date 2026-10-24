import { buildKakaoSkillResponse, type KakaoCardButton } from "@/lib/kakao-chatbot-contract";

// 인증 흐름으로 보낼 정확한 메뉴 문구(바로가기 버튼이 보내는 말)
const AUTH_EXACT = /^(기존 수강생 인증|학부모 인증하기|인증|계정 연결)$/;
// 이미 다니는 학부모가 문장으로 말할 때 쓰는 단어. "수강 신청"의 '수강'은 걸리지 않도록 '수강생'만 본다.
const AUTH_HINT = /인증|기존|수강생|학부모|재원|다니(고|는)|계정\s*연결/;
// 처음 온 사람의 신청·문의 신호. 둘 다 들어 있으면 신규 안내가 이긴다(신규 수강생 문의 → 체험·수강 안내).
// '다니고 싶어요'(아직 안 다님)·'상담'(신규 문의가 대부분)도 신규 쪽으로 본다(검수 오탐 2건).
const NEW_HINT = /체험|신규|입학|수강\s*신청|등록\s*문의|처음|모집|다니고\s*싶|상담/;

/**
 * 연결 안 된 카카오 사용자의 말이 "기존 수강생 인증"을 원하는지.
 * 오탐(신규 문의를 인증 링크로 보내는 것)을 막기 위해 신규 신호가 있으면 false 다.
 * 경계는 tests/kakao-guest-entry.test.mjs 가 고정한다.
 */
export function isKakaoParentAuthIntent(utterance: string): boolean {
  const text = utterance.replace(/\s+/g, " ").trim();
  if (AUTH_EXACT.test(text)) return true;
  if (NEW_HINT.test(text)) return false;
  return AUTH_HINT.test(text);
}

/** 처음 온 사람의 신청·문의 신호(체험·신규·수강 신청·상담 등)가 있는지 — 있으면 정책 답변보다 기존 안내 카드가 먼저다 */
export function hasKakaoNewEnrollmentHint(utterance: string): boolean {
  return NEW_HINT.test(utterance.replace(/\s+/g, " ").trim());
}

// 안내 카드 맨 위에 두는 "이미 다니는 학부모" 버튼. 누르면 '기존 수강생 인증' 발화가 돌아와 인증 링크를 받는다.
const AUTH_BUTTON: KakaoCardButton = { action: "message", label: "기존 수강생 인증", messageText: "기존 수강생 인증" };

/** 공개 안내만 반환한다. 학생 조회·접수·인증 레코드 생성은 하지 않는다. */
export function kakaoGuestEntry(utterance: string, origin: string) {
  const text = utterance.replace(/\s+/g, " ").trim();
  if (isKakaoParentAuthIntent(text)) return null;
  const base = origin.replace(/\/+$/, "");
  const isTrial = /체험/.test(text);
  const isEnroll = /신규|입학|수강\s*신청|등록\s*문의/.test(text);
  const isConsultation = /상담|문의/.test(text);
  const links: KakaoCardButton[] = isTrial
    ? [{ action:"webLink", label:"체험수업 신청", webLinkUrl:`${base}/apply/trial` }]
    : isEnroll
      ? [{ action:"webLink", label:"수강 신청", webLinkUrl:`${base}/apply/enroll` }]
      : isConsultation
        ? [{ action:"webLink", label:"상담·신청 안내", webLinkUrl:`${base}/apply` }]
        // textCard 버튼은 3개까지라 기본 카드의 '상담·신청 안내'는 아래 바로가기(상담 안내)로 옮겼다.
        : [
          { action:"webLink", label:"체험수업 신청", webLinkUrl:`${base}/apply/trial` },
          { action:"webLink", label:"수강 신청", webLinkUrl:`${base}/apply/enroll` },
        ];
  return buildKakaoSkillResponse({
    title: "이미 다니는 학부모님은 ‘기존 수강생 인증’을 눌러 주세요",
    text: "안녕하세요~ 스티즈농구교실 다산2호점입니다. 처음 방문하셨다면 인증 없이 체험·수강 신청과 상담 안내를 확인하실 수 있어요.\n\n상담 안내 페이지의 전화 문의를 이용해 주세요. 이 메뉴만으로 상담이 접수되지는 않습니다.\n\n이미 다니는 자녀의 결석·셔틀·청구 요청은 ‘기존 수강생 인증’을 먼저 눌러주세요.",
    // 기존 학부모 버튼을 맨 위에 둔다(현장에서 신규 안내만 보고 막히는 일이 잦았다).
    buttons: [AUTH_BUTTON, ...links],
    quickReplies: ["기존 수강생 인증", "체험 문의", "수강 신청", "상담 안내"],
  });
}

/**
 * 카카오 학부모 인증 링크 안내.
 * reused: 아직 유효한 같은 링크를 다시 보여주는 경우 / replacedPrevious: 쓸 수 있던 옛 링크가 무효가 된 경우.
 */
export function kakaoConnectLinkReply(input: {
  url: string;
  reused: boolean;
  replacedPrevious: boolean;
  minutesLeft: number;
}) {
  const lines = input.reused
    ? [`조금 전에 보내드린 인증 링크를 다시 보여드려요. ${Math.max(1, input.minutesLeft)}분 안에 열어 주세요.`]
    : [
      "처음 한 번만 학부모 인증을 해주세요. 인증이 끝나면 다음부터는 자녀를 자동으로 알아볼게요.",
      ...(input.replacedPrevious ? ["이전에 받은 인증 링크는 더 이상 쓸 수 없어요. 아래 새 링크를 눌러 주세요."] : []),
      "링크는 15분 안에 열어 주세요.",
    ];
  lines.push("로그인이 안 되면 연결 화면에서 ‘기존 학부모 계정 활성화’를 누르세요.");
  return buildKakaoSkillResponse({
    text: lines.join("\n\n"),
    buttons: [{ action: "webLink", label: "학부모 인증하기", webLinkUrl: input.url }],
    // 처음 온 분이 잘못 눌렀을 때 돌아갈 길("처음"이 들어 있어 신규 안내로 간다)
    quickReplies: ["처음 방문이에요"],
  });
}
