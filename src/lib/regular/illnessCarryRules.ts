// 질병·부상 결석 «이월 검토» 규칙 — 순수 모듈(DB·React 없음. node 테스트가 바로 실행한다).
//
// 원장 결정표(2026-11-14) a1~a8:
//   · 사유 «질병·부상»이면 보강권을 바로 주지 않고 «이월 검토 중»으로 둔다.
//   · 증빙 사진은 1~3장, 알릴 때 또는 «결석일(더 늦게 알렸으면 알린 날)부터 7일» 안에 추가.
//   · 원장이 [이월 승인] → 다음 달 수강료에서 1회분 차감 / [보강권으로] 또는 7일 안에 사진 없음 → 보강권 1장.
//   · 사진은 처리 끝나고 90일 뒤 자동 삭제.
//
// 날짜는 전부 «YYYY-MM-DD»(KST 달력 날짜) 글자로 받는다 — 달력 계산은 공용 모듈(kst.ts)에서만 한다.
import { addDaysKst, isKstYmd } from "@/lib/datetime/kst";

/** 이월 검토 대상이 되는 사유 값(학부모 신고·출석부 표시·청구 작업대가 같은 값을 쓴다) */
export const ILLNESS_REASON = "ILLNESS_INJURY";

/** 검토 상태 — DB CHECK 제약(RegularAbsenceCarryReview_status_check)과 같은 집합(테스트가 비교) */
export const ILLNESS_REVIEW_STATUSES = ["PENDING", "APPROVED", "MAKEUP", "CLOSED"] as const;
export type IllnessReviewStatus = (typeof ILLNESS_REVIEW_STATUSES)[number];

/** 어디서 생긴 검토인가 — DB CHECK 제약과 같은 집합 */
export const ILLNESS_REVIEW_SOURCES = ["PARENT", "KAKAO", "STAFF"] as const;
export type IllnessReviewSource = (typeof ILLNESS_REVIEW_SOURCES)[number];

/** 사진을 올릴 수 있는 기간(기준일 포함하지 않고 +7일째 되는 날 자정까지). 기준일 = evidenceBaseYmd */
export const EVIDENCE_WINDOW_DAYS = 7;
/** 결석 1건에 살아 있는 사진 최대 장수 */
export const EVIDENCE_MAX_PHOTOS = 3;
/** 처리(승인·전환·닫힘)가 끝난 뒤 사진을 지우기까지 */
export const EVIDENCE_RETENTION_DAYS = 90;
/** 사유 글 최대 길이 — DB CHECK(RegularAbsenceCarryReview_reasonText_check)와 같은 값 */
export const REASON_TEXT_MAX = 100;

/** 학부모 화면 상태 한 단어 */
export const ILLNESS_REVIEW_LABEL: Record<IllnessReviewStatus, string> = {
  PENDING: "이월 검토 중",
  APPROVED: "이월 승인",
  MAKEUP: "보강권으로 전환",
  CLOSED: "닫힘",
};

export function illnessReviewLabel(status: string | null | undefined): string | null {
  return status && status in ILLNESS_REVIEW_LABEL ? ILLNESS_REVIEW_LABEL[status as IllnessReviewStatus] : null;
}

/** 사유 글 다듬기 — 앞뒤 공백 제거, 줄바꿈은 한 칸으로. 비면 null */
export function normalizeReasonText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/** 사유 글이 저장할 수 있는 길이인가(비어 있으면 false) */
export function isValidReasonText(value: unknown): boolean {
  const text = normalizeReasonText(value);
  return Boolean(text) && text!.length <= REASON_TEXT_MAX;
}

/**
 * «7일»을 세기 시작하는 날 = 알린 날과 결석일 중 «더 늦은 날».
 * 왜: 몇 주 뒤 결석(수술 예정 등)을 미리 알리면, 알린 날만 기준으로는 결석일이 오기도 전에 기한이 끝나
 *     진단서를 받을 수 없는 시점에 보강권으로 바뀐다. 올리기 가능 판정·자동 전환·화면 기한 안내가 모두 이 함수를 쓴다.
 * 결석일을 모르면(값 없음·형식 오류) 알린 날 그대로.
 */
export function evidenceBaseYmd(requestedYmd: string, absenceYmd?: string | null): string {
  return absenceYmd && isKstYmd(absenceYmd) && absenceYmd > requestedYmd ? absenceYmd : requestedYmd;
}

/** 사진을 올릴 수 있는 마지막 날(KST). 기준일이 11/14 면 11/21 */
export function evidenceDeadlineYmd(requestedYmd: string, absenceYmd?: string | null): string {
  return addDaysKst(evidenceBaseYmd(requestedYmd, absenceYmd), EVIDENCE_WINDOW_DAYS);
}

/** 사진 기간이 끝났나 — 마지막 날 «다음 날»부터 true(마지막 날 밤 11:59 까지는 올릴 수 있다) */
export function isEvidenceWindowOver(requestedYmd: string, todayYmd: string, absenceYmd?: string | null): boolean {
  if (!isKstYmd(requestedYmd) || !isKstYmd(todayYmd)) return false; // 날짜를 모르면 닫지 않는다(전환은 되돌리기 어렵다)
  return todayYmd > evidenceDeadlineYmd(requestedYmd, absenceYmd);
}

/** 학부모가 지금 사진을 추가·삭제할 수 있나 — 검토 중이고 기간 안일 때만 */
export function canEditEvidence(input: { status: string | null | undefined; requestedYmd: string; absenceYmd?: string | null; todayYmd: string }): boolean {
  if (input.status !== "PENDING") return false;
  if (!isKstYmd(input.requestedYmd) || !isKstYmd(input.todayYmd)) return false;
  return !isEvidenceWindowOver(input.requestedYmd, input.todayYmd, input.absenceYmd);
}

/** 한 장 더 올릴 수 있나(기간 + 장수) */
export function canAddEvidence(input: { status: string | null | undefined; requestedYmd: string; absenceYmd?: string | null; todayYmd: string; photoCount: number }): boolean {
  return canEditEvidence(input) && input.photoCount < EVIDENCE_MAX_PHOTOS;
}

/**
 * 7일 지나 보강권으로 자동 전환할 검토인가.
 * 학부모(앱·카카오)가 알린 «검토 중»이고, 살아 있는 사진이 한 장도 없고, 사진 기간이 끝났을 때만.
 * 학원이 등록한 결석(STAFF)은 원장이 직접 고르므로 자동 전환하지 않는다.
 */
export function shouldAutoConvertToMakeup(input: {
  status: string; source: string; photoCount: number; requestedYmd: string; absenceYmd?: string | null; todayYmd: string;
}): boolean {
  if (input.status !== "PENDING") return false;
  if (input.source !== "PARENT" && input.source !== "KAKAO") return false;
  if (input.photoCount > 0) return false;
  return isEvidenceWindowOver(input.requestedYmd, input.todayYmd, input.absenceYmd);
}

/** 처리 끝난 날로부터 90일이 지나 사진을 지울 때인가(90일째 되는 날부터 true) */
export function isEvidencePurgeDue(decidedYmd: string | null | undefined, todayYmd: string): boolean {
  if (!decidedYmd || !isKstYmd(decidedYmd) || !isKstYmd(todayYmd)) return false;
  return todayYmd >= addDaysKst(decidedYmd, EVIDENCE_RETENTION_DAYS);
}

/**
 * 원장이 [이월 승인]을 누르기 전에 화면이 먼저 알려 주는 «아직 안 되는 이유» 한 줄. 없으면 null.
 * (최종 판정은 서버의 기존 이월 규칙 resolveWorkbenchAbsence 가 한다 — 여기는 버튼을 켤지 정하는 미리보기)
 */
export function carryApprovalBlocker(input: {
  absenceYmd: string; todayYmd: string; creditStatus: string | null; billReady: boolean | null; writesEnabled: boolean;
}): string | null {
  if (!input.writesEnabled) return "청구 준비 저장이 꺼져 있어 이월을 적립할 수 없어요.";
  if (input.absenceYmd > input.todayYmd) return "결석일이 지난 뒤에 승인할 수 있어요.";
  if (input.creditStatus === "USED" || input.creditStatus === "NO_SHOW") return "이미 보강을 들은 결석이라 이월할 수 없어요.";
  if (input.billReady === false) return "그 달 수강료 청구를 발행한 뒤에 승인할 수 있어요.";
  return null;
}

/** 증빙 사진으로 받는 «실제» 파일 형식(파일 머리를 읽어 확인한 값 — 브라우저가 보낸 형식 이름은 믿지 않는다) */
export const EVIDENCE_IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;
export function isAllowedEvidenceFormat(format: unknown): boolean {
  return typeof format === "string" && (EVIDENCE_IMAGE_FORMATS as readonly string[]).includes(format);
}

/** 증빙 사진 저장 경로 — 결석 id 아래 사진 id. 다른 모양의 경로는 읽지도 지우지도 않는다 */
export const EVIDENCE_BUCKET = "absence-evidence";
export function evidenceStoragePath(absenceId: string, photoId: string): string {
  return `regular-absence/${absenceId}/${photoId}.jpg`;
}
export function isValidEvidencePath(path: unknown): boolean {
  return typeof path === "string" && /^regular-absence\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9-]{1,64}\.jpg$/.test(path);
}
