import { requireAdmin } from "@/lib/auth-guard";
import RegularRunEditor from "./RegularRunEditor";
import ShuttleSectionTabs from "../ShuttleSectionTabs";
import SeasonalHeader from "../../seasonal/SeasonalHeader";
import { getRegularShuttleMonths, getRegularShuttleStops, getRegularStopsWithoutCoords } from "@/lib/shuttle/regularImport";
import RegularStopGeocodePanel from "@/components/shuttle/RegularStopGeocodePanel";
import { koreaServiceMonth, pickServiceMonthFor, isServiceMonth } from "@/lib/regular/serviceMonth";
import { ensureRegularRosterMonths } from "@/lib/shuttle/regularRosterEdit";
import { getSettings } from "@/lib/seasonal/shuttle-optimize";
import { isKoreanCoordinate } from "@/lib/shuttle/academyLocation";
// 휴원 뱃지·이 달 휴무 — 기사님 화면과 같은 판정(regularRunDayRules)
import { getRegularRosterMonthMarks } from "@/lib/shuttle/regularRunDay";
import { todayKst } from "@/lib/datetime/kst";
// 셔틀 당일 변경(학부모 입력분 + 학원 입력분) 목록과 «당일 변경 입력»(2026-11-15 원장 요청)
import ShuttleDayExceptionAdminPanel from "./ShuttleDayExceptionAdminPanel";
import { getShuttleExceptionBoardForAdmin } from "@/lib/shuttle/admin-shuttle-exception";

export const dynamic = "force-dynamic";

// 정규 셔틀 운행표(관리자) — 2026-11-09 원장 결정: 기사님 화면과 똑같이 보이고, 이 화면에서 직접 고친다.
// 셔틀 명단(RegularShuttleStop)이 유일한 정본이다. 예전 «자동 제안(T맵)·저장 노선·차량 이동»은 없앴다
// (저장 노선 테이블은 지우지 않는다 — 기사님 화면이 더 읽지 않을 뿐).
// 주소는 그대로(/admin/shuttle/regular-dispatch) — 메뉴·탭·배차 진행 링크·카카오 딥링크(?month=&studentId=)를 보존한다.
export default async function RegularDispatchPage({ searchParams }: { searchParams: Promise<{ month?: string; studentId?: string; stopId?: string }> }) {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  // 이번 달·다음 달 명단이 없으면 직전 달을 복사해 만든다. 실패해도 화면은 뜬다.
  try { await ensureRegularRosterMonths(); } catch (e) { console.error("[admin/shuttle/regular-dispatch] 명단 월 자동 생성 실패", e); }
  const months = await getRegularShuttleMonths();
  const requested = await searchParams;
  const initialStudentId = requested.studentId?.slice(0, 64);
  // 기본 월 = 이번 달(KST) 이하의 최신 명단 달. 「다음 달 명단 만들기」로 미래 달이 생겨도 이번 달을 먼저 보여 준다.
  const currentMonth = koreaServiceMonth();
  const serviceMonth = requested.month && isServiceMonth(requested.month)
    ? requested.month
    : (pickServiceMonthFor(months, currentMonth) ?? months[0] ?? currentMonth);

  const [{ stops }, missingStops, settings] = await Promise.all([
    getRegularShuttleStops(serviceMonth),
    getRegularStopsWithoutCoords(serviceMonth), // 좌표 없는 정류장(1회용 좌표 채우기 패널)
    getSettings().catch(() => null), // 학원 좌표 — 순서를 옮길 때 시각 다시 계산(없으면 학원 구간 없이 계산)
  ]);
  const academy = settings?.academy && isKoreanCoordinate(settings.academy.lat, settings.academy.lng)
    ? { lat: settings.academy.lat, lng: settings.academy.lng } : null;
  // 처음 보여 줄 요일 = 신청 학생이 타는 요일 → 없으면 학생이 있는 첫 요일(월→토→일) → 월.
  const exactStop = requested.stopId
    ? stops.find((s) => s.id === requested.stopId && (!initialStudentId || s.studentId === initialStudentId) && (s.direction === "BOARD" || s.direction === "ALIGHT"))
    : undefined;
  const target = exactStop ?? (initialStudentId ? stops.find((s) => s.studentId === initialStudentId) : null);
  const firstDay = [1, 2, 3, 4, 5, 6, 0].find((w) => stops.some((s) => s.weekday === w && s.studentName && (s.direction === "BOARD" || s.direction === "ALIGHT")));
  const initialWeekday = target?.weekday ?? firstDay ?? 1;
  const totalStopCount = new Set(stops.map((s) => s.stopName).filter(Boolean)).size;
  // 뱃지 기준일: 이번 달이면 오늘, 앞으로의 달이면 그 달 1일, 지난 달이면 오늘(지금 상태). 실패해도 화면은 뜬다.
  const today = todayKst();
  const refYmd = serviceMonth > today.slice(0, 7) ? `${serviceMonth}-01` : today;
  const marks = await getRegularRosterMonthMarks(
    stops.filter((s) => s.studentName && (s.direction === "BOARD" || s.direction === "ALIGHT")),
    serviceMonth,
    refYmd,
  ).catch((e) => {
    console.error("[admin/shuttle/regular-dispatch] 휴원·휴무 표시 실패", e);
    return { labelByRowId: {}, holidays: [] };
  });

  // 셔틀 당일 변경 목록 — 조회에 실패해도 운행표는 떠야 한다(빈 목록으로 두고 입력 버튼은 그대로 보인다)
  const dayExceptions = await getShuttleExceptionBoardForAdmin().catch((e) => {
    console.error("[admin/shuttle/regular-dispatch] 셔틀 당일 변경 조회 실패", e);
    return { today, maxDate: today, rows: [] };
  });

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" />
      <ShuttleSectionTabs />
      <ShuttleDayExceptionAdminPanel initial={JSON.parse(JSON.stringify(dayExceptions))} />
      <RegularRunEditor
        key={`${serviceMonth}:${exactStop?.id ?? initialStudentId ?? ""}`}
        stops={JSON.parse(JSON.stringify(stops))}
        serviceMonth={serviceMonth}
        months={[...new Set([...months, serviceMonth])].sort().reverse()}
        currentMonth={currentMonth}
        initialWeekday={initialWeekday}
        initialStudentId={initialStudentId}
        initialStopId={exactStop?.id}
        academy={academy}
        riderBlocks={marks.labelByRowId}
        monthHolidays={marks.holidays}
      />
      <RegularStopGeocodePanel
        stopNames={missingStops}
        totalStopCount={totalStopCount}
        initialCompletedCount={Math.max(0, totalStopCount - missingStops.length)}
      />
    </>
  );
}
