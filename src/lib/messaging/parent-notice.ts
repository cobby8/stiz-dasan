/**
 * 학부모 공지(/admin/sms «학부모 공지 보내기») 순수 규칙 — 서버 동작과 테스트가 같은 함수를 쓴다.
 *
 * 공지는 두 갈래다(원장 결정 2026-11-09).
 *  ① «카톡 틀»(휴무·행사·월 안내) = 카카오 알림톡. 변수 칸만 입력하고 학생명·학원전화는 자동.
 *     템플릿 id(env ALIMTALK_TPL_NOTICE_*)가 없거나 알림톡이 거절되면 같은 본문을 문자로 보낸다.
 *  ② «자유 공지» = 카카오 브랜드 메시지(BMS 자유형·텍스트형). 카카오가 «광고성» 메시지로 분류하므로
 *     앞에 (광고)·끝에 수신거부 안내를 넣고, 밤(20:50~08:00)에는 보내지 않는다.
 *     문자로 자동 대체하지 않는다(광고 문자 금지 — 검수 (나)안). 못 받은 학부모는 원장이 골라 «광고 표시 없는
 *     정보성 문자»로 다시 보낸다. 스위치(env)가 꺼져 있으면 지금처럼 문자.
 *
 * import 는 순수 모듈만(테스트가 그대로 실행한다).
 */
import { kstAt, kstHm, todayKst } from "@/lib/datetime/kst";
import {
  DEFAULT_ACADEMY_PHONE,
  NOTICE_ALIMTALK_TEMPLATES,
  NOTICE_BUTTON_NAME,
  PARENT_MESSAGE_PREFIX,
  buildNoticeAlimtalkMessage,
  type NoticeAlimtalkKind,
} from "./parent-alimtalk-templates";

/** 화면에서 고르는 공지 종류 — «카톡 틀» 3종 + 자유 공지 */
export type ParentNoticeKind = NoticeAlimtalkKind | "FREE";

/** 화면 입력 칸 정의(틀 변수 하나 = 칸 하나). 학생명·학원전화·공지경로는 칸이 없다(자동) */
export type NoticeField = {
  key: string;
  label: string;
  placeholder: string;
  /** true 면 비워도 된다 — 비면 금고의 기본 문장이 들어간다 */
  optional?: boolean;
  /** 여러 줄 허용(내용·안내 사항만) */
  multiline?: boolean;
  maxLength: number;
};

export const NOTICE_FIELDS: Record<NoticeAlimtalkKind, NoticeField[]> = {
  NOTICE_CLOSURE: [
    { key: "closurePeriod", label: "휴무 기간", placeholder: "예) 11월 17일(월)~11월 18일(화)", maxLength: 60 },
    { key: "reason", label: "사유", placeholder: "예) 체육관 바닥 공사", maxLength: 60 },
    { key: "makeupNotice", label: "보강 안내(선택)", placeholder: "비우면 «보강: 없음»", optional: true, maxLength: 100 },
  ],
  NOTICE_EVENT: [
    { key: "eventName", label: "행사명", placeholder: "예) 겨울 농구 축제", maxLength: 40 },
    { key: "eventDate", label: "일시", placeholder: "예) 12월 20일(토) 14:00~16:00", maxLength: 60 },
    { key: "eventPlace", label: "장소", placeholder: "예) 다산 본관 체육관", maxLength: 60 },
    { key: "eventDetail", label: "내용", placeholder: "예) 학년별 미니 게임, 기념품 증정", multiline: true, maxLength: 300 },
    { key: "applyNotice", label: "신청 안내(선택)", placeholder: "비우면 «별도 신청은 필요 없습니다.»", optional: true, maxLength: 100 },
  ],
  NOTICE_MONTHLY: [
    { key: "month", label: "월(숫자)", placeholder: "예) 12", maxLength: 2 },
    { key: "closedDays", label: "휴무일", placeholder: "예) 12월 25일(목) 성탄절 / 없으면 «없음»", maxLength: 100 },
    { key: "tuitionNotice", label: "수강료 안내", placeholder: "예) 12월 1일부터 홈페이지에서 결제", maxLength: 100 },
    { key: "notes", label: "안내 사항", placeholder: "예) 겨울특강 신청은 12월 5일까지", multiline: true, maxLength: 300 },
  ],
};

export const NOTICE_KIND_LABEL: Record<ParentNoticeKind, string> = {
  NOTICE_CLOSURE: NOTICE_ALIMTALK_TEMPLATES.NOTICE_CLOSURE.name,
  NOTICE_EVENT: NOTICE_ALIMTALK_TEMPLATES.NOTICE_EVENT.name,
  NOTICE_MONTHLY: NOTICE_ALIMTALK_TEMPLATES.NOTICE_MONTHLY.name,
  FREE: "자유 공지",
};

export function isParentNoticeKind(kind: unknown): kind is ParentNoticeKind {
  return kind === "FREE" || (typeof kind === "string" && Object.prototype.hasOwnProperty.call(NOTICE_FIELDS, kind));
}

/**
 * 입력값 정리·검사. 문제가 있으면 사람이 읽을 문장을 던진다.
 *  - 한 줄 칸은 줄바꿈을 공백으로 바꾼다(카톡 틀의 줄 구성이 흐트러지지 않게)
 *  - 월은 1~12 숫자만
 */
export function normalizeNoticeFields(kind: NoticeAlimtalkKind, input: Record<string, unknown> | null | undefined) {
  const values: Record<string, string> = {};
  for (const field of NOTICE_FIELDS[kind]) {
    const raw = typeof input?.[field.key] === "string" ? String(input[field.key]) : "";
    const value = (field.multiline ? raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") : raw.replace(/\s*[\r\n]+\s*/g, " ")).trim();
    if (!value && !field.optional) throw new Error(`«${field.label}» 칸을 채워 주세요.`);
    if ([...value].length > field.maxLength) throw new Error(`«${field.label}» 은 ${field.maxLength}자 이내로 써 주세요.`);
    if (/#\{/.test(value)) throw new Error(`«${field.label}» 에 #{ 기호는 쓸 수 없어요.`);
    values[field.key] = value;
  }
  if (kind === "NOTICE_MONTHLY") {
    const month = Number(values.month);
    if (!/^\d{1,2}$/.test(values.month) || month < 1 || month > 12) throw new Error("«월» 은 1~12 숫자로 써 주세요.");
    values.month = String(month);
  }
  return values;
}

/** DB 에서 읽은 «재원생 1명 – 대표 학부모» 한 줄 */
export type NoticeCandidate = { studentName: string; phone: string | null };

export type NoticeRecipient = { phone: string; studentNames: string[] };

function normalizeMobile(value: string | null | undefined) {
  const digits = (value ?? "").replace(/[^0-9]/g, "");
  return /^01\d{8,9}$/.test(digits) ? digits : null;
}

/**
 * 받는 사람 고르기: 휴대폰 번호만, 같은 번호는 1통(형제 이름은 «·»로 모은다), 번호 오름차순 고정
 * (미리보기와 보내기 직전 재계산이 같은 순서·같은 결과를 내게).
 */
export function selectNoticeRecipients(candidates: NoticeCandidate[]) {
  const byPhone = new Map<string, NoticeRecipient>();
  let invalidPhoneCount = 0;
  for (const row of candidates) {
    const phone = normalizeMobile(row.phone);
    const name = String(row.studentName ?? "").trim();
    if (!phone) { invalidPhoneCount += 1; continue; }
    const found = byPhone.get(phone);
    if (found) {
      if (name && !found.studentNames.includes(name)) found.studentNames.push(name);
    } else {
      byPhone.set(phone, { phone, studentNames: name ? [name] : [] });
    }
  }
  // 학생 이름이 하나도 없는 번호는 «안녕하세요,  학부모님» 이 되므로 빼고, 화면에 «이름 없는 N명 제외»로 보인다
  const noNameCount = [...byPhone.values()].filter((item) => item.studentNames.length === 0).length;
  const recipients = [...byPhone.values()]
    .filter((item) => item.studentNames.length > 0)
    .map((item) => ({ ...item, studentNames: [...item.studentNames].sort((a, b) => a.localeCompare(b, "ko")) }))
    .sort((a, b) => (a.phone < b.phone ? -1 : a.phone > b.phone ? 1 : 0));
  return { recipients, invalidPhoneCount, noNameCount };
}

/**
 * 30분 중복 접수 차단·묶음 지문용 «공지 내용 지문 원문» — 종류 + 입력값 + 버튼 경로.
 * 받는 사람(학생명) 이 바뀌어도 같은 공지면 같은 값이 나오게, 키 순서를 고정해 만든다.
 */
export function noticeContentKey(kind: ParentNoticeKind, values: Record<string, string>, noticePath: string | null): string {
  const sorted = Object.keys(values).sort().map((key) => [key, values[key]]);
  return JSON.stringify({ kind, values: sorted, noticePath: kind === "FREE" ? null : noticePath });
}

/** 알림톡 한 통(받는 사람 1명분) — 문자로 대신 보낼 때 쓸 본문(버튼 링크를 본문 끝에 붙임)도 같이 */
export type NoticeAlimtalkItem = {
  phone: string;
  /** 알림톡 본문(등록 문구에 값을 넣은 것) */
  body: string;
  /** 알림톡 id 가 없거나 거절돼 문자로 보낼 때의 본문 — 버튼이 없으니 링크를 본문에 붙인다 */
  smsBody: string;
  variables: Record<string, string>;
  button: { buttonName: string; buttonType: "WL"; linkMo: string; linkPc: string };
  envKey: string;
};

export function buildNoticeAlimtalkItems(
  kind: NoticeAlimtalkKind,
  fields: Record<string, string>,
  recipients: NoticeRecipient[],
  options: { academyPhone?: string | null; noticePath?: string | null },
): NoticeAlimtalkItem[] {
  const academyPhone = String(options.academyPhone ?? "").trim() || DEFAULT_ACADEMY_PHONE;
  return recipients.map((recipient) => {
    const message = buildNoticeAlimtalkMessage(
      kind,
      { ...fields, studentName: recipient.studentNames.join("·"), academyPhone },
      options.noticePath,
    );
    return {
      phone: recipient.phone,
      body: message.body,
      smsBody: `${message.body}\n${NOTICE_BUTTON_NAME}: ${message.button.linkMo}`,
      variables: message.variables,
      button: message.button,
      envKey: message.envKey,
    };
  });
}

// ───────────────────────── 자유 공지 = 브랜드 메시지(BMS 자유형) ─────────────────────────

/** 광고 표시 — 본문 맨 앞. 솔라피 문서: «BMS 자유형 대체 발송 시 (광고) 문구가 필수 포함됩니다» */
export const BMS_AD_MARK = "(광고)";
/** 수신거부 안내 — 채널 친구 대상 메시지라 채널 차단이 수신거부 방법이다. 문자 대체 시에도 같은 글자가 간다 */
export const BMS_OPT_OUT_LINE = "수신거부: 카카오톡 채널 ‘스티즈농구교실’ 차단";
/** 솔라피 BMS 텍스트형 본문 한도: 1,300자·줄바꿈 99개 */
export const BMS_TEXT_MAX_CHARS = 1300;
export const BMS_TEXT_MAX_LINE_BREAKS = 99;

/** 자유 공지 본문(브랜드 메시지·문자 대체 공통): «(광고) [스티즈농구교실] …» + 수신거부 안내 */
export function buildFreeNoticeBrandText(message: string): string {
  const text = `${BMS_AD_MARK} ${PARENT_MESSAGE_PREFIX} ${String(message ?? "").trim()}\n\n${BMS_OPT_OUT_LINE}`;
  if ([...text].length > BMS_TEXT_MAX_CHARS) throw new Error(`브랜드 메시지는 ${BMS_TEXT_MAX_CHARS}자 이내로 써 주세요.`);
  if ((text.match(/\n/g) ?? []).length > BMS_TEXT_MAX_LINE_BREAKS) throw new Error(`줄바꿈은 ${BMS_TEXT_MAX_LINE_BREAKS}번까지만 쓸 수 있어요.`);
  return text;
}

/** 자유 공지를 문자로 보낼 때(브랜드 메시지 꺼짐) — 지금 수동 발송과 같은 «[스티즈농구교실] 본문» */
export function buildFreeNoticeSmsText(message: string): string {
  return `${PARENT_MESSAGE_PREFIX} ${String(message ?? "").trim()}`;
}

/**
 * 광고성 메시지 발송 가능 시간(KST 08:00 ≤ 시각 < 20:50). 솔라피 가이드 «광고성 메시지 발송 제한 시간: 20:50 ~ 익일 08:00».
 * 접수 뒤 매분 크론이 실제로 보내므로 마감 직전 접수는 marginMinutes 만큼 일찍 막는다.
 */
export const BMS_SEND_START_HM = "08:00";
export const BMS_SEND_END_HM = "20:50";

export function brandMessageWindow(nowMs: number = Date.now(), marginMinutes = 0) {
  const today = todayKst(nowMs);
  const startMs = kstAt(today, BMS_SEND_START_HM);
  const endMs = kstAt(today, BMS_SEND_END_HM);
  const open = nowMs >= startMs && nowMs < endMs - marginMinutes * 60_000;
  return { open, nowHm: kstHm(nowMs), startMs, endMs };
}

/**
 * 브랜드 메시지를 못 받은 건의 장부 사유 앞머리(2026-11-09 검수 (나)안).
 * 브랜드 메시지는 광고성이라 «수신 동의 없는 광고 문자»가 나가지 않게 문자 대체를 끄고 보낸다(disableSms:true).
 * 대신 못 받은 학부모 수를 세어 원장이 «광고 표시 없는 정보성 문자»로 다시 보낼지 고른다.
 */
export const BMS_NOT_DELIVERED_PREFIX = "BMS_NOT_DELIVERED:";

/** 접수 여유 — 크론(매분)·묶음 처리 시간을 생각해 마감 10분 전부터 새 접수를 막는다 */
export const BMS_QUEUE_MARGIN_MINUTES = 10;
