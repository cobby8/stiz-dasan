import PublicSiteTheme from "@/components/PublicSiteTheme";
import AnnualEventsClient from "@/app/annual/AnnualEventsClient";
import { loadAnnualPageData } from "@/app/annual/annualData";
import ForceLightScope from "@/components/staff/ForceLightScope";

export const dynamic = "force-dynamic";
export const metadata = { title: "일정 | 스티즈 선생님" };

// 선생님·기사님 «일정»(2026-11-16 원장 지시 «일정은 사이트와 동일하게 동작하도록») — 아래 탭 «일정»에서 연다.
// 공개 /annual 은 설치 앱의 범위(/staff) 밖이라 누르면 앱을 벗어난다 → 같은 자료(loadAnnualPageData)·같은 부품(AnnualEventsClient)을
// 앱 안에서 그대로 보인다: 달력형·목록형 전환, 달 이동, 날짜를 누르면 그날 일정, 일정을 누르면 상세.
// 로그인 확인은 /staff 레이아웃(requireStaff)이 한다. 선생님 전용 판정을 두지 않아 기사님도 본다.
// 부품의 모양은 공개 화면용 범위(.stiz-public-sport) 안에서만 먹으므로 그 범위로 감싼다.

export default async function StaffAnnualPage() {
  const { allEvents, classDays, yearlySchedules } = await loadAnnualPageData();

  return (
    <main className="pb-8">
      {/* 선생님 앱은 밝은 화면 — 사이트의 어두운 모드가 달력만 검게 만들지 않게 이 화면에서만 뗀다 */}
      <ForceLightScope />
      <header className="mx-auto max-w-lg px-4 pb-3 pt-5">
        <h1 className="academy-heading">일정</h1>
      </header>
      <PublicSiteTheme publicScope>
        <AnnualEventsClient allEvents={allEvents} classDays={classDays} yearlySchedules={yearlySchedules} />
      </PublicSiteTheme>
    </main>
  );
}
