export const PUBLIC_DESIGNS = ["lavender", "official", "sport"] as const;
export type PublicDesign = typeof PUBLIC_DESIGNS[number];

/** 비교 주소는 표현만 선택합니다. 업무 화면이나 저장 자료에는 사용하지 않습니다. */
export function readPublicDesign(search: string): PublicDesign | null {
  const value = new URLSearchParams(search).get("previewTheme");
  return PUBLIC_DESIGNS.find(theme => theme === value) ?? null;
}

/** 기존 소개 자료는 보존하고, 근거가 확인되지 않은 기존 홍보 수치만 공개 표현에서 덜어냅니다. */
export function publicIntroduction(value: string): string {
  return value
    .replace(/\bNo\.?\s*1\b/gi, "")
    .replace(/체험\s*수업\s*등록률\s*90%\s*가\s*보여주는\s*압도적인\s*신뢰도[!！]?/g, "")
    .replace(/[ \t]{2,}/g, " ").trim();
}
