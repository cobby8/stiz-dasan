/**
 * 학부모 알림톡 템플릿 id 읽기(서버 전용 값 — 환경변수).
 *
 * 카카오 심사가 끝나 템플릿 id(KA01TP…)를 받으면 Vercel 환경변수 ALIMTALK_TPL_<키> 에 넣는다.
 * 비어 있으면 그 안내는 지금처럼 문자(SMS/LMS)로만 나간다 — 순서와 상관없이 학부모가 못 받는 일은 없다.
 * (체육관 대관은 RENTAL_ALIMTALK_* 를 그대로 쓴다.)
 */
import { PARENT_ALIMTALK_TEMPLATES, type ParentAlimtalkTrigger } from "./parent-alimtalk-templates";

/** 환경변수 이름으로 id 를 읽는다 — buildParentAlimtalkMessage 가 고른 틀(기본/«순번 없는 판»)의 envKey 를 넘긴다 */
export function alimtalkTemplateIdForEnv(envKey: string): string {
  return String(process.env[envKey] ?? "").trim();
}

export function parentAlimtalkTemplateId(trigger: ParentAlimtalkTrigger): string {
  return alimtalkTemplateIdForEnv(PARENT_ALIMTALK_TEMPLATES[trigger].envKey);
}

/**
 * 자유 공지를 카카오 «브랜드 메시지»(BMS 자유형·텍스트형)로 보낼지 — 서버 전용 스위치.
 *
 * 솔라피 문서상 BMS 자유형은 «템플릿 등록 없이» 보내므로 템플릿 id 가 필요 없다(채널 친구 대상 targeting=I 는
 * 브랜드 등록도 불필요). 대신 카카오가 광고성 메시지로 분류해 (광고)·수신거부·야간 금지가 붙으므로,
 * 원장이 준비를 마치고 켜도록 스위치를 둔다: Vercel 환경변수 ALIMTALK_BMS_FREE_NOTICE=on.
 * 꺼져 있으면(기본) 자유 공지는 지금처럼 문자(SMS/LMS)로 나간다.
 */
export const BMS_FREE_NOTICE_ENV_KEY = "ALIMTALK_BMS_FREE_NOTICE";

export function isBrandFreeNoticeEnabled(): boolean {
  return /^(on|1|true|yes)$/i.test(String(process.env[BMS_FREE_NOTICE_ENV_KEY] ?? "").trim());
}
