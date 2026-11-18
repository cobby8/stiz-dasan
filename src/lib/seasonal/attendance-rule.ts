/**
 * 방학특강 «이 신청서가 이 회차에 나오는가» — 단일 규칙(2026-11-18 기간 선택·날짜별 선택).
 *
 * 왜 한 곳에 모으는가:
 *   출석부·셔틀 명단·정원 계산·좌석(REGULAR) 생성이 모두 같은 질문을 한다. 예전엔 «요일»만 보면 됐지만
 *   이제 «기간(앞 3주만)»과 «날짜 하나씩 고르기»가 생겨, 곳곳에서 따로 판정하면 한쪽만 틀리는 사고가 난다.
 *   그래서 JS 판정(attendsSessionDate)과 SQL 조각(seasonalAttendsSql)을 이 파일 한 곳에 둔다.
 *
 * 규칙(순서대로):
 *   1) selectedDates 가 비어 있지 않으면 → 회차의 KST 날짜가 그 목록에 있을 때만 나온다.
 *   2) 아니면 → (periodStartDate 없음 또는 날짜 >= 시작)
 *              AND (periodEndDate 없음 또는 날짜 <= 종료)
 *              AND (요일이 비었음 또는 회차의 KST 요일이 고른 요일)
 *   기존 신청서(selectedDates 빈 배열·기간 NULL)는 예전 «요일만» 규칙과 결과가 같다.
 *
 * ⚠️ prisma 를 import 하지 않는다 — 브라우저(클라이언트 컴포넌트)에서도 쓸 수 있어야 한다.
 * ⚠️ 날짜·요일은 kst.ts 함수만 쓴다(getDay·toISOString 금지 — 서버가 UTC 라 하루 밀린다).
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { kstDow, toKstYmd } from "../datetime/kst.ts";
import type { SeasonalWeekday } from "./contracts";

/** 신청서 선택 방식 허용값 — 마이그레이션 CHECK 목록과 같아야 한다(짝 테스트 있음). */
export const SELECTION_MODES = ["WEEKDAY", "DATE"] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

/** 이 신청서가 어느 회차에 나오는지 판정하는 데 필요한 값만 모은 것(DB 행을 그대로 넣어도 된다). */
export type SeasonalAttendanceRule = {
  selectionMode?: SelectionMode | string | null;
  /** 고른 요일 — DB 에서 null·한글 요일이 올 수 있어 넓게 받는다. */
  selectedWeekdays: readonly SeasonalWeekday[] | readonly string[] | null | undefined;
  /** 날짜별 선택일 때 고른 날짜(KST 'YYYY-MM-DD'). 비어 있으면 요일·기간 규칙. */
  selectedDates?: readonly string[] | null;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
};

export type AttendanceSessionLike = { id: string; startsAt: Date | string };

// kstDow 결과(0=일 … 6=토)를 신청서 요일 키로 바꾸는 표
const WEEKDAY_BY_DOW: readonly SeasonalWeekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// 예전 데이터에 한글/풀네임 요일이 섞여 있어 관대하게 정규화한다.
// enrollment-dates.ts 의 표와 같은 내용(그 파일은 prisma 를 import 해서 여기서 가져다 쓸 수 없다).
const WEEKDAY_ALIASES: Record<string, SeasonalWeekday> = {
  MON: "MON", MONDAY: "MON", 월: "MON", 월요일: "MON",
  TUE: "TUE", TUESDAY: "TUE", 화: "TUE", 화요일: "TUE",
  WED: "WED", WEDNESDAY: "WED", 수: "WED", 수요일: "WED",
  THU: "THU", THURSDAY: "THU", 목: "THU", 목요일: "THU",
  FRI: "FRI", FRIDAY: "FRI", 금: "FRI", 금요일: "FRI",
  SAT: "SAT", SATURDAY: "SAT", 토: "SAT", 토요일: "SAT",
  SUN: "SUN", SUNDAY: "SUN", 일: "SUN", 일요일: "SUN",
};

/** 요일 값을 MON~SUN 으로 정리. 알 수 없는 값은 조용히 버린다(enrollment-dates 의 normalizeWeekdayKeys 와 같은 규칙). */
function normalizeWeekdays(values: unknown): SeasonalWeekday[] {
  if (!Array.isArray(values)) return [];
  const out: SeasonalWeekday[] = [];
  for (const value of values) {
    const weekday = WEEKDAY_ALIASES[String(value ?? "").trim().toUpperCase()];
    if (weekday && !out.includes(weekday)) out.push(weekday);
  }
  return out;
}

/** 회차 시각 → KST 달력 날짜. 잘못된 값이면 "". */
function sessionYmd(startsAt: Date | string): string {
  return toKstYmd(startsAt);
}

/** 고른 날짜 목록을 깨끗한 문자열 배열로(공백·빈 값 제거). */
function cleanDates(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

/**
 * 이 신청서가 이 회차(시작 시각)에 나오는가.
 * startsAt 은 Date 또는 ISO 문자열. 날짜는 반드시 KST 로 바꿔 비교한다(UTC 15:00 = KST 다음 날 0시).
 */
export function attendsSessionDate(rule: SeasonalAttendanceRule, startsAt: Date | string): boolean {
  const ymd = sessionYmd(startsAt);
  const dates = cleanDates(rule.selectedDates);
  // 1) 날짜별 선택 — 고른 날짜에만 나온다
  if (dates.length > 0) return ymd !== "" && dates.includes(ymd);

  // 2) 기간 — 시작·종료일 모두 «포함». 'YYYY-MM-DD' 는 글자 비교가 곧 날짜 비교다.
  const start = rule.periodStartDate ? String(rule.periodStartDate) : "";
  const end = rule.periodEndDate ? String(rule.periodEndDate) : "";
  if (start && (ymd === "" || ymd < start)) return false;
  if (end && (ymd === "" || ymd > end)) return false;

  // 3) 요일 — 비었으면(주5회·구 데이터) 전 회차
  const wanted = normalizeWeekdays(rule.selectedWeekdays);
  if (wanted.length === 0) return true;
  if (ymd === "") return false; // 날짜를 못 읽은 회차는 요일 판정 불가 → 제외(기존 함수와 같음)
  const dow = kstDow(ymd);
  return Number.isInteger(dow) && wanted.includes(WEEKDAY_BY_DOW[dow]);
}

/**
 * 특강 전체 회차 중 이 신청서가 나오는 회차만 고른다(입력 순서 유지).
 * 기존 신청서(날짜 없음·기간 없음)에선 enrollment-dates.ts 의 pickSessionDatesForWeekdays 와 결과가 같다.
 */
export function pickSessionDatesForApplication<T extends AttendanceSessionLike>(
  sessionDates: readonly T[],
  rule: SeasonalAttendanceRule,
): T[] {
  return sessionDates.filter((sd) => attendsSessionDate(rule, sd.startsAt));
}

// SQL 별칭은 문자열로 끼워 넣으므로 식별자 모양만 허용한다(SQL 주입 차단).
const SQL_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 같은 규칙의 SQL 조각(WHERE/JOIN ON 에 그대로 넣는다). 괄호로 감싼 boolean 식을 돌려준다.
 *   appAlias = SpecialProgramApplication 별칭, sdAlias = SpecialProgramSessionDate 별칭
 * startsAt 은 timestamptz 라 AT TIME ZONE 'Asia/Seoul' 을 «한 번»만 건다(queries.ts 와 같은 식).
 * ⚠️ 요일은 기존 SQL 과 같이 저장값('MON' 등)을 그대로 비교한다(한글 요일 정규화는 JS 쪽만 한다).
 */
export function seasonalAttendsSql(appAlias: string, sdAlias: string): string {
  if (!SQL_ALIAS_RE.test(appAlias) || !SQL_ALIAS_RE.test(sdAlias)) {
    throw new Error("seasonalAttendsSql: 잘못된 SQL 별칭");
  }
  const app = appAlias;
  // 회차의 KST 달력 날짜 'YYYY-MM-DD'
  const ymd = `to_char(${sdAlias}."startsAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
  // 회차의 KST 요일 키(queries.ts 와 같은 CASE 식)
  const weekday = `CASE EXTRACT(ISODOW FROM ${sdAlias}."startsAt" AT TIME ZONE 'Asia/Seoul')::int
        WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
        WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
      END`;
  return `(
    CASE WHEN COALESCE(cardinality(${app}."selectedDates"), 0) > 0
      THEN ${ymd} = ANY(${app}."selectedDates")
      ELSE (${app}."periodStartDate" IS NULL OR ${ymd} >= ${app}."periodStartDate")
       AND (${app}."periodEndDate" IS NULL OR ${ymd} <= ${app}."periodEndDate")
       AND (
         COALESCE(cardinality(${app}."selectedWeekdays"), 0) = 0
         OR ${weekday} = ANY(${app}."selectedWeekdays")
       )
    END
  )`;
}

/**
 * 날짜별 인원 — 회차가 있는 날마다(KST 날짜) 그날 나오는 신청서 수.
 * 회차가 없는 날은 키가 없다. 한 날짜에 회차가 여러 개여도 신청서 하나는 한 번만 센다.
 * 결과 Map 은 날짜 오름차순.
 */
export function countOccupancyByDate(
  apps: readonly SeasonalAttendanceRule[],
  sessionDates: readonly AttendanceSessionLike[],
): Map<string, number> {
  // 날짜별 대표 회차 시각을 모은다(같은 날짜면 첫 회차로 판정 — 규칙은 날짜·요일만 보므로 결과가 같다)
  const byDate = new Map<string, Date | string>();
  for (const sd of sessionDates) {
    const ymd = sessionYmd(sd.startsAt);
    if (ymd && !byDate.has(ymd)) byDate.set(ymd, sd.startsAt);
  }
  const result = new Map<string, number>();
  for (const ymd of [...byDate.keys()].sort()) {
    const startsAt = byDate.get(ymd)!;
    result.set(ymd, apps.filter((app) => attendsSessionDate(app, startsAt)).length);
  }
  return result;
}
