import { getRegularShuttleMonths, getRegularShuttleStops } from "./regularImport";
import { getRegularAbsentPeople } from "./regularRun";
import { getShuttleExceptionsForDate } from "./parent-shuttle-exception";
import { describeException } from "./dayExceptionRules";
import { pickServiceMonthFor } from "@/lib/regular/serviceMonth";
import { kstDow } from "@/lib/datetime/kst";
import { DRIVER_ABSENCE_LABEL, matchAbsentee } from "@/lib/regular/regularAbsenceMatch";
import type { DriverClass } from "./regularDriverRouteLogic";
// 운행표 조립(묶음·결석 뱃지·«오늘만» 변경)은 관리자 운행표와 같은 순수 함수 한 곳에서 한다.
import { buildRegularRunClasses } from "./regularRunRows";
import { selectDriverDayRows } from "./regularDriverRouteLogic";
// 휴원·퇴원·첫 수업 전·휴무 잠금 — 학부모 셔틀과 같은 규칙(regularRunDayRules)으로 판정한다.
import { getRegularRunDayBlocks } from "./regularRunDay";
import type { RunHoliday } from "./regularRunDayRules";

/**
 * 정규 셔틀 기사님 화면의 "그날 무엇을 보여 줄지"를 한곳에서 만든다(서버 전용).
 *
 * 5단계(2026-11-09 원장 결정): 셔틀 명단(RegularShuttleStop)만 읽는다 — 명단이 유일한 운행 정본이다.
 *   예전 «저장된 정규 배차 노선(RegularDispatchRoute) 우선»은 없앴다(관리자가 명단을 고쳐도 기사님 화면이
 *   안 바뀌던 원인). 남아 있던 1건은 배포 직전 SQL 로 명단에 옮긴다. 테이블은 지우지 않는다(읽기만 끊음).
 *
 * ⚠️ 탑승 체크(ShuttleBoarding, direction='REGULAR')의 저장·조회 경로는 손대지 않는다 — 키는 명단 정차행 id.
 * ⚠️ PgBouncer 트랜잭션 모드 → 하위 조회는 모두 $queryRawUnsafe 를 쓰는 기존 함수만 호출한다.
 */

// KST 날짜의 요일(0=일 … 6=토). 공용 모듈(kstDow)로 계산해 시간대가 개입하지 않는다.
function weekdayOf(dateIso: string): number {
  return kstDow(dateIso);
}

/** 기사님 화면(정규)의 그날 섹션 목록. 두 기사님 화면(/driver/[token], /shuttle/regular/[token])이 공유한다. */
export async function getRegularDriverClasses(viewDate: string): Promise<DriverClass[]> {
  return (await getRegularDriverDay(viewDate)).classes;
}

/**
 * 그날 섹션 + 휴무 안내. 화면 맨 위 «오늘은 휴무(사유)»가 필요한 곳(기사님 화면·계정 운행표)은 이걸 쓴다.
 * 탑승 저장 API 도 같은 함수 결과(줄의 blockedLabel)로 잠긴 줄의 체크를 거부한다 — 화면과 서버가 같은 판정.
 */
export async function getRegularDriverDay(viewDate: string): Promise<{ classes: DriverClass[]; holiday: RunHoliday | null }> {
  const weekday = weekdayOf(viewDate);

  // 그날이 속한 달 "이하"의 최신 명단 달을 한 번만 정해 명단 조회에 넘긴다.
  // 왜: 「다음 달 명단 만들기」로 미래 달 행이 먼저 생겨도 기사님 화면은 그날 달 명단을 봐야 한다.
  // 해당 달이 없으면 undefined → 각 함수의 기존 동작(최신 달).
  const serviceMonth = pickServiceMonthFor(await getRegularShuttleMonths(), viewDate);

  const [{ stops }, absentees, shuttleExceptions] = await Promise.all([
    getRegularShuttleStops(serviceMonth),
    getRegularAbsentPeople(viewDate),
    getShuttleExceptionsForDate(viewDate),
  ]);
  // 그 요일 학생 행만 잠금 판정(휴원·퇴원·첫 수업 전 + 그날 휴무). 실패해도 화면은 잠금 없이 뜬다.
  const { holiday, labelByRowId } = await getRegularRunDayBlocks(selectDriverDayRows(stops, weekday), viewDate)
    .catch((e) => {
      console.error("[regularDriverRoute] 잠금 판정 실패 — 잠금 없이 표시", e);
      return { holiday: null, labelByRowId: new Map<string, string>() };
    });

  // 결석 매칭: 이름(+가능하면 학부모 전화)으로 그날 결석자와 이어 붙인다(best-effort) — 종전과 동일.
  // ⚠️ 결석 학생은 명단에서 빼지 않는다(원장 지시 2026-11-09). absent 표시 + 아래에서 뱃지 문구만 붙인다.
  // 🔒 뱃지는 사유 없이 항상 «결석»(건강 민감정보를 로그인 없는 기사님 화면에 내리지 않는다).
  const isAbsent = (p: { name: string | null; phone: string | null }) => matchAbsentee(p, absentees) !== null;
  const absentLabelOf = (p: { name: string | null; phone: string | null }) => (isAbsent(p) ? DRIVER_ABSENCE_LABEL : null);

  // 조립은 순수 함수(buildRegularRunClasses)에 맡긴다 — 종전과 같은 순서:
  // 묶음(명단 순서 그대로) → 결석 뱃지 → "오늘만" 셔틀 변경. 관리자 운행표도 같은 함수를 쓴다.
  // "오늘만" 변경은 결석과 같은 이름·전화 매칭을 쓴다(명단 행에는 학생 id 가 없을 수 있다).
  const classes = buildRegularRunClasses({
    stops,
    weekday,
    isAbsent,
    absentLabelOf,
    dayNotes: {
      exceptions: shuttleExceptions,
      matches: (row, entry) => matchAbsentee(row, [{ name: entry.name, phone: entry.phone }]) !== null,
      describe: describeException,
    },
    blockOf: (rowId) => labelByRowId.get(rowId) ?? null,
  });
  return { classes, holiday };
}
