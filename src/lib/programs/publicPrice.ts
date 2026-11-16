/**
 * 공개 화면(프로그램 소개·상담 챗봇)에서 수강료를 숨길 프로그램 — 2026-11-16 원장 지시 «수강료 숨기기».
 * 대회준비반은 반 수·묶음에 따라 금액이 달라 상담 뒤 안내한다. 청구 준비·관리자 화면은 그대로 금액을 쓴다.
 */
export const PUBLIC_PRICE_HIDDEN_PROGRAMS = ["대회준비반"] as const;

export const PUBLIC_PRICE_HIDDEN_TEXT = "수강료는 상담 후 안내해 드려요";

export function isPublicPriceHidden(programName: string | null | undefined): boolean {
  return (PUBLIC_PRICE_HIDDEN_PROGRAMS as readonly string[]).includes((programName ?? "").trim());
}
