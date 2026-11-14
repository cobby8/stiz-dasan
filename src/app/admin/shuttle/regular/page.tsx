import { requireAdmin } from "@/lib/auth-guard";
import RegularShuttleClient from "./RegularShuttleClient";
import ShuttleSectionTabs from "../ShuttleSectionTabs";
import SeasonalHeader from "../../seasonal/SeasonalHeader";
import { getRegularShuttleMonths, getRegularShuttleStops } from "@/lib/shuttle/regularImport";
import { koreaServiceMonth, pickServiceMonthFor, isServiceMonth } from "@/lib/regular/serviceMonth";
import { ensureRegularRosterMonths } from "@/lib/shuttle/regularRosterEdit";
import KakaoShuttleRosterTasks from "./KakaoShuttleRosterTasks";
import DriverRunLinkControls from "./DriverRunLinkControls";
import { isDriverRunLinkEnabled } from "@/lib/shuttle/driverLinkAccess";
import { getOpenKakaoShuttleRosterTasks, type KakaoShuttleRosterTaskItem } from "@/lib/kakao-shuttle-roster-task-query";
import RegularChangeRequestsPanel from "./RegularChangeRequestsPanel";
import { listRegularChangeRequests, type AdminRegularChangeRow } from "@/lib/shuttle/regularChangeRequest";

export const dynamic = "force-dynamic";

// 셔틀 명단 — 사이트가 정규 셔틀 명단의 원장이다(구글 시트 가져오기 대신 여기서 추가·빼기·반이동).
export default async function RegularShuttlePage({ searchParams }: { searchParams: Promise<{ month?: string; studentId?: string; weekday?: string; add?: string }> }) {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  // 이번 달·다음 달 명단이 없으면 직전 달을 복사해 바로 만든다(크론과 같은 함수, 이미 있으면 아무것도 안 함).
  // 실패해도 화면은 떠야 하므로 오류는 기록만 한다.
  try { await ensureRegularRosterMonths(); } catch (e) { console.error("[admin/shuttle/regular] 명단 월 자동 생성 실패", e); }
  const currentMonth = koreaServiceMonth();
  const months = await getRegularShuttleMonths();
  const requested = await searchParams;
  // 이번 달 명단이 있으면 이번 달, 없으면 이번 달 이전 중 가장 최근 달, 그것도 없으면 가장 이른 달.
  const initialMonth = requested.month && isServiceMonth(requested.month) ? requested.month : pickServiceMonthFor(months, currentMonth) ?? months[months.length - 1] ?? currentMonth;
  const data = await getRegularShuttleStops(initialMonth);
  const initial = JSON.parse(JSON.stringify(data)) as typeof data;
  // 원장 할 일: 카카오 정규 셔틀 신청 → «셔틀 명단에 넣어 주세요». 조회 실패해도 명단 화면은 떠야 하므로 빈 목록으로 둔다.
  let rosterTasks: KakaoShuttleRosterTaskItem[] = [];
  try { rosterTasks = await getOpenKakaoShuttleRosterTasks(); } catch (e) { console.error("[admin/shuttle/regular] 카카오 셔틀 신청 할 일 조회 실패", e); }

  // 학부모 «셔틀 계속 바꾸기» 신청(2026-11-14 c5) — 승인·반려는 이 화면에서. 조회 실패·표 없음이어도 명단 화면은 떠야 한다.
  let changeRequests: AdminRegularChangeRow[] = [];
  try { changeRequests = await listRegularChangeRequests(); } catch (e) { console.error("[admin/shuttle/regular] 셔틀 계속 바꾸기 신청 조회 실패", e instanceof Error ? e.name : ""); }

  // 기사님 운행 링크(문자 주소) 스위치 — 서버가 실제로 막는 값과 같은 함수로 읽는다.
  const driverRunLinkEnabled = await isDriverRunLinkEnabled();

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" subtitle="정규 수업 셔틀 이용 학생 명단을 요일·수업별로 관리합니다." />
      <ShuttleSectionTabs />
      <KakaoShuttleRosterTasks tasks={rosterTasks} />
      <RegularChangeRequestsPanel rows={changeRequests} />
      <DriverRunLinkControls initialEnabled={driverRunLinkEnabled} />
      <RegularShuttleClient initialStops={initial.stops} initialMonth={initialMonth} months={initial.months} currentMonth={currentMonth} initialStudentId={requested.studentId?.slice(0,64)} initialWeekday={/^[0-6]$/.test(requested.weekday ?? "") ? Number(requested.weekday) : undefined} initialAdd={requested.add === "1"} />
    </>
  );
}
