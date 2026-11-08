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
  },
} satisfies Record<string, ParentAlimtalkSpec>;

export type ParentAlimtalkTrigger = keyof typeof PARENT_ALIMTALK_TEMPLATES;

/**
 * 금고 밖에서 학부모에게 «문자로만» 나가도 되는 트리거(가드 테스트가 이 목록과 금고만 허용한다).
 * 새 학부모 문자를 만들 때는 금고에 넣거나, 여기에 이유와 함께 적는다.
 */
export const SMS_ONLY_PARENT_TRIGGERS: Record<string, string> = {
  TRIAL_CONFIRM_PARENT: "공개 폼 접수 확인(꺼짐 유지 — 남의 번호 위험). 3차 후보",
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
  const variables: Record<string, string> = {};
  for (const key of templateVariableKeys(spec.body)) {
    const callerKey = spec.vars[key];
    if (!callerKey) throw new Error(`알림톡 변수 ${key} 의 연결이 없습니다.`);
    const raw = String(callerVariables[callerKey] ?? "").trim();
    variables[key] = raw || spec.defaults?.[callerKey] || "";
  }
  return { trigger, envKey: spec.envKey, body: fillAlimtalkTemplate(spec.body, variables), variables };
}

/**
 * 같은 틀을 DB 문자 틀 표기({{childName}})로 바꾼다 — 관리자 화면 표시·«기본값 복원»·운영 DB 동기화용.
 * 이 표기는 금고 틀이 실패했을 때만 쓰는 대체 문구다.
 */
export function parentAlimtalkSmsTemplateBody(trigger: ParentAlimtalkTrigger): string {
  const spec: ParentAlimtalkSpec = PARENT_ALIMTALK_TEMPLATES[trigger];
  return spec.body.replace(/#\{[^}]+\}/g, (key) => `{{${spec.vars[key]}}}`);
}
