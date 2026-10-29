// 공개 안내와 신청 경로만 포함한다. 역할별 업무 화면에는 적용하지 않는다.
const PUBLIC_SECTIONS = [
  "/about", "/programs", "/schedule", "/annual", "/gallery", "/notices",
  "/faq", "/terms", "/privacy", "/apply", "/seasonal", "/shop", "/simulator",
];
const PUBLIC_ENTRIES = [
  "/", "/login", "/signup", "/signup/parent", "/parent", "/parent-app", "/teacher-app",
  // 로그인 직후·계정 연결 입구도 로그인 화면과 같은 밝은 기본 테마로 연다.
  "/auth/continue", "/setup",
];

export function isPublicSitePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_ENTRIES.includes(pathname) || PUBLIC_SECTIONS.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}
