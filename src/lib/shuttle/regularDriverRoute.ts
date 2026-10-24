import { getRegularShuttleMonths, getRegularShuttleStops } from "./regularImport";
import { getRegularAbsentPeople } from "./regularRun";
import { getShuttleExceptionsForDate } from "./parent-shuttle-exception";
import { describeException } from "./dayExceptionRules";
import { getSavedRegularDispatchRoute } from "@/lib/regular/regularDispatchRoute";
import { getRegularShuttleRiders } from "@/lib/regular/shuttleRoster";
import { DOW_NAMES } from "@/lib/regular/shuttleRosterLogic";
import { pickServiceMonthFor } from "@/lib/regular/serviceMonth";
import { kstDow } from "@/lib/datetime/kst";
import { matchAbsentee } from "@/lib/regular/regularAbsenceMatch";
import {
  assembleRegularDriverClasses,
  attachShuttleDayNotes,
  pickRegularRouteSource,
  selectDriverDayRows,
  type DriverClass,
  type RouteDirection,
} from "./regularDriverRouteLogic";
import type { RegularShuttleStop } from "./regularSheet";

/**
 * 정규 셔틀 기사님 화면의 "그날 무엇을 보여 줄지"를 한곳에서 만든다(서버 전용).
 *
 * 우선순위:
 *   1) 그 요일의 저장된 정규 배차 노선(RegularDispatchRoute) — 원장이 순서·시각을 확정한 노선.
 *   2) 없으면 셔틀 명단(RegularShuttleStop) 그대로 = 종전 동작(폴백, '확정 전' 표시).
 *
 * ⚠️ 탑승 체크(ShuttleBoarding, direction='REGULAR')의 저장·조회 경로는 손대지 않는다.
 *    저장 노선을 쓰더라도 각 학생의 rowId 는 예전과 같은 **명단 정차행 id** 로 되돌려 넘긴다.
 *    (저장 payload 의 학생 식별자는 studentId 라서 그대로 쓰면 과거 체크 기록이 끊긴다.)
 *
 * ⚠️ PgBouncer 트랜잭션 모드 → 하위 조회는 모두 $queryRawUnsafe 를 쓰는 기존 함수만 호출한다.
 */

// KST 날짜의 요일(0=일 … 6=토). 공용 모듈(kstDow)로 계산해 시간대가 개입하지 않는다.
function weekdayOf(dateIso: string): number {
  return kstDow(dateIso);
}

const DIRECTIONS: RouteDirection[] = ["PICKUP", "DROPOFF"];

/** 그 요일·방향의 "라이더 studentId → 명단 정차행 id 목록"(명단 순서). 저장 노선 ↔ 탑승체크 키 다리. */
async function loadRowIdsByStudentId(
  dayOfWeek: string,
  direction: RouteDirection,
  orderIndex: Map<string, number>,
  serviceMonth?: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const roster = await getRegularShuttleRiders({ direction, dayOfWeek, serviceMonth });
    // 좌표 없는 이용자(unassigned)도 포함해야 저장 노선에 남아 있는 학생을 놓치지 않는다.
    for (const rider of [...roster.riders, ...roster.unassigned]) {
      const rowId = rider.stopRowId ?? null;
      if (!rowId) continue;
      const list = out.get(rider.studentId) ?? [];
      list.push(rowId);
      out.set(rider.studentId, list);
    }
    // 같은 학생이 여러 행을 가질 때(명단 중복·오분류) 명단 순서대로 소비되도록 정렬한다.
    for (const list of out.values()) list.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
  } catch {
    // 명단 조회 실패 → 빈 매핑. 저장 노선은 그대로 보이고, 명단 행은 '노선에 없는 승객'으로 전부 노출된다.
  }
  return out;
}

/** 기사님 화면(정규)의 그날 섹션 목록. 두 기사님 화면(/driver/[token], /shuttle/regular/[token])이 공유한다. */
export async function getRegularDriverClasses(viewDate: string): Promise<DriverClass[]> {
  const weekday = weekdayOf(viewDate);
  const dayOfWeek = DOW_NAMES[weekday];

  // 그날이 속한 달 "이하"의 최신 명단 달을 한 번만 정해 명단·저장노선·탑승키 조회에 모두 넘긴다.
  // 왜: 「다음 달 명단 만들기」로 미래 달 행이 먼저 생겨도 기사님 화면은 그날 달 명단을 봐야 한다.
  // 해당 달이 없으면 undefined → 각 함수의 기존 동작(최신 달).
  const serviceMonth = pickServiceMonthFor(await getRegularShuttleMonths(), viewDate);

  const [{ stops }, absentees, shuttleExceptions] = await Promise.all([
    getRegularShuttleStops(serviceMonth),
    getRegularAbsentPeople(viewDate),
    getShuttleExceptionsForDate(viewDate),
  ]);

  // 그 요일의 학생 정차행만(승차/하차). 명단 순서 유지 — 폴백 화면은 이 순서가 곧 운행 순서다.
  // 관리자 「셔틀 명단 → 기사님 화면」 보기와 같은 함수(selectDriverDayRows)로 고른다.
  const dayRows: RegularShuttleStop[] = selectDriverDayRows(stops, weekday);

  // 결석 매칭: 이름(+가능하면 학부모 전화)으로 그날 결석자와 이어 붙인다(best-effort) — 종전과 동일.
  const isAbsent = (p: { name: string | null; phone: string | null }) => matchAbsentee(p, absentees) !== null;

  // 요일·방향별 저장 노선. 테이블이 없거나 실패하면 null → 자동으로 폴백.
  const [savedPickup, savedDropoff] = await Promise.all(
    DIRECTIONS.map((d) => getSavedRegularDispatchRoute(dayOfWeek, d, serviceMonth)),
  );
  const saved: Record<RouteDirection, { vehicles?: unknown } | null> = { PICKUP: savedPickup, DROPOFF: savedDropoff };

  // 저장 노선을 실제로 쓰는 방향에서만 매핑을 조회한다(폴백뿐이면 추가 쿼리 0).
  const orderIndex = new Map<string, number>();
  dayRows.forEach((r, i) => { if (r.id) orderIndex.set(r.id, i); });
  const empty = new Map<string, string[]>();
  const [mapPickup, mapDropoff] = await Promise.all(
    DIRECTIONS.map((d) =>
      pickRegularRouteSource(saved[d]) === "SAVED" ? loadRowIdsByStudentId(dayOfWeek, d, orderIndex, serviceMonth) : Promise.resolve(empty),
    ),
  );

  const classes = assembleRegularDriverClasses({
    dayRows,
    isAbsent,
    saved,
    rowIdsByStudentId: { PICKUP: mapPickup, DROPOFF: mapDropoff },
  });

  // "오늘만" 셔틀 변경은 명단을 다 만든 뒤 덧붙인다. 저장 노선·폴백 두 경로 모두에
  // 똑같이 적용되어야 하는데, 조립 안에 심으면 한쪽만 고쳐지기 쉽다.
  // 결석과 같은 이름·전화 매칭을 쓴다(명단 행에는 학생 id 가 없을 수 있다).
  return attachShuttleDayNotes(
    classes,
    shuttleExceptions,
    (row, entry) => matchAbsentee(row, [{ name: entry.name, phone: entry.phone }]) !== null,
    describeException,
  );
}
