import RegularDispatchClient from "./RegularDispatchClient";
import ShuttleSectionTabs from "../ShuttleSectionTabs";
import SeasonalHeader from "../../seasonal/SeasonalHeader";
import { getRegularShuttleWeekdays } from "@/lib/regular/shuttleRoster";
import { getRegularDispatchForView } from "@/lib/regular/regularDispatchRoute";
import { getRegularShuttleStops, getRegularStopsWithoutCoords } from "@/lib/shuttle/regularImport";
import RegularStopGeocodePanel from "@/components/shuttle/RegularStopGeocodePanel";
import { getRegularShuttleMonths } from "@/lib/shuttle/regularImport";
import { prisma } from "@/lib/prisma";
import { koreaServiceMonth, pickServiceMonthFor } from "@/lib/regular/serviceMonth";
import { ensureRegularRosterMonths } from "@/lib/shuttle/regularRosterEdit";

export const dynamic = "force-dynamic";

// 정규 셔틀 동적배차(신청서 좌표 기반) — 방학특강 배차 화면을 요일 기준으로 재사용한다.
// 명단 편집은 「셔틀 명단」 탭(/admin/shuttle/regular)이 맡고, 이 화면은 그 명단으로 노선을 짠다.
export default async function RegularDispatchPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  // 이번 달·다음 달 명단(과 저장 노선)이 없으면 직전 달을 복사해 만든다. 실패해도 화면은 뜬다.
  try { await ensureRegularRosterMonths(); } catch (e) { console.error("[admin/shuttle/regular-dispatch] 명단 월 자동 생성 실패", e); }
  const months = await getRegularShuttleMonths();
  const requestedMonth = (await searchParams).month;
  // 기본 월 = 이번 달(KST) 이하의 최신 명단 달. 「다음 달 명단 만들기」로 미래 달이 생겨도 이번 달을 먼저 보여 준다.
  // 이번 달 이하가 없으면 최신 달(months[0]), 명단이 아예 없으면 이번 달.
  const currentMonth = koreaServiceMonth();
  const serviceMonth = requestedMonth && months.includes(requestedMonth)
    ? requestedMonth
    : (pickServiceMonthFor(months, currentMonth) ?? months[0] ?? currentMonth);
  const weekdays = await getRegularShuttleWeekdays(serviceMonth);
  const initialDay = weekdays[0] ?? "Mon";

  // 좌표 없는 정류장(1회용 좌표 채우기 패널용). 배차 조회와 병렬.
  const [missingStops, regularStops, drivers, [pickup, dropoff]] = await Promise.all([
    getRegularStopsWithoutCoords(serviceMonth),
    getRegularShuttleStops(serviceMonth),
    prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
      `SELECT id, name FROM "User" WHERE role='DRIVER' ORDER BY name`,
    ),
    // 저장본이 있으면 T맵 없이 그대로(제공량 절약). 없을 때만 T맵으로 초안 계산.
    Promise.all([
      getRegularDispatchForView(initialDay, "PICKUP", true, serviceMonth),
      getRegularDispatchForView(initialDay, "DROPOFF", true, serviceMonth),
    ]),
  ]);
  const initialPickup = JSON.parse(JSON.stringify(pickup));
  const initialDropoff = JSON.parse(JSON.stringify(dropoff));
  const totalStopCount = new Set(regularStops.stops.map((stop) => stop.stopName).filter(Boolean)).size;
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const classTimeByStudent = new Map<string, { dayOfWeek: string; studentName: string; pickupClassTime: string | null; dropoffClassTime: string | null }>();
  for (const stop of regularStops.stops) {
    if (!stop.studentName || (stop.direction !== "BOARD" && stop.direction !== "ALIGHT")) continue;
    const key = `${stop.weekday}:${stop.studentId ?? stop.studentName.replace(/\s/g, "")}`;
    const row = classTimeByStudent.get(key) ?? { dayOfWeek: dowNames[stop.weekday] ?? "", studentName: stop.studentName, pickupClassTime: null, dropoffClassTime: null };
    if (stop.direction === "BOARD") row.pickupClassTime = stop.classTime;
    if (stop.direction === "ALIGHT") row.dropoffClassTime = stop.classTime;
    classTimeByStudent.set(key, row);
  }
  const classTimeMismatches = [...classTimeByStudent.values()].filter((row) => row.pickupClassTime && row.dropoffClassTime && row.pickupClassTime !== row.dropoffClassTime);

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" />
      <ShuttleSectionTabs />
      <RegularDispatchClient
        weekdays={weekdays}
        initialDay={initialDay}
        initialPickup={initialPickup}
        initialDropoff={initialDropoff}
        serviceMonth={serviceMonth}
        months={months}
        classTimeMismatches={classTimeMismatches}
        drivers={drivers}
      />
      {/* 일상 배차를 먼저 표시한다. 누락 좌표 안내의 기존 문서 내 링크는 그대로 유지한다. */}
      <RegularStopGeocodePanel
        stopNames={missingStops}
        totalStopCount={totalStopCount}
        initialCompletedCount={Math.max(0, totalStopCount - missingStops.length)}
      />
    </>
  );
}
