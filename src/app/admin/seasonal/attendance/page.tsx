import { requireAdmin } from "@/lib/auth-guard";
import SeasonalAttendanceClient from "./SeasonalAttendanceClient";
import SeasonalSectionTabs from "../SeasonalSectionTabs";
import SeasonalHeader from "../SeasonalHeader";
import { countPendingMakeups, getSeasonalAttendanceBootstrap } from "@/lib/seasonal/attendance";

export const dynamic = "force-dynamic";

export default async function SeasonalAttendancePage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  // 부트스트랩과 대기 건수는 서로 무관하므로 병렬로 조회한다(응답 지연 최소화).
  const [bootstrap, makeupPending] = await Promise.all([
    getSeasonalAttendanceBootstrap(),
    countPendingMakeups(),
  ]);
  const initial = JSON.parse(JSON.stringify(bootstrap)) as {
    seasons: Array<{ id: string; title: string; status: string }>;
    offerings: Array<{
      id: string; seasonId: string; title: string; capacity: number | null;
      targetGrades: string | null; instructorName: string | null; dateCount: number; enrolledSlots: number;
    }>;
  };
  return (
    <>
      {/* 렌더 순서 통일: 공통 헤더 → 6개 탭 바 → 본문 */}
      <SeasonalHeader />
      <SeasonalSectionTabs makeupPending={makeupPending} />
      <SeasonalAttendanceClient initial={initial} />
    </>
  );
}
