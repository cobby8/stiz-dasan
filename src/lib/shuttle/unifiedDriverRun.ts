import { getDispatchForView } from "@/lib/seasonal/shuttle-optimize";
import { prisma } from "@/lib/prisma";
// 정규 쪽 "그날 무엇을 띄울지"(확정 저장 노선 우선 · 없으면 셔틀 명단 폴백)는 이 게이트웨이 한곳에서만 만든다.
import { getRegularDriverClasses } from "./regularDriverRoute";
import { readDriverBoarding } from "./driverStatusRead";
import {
  buildUnifiedRun,
  type SeasonalSectionInput,
  type UnifiedRow,
} from "./unifiedDriverRunLogic";
import type { DriverClass } from "./regularDriverRouteLogic";

/**
 * 기사님 통합 운행 화면의 그날 데이터(서버 전용).
 *
 * 기사님은 방학특강·정규를 구분하지 않으므로 **한 링크에서 그날 운행 전부**를 시각순으로 본다.
 *
 * ⚠️ 탑승 체크의 저장·조회 경로는 종류별로 그대로 둔다.
 *    · 특강: ShuttleBoarding(direction='PICKUP'|'DROPOFF', shuttleRequestId)
 *    · 정규: ShuttleBoarding(direction='REGULAR', shuttleRequestId=명단 정차행 id)
 *    화면 상태만 접두사 키(S:/R:)로 합쳐 쓰고, 저장할 땐 각자 원래 API·원래 키로 되돌린다.
 *
 * ⚠️ PgBouncer 트랜잭션 모드 → 하위 조회는 전부 $queryRawUnsafe 를 쓰는 기존 함수만 호출한다.
 */

export type BoardingStatus = "BOARDED" | "NOSHOW" | "SELF";

const PREFIX = /^(STIZ 다산점 · |차고지 · )/;
const KST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type DispatchVehicleLike = {
  vehicleName: string; tripLabel?: string | null;
  departTime?: string | null; arriveTime?: string | null; depotTime?: string | null;
  stops?: {
    label: string; isHub?: boolean; etaLabel?: string | null; lat?: number; lng?: number;
    students?: { requestId: string; name: string; grade?: string | null; parentPhone?: string | null; childPhone?: string | null }[];
  }[];
};

function toKstDateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return KST_DATE_FORMATTER.format(date);
}

/**
 * 방학특강은 시즌 기간 안에서만 기사님 통합 링크에 붙인다.
 * 시즌이 끝난 뒤 저장된 과거 배차가 정규 기사님 링크에 섞이면 실제 운행표가 오염된다.
 */
export async function hasSeasonalRunOnDate(viewDate: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(viewDate)) return false;

  try {
    const seasons = await prisma.$queryRawUnsafe<{
      startsAt: Date | null;
      endsAt: Date | null;
      status: string | null;
    }[]>(
      `SELECT "startsAt", "endsAt", "status"
         FROM "SpecialProgramSeason"
        WHERE "status" IN ('PUBLISHED', 'ACTIVE')`,
    );

    return seasons.some((season) => {
      const startsAt = toKstDateKey(season.startsAt);
      const endsAt = toKstDateKey(season.endsAt);
      return Boolean(startsAt && endsAt && startsAt <= viewDate && viewDate <= endsAt);
    });
  } catch {
    // 시즌 확인이 안 되면 종료된 특강을 잘못 노출하는 쪽이 더 위험하다.
    return false;
  }
}

/** 방학특강 그날 구간(등원·하원) — 종전 기사님 화면이 만들던 것과 같은 모양·같은 값. */
export async function loadSeasonalSections(viewDate: string): Promise<SeasonalSectionInput[]> {
  if (!(await hasSeasonalRunOnDate(viewDate))) return [];

  const directions: ("PICKUP" | "DROPOFF")[] = ["PICKUP", "DROPOFF"];
  return Promise.all(directions.map(async (d) => {
    const sug = await getDispatchForView(viewDate, d, false); // 기사님 화면은 T맵 미호출(저장본/직선)
    const vraw = sug.vehicles as DispatchVehicleLike[];
    const isPickup = d === "PICKUP";
    return {
      direction: d,
      time: (isPickup ? sug.classStart : sug.classEnd) ?? null,
      startName: (isPickup ? (sug.depot?.name ?? "차고지") : sug.academy.name).replace(PREFIX, ""),
      endName: (isPickup ? sug.academy.name : (sug.depot?.name ?? "차고지")).replace(PREFIX, ""),
      vehicles: vraw.map((v) => ({
        vehicleName: v.vehicleName, tripLabel: v.tripLabel ?? null,
        departTime: v.departTime ?? null, arriveTime: v.arriveTime ?? null, depotTime: v.depotTime ?? null,
        stops: (v.stops ?? []).map((s) => ({
          label: s.label, isHub: Boolean(s.isHub), etaLabel: s.etaLabel ?? null,
          lat: typeof s.lat === "number" ? s.lat : null, lng: typeof s.lng === "number" ? s.lng : null,
          students: (s.students ?? []).map((st) => ({
            requestId: st.requestId, name: st.name, grade: st.grade ?? null,
            parentPhone: st.parentPhone ?? null, childPhone: st.childPhone ?? null,
          })),
        })),
      })),
    };
  }));
}

/** 화면 상태용 통합 탑승 맵 — 종류·방향 접두사를 붙여 서로 덮어쓰지 않게 한다. */
export function mergeBoardingMaps(input: {
  pickup: Record<string, BoardingStatus>;
  dropoff: Record<string, BoardingStatus>;
  regular: Record<string, BoardingStatus>;
}): Record<string, BoardingStatus> {
  const out: Record<string, BoardingStatus> = {};
  for (const [id, st] of Object.entries(input.pickup)) out[`S:PICKUP:${id}`] = st;
  for (const [id, st] of Object.entries(input.dropoff)) out[`S:DROPOFF:${id}`] = st;
  for (const [id, st] of Object.entries(input.regular)) out[`R:${id}`] = st;
  return out;
}

export type UnifiedDriverRun = {
  rows: UnifiedRow[];
  boarding: Record<string, BoardingStatus>;
  boardingReliable: boolean;
  /** 관리자 지도에 표시되는 기사님 이름표(GPS 공유). 종전 화면과 같은 값을 유지한다. */
  driverLabel: string;
};

/** 그날 운행 전체(특강+정규)를 시각순 한 줄 목록으로. */
export async function loadUnifiedDriverRun(viewDate: string): Promise<UnifiedDriverRun> {
  // 정규는 셔틀 명단(DB)을 따로 읽는다. 정규 쪽이 실패해도 **매일 쓰이는 방학특강 화면이 같이 죽으면 안 되므로** 따로 감싼다.
  const regularSafe = async (): Promise<{ classes: DriverClass[] }> => {
    try {
      const classes = await getRegularDriverClasses(viewDate);
      return { classes };
    } catch {
      return { classes: [] };
    }
  };

  const [sections, regular] = await Promise.all([
    loadSeasonalSections(viewDate),
    regularSafe(),
  ]);

  const reads = await Promise.allSettled([
    readDriverBoarding(viewDate, "PICKUP"),
    readDriverBoarding(viewDate, "DROPOFF"),
    readDriverBoarding(viewDate, "REGULAR"),
  ]);
  const boardingReliable = reads.every((read) => read.status === "fulfilled");
  const [pickup, dropoff, regularBoarding] = reads.map((read) => read.status === "fulfilled" ? read.value.boarding : {});

  // 이름표는 종전 화면 규칙 그대로: 특강 차량명 → 없으면 정규 명단 유무에 따라 기본 문구.
  const driverLabel = sections[0]?.vehicles?.[0]?.vehicleName
    ?? (regular.classes.length > 0 ? "정규 셔틀 기사님" : "방학특강 기사님");

  return {
    rows: buildUnifiedRun({ seasonal: sections, regular: regular.classes }),
    boarding: mergeBoardingMaps({ pickup, dropoff, regular: regularBoarding }),
    boardingReliable,
    driverLabel,
  };
}
