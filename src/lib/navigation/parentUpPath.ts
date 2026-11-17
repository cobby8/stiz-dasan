/**
 * 학부모 화면의 «한 단계 위» 주소(2026-11-17 원장 지시 — 뒤로 가기 전수 조치).
 *
 * 원칙: «←» = 방금 있던 화면. 방금 있던 화면이 없을 때(알림·문자로 바로 들어옴)만 이 표의 한 단계 위로 간다.
 * 예전엔 머리줄 «←» 가 어느 화면이든 학부모 홈(/mypage)으로 가서, 화면 안 «←»(목록)와 서로 다른 곳으로 갔다.
 * 공개 화면은 publicParentPath(publicHistory.ts)가 같은 일을 한다.
 *
 * 수업 탭 소속 화면(보강·결석·수강 변경·셔틀·방학특강)은 들어오는 길이 대부분 홈 카드라 학부모 홈 그대로 둔다.
 */
export function parentUpPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  // 설정 아래 화면
  if (p === "/mypage/login-methods" || p === "/mypage/withdraw" || p === "/mypage/consult" || p === "/mypage/children") return "/mypage/settings";
  // 셔틀 «계속 바꾸기» → 셔틀 변경
  if (p.startsWith("/mypage/shuttle/")) return "/mypage/shuttle";
  // 결제(묶음 결제·완료) → 청구 목록
  if (p.startsWith("/mypage/payments/")) return "/mypage/payments";
  // 소식: 글 → 지난 공지 목록 → 소식 탭
  if (p.startsWith("/mypage/news/")) return "/mypage/news";
  if (p === "/mypage/news") return "/mypage/reports";
  if (p.startsWith("/mypage/reports/")) return "/mypage/reports";
  // 문의 글 → 문의 목록
  if (p.startsWith("/mypage/requests/")) return "/mypage/requests";
  // 연간 일정 → 일정 탭
  if (p === "/mypage/annual") return "/mypage/history";
  // 신청 메뉴 아래(대관·방학특강 신청)
  const seasonalApply = p.match(/^\/mypage\/seasonal\/apply\/([^/]+)\/apply$/);
  if (seasonalApply) return `/mypage/seasonal/apply/${seasonalApply[1]}`;
  if (p.startsWith("/mypage/seasonal/apply/")) return "/mypage/seasonal/apply";
  if (p === "/mypage/seasonal/apply" || p === "/mypage/rental") return "/mypage/apply";
  return "/mypage";
}
