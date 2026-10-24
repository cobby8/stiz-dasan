import RegularShuttleClient from "./RegularShuttleClient";
import ShuttleSectionTabs from "../ShuttleSectionTabs";
import SeasonalHeader from "../../seasonal/SeasonalHeader";
import { getRegularShuttleMonths, getRegularShuttleStops } from "@/lib/shuttle/regularImport";
import { koreaServiceMonth, pickServiceMonthFor } from "@/lib/regular/serviceMonth";
import { ensureRegularRosterMonths } from "@/lib/shuttle/regularRosterEdit";

export const dynamic = "force-dynamic";

// 셔틀 명단 — 사이트가 정규 셔틀 명단의 원장이다(구글 시트 가져오기 대신 여기서 추가·빼기·반이동).
export default async function RegularShuttlePage() {
  // 이번 달·다음 달 명단이 없으면 직전 달을 복사해 바로 만든다(크론과 같은 함수, 이미 있으면 아무것도 안 함).
  // 실패해도 화면은 떠야 하므로 오류는 기록만 한다.
  try { await ensureRegularRosterMonths(); } catch (e) { console.error("[admin/shuttle/regular] 명단 월 자동 생성 실패", e); }
  const currentMonth = koreaServiceMonth();
  const months = await getRegularShuttleMonths();
  // 이번 달 명단이 있으면 이번 달, 없으면 이번 달 이전 중 가장 최근 달, 그것도 없으면 가장 이른 달.
  const initialMonth = pickServiceMonthFor(months, currentMonth) ?? months[months.length - 1] ?? currentMonth;
  const data = await getRegularShuttleStops(initialMonth);
  const initial = JSON.parse(JSON.stringify(data)) as typeof data;

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" subtitle="정규 수업 셔틀 이용 학생 명단을 요일·수업별로 관리합니다." />
      <ShuttleSectionTabs />
      <RegularShuttleClient initialStops={initial.stops} initialMonth={initialMonth} months={initial.months} currentMonth={currentMonth} />
    </>
  );
}
