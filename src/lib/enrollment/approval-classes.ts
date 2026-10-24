/** 승인 버튼뿐 아니라 서버에서도 반 없는 등록과 잘못된 ID를 차단한다. */
export function normalizeApprovalClassIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new Error("배정할 수업을 1개 이상 선택해 주세요.");
  }
  if (value.some((id) => typeof id !== "string" || !id.trim() || id.length > 100)) {
    throw new Error("배정할 수업 정보가 올바르지 않습니다. 다시 선택해 주세요.");
  }
  return [...new Set((value as string[]).map((id) => id.trim()))];
}
