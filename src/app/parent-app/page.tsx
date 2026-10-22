import type { Metadata } from "next";
import ParentAppInstallClient from "./ParentAppInstallClient";
import PublicSiteTheme from "@/components/PublicSiteTheme";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const metadata: Metadata = {
  ...buildPublicMetadata({
    title: "스티즈 학부모 앱 설치",
    description: "출결과 셔틀 시각, 결석 신고와 청구를 확인하는 스티즈 학부모 앱을 홈 화면에 설치하세요.",
    path: "/parent-app",
  }),
  // 학부모용은 시작 주소가 /mypage인 별도 manifest를 쓴다(교사용 manifest와 분리).
  manifest: "/manifest-parent.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "스티즈 학부모",
  },
  icons: {
    apple: [{ url: "/icon-v2-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export default function ParentAppInstallPage() {
  return <PublicSiteTheme><ParentAppInstallClient /></PublicSiteTheme>;
}
