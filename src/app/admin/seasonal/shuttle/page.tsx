import { requireAdmin } from "@/lib/auth-guard";
import ShuttleRosterClient from "./ShuttleRosterClient";
import ShuttleSectionTabs from "../../shuttle/ShuttleSectionTabs";
import SeasonalHeader from "../SeasonalHeader";
import { getSeasonalShuttleRoster } from "@/lib/seasonal/shuttle-roster";
import { shuttleRosterConfirmationInfo } from "@/lib/seasonal/shuttleRoster";

export const dynamic = "force-dynamic";

// 방학특강 셔틀 통합 명단(학생 단위 편집 뷰). 상단 공통 헤더·탭을 다른 방학특강 화면과 동일하게 사용한다.
export default async function SeasonalShuttleRosterPage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  const [roster, confirmation] = await Promise.all([
    getSeasonalShuttleRoster(),
    // 확정일시(배너 표기용). 명단 조회와 독립이라 같이 병렬로 읽는다.
    shuttleRosterConfirmationInfo(),
  ]);
  const initialRoster = JSON.parse(JSON.stringify(roster));

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" subtitle="방학특강 셔틀 신청 학생 명단을 확인·편집합니다." />
      <ShuttleSectionTabs />
      <ShuttleRosterClient
        initialRoster={initialRoster}
        initialConfirmedAt={confirmation.confirmedAt ? confirmation.confirmedAt.toISOString() : null}
        initialConfirmedCount={confirmation.count}
        initialConfirmed={confirmation.confirmed}
      />
    </>
  );
}
