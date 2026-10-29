import AcademyTheme from "@/components/academy/AcademyTheme";

// 카카오 요청 링크(수강 변경 요청·재확인)는 학부모 화면이라 마이페이지와 같은 공통 스포츠 색을 쓴다. academyTheme.ts 경로 목록과 짝이다.
export default function ParentRequestThemeLayout({ children }: { children: React.ReactNode }) {
  return <AcademyTheme role="parent" className="min-h-screen">{children}</AcademyTheme>;
}
