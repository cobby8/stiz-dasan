/**
 * 고객(학부모·대관 문의자)에게 보내는 «미리보기 → 원장 승인 → 발송» 안내 문자의 문구 모음.
 *
 * 왜 따로 두나: 문구는 원장님이 승인하는 «계약서 본문» 같은 것이라, 화면·서버·테스트가
 * 모두 같은 한 곳을 봐야 한다. 이 파일은 DB·서버를 전혀 모르는 순수 함수만 둔다
 * (테스트가 그대로 실행해 문구 전문을 확인할 수 있게 import 도 없다).
 */

/** 고객 안내 문자 종류. 발송 장부(NotificationDelivery.eventType)에도 이 값이 남는다. */
export const CUSTOMER_NOTICE_KINDS = ["KAKAO_INTAKE_RESULT", "KAKAO_CHANNEL_INVITE", "RENTAL_GUIDE"] as const;
export type CustomerNoticeKind = (typeof CUSTOMER_NOTICE_KINDS)[number];

/** 화면·장부에 보이는 이름 */
export const CUSTOMER_NOTICE_LABEL: Record<CustomerNoticeKind, string> = {
  KAKAO_INTAKE_RESULT: "카카오 접수 처리 결과 안내",
  KAKAO_CHANNEL_INVITE: "카카오채널 링크 안내",
  RENTAL_GUIDE: "체육관 대관 안내",
};

/** 같은 번호에 같은 안내를 다시 보내지 못하게 막는 시간(분). 실수로 두 번 누르는 사고 방지 */
export const CUSTOMER_NOTICE_DUPLICATE_WINDOW_MINUTES = 30;
/** 미리보기 승인이 유효한 시간(분). 오래된 미리보기로 보내지 않게 한다 */
export const CUSTOMER_NOTICE_PREVIEW_TTL_MINUTES = 10;
/** 결과 안내에 원장이 덧붙이는 한 줄의 최대 길이 */
export const CUSTOMER_NOTICE_EXTRA_LINE_MAX = 200;

const PREFIX = "[STIZ 농구교실]";
export const RENTAL_APPLY_URL = "https://www.stiz-dasan.kr/rental";
/** 설정값이 비어 있을 때만 쓰는 예비 채널 주소(실제 운영 채널) */
export const FALLBACK_KAKAO_CHANNEL_URL = "https://pf.kakao.com/_HhaQG";

/**
 * 관리자 설정(AcademySettings.kakaoChannelUrl)의 채널 주소에서
 * «채널 추가» 주소와 «채팅» 주소를 만든다.
 * 예) https://pf.kakao.com/_HhaQG, …/_HhaQG/chat, pf.kakao.com/_HhaQG/friend 모두 같은 채널로 본다.
 */
export function kakaoChannelLinks(settingUrl: string | null | undefined) {
  const raw = (settingUrl ?? "").trim() || FALLBACK_KAKAO_CHANNEL_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    url = new URL(FALLBACK_KAKAO_CHANNEL_URL);
  }
  if (url.hostname === "pf.kakao.com") {
    // 끝의 /chat · /friend 를 떼고 채널 기본 주소만 남긴다
    const base = `https://pf.kakao.com${url.pathname.replace(/\/(chat|friend)\/?$/i, "").replace(/\/+$/, "")}`;
    return { channelUrl: base, addUrl: `${base}/friend`, chatUrl: `${base}/chat` };
  }
  // 카카오 공식 주소가 아니면 손대지 않고 그대로 쓴다(https 만 허용)
  const plain = url.protocol === "https:" ? url.toString().replace(/\/+$/, "") : FALLBACK_KAKAO_CHANNEL_URL;
  return { channelUrl: plain, addUrl: plain, chatUrl: plain };
}

/** 카카오 접수 종류 → 학부모가 읽는 이름 */
const INTAKE_KIND_LABEL: Record<string, string> = {
  PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀", CLASS_CHANGE: "반 변경", CLASS_ADD: "반 추가",
  SHUTTLE_START_STOP: "셔틀 이용 변경", SHUTTLE_CHANGE: "셔틀 탑승 정보 변경", SHUTTLE_FEE: "셔틀비",
  CONTACT_CHANGE: "연락처 변경", BILLING_CORRECTION: "수강료 청구 확인", MAKEUP: "보강", OTHER: "문의",
};

/** 결과 안내를 보낼 수 있는 접수 상태(원장이 처리를 끝낸 상태만) */
export const INTAKE_RESULT_STATUSES = ["APPROVED", "REJECTED", "NEEDS_DETAILS", "CONSULTATION", "CONSULTATION_CLOSED", "APPLIED"] as const;
export type IntakeResultStatus = (typeof INTAKE_RESULT_STATUSES)[number];

export function isIntakeResultStatus(status: string): status is IntakeResultStatus {
  return (INTAKE_RESULT_STATUSES as readonly string[]).includes(status);
}

/** 결과 문구의 가운데 줄(상태별) */
function intakeResultSentence(status: IntakeResultStatus, kindLabel: string) {
  switch (status) {
    case "APPROVED":
      return `카카오채널로 보내 주신 ${kindLabel} 요청을 확인했습니다. 담당자가 반영을 준비하고 있으며, 반영이 끝나면 다시 안내드리겠습니다.`;
    case "APPLIED":
    case "CONSULTATION_CLOSED":
      return `카카오채널로 보내 주신 ${kindLabel} 요청 처리를 마쳤습니다. 감사합니다.`;
    case "REJECTED":
      return `카카오채널로 보내 주신 ${kindLabel} 요청은 아쉽게도 이번에는 진행이 어렵습니다.`;
    case "NEEDS_DETAILS":
      return `카카오채널로 보내 주신 ${kindLabel} 요청을 처리하려면 확인이 조금 더 필요합니다. 카카오채널에서 날짜·수업 등 자세한 내용을 한 번 더 알려 주세요.`;
    case "CONSULTATION":
      return `카카오채널로 보내 주신 ${kindLabel} 요청은 상담으로 안내드리려고 합니다. 담당자가 곧 연락드리겠습니다.`;
  }
}

/** 원장이 덧붙인 한 줄을 정리한다(줄바꿈·앞뒤 공백 제거, 길이 제한) */
export function cleanExtraLine(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, CUSTOMER_NOTICE_EXTRA_LINE_MAX);
}

/** ① 카카오 접수 처리 결과 안내 */
export function buildIntakeResultMessage(input: {
  studentName: string;
  intakeKind: string;
  status: IntakeResultStatus;
  extraLine?: string | null;
}) {
  const kindLabel = INTAKE_KIND_LABEL[input.intakeKind] ?? "문의";
  const extra = cleanExtraLine(input.extraLine);
  return [
    `${PREFIX} 안녕하세요, ${input.studentName} 학부모님.`,
    intakeResultSentence(input.status, kindLabel),
    ...(extra ? [`※ ${extra}`] : []),
    "궁금하신 점은 카카오채널로 편하게 말씀해 주세요.",
  ].join("\n");
}

/** ② 카카오채널 링크 안내 */
export function buildKakaoChannelInviteMessage(input: { studentName: string; channelSettingUrl: string | null | undefined }) {
  const { addUrl } = kakaoChannelLinks(input.channelSettingUrl);
  return [
    `${PREFIX} 안녕하세요, ${input.studentName} 학부모님.`,
    "카카오채널에서 결석·셔틀·보강을 바로 신청하실 수 있어요.",
    "",
    `1) 채널 추가: ${addUrl}`,
    "2) 채널 채팅창에서 ‘기존 수강생 인증’을 누르면 연결 링크가 옵니다.",
    "3) 링크를 열어 홈페이지 학부모 계정으로 로그인하면 연결이 끝나요. (링크는 받은 뒤 15분 동안 쓸 수 있어요)",
  ].join("\n");
}

/** ③ 체육관 대관 안내 (계좌번호는 넣지 않는다 — 신청 후 따로 안내) */
export function buildRentalGuideMessage() {
  return [
    `${PREFIX} 체육관 대관 안내드립니다.`,
    "",
    "■ 요금",
    // 30분 단위 요금(2026-11-08 원장 확정). 이 파일은 import 없는 순수 모듈이라 숫자를 직접 적는다(테스트가 RENTAL_FEE 와 비교)
    "- 첫 1시간 40,000원, 이후 30분마다 15,000원 (1시간 30,000원)",
    "- 냉난방 사용 시 30분당 2,500원 (1시간 5,000원)",
    "- 10명을 넘으면 넘는 1명당 30분 1,500원 (1시간 3,000원)",
    "- 시작은 10분 단위, 이용은 30분 단위(최소 1시간)",
    "- 보증금 20,000원 (사용 후 확인하고 돌려드려요)",
    "",
    "■ 꼭 지켜 주세요",
    "- 실내 운동화를 꼭 신어 주세요.",
    "- 주차는 인근 주민센터 주차장을 이용해 주세요.",
    "",
    `■ 신청하기: ${RENTAL_APPLY_URL}`,
  ].join("\n");
}

/** 휴대폰 번호를 숫자만 남겨 정리하고, 010 등 휴대폰 형식인지 본다 */
export function normalizeMobilePhone(value: string | null | undefined) {
  const digits = (value ?? "").replace(/[^0-9]/g, "");
  return /^01\d{8,9}$/.test(digits) ? digits : null;
}

/** 화면에 보일 가린 번호 «***-****-1234» */
export function maskPhone(phone: string) {
  return `***-****-${phone.slice(-4)}`;
}
