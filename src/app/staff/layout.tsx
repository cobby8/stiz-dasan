import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireStaff } from "@/lib/auth-guard";
import StaffBottomNav from "./StaffBottomNav";
import StaffProfileMenu from "./StaffProfileMenu";
import StaffHomeLink from "./StaffHomeLink";
import AppBackButton from "@/components/AppBackButton";
import AcademyTheme from "@/components/academy/AcademyTheme";

export const metadata: Metadata = {
  title: "스티즈 선생님",
  description: "수업, 출결, 학생 연락과 청구를 관리하는 스티즈 선생님 앱",
  manifest: "/manifest-staff.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    // 아이폰 홈 화면에 찍히는 이름. manifest 와 어긋나면 기기마다 다른 이름이 뜬다.
    title: "스티즈 선생님",
  },
  icons: {
    apple: [{ url: "/icon-v2-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();

  return (
    // 역할별 데이터는 그대로 두고 공통 라이트 표면과 라벤더 강조색을 적용합니다.
    <AcademyTheme role={staff.appUserRole === "DRIVER" ? "driver" : "teacher"} className="min-h-screen pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      <header className="academy-staff-header sticky top-0 z-30 border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="mx-auto flex min-h-11 max-w-lg items-center justify-between gap-2">
          <div className="flex shrink-0 items-center gap-2">
            {/* 설치된 선생님 앱에서는 /staff 밖으로 나가지 않는다.
                (fallbackHref 가 현재 경로와 같을 때 홈페이지로 튀던 함정도 여기서 막힌다) */}
            <AppBackButton fallbackHref="/staff" scopeHref="/staff" />
            <StaffHomeLink isDriver={staff.appUserRole === "DRIVER"} />
          </div>
          <StaffProfileMenu staffName={staff.appUserName} staffRole={staff.appUserRole} />
        </div>
      </header>
      {children}
      <StaffBottomNav staffRole={staff.appUserRole} />
    </AcademyTheme>
  );
}
