import AcademyTheme from "@/components/academy/AcademyTheme";

// 비회원 결제 링크 화면도 학부모 납부 화면과 같은 학원 앱 색(토큰)을 쓴다. academyTheme.ts 경로 목록(/pay)과 짝이다.
export default function GuestPayThemeLayout({ children }: { children: React.ReactNode }) {
    return <AcademyTheme role="parent" className="min-h-screen">{children}</AcademyTheme>;
}
