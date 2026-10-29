import AcademyTheme from "@/components/academy/AcademyTheme";

// 직원 초대 수락 화면은 업무 화면(선생님 앱)과 같은 공통 스포츠 색을 쓴다. academyTheme.ts 경로 목록과 짝이다.
export default function InviteThemeLayout({ children }: { children: React.ReactNode }) {
  return <AcademyTheme role="teacher" className="min-h-screen">{children}</AcademyTheme>;
}
