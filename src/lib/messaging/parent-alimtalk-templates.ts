/**
 * 학부모 알림톡 틀 금고(레지스트리) — 2026-11-09 1차 9종
 *
 * 왜 필요한가?
 *  알림톡은 «카카오에 등록(심사)한 문구와 한 글자라도 다르면 실패»한다. 그런데 학부모 자동 문자 문구는
 *  DB(SmsTemplate.body)에 있고 관리자가 고칠 수 있었다. 그래서 알림톡으로 바꾸는 트리거는 문구 원본을
 *  **이 파일 한 곳**에 두고, 문자 본문·알림톡 본문·심사 문서(docs/kakao-alimtalk-parent-templates.md)가
 *  모두 여기서 복사해 간다(체육관 대관 RENTAL_APPLICANT_TEMPLATES 패턴을 일반화).
 *
 * 규칙
 *  - 문자 본문 = 알림톡 본문(같은 틀에 같은 값). 알림톡이 실패하면 코드가 같은 본문을 문자로 대신 보낸다.
 *  - 빈 변수는 오류(«문의: » 같은 빈칸 문장 방지). 오류가 나면 발송부가 옛 DB 문구로 «문자만» 보낸다.
 *  - 문구를 바꾸려면 이 파일 + 심사 문서 + 카카오 템플릿을 같이 고치고 재심사 받는다(테스트가 문서와 대조).
 *  - import 없는 순수 모듈(테스트가 그대로 실행한다).
 */

/** 머리말 — 학부모 대상 문자 전부 이 이름으로 통일(원장 결정 2026-11-09) */
export const PARENT_MESSAGE_PREFIX = "[스티즈농구교실]";

/** 직원(내부) 대상 수동 문자의 머리말 — 예전 그대로 둔다(검수 정정 2026-11-09: 학부모만 통일) */
export const STAFF_MESSAGE_PREFIX = "[STIZ]";

/** 수동 문자 머리말: 학부모(EXTERNAL)만 [스티즈농구교실], 직원(INTERNAL)은 예전 [STIZ] */
export function manualMessagePrefix(audienceScope: "INTERNAL" | "EXTERNAL"): string {
  return audienceScope === "EXTERNAL" ? PARENT_MESSAGE_PREFIX : STAFF_MESSAGE_PREFIX;
}

/**
 * 예약 발송 본문에 학부모 머리말을 붙인다(크론 전용).
 *  - 이미 머리말([STIZ…]/[스티즈농구교실])이 있으면 그대로 — 겹치지 않게
 *  - 배포 전에 예약된 등원 안내는 «농구교실 등원 셔틀 안내»로 시작한다 → 제목의 «농구교실 »을 떼고 붙여
 *    즉시 발송과 같은 «[스티즈농구교실] 등원 셔틀 안내»가 되게 한다(«[스티즈농구교실] 농구교실…» 겹침 방지)
 */
export function withParentPrefix(body: string): string {
  if (body.startsWith("[STIZ") || body.startsWith(PARENT_MESSAGE_PREFIX)) return body;
  const normalized = body.startsWith("농구교실 등원 셔틀 안내") ? body.slice("농구교실 ".length) : body;
  return `${PARENT_MESSAGE_PREFIX} ${normalized}`;
}

/** 학원 전화가 설정에 비어 있을 때 쓰는 대표번호(보안 알림 문구와 같은 번호) */
export const DEFAULT_ACADEMY_PHONE = "070-8824-5712";

export type ParentAlimtalkSpec = {
  /** 관리자 화면·문서에 보이는 이름 */
  name: string;
  /** 템플릿 id 를 담는 환경변수 이름. 비어 있으면 그 안내는 문자로만 나간다 */
  envKey: string;
  /** 등록 문구(#{한글변수}) */
  body: string;
  /** 틀 변수 → 호출부가 넘기는 값의 키(예: "#{학생명}" ← "childName") */
  vars: Record<string, string>;
  /** 호출부 값이 비었을 때 넣을 값(빈 변수 방지). 없으면 오류 → 문자로 대체 */
  defaults?: Record<string, string>;
  /**
   * 호출부 값(callerKey)이 비었을 때 쓰는 «그 줄이 없는» 별도 틀. 빈칸 줄을 만들지 않으려고 둔다.
   * 별도 알림톡 템플릿이라 envKey 가 따로 있다(비어 있으면 이 판은 문자로만 나간다).
   */
  whenEmpty?: { callerKey: string; name: string; envKey: string; body: string };
};

const P = PARENT_MESSAGE_PREFIX;

export const PARENT_ALIMTALK_TEMPLATES = {
  /** T1 체험수업 일정 확정 */
  TRIAL_SCHEDULED_PARENT: {
    name: "체험수업 일정 확정",
    envKey: "ALIMTALK_TPL_TRIAL_SCHEDULED",
    body: [
      `${P} #{학생명} 체험수업 일정이 확정되었습니다.`,
      "일시: #{일시}",
      "반: #{반}",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{일시}": "scheduledDate", "#{반}": "className", "#{학원전화}": "academyPhone" },
    defaults: { className: "추후 안내", academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** T2 수강신청서 안내 — 다비치 제휴 할인·제휴 공지 링크는 광고라 뺐다(원장 결정 d-davichi) */
  TRIAL_ENROLL_GUIDE_PARENT: {
    name: "수강신청서 안내",
    envKey: "ALIMTALK_TPL_TRIAL_ENROLL_GUIDE",
    body: [
      `${P} #{학생명} 수강신청서`,
      "아래 링크에서 작성해주세요 :)",
      "#{신청서링크}",
      "",
      "■ 수업 준비물: 실내용 운동화, 물 담은 텀블러",
      "",
      "■ 안경 착용 안내",
      "안경은 부상 위험이 있어 스포츠고글 착용을 권장합니다.",
      "",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{신청서링크}": "enrollLink", "#{학원전화}": "academyPhone" },
    defaults: { academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** T3 셔틀 노선 확정 안내(값이 없으면 셔틀 코드가 «운행일 확인 중»·«시간 확인 중»을 넣는다) */
  SHUTTLE_ROUTE_CONFIRMED_PARENT: {
    name: "셔틀 탑승 안내",
    envKey: "ALIMTALK_TPL_SHUTTLE_ROUTE_CONFIRMED",
    body: [
      `${P} #{학생명} 셔틀 #{운행방향} 안내`,
      "#{운행일} #{예정시간} / #{정류장}",
    ].join("\n"),
    vars: { "#{학생명}": "학생명", "#{운행방향}": "운행방향", "#{운행일}": "운행일", "#{예정시간}": "예정시간", "#{정류장}": "정류장" },
  },
  /** T4 셔틀 미탑승 */
  SHUTTLE_NO_SHOW_PARENT: {
    name: "셔틀 미탑승 안내",
    envKey: "ALIMTALK_TPL_SHUTTLE_NO_SHOW",
    body: `${P} #{학생명} 학생이 오늘 #{운행방향} 셔틀에 미탑승 처리되었습니다. 확인 부탁드립니다.`,
    vars: { "#{학생명}": "학생명", "#{운행방향}": "운행방향" },
  },
  /** T5 특강 결제 요청 */
  SPECIAL_PAYMENT_REQUEST_PARENT: {
    name: "특강 결제 요청",
    envKey: "ALIMTALK_TPL_SPECIAL_PAYMENT_REQUEST",
    body: [
      `${P} #{학생명} 학생의 #{특강명} 특강 결제를 확인해 주세요.`,
      "금액: #{금액}원",
      "납부기한: #{납부기한}",
      "#{결제링크}",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{특강명}": "offeringTitle", "#{금액}": "amount", "#{납부기한}": "dueDate", "#{결제링크}": "paymentUrl" },
  },
  /** T6 특강 신청 취소 */
  SPECIAL_APPLICATION_CANCELLED_PARENT: {
    name: "특강 신청 취소",
    envKey: "ALIMTALK_TPL_SPECIAL_APPLICATION_CANCELLED",
    body: [
      `${P} #{학생명} 학생의 #{특강명} 특강 신청이 취소되었습니다.`,
      "문의: #{학원전화}",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{특강명}": "offeringTitle", "#{학원전화}": "academyPhone" },
    defaults: { academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** T7 특강 신청 접수(규칙은 꺼짐 — 켜는 시점은 원장) */
  SPECIAL_APPLICATION_RECEIVED_PARENT: {
    name: "특강 신청 접수",
    envKey: "ALIMTALK_TPL_SPECIAL_APPLICATION_RECEIVED",
    body: [
      `${P} #{학생명} 학생의 #{시즌명} 특강 신청이 접수되었습니다.`,
      "신청: #{특강명}",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{시즌명}": "seasonTitle", "#{특강명}": "offeringTitle", "#{학원전화}": "academyPhone" },
    defaults: { academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** T8 특강 신청 승인(규칙은 꺼짐) */
  SPECIAL_APPLICATION_APPROVED_PARENT: {
    name: "특강 신청 승인",
    envKey: "ALIMTALK_TPL_SPECIAL_APPLICATION_APPROVED",
    body: [
      `${P} #{학생명} 학생의 #{특강명} 특강 신청이 승인되었습니다.`,
      "결제 및 계정 안내를 확인해 주세요.",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{특강명}": "offeringTitle", "#{학원전화}": "academyPhone" },
    defaults: { academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** T9 특강 대기 접수 */
  SPECIAL_APPLICATION_WAITLISTED_PARENT: {
    name: "특강 대기 접수",
    envKey: "ALIMTALK_TPL_SPECIAL_APPLICATION_WAITLISTED",
    body: [
      `${P} #{학생명} 학생의 #{특강명} 특강은 대기 접수되었습니다.`,
      "대기순번: #{대기순번}",
      "자리 발생 시 안내드리겠습니다.",
    ].join("\n"),
    vars: { "#{학생명}": "childName", "#{특강명}": "offeringTitle", "#{대기순번}": "waitlistOrder" },
    // 신청서 단위로 대기 처리했는데 항목에 순번이 하나도 없을 때 — «대기순번:» 줄 없이 보낸다(빈칸 금지)
    whenEmpty: {
      callerKey: "waitlistOrder",
      name: "특강 대기 접수(순번 없음)",
      envKey: "ALIMTALK_TPL_SPECIAL_APPLICATION_WAITLISTED_NO_ORDER",
      body: [
        `${P} #{학생명} 학생의 #{특강명} 특강은 대기 접수되었습니다.`,
        "자리 발생 시 안내드리겠습니다.",
      ].join("\n"),
    },
  },
} satisfies Record<string, ParentAlimtalkSpec>;

export type ParentAlimtalkTrigger = keyof typeof PARENT_ALIMTALK_TEMPLATES;

// ═════════════════════ 공지 알림톡 3종(2026-11-09 원장 결정) ═════════════════════
//
// 왜 위 9종과 따로 두나: 위 9종은 «자동 발송 규칙(트리거)»이 보내는 안내이고, 이 3종은 원장이 /admin/sms 에서
// 직접 써서 재원생 학부모 전체에게 보내는 «공지»다. 트리거·DB 문자 틀이 없어 자동 발송 가드와 섞지 않는다.
// 규칙은 같다 — 문자 본문 = 알림톡 본문, 빈 변수 금지, 문구를 바꾸면 심사 문서·카카오 템플릿도 같이(재심사).

/** 모든 공지 틀의 웹링크 버튼. 도메인은 등록 문구에 고정하고 경로만 변수(카카오 규칙: 프로토콜·도메인은 고정 영역) */
export const NOTICE_BUTTON_NAME = "공지 자세히 보기";
export const NOTICE_LINK_BASE = "https://www.stiz-dasan.kr/";
export const NOTICE_BUTTON_LINK_TEMPLATE = `${NOTICE_LINK_BASE}#{공지경로}`;
/** 공지를 고르지 않으면 공지 목록으로 */
export const DEFAULT_NOTICE_PATH = "notices";

/** 선택 칸이 비었을 때 들어가는 기본 문장(빈 변수 금지 규칙 때문에 줄을 비우지 않는다) */
export const NOTICE_EMPTY_DEFAULTS = {
  /** 휴무 공지의 #{보강안내} — 학원 휴무는 보강 없음이 기본 정책이라(2027 연간일정) «없음»으로 */
  makeupNotice: "보강: 없음",
  /** 행사 공지의 #{신청안내} — 비우면 «신청 필요 없음»으로 읽히게 */
  applyNotice: "별도 신청은 필요 없습니다.",
} as const;

export type NoticeAlimtalkSpec = {
  name: string;
  envKey: string;
  body: string;
  /** 틀 변수 → 화면 입력 칸 키 */
  vars: Record<string, string>;
  defaults?: Record<string, string>;
};

export const NOTICE_ALIMTALK_TEMPLATES = {
  /** N1 학원 휴무 안내(반 단위가 아니라 학원 전체 휴무) */
  NOTICE_CLOSURE: {
    name: "학원 휴무 안내",
    envKey: "ALIMTALK_TPL_NOTICE_CLOSURE",
    body: [
      `${P} 학원 휴무 안내`,
      "안녕하세요, #{학생명} 학부모님.",
      "#{휴무기간} 학원 전체 휴무입니다.",
      "사유: #{사유}",
      "#{보강안내}",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: {
      "#{학생명}": "studentName", "#{휴무기간}": "closurePeriod", "#{사유}": "reason",
      "#{보강안내}": "makeupNotice", "#{학원전화}": "academyPhone",
    },
    defaults: { makeupNotice: NOTICE_EMPTY_DEFAULTS.makeupNotice, academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** N2 행사 안내(재원생 대상) */
  NOTICE_EVENT: {
    name: "행사 안내",
    envKey: "ALIMTALK_TPL_NOTICE_EVENT",
    body: [
      `${P} 행사 안내`,
      "안녕하세요, #{학생명} 학부모님.",
      "재원생 대상 #{행사명} 일정을 안내드립니다.",
      "· 일시: #{일시}",
      "· 장소: #{장소}",
      "· 내용: #{내용}",
      "#{신청안내}",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: {
      "#{학생명}": "studentName", "#{행사명}": "eventName", "#{일시}": "eventDate", "#{장소}": "eventPlace",
      "#{내용}": "eventDetail", "#{신청안내}": "applyNotice", "#{학원전화}": "academyPhone",
    },
    defaults: { applyNotice: NOTICE_EMPTY_DEFAULTS.applyNotice, academyPhone: DEFAULT_ACADEMY_PHONE },
  },
  /** N3 ○월 수업 안내 */
  NOTICE_MONTHLY: {
    name: "월 수업 안내",
    envKey: "ALIMTALK_TPL_NOTICE_MONTHLY",
    body: [
      `${P} #{월}월 수업 안내`,
      "안녕하세요, #{학생명} 학부모님.",
      "#{월}월 수업 일정과 안내 사항을 알려드립니다.",
      "· 휴무일: #{휴무일}",
      "· 수강료: #{수강료안내}",
      "· 안내 사항: #{안내사항}",
      "문의: #{학원전화}",
    ].join("\n"),
    vars: {
      "#{월}": "month", "#{학생명}": "studentName", "#{휴무일}": "closedDays",
      "#{수강료안내}": "tuitionNotice", "#{안내사항}": "notes", "#{학원전화}": "academyPhone",
    },
    defaults: { academyPhone: DEFAULT_ACADEMY_PHONE },
  },
} satisfies Record<string, NoticeAlimtalkSpec>;

export type NoticeAlimtalkKind = keyof typeof NOTICE_ALIMTALK_TEMPLATES;

export function isNoticeAlimtalkKind(kind: unknown): kind is NoticeAlimtalkKind {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(NOTICE_ALIMTALK_TEMPLATES, kind);
}

export type NoticeAlimtalkMessage = {
  kind: NoticeAlimtalkKind;
  envKey: string;
  /** 문자·알림톡 공통 본문 */
  body: string;
  variables: Record<string, string>;
  /** 알림톡 버튼(등록 템플릿의 버튼과 이름·유형이 같아야 한다). 링크는 경로만 바뀐다 */
  button: { buttonName: string; buttonType: "WL"; linkMo: string; linkPc: string };
};

/**
 * 공지 경로 정리 — 도메인 고정·경로만 변수라 «notices/아이디» 같은 상대 경로만 받는다.
 * 앞 «/» 는 떼고, 영문·숫자·-_/ 밖의 글자가 있으면 공지 목록으로 돌린다(남의 사이트로 못 보내게).
 */
export function normalizeNoticePath(value: string | null | undefined): string {
  const path = String(value ?? "").trim().replace(/^\/+/, "");
  if (!path || path.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_\-/]*$/.test(path) || path.includes("//")) return DEFAULT_NOTICE_PATH;
  return path;
}

/**
 * 화면 입력값(+학생명·학원전화)으로 공지 알림톡 본문·변수·버튼을 만든다.
 * 선택 칸이 비면 defaults 로 채우고, 필수 칸이 비면 오류(빈칸 문장 금지).
 */
export function buildNoticeAlimtalkMessage(
  kind: NoticeAlimtalkKind,
  callerVariables: Record<string, string | null | undefined>,
  noticePath?: string | null,
): NoticeAlimtalkMessage {
  const spec: NoticeAlimtalkSpec = NOTICE_ALIMTALK_TEMPLATES[kind];
  const variables: Record<string, string> = {};
  for (const key of templateVariableKeys(spec.body)) {
    const callerKey = spec.vars[key];
    if (!callerKey) throw new Error(`알림톡 변수 ${key} 의 연결이 없습니다.`);
    const raw = String(callerVariables[callerKey] ?? "").trim();
    variables[key] = raw || spec.defaults?.[callerKey] || "";
  }
  const path = normalizeNoticePath(noticePath);
  const link = `${NOTICE_LINK_BASE}${path}`;
  const body = fillAlimtalkTemplate(spec.body, variables);
  return {
    kind,
    envKey: spec.envKey,
    body,
    // 버튼 링크의 경로 변수도 같은 맵에 넣는다(등록 템플릿에 정의된 변수라 보내도 된다). 버튼도 아래에 직접 넘긴다
    variables: { ...variables, "#{공지경로}": path },
    button: { buttonName: NOTICE_BUTTON_NAME, buttonType: "WL", linkMo: link, linkPc: link },
  };
}

/**
 * 금고 밖에서 학부모에게 «문자로만» 나가도 되는 트리거(가드 테스트가 이 목록과 금고만 허용한다).
 * 새 학부모 문자를 만들 때는 금고에 넣거나, 여기에 이유와 함께 적는다.
 */
export const SMS_ONLY_PARENT_TRIGGERS: Record<string, string> = {
  TRIAL_CONFIRM_PARENT: "공개 폼 접수 확인(꺼짐 유지 — 남의 번호 위험). 3차 후보",
  // 2026-11-10 초안 — 원장 문구 승인 전이라 자동 발송 스위치 기본 꺼짐(미리보기만). 승인되면 알림톡 금고 후보
  TRIAL_PAID_GUIDE_PARENT: "체험비 결제 완료 → 체험 확정 안내(src/lib/trial-fee/guideMessages.ts, 스위치 기본 꺼짐)",
  ENROLL_WELCOME_GUIDE_PARENT: "등록 안내 — 담당 코치·셔틀 기사님 연락처 자동(guideMessages.ts, 스위치 기본 꺼짐)",
  ENROLL_CONFIRM_PARENT: "공개 폼 접수 확인(꺼짐 유지). 3차 후보",
  UNPAID_PARENT: "미납 안내(잠금 — 토스 라이브 때 전환). 3차 후보",
  SPECIAL_APPLICATION_REJECTED_PARENT: "특강 반려(꺼짐). 2차 후보",
  SPECIAL_ACCOUNT_ACTIVATION_PARENT: "특강 보호자 가입 링크(꺼짐). 2차 후보",
  RENTAL_RECEIVED_APPLICANT: "대관 접수(꺼짐 유지). 대관 틀은 src/lib/rental 이 따로 관리",
  RENTAL_APPROVED_APPLICANT: "대관 — 자체 알림톡 틀(RENTAL_APPLICANT_TEMPLATES)",
  RENTAL_CONFIRMED_APPLICANT: "대관 — 자체 알림톡 틀",
  RENTAL_REJECTED_APPLICANT: "대관 — 자체 알림톡 틀",
};

export function isParentAlimtalkTrigger(trigger: string | null | undefined): trigger is ParentAlimtalkTrigger {
  return typeof trigger === "string" && Object.prototype.hasOwnProperty.call(PARENT_ALIMTALK_TEMPLATES, trigger);
}

/** 틀의 #{변수} 를 값으로 바꾼다. 값이 없는 변수가 남으면 오류(빈칸 문자 방지) */
export function fillAlimtalkTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/#\{([^}]+)\}/g, (_, key: string) => {
    const value = variables[`#{${key}}`];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new Error(`알림톡 변수 ${key} 값이 없습니다.`);
    }
    return String(value);
  });
}

/** 틀에 실제로 쓰인 #{변수} 목록(등록 템플릿과 변수 목록이 같아야 발송된다) */
export function templateVariableKeys(template: string): string[] {
  return [...new Set(template.match(/#\{[^}]+\}/g) ?? [])];
}

export type ParentAlimtalkMessage = {
  trigger: ParentAlimtalkTrigger;
  envKey: string;
  /** 문자·알림톡 공통 본문 */
  body: string;
  /** 알림톡 variables(#{한글} → 값) */
  variables: Record<string, string>;
};

/**
 * 호출부 값(childName 등)으로 알림톡 변수 맵과 본문을 **같은 맵에서** 만든다.
 * 빈 값은 defaults 로 채우고, 그래도 비면 오류를 던진다(발송부가 문자 대체로 처리).
 */
export function buildParentAlimtalkMessage(
  trigger: ParentAlimtalkTrigger,
  callerVariables: Record<string, string | null | undefined>,
): ParentAlimtalkMessage {
  const spec: ParentAlimtalkSpec = PARENT_ALIMTALK_TEMPLATES[trigger];
  // 특정 값이 비면 «그 줄 없는 판» 틀로 바꾼다(예: 대기순번 없는 대기 안내)
  const alt = spec.whenEmpty && !String(callerVariables[spec.whenEmpty.callerKey] ?? "").trim() ? spec.whenEmpty : null;
  const body = alt ? alt.body : spec.body;
  const variables: Record<string, string> = {};
  for (const key of templateVariableKeys(body)) {
    const callerKey = spec.vars[key];
    if (!callerKey) throw new Error(`알림톡 변수 ${key} 의 연결이 없습니다.`);
    const raw = String(callerVariables[callerKey] ?? "").trim();
    variables[key] = raw || spec.defaults?.[callerKey] || "";
  }
  return { trigger, envKey: alt ? alt.envKey : spec.envKey, body: fillAlimtalkTemplate(body, variables), variables };
}

/**
 * 같은 틀을 DB 문자 틀 표기({{childName}})로 바꾼다 — 관리자 화면 표시·«기본값 복원»·운영 DB 동기화용.
 * 이 표기는 금고 틀이 실패했을 때만 쓰는 대체 문구다.
 */
export function parentAlimtalkSmsTemplateBody(trigger: ParentAlimtalkTrigger): string {
  const spec: ParentAlimtalkSpec = PARENT_ALIMTALK_TEMPLATES[trigger];
  return spec.body.replace(/#\{[^}]+\}/g, (key) => `{{${spec.vars[key]}}}`);
}
