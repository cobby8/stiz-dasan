// 가져오기·특강 신청 등으로 학원이 만든 "빈 보호자 계정"(로그인 수단 없음)의 합성 이메일 규칙.
// 이 규칙은 이 파일 한 곳에만 둔다 — 활성화 링크 발급·회원가입 넘기기·특강 발송 판정이 모두 여기를 쓴다.
// (2026-10-08 운영 실측: 옛 규칙 `parent_<숫자>@` 은 `parent_<숫자>_<숫자>@` 163명을 놓쳤다)
//
// 맞는 형식
//   parent_<숫자>@stiz.local · parent_<숫자>_<숫자>@stiz.local · parent_<uuid>@stiz.local
//   rallyz-parent-<uuid>@stiz.local · <숫자>@import.local · <숫자-숫자-숫자>@import.local
// 일부러 뺀 형식
//   team_…@stiz.local — 팀 재연결용 계정이라 학부모 활성화 대상이 아니다
export const SYNTHETIC_PARENT_EMAIL =
  /^(?:parent_[0-9a-f_-]+@stiz\.local|rallyz-parent-[0-9a-f-]+@stiz\.local|[0-9-]+@import\.local)$/i;

/** 가져오기로 만들어진 빈 보호자 계정의 합성 이메일인지 */
export function isSyntheticParentEmail(email: string | null | undefined): boolean {
  return SYNTHETIC_PARENT_EMAIL.test((email || "").trim());
}
