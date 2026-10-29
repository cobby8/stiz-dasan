import PublicSiteTheme from "@/components/PublicSiteTheme";

// 로그인·가입·연결 같은 입구 화면도 공개 홈페이지와 같은 스포츠 색을 쓴다.
export default function EntryThemeLayout({ children }: { children: React.ReactNode }) {
  return <PublicSiteTheme publicScope className="min-h-screen">{children}</PublicSiteTheme>;
}
