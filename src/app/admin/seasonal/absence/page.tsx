import { requireAdmin } from "@/lib/auth-guard";
import SeasonalSectionTabs from "../SeasonalSectionTabs";
import SeasonalHeader from "../SeasonalHeader";
import SeasonalAbsenceAdminClient from "./SeasonalAbsenceAdminClient";
import { countPendingMakeups } from "@/lib/seasonal/attendance";
import { getSeasonalAbsenceSeasons, getSeasonalAbsences } from "@/lib/seasonal/admin-absence";

export const dynamic = "force-dynamic";

export default async function SeasonalAbsencePage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  // 시즌 목록·결석 신고 목록·보강 대기 뱃지는 서로 무관하므로 병렬 조회한다.
  const [seasons, absences, makeupPending] = await Promise.all([
    getSeasonalAbsenceSeasons(),
    getSeasonalAbsences(), // 초기엔 전체 시즌(필터 없음)
    countPendingMakeups(),
  ]);
  const initial = JSON.parse(JSON.stringify({ seasons, absences })) as {
    seasons: Array<{ id: string; title: string; status: string }>;
    absences: import("@/lib/seasonal/admin-absence").SeasonalAbsenceRow[];
  };
  return (
    <>
      <SeasonalHeader />
      <SeasonalSectionTabs makeupPending={makeupPending} />
      <SeasonalAbsenceAdminClient initial={initial} />
    </>
  );
}
