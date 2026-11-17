/**
 * 고객(학부모·대관 문의자)에게 보내는 «미리보기 → 원장 승인 → 발송» 안내 문자의 문구 모음.
 *
 * 왜 따로 두나: 문구는 원장님이 승인하는 «계약서 본문» 같은 것이라, 화면·서버·테스트가
 * 모두 같은 한 곳을 봐야 한다. 이 파일은 DB·서버를 전혀 모르는 순수 함수만 둔다
 * (테스트가 그대로 실행해 문구 전문을 확인할 수 있게 import 도 없다).
 */

/** 고객 안내 문자 종류. 발송 장부(NotificationDelivery.eventType)에도 이 값이 남는다. */
export const CUSTOMER_NOTICE_KINDS = ["KAKAO_INTAKE_RESULT", "KAKAO_CHANNEL_INVITE", "RENTAL_GUIDE", "PARENT_SIGNUP_GUIDE"] as const;
export type CustomerNoticeKind = (typeof CUSTOMER_NOTICE_KINDS)[number];

/** 화면·장부에 보이는 이름 */
export const CUSTOMER_NOTICE_LABEL: Record<CustomerNoticeKind, string> = {
  KAKAO_INTAKE_RESULT: "카카오 접수 처리 결과 안내",
  KAKAO_CHANNEL_INVITE: "카카오채널 링크 안내",
  RENTAL_GUIDE: "체육관 대관 안내",
  PARENT_SIGNUP_GUIDE: "학부모 가입 안내",
};

/** 같은 번호에 같은 안내를 다시 보내지 못하게 막는 시간(분). 실수로 두 번 누르는 사고 방지 */
export const CUSTOMER_NOTICE_DUPLICATE_WINDOW_MINUTES = 30;
/** 미리보기 승인이 유효한 시간(분). 오래된 미리보기로 보내지 않게 한다 */
export const CUSTOMER_NOTICE_PREVIEW_TTL_MINUTES = 10;
/** 결과 안내에 원장이 덧붙이는 한 줄의 최대 길이 */
export const CUSTOMER_NOTICE_EXTRA_LINE_MAX = 200;

// 머리말 — 학부모 대상 문자 전부 [스티즈농구교실] 로 통일(2026-11-09 원장 결정)
const PREFIX = "[스티즈농구교실]";
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

// ───────────────────────── ④ 학부모 가입 안내(여러 명에게 한 번에) ─────────────────────────

export const PARENT_SIGNUP_URL = "https://www.stiz-dasan.kr/signup/parent";
// 앱 설치 짧은 주소(2026-11-13 f10) — 기기를 보고 Play 스토어/App Store 로 나눠 보낸다(src/app/install/page.tsx).
// 경로는 @/lib/app-install-links 의 APP_INSTALL_PATH 와 같아야 한다(이 파일은 import 없는 순수 모듈이라 테스트가 대조한다).
export const PARENT_APP_INSTALL_URL = "https://www.stiz-dasan.kr/install";

/**
 * ④ 학부모 가입 안내 (2026-11-09 원장 승인 문구)
 *
 * ⚠️ 원장 승인본에서 딱 두 군데만 바꿨다 — 문자(SMS/LMS)는 통신사 규격상 한글 완성형(EUC-KR)
 * 글자만 온전히 간다. 그 밖의 글자는 받는 휴대폰에서 «?»로 깨지거나 발송이 거절된다.
 *   - 🏀 (이모지) → 뺐다 ("재원생 가족 혜택" 제목만 남김)
 *   - 결석 알리기·스티즈농구교실을 감싼 꺾쇠 따옴표 → ‘ ’ (기존 카카오채널 안내와 같은 따옴표)
 * 테스트(tests/parent-signup-guide.test.mjs)가 «완성형 밖 글자 없음»을 못박는다.
 * 2026-11-13 f10: «▶ 앱 설치» 두 줄 추가(원장 점검표 지시). 원래부터 LMS(90바이트 초과)라 요금 구간은 같다.
 */
// 2026-11-17 원장 지시: «랠리즈 종료·앱에서 모든 소식·청구·결제», 앱 설치를 맨 앞에,
// 카카오톡 채널은 아직 준비 전이라 문의 줄을 원장 전화로 바꿨다(채널 안내 금지).
/** 가입 안내 네 문구의 문의 줄 — 카카오톡 채널 대신 원장 전화(2026-11-17 원장 지시) */
export const SIGNUP_GUIDE_CONTACT_LINE = "문의: 김수빈 원장 010-9167-8117";

export function buildParentSignupGuideMessage() {
  return [
    "[스티즈농구교실] 학부모 앱 안내",
    "",
    "안녕하세요, 스티즈농구교실입니다.",
    "랠리즈 사용을 종료하고, 12월부터 스티즈농구교실 앱을 사용합니다.",
    "수업 소식·출결·수강료 청구와 결제를 모두 앱에서 하실 수 있어요.",
    "",
    `▶ 앱 설치: ${PARENT_APP_INSTALL_URL}`,
    `▶ 가입하기: ${PARENT_SIGNUP_URL}`,
    "학원에 등록하신 휴대폰 번호로 가입하시면 자녀가 자동으로 연결돼요.",
    "앱에서는 가입하신 아이디로 로그인하시면 돼요.",
    "",
    // 2026-11-14 원장 결정표: 학부모 화면 이름과 같게 «결석 신고» → «결석 알리기»
    "▶ 결석은 가입 후 앱의 ‘결석 알리기’로 알려 주세요.",
    "",
    "재원생 가족 혜택",
    "로그인 후 체육관 대관을 신청하시면 2시간 무료예요.",
    RENTAL_APPLY_URL,
    "",
    SIGNUP_GUIDE_CONTACT_LINE,
  ].join("\n");
}

/**
 * ④-2 성인 수강생 본인용 가입 안내 (2026-11-16 원장 결정표 «성인도 포함해»)
 *
 * 왜 따로 두나: 만 19세 이상 수강생은 본인이 계정 주인이라(학원 기록의 대표 보호자 = 본인 이름·본인 번호)
 * «학부모님·자녀» 문구가 어색하다. 학부모용 승인 문구(혜택 3줄 포함)는 그대로 두고,
 * 성인용은 «학부모 → 회원», «자녀 → 수강 정보», «재원생 가족 혜택 → 재원생 혜택» 세 군데만 바꿨다.
 * 링크·순서·혜택 내용은 학부모용과 같다(테스트가 두 문구의 차이를 이 세 줄로 못박는다).
 */
export function buildAdultSignupGuideMessage() {
  return buildParentSignupGuideMessage()
    .replace("[스티즈농구교실] 학부모 앱 안내", "[스티즈농구교실] 회원 앱 안내")
    .replace("가입하시면 자녀가 자동으로 연결돼요.", "가입하시면 수강 정보가 자동으로 연결돼요.")
    .replace("재원생 가족 혜택", "재원생 혜택");
}

/** 로그인 화면 주소(src/app/login/page.tsx) */
export const PARENT_LOGIN_URL = "https://www.stiz-dasan.kr/login";

/**
 * ④-3 이미 가입한 보호자용 이용 안내 (2026-11-16 원장 지시 «이미 가입한 보호자도 넣어 — 아무도 제대로 쓰고 있지 않아서»)
 *
 * 학부모용 승인본을 바탕으로 «가입하기» 대신 «로그인»으로 바꿨다(문구 전문은 원장 지시 그대로).
 * 혜택 3줄·앱 설치·결석·문의 줄은 승인본과 같다.
 */
// 2026-11-17 원장 지시: 이미 가입한 분도 앱을 받게 — 웹 로그인 링크는 빼고 앱 설치 링크만 둔다.
export function buildSignedInGuideMessage() {
  return [
    "[스티즈농구교실] 학부모 앱 설치 안내",
    "",
    "안녕하세요, 스티즈농구교실입니다.",
    "랠리즈 사용을 종료하고, 12월부터 스티즈농구교실 앱을 사용합니다.",
    "수업 소식·출결·수강료 청구와 결제를 모두 앱에서 하실 수 있어요.",
    "",
    `▶ 앱 설치: ${PARENT_APP_INSTALL_URL}`,
    "이미 가입하신 아이디로 로그인하시면 바로 이용하실 수 있어요.",
    "",
    "▶ 결석은 앱의 ‘결석 알리기’로 알려 주세요.",
    "",
    "재원생 가족 혜택",
    "로그인 후 체육관 대관을 신청하시면 2시간 무료예요.",
    RENTAL_APPLY_URL,
    "",
    SIGNUP_GUIDE_CONTACT_LINE,
  ].join("\n");
}

/** ④-4 이미 가입한 성인 수강생 본인용 — 성인 가입 안내와 같은 방식(학부모 → 회원, 가족 혜택 → 혜택) */
export function buildAdultSignedInGuideMessage() {
  return buildSignedInGuideMessage()
    .replace("[스티즈농구교실] 학부모 앱 설치 안내", "[스티즈농구교실] 회원 앱 설치 안내")
    .replace("재원생 가족 혜택", "재원생 혜택");
}

/** 미리보기에 보여 줄 받는 사람 수(처음 몇 명만) */
export const PARENT_SIGNUP_PREVIEW_SAMPLE = 5;

/** 받는 번호 한 개의 구분 — 재원(수강 중) · 휴원(휴원만 남음) · 성인(그 번호의 학생이 모두 만 19세 이상) */
export type SignupGuideGroup = "ACTIVE" | "PAUSED" | "ADULT";

/** DB 에서 읽은 «수강생 1명 – 대표 보호자» 한 줄 */
export type SignupGuideCandidate = {
  parentUserId: string;
  studentName: string;
  phone: string | null;
  /** 로그인 계정이 있으면(User.authUserId 가 있으면) true — «가입함» 구분으로 로그인 안내를 받는다 */
  hasAccount: boolean;
  /** 이 학생의 수강 상태 — 수강 중인 반이 하나라도 있으면 ACTIVE, 휴원만 남았으면 PAUSED (없으면 ACTIVE 로 본다) */
  enrollmentStatus?: "ACTIVE" | "PAUSED";
  /** 학생이 만 19세 이상(성인 수강생 — 본인이 계정 주인) */
  isAdult?: boolean;
  /**
   * 이 번호로 가입하면 «이미 가입된 휴대폰 번호» 로 막히는가 (가입 판정 classifyPhoneOwnership 와 같은 기준:
   * 같은 번호를 쓰는 계정 중 «빈 보호자 계정»이 아닌 것 — 로그인 수단이 있거나 직원 계정 — 이 하나라도 있으면 true)
   */
  phoneRegistered?: boolean;
  /** 같은 번호의 빈 보호자 계정이 여러 개 — 가입하면 «학원에 문의» 로 멈춘다(자동으로 고르지 않음) */
  phoneMultipleClaimable?: boolean;
};

export type SignupGuideRecipient = {
  phone: string;
  parentUserId: string;
  studentNames: string[];
  /** 문구·미리보기 구분. 성인이면 성인용 문구가 간다 */
  group: SignupGuideGroup;
  /** 이 번호로 이미 가입한 보호자(또는 성인 본인)가 있다 — 가입 안내 대신 로그인 안내가 간다 */
  signedIn: boolean;
  /** 가입하면 «학원에 문의» 로 멈추는 번호(보내기는 하되 미리보기에 따로 센다) */
  needsAcademyHelp: boolean;
};

/** 번호 하나에 묶인 학생들 → 구분. 성인만 있으면 성인, 아니면 수강 중이 하나라도 있으면 재원, 그 밖은 휴원 */
function groupOf(rows: SignupGuideCandidate[]): SignupGuideGroup {
  if (rows.every((row) => row.isAdult === true)) return "ADULT";
  return rows.some((row) => (row.enrollmentStatus ?? "ACTIVE") === "ACTIVE") ? "ACTIVE" : "PAUSED";
}

/**
 * 받는 사람 고르기(순수 함수 — 서버와 테스트가 같은 규칙을 쓴다).
 *
 * 대상(서버 SQL): 수강이 ACTIVE 또는 PAUSED 인 학생(병합 제외·퇴원만 남은 학생 제외)의 대표 보호자.
 *   성인 수강생도 대표 보호자 칸이 «본인 이름·본인 번호의 빈 계정»이라 같은 길로 잡힌다.
 *
 * 규칙
 *   1) 휴대폰 번호가 아니면 뺀다(번호 없음·집 전화). 가입 여부와 상관없이 학생 수로 센다.
 *   2) 로그인 계정이 있는 보호자(성인 본인 포함)는 «가입함»으로 넣는다 — 가입 안내 대신 로그인 안내(2026-11-16).
 *      같은 번호를 계정 있는 다른 보호자가 쓰고 있으면 그 번호 전체를 «가입함»으로 본다(1통).
 *   2-1) 미가입 번호 중 가입 판정에서 «이미 가입된 번호»로 막히는 번호(직원 계정 등이 같은 번호를 씀)는 뺀다 — 개수만 센다.
 *        가입함 번호에는 적용하지 않는다(가입이 아니라 로그인 안내라서).
 *   3) 같은 번호는 한 번만(형제가 둘이면 문자는 1통, 자녀 이름은 모아 둔다).
 *   4) 이미 이 안내를 받은 번호는 뺀다 — 원장이 «다시 보내기»를 고른 때만 넣는다.
 * 순서는 번호 오름차순으로 고정한다(미리보기·보내기 직전 대조가 같은 결과를 내게).
 */
export function selectParentSignupGuideRecipients(
  candidates: SignupGuideCandidate[],
  options: { alreadySentPhones: ReadonlySet<string>; resend: boolean },
) {
  // 계정 있는 보호자의 번호부터 모은다(규칙 2 — 이 번호는 «가입함»)
  const accountPhones = new Set<string>();
  for (const row of candidates) {
    const phone = normalizeMobilePhone(row.phone);
    if (phone && row.hasAccount) accountPhones.add(phone);
  }

  const rowsByPhone = new Map<string, SignupGuideCandidate[]>();
  const registeredPhones = new Set<string>();
  let invalidPhoneCount = 0;
  for (const row of candidates) {
    const phone = normalizeMobilePhone(row.phone);
    if (!phone) { invalidPhoneCount += 1; continue; }
    // 규칙 2-1 — 미가입 번호만: 가입하면 «이미 가입된 번호»로 막힌다. 보내지 않고 번호 수만 센다
    if (!accountPhones.has(phone) && row.phoneRegistered) { registeredPhones.add(phone); continue; }
    const list = rowsByPhone.get(phone);
    if (list) list.push(row); else rowsByPhone.set(phone, [row]);
  }

  const all: SignupGuideRecipient[] = [];
  for (const [phone, rows] of rowsByPhone) {
    const signedIn = accountPhones.has(phone);
    // 같은 번호 = 문자 1통. 자녀 이름만 모은다(규칙 3)
    const studentNames: string[] = [];
    for (const row of rows) if (!studentNames.includes(row.studentName)) studentNames.push(row.studentName);
    // 대표 계정 = 가입함 번호면 계정 있는 보호자, 아니면 첫 줄
    const owner = (signedIn ? rows.find((row) => row.hasAccount) : undefined) ?? rows[0];
    all.push({
      phone,
      parentUserId: owner.parentUserId,
      studentNames,
      group: groupOf(rows),
      signedIn,
      // «학원에 문의» 경고는 가입하는 사람에게만 의미가 있다
      needsAcademyHelp: !signedIn && rows.some((row) => row.phoneMultipleClaimable === true),
    });
  }
  all.sort((a, b) => (a.phone < b.phone ? -1 : a.phone > b.phone ? 1 : 0));
  const alreadySentCount = all.filter((item) => options.alreadySentPhones.has(item.phone)).length;
  // 규칙 4 — «다시 보내기»를 고르지 않았으면 이미 받은 번호는 뺀다
  const recipients = options.resend ? all : all.filter((item) => !options.alreadySentPhones.has(item.phone));
  // 미리보기에 보일 구성(받는 번호 기준, 겹치지 않게) — 미가입 재원·휴원·성인 + 가입함
  const unsigned = recipients.filter((item) => !item.signedIn);
  const breakdown = {
    active: unsigned.filter((item) => item.group === "ACTIVE").length,
    paused: unsigned.filter((item) => item.group === "PAUSED").length,
    adult: unsigned.filter((item) => item.group === "ADULT").length,
    signedIn: recipients.length - unsigned.length,
  };
  const needsAcademyHelpCount = recipients.filter((item) => item.needsAcademyHelp).length;
  return { recipients, alreadySentCount, invalidPhoneCount, registeredPhoneCount: registeredPhones.size, breakdown, needsAcademyHelpCount };
}

/**
 * 받는 사람 1명에게 갈 문구
 *   미가입: 학부모용(원장 승인본) / 성인 본인이면 성인용
 *   가입함: 로그인 안내 / 성인 본인이면 회원용 로그인 안내
 */
export function signupGuideMessageFor(item: Pick<SignupGuideRecipient, "group"> & { signedIn?: boolean }) {
  if (item.signedIn) return item.group === "ADULT" ? buildAdultSignedInGuideMessage() : buildSignedInGuideMessage();
  return item.group === "ADULT" ? buildAdultSignupGuideMessage() : buildParentSignupGuideMessage();
}

/** 이름 가리기: 김민수 → 김*수, 이준 → 이*, 남궁민수 → 남**수 */
export function maskPersonName(name: string) {
  const chars = [...(name ?? "").trim()];
  if (chars.length <= 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** 미리보기 한 줄: «김*수 학생 학부모 · ***-****-1234» (성인 «김*수 성인 수강생 본인 · …», 휴원 «… 학부모(휴원) · …») */
export function describeSignupGuideRecipient(item: Pick<SignupGuideRecipient, "phone" | "studentNames"> & { group?: SignupGuideGroup; signedIn?: boolean }) {
  const names = item.studentNames.map(maskPersonName).join("·");
  const who = item.group === "ADULT" ? "성인 수강생 본인" : item.group === "PAUSED" ? "학생 학부모(휴원)" : "학생 학부모";
  // 이미 가입한 번호는 «가입함» 표시(로그인 안내가 간다)
  return `${names} ${who}${item.signedIn ? " · 가입함" : ""} · ${maskPhone(item.phone)}`;
}
