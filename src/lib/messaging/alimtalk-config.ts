/**
 * 학부모 알림톡 템플릿 id 읽기(서버 전용 값 — 환경변수).
 *
 * 카카오 심사가 끝나 템플릿 id(KA01TP…)를 받으면 Vercel 환경변수 ALIMTALK_TPL_<키> 에 넣는다.
 * 비어 있으면 그 안내는 지금처럼 문자(SMS/LMS)로만 나간다 — 순서와 상관없이 학부모가 못 받는 일은 없다.
 * (체육관 대관은 RENTAL_ALIMTALK_* 를 그대로 쓴다.)
 */
import { PARENT_ALIMTALK_TEMPLATES, type ParentAlimtalkTrigger } from "./parent-alimtalk-templates";

export function parentAlimtalkTemplateId(trigger: ParentAlimtalkTrigger): string {
  const envKey = PARENT_ALIMTALK_TEMPLATES[trigger].envKey;
  return String(process.env[envKey] ?? "").trim();
}
