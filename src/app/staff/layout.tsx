import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireStaff } from "@/lib/auth-guard";
import StaffBottomNav from "./StaffBottomNav";
import StaffProfileMenu from "./StaffProfileMenu";
import StaffHomeLink from "./StaffHomeLink";
import StaffDocumentReload from "./StaffDocumentReload";
import AppBackButton from "@/components/AppBackButton";
import AcademyTheme from "@/components/academy/AcademyTheme";
import { getAccountViewAccess } from "@/lib/account-view-access";
import { staffShuttleAccess } from "@/lib/shuttle/teacherShuttleView";
import { StaffPushBanner, StaffPushToggle } from "@/components/push/StaffPushControls";

export const metadata: Metadata = {
  title: "스티즈 선생님",
  description: "수업, 출결, 학생 연락과 일정을 관리하는 스티즈 선생님 화면",
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
  // 직원 확인과 «화면 전환 메뉴» 계산은 서로 기다릴 필요가 없어 함께 보낸다(2026-11-16 속도 개선 — 관리자·학부모 레이아웃과 같은 방식).
  // getAccountViewAccess 는 로그인이 없거나 조회가 실패해도 던지지 않고 빈 메뉴를 돌려주므로,
  // 여기서 나는 예외는 예전과 같이 requireStaff 의 것뿐이다(로그인 없음·권한 없음 → 같은 예외).
  const [staff, { views }] = await Promise.all([requireStaff(), getAccountViewAccess()]);
  // 기사님 전용 색·홈 링크는 «기사님만»인 사람에게. 「선생님 + 기사님」은 선생님 화면이 기본이다.
  const isDriverOnly = staff.roles.driver && !staff.roles.teacher;
  // 2026-11-16 원장 지시: 일반 선생님에게도 «셔틀» 탭을 연다(보기 + 선생님 운행). 판정은 teacherShuttleView 한 곳
  const shuttleAccess = staffShuttleAccess(staff.roles);
  const canShuttle = shuttleAccess.canOpen;

  return (
    // 역할별 데이터는 그대로 두고 공통 라이트 표면과 브랜드 강조색을 적용합니다.
    <AcademyTheme role={isDriverOnly ? "driver" : "teacher"} className="min-h-screen pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      <header className="academy-staff-header sticky top-0 z-40 border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="mx-auto flex min-h-11 max-w-lg items-center justify-between gap-2">
          <div className="flex shrink-0 items-center gap-2">
            {/* 설치된 선생님 앱에서는 /staff 밖으로 나가지 않는다.
                (fallbackHref 가 현재 경로와 같을 때 홈페이지로 튀던 함정도 여기서 막힌다) */}
            <AppBackButton fallbackHref="/staff" scopeHref="/staff" />
            <StaffHomeLink isDriver={isDriverOnly} />
          </div>
          <div className="flex min-w-0 items-center gap-1">
            {/* 휴대폰 알림 켜기·켜짐(선생님·기사님 공통) — 예전엔 켜는 버튼이 학부모 화면에만 있어 직원 구독이 0건이었다 */}
            <StaffPushToggle />
            <StaffProfileMenu staffName={staff.appUserName} staffRole={staff.appUserRole} accountViews={views} />
          </div>
        </div>
      </header>
      {/* 기사님: 알림이 꺼져 있으면 상단 한 줄(켜면 사라짐) — 명단 변경을 놓치지 않게 */}
      {staff.roles.driver && <StaffPushBanner />}
      {/* 다른 화면에서 넘어왔으면 한 번 새로 불러온다(마이크 허용 머리글은 처음 불러온 문서에만 붙는다). 그리는 것 없음 */}
      <StaffDocumentReload />
      {children}
      <StaffBottomNav canTeach={staff.roles.teacher} canShuttle={canShuttle} shuttleViewOnly={shuttleAccess.teacherOnly} />
    </AcademyTheme>
  );
}
