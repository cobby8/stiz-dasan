import type { Metadata } from "next";
import StaffAppInstallClient from "./StaffAppInstallClient";
import PublicSiteTheme from "@/components/PublicSiteTheme";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const metadata: Metadata = {
  ...buildPublicMetadata({
    title: "스티즈 선생님 앱 설치",
    description: "수업과 학생 관리를 위한 스티즈 선생님 앱을 홈 화면에 설치하세요.",
    path: "/teacher-app",
  }),
  manifest: "/manifest-staff.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "스티즈 선생님",
  },
  icons: {
    apple: [{ url: "/icon-v2-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export default function TeacherAppInstallPage() {
  return <PublicSiteTheme><StaffAppInstallClient /></PublicSiteTheme>;
}
