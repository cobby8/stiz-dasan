/**
 * 수강 신청서 «셔틀 이용 → 아이 휴대폰 번호 필수» (2026-11-18 원장 메모) — 순수 함수. 화면(EnrollApplicationForm)과
 * 서버(submitEnrollApplication)가 같은 판정을 쓴다(화면 검사를 건너뛴 요청도 막히게). 실행 테스트: tests/anonymous-identity.test.mjs
 *
 * 신청서의 «학생 전화번호» 칸은 이미 모든 신청에 필수다. 셔틀을 타면 기사님이 아이에게 연락할 수 있어야 하므로
 * 그 칸이 «휴대폰 번호 모양»(010 등)이어야 한다 — 비었거나 집 전화·잘린 번호면 막는다.
 * (보호자 번호와 같은 번호를 막지는 않는다 — 휴대폰이 없는 아이가 있어 원장 결정이 필요하다)
 */

export const SHUTTLE_CHILD_PHONE_MESSAGE = "셔틀을 이용하면 아이 휴대폰 번호가 꼭 필요해요(기사님 연락용). 1단계 «학생 전화번호»에 휴대폰 번호를 정확히 적어 주세요.";

/** 셔틀을 타는데 아이 휴대폰 번호가 휴대폰 모양이 아니면 안내 문구, 괜찮으면 null */
export function shuttleChildPhoneError(shuttleNeeded: boolean | null | undefined, childPhone: string | null | undefined): string | null {
  if (!shuttleNeeded) return null;
  const digits = String(childPhone ?? "").replace(/\D/g, "");
  return /^01[016789]\d{7,8}$/.test(digits) ? null : SHUTTLE_CHILD_PHONE_MESSAGE;
}
