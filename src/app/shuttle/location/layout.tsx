import AcademyTheme from "@/components/academy/AcademyTheme";

// 학부모 셔틀 위치 보기도 마이페이지와 같은 공통 스포츠 색(학원 앱 토큰)을 쓴다. academyTheme.ts 경로 목록과 짝이다.
export default function ShuttleLocationThemeLayout({ children }: { children: React.ReactNode }) {
  return <AcademyTheme role="parent" className="min-h-screen">{children}</AcademyTheme>;
}
