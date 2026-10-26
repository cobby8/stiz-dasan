import type { Metadata } from "next";
import type { ReactNode } from "react";
import AcademyTheme from "@/components/academy/AcademyTheme";
import { ACADEMY_THEME_COLOR } from "@/lib/academyTheme";

// 기사님 전용 레이아웃 — 공용 manifest 대신 기사님 앱 manifest를 주입한다.
export const metadata: Metadata = {
  manifest: "/driver-manifest.json",
  title: "스티즈 기사님",
  description: "스티즈농구교실 셔틀 기사님 전용 운행 앱",
  themeColor: ACADEMY_THEME_COLOR,
};

export default function DriverLayout({ children }: { children: ReactNode }) {
  // 기사님 링크도 다른 역할과 같은 라이트 화면 기준을 사용합니다.
  return <AcademyTheme role="driver" className="min-h-screen">{children}</AcademyTheme>;
}
