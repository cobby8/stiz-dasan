// 기사님 운행표(정규 셔틀)의 «그날 이 아이를 체크해도 되는가» 판정 — 순수 함수(DB·React·시계 없음).
// 실행 테스트: tests/driver-paused-holiday.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 왜 만들었나(2026-11-14 원장 지시):
//   (가) «휴원 학생은 명단에서 빼지 않고 뱃지로 표시하고 탑승·미탑승 버튼을 비활성화하기로 하지 않았어?»
//   (나) «기사님 운행표에도 공휴일·휴무 표시 넣어줘»
//   학부모 쪽(childShuttleRules)은 이미 휴원·퇴원·첫 수업 전·휴무를 판정한다. 기사님 화면이 따로 규칙을 만들면
//   «학부모는 휴원인데 기사님은 체크 대상» 같은 어긋남이 생기므로 **학부모 쪽 함수를 그대로 불러** 한 규칙으로 쓴다.
//     - 수강 상태: enrollmentStateOn(첫 수업 전 → 퇴원 → 휴원 순) · 명단 행 ↔ 반 맞추기: matchRosterClass
//     - 휴무: 연간일정 수업일(classDatesForCalendarMonth = 수업 탭 «다음 수업»·학부모 셔틀과 같은 계산)이 아니면 휴무
// 막는 범위:
//   - 휴원·퇴원·첫 수업 전 → 그 학생 줄만 뱃지 + 탑승·미탑승 버튼 잠금
//   - 휴무(연간일정 수업일 아님) → 그날 정규 행 전부 잠금 + 화면 맨 위 «오늘은 휴무(사유)»
//   - 부상·질병 «기간 결석»은 휴원이 아니다(결석 신고) → 여기서 막지 않는다. 기존 «결석» 뱃지 그대로.
// 판정이 «모름»이면(연간일정 확정 전·반을 못 찾음·학생 id 없음) 막지 않는다 — 기사님이 아이를 못 태우는 쪽이 더 위험하다.

import { addDaysKst, kstDow } from "@/lib/datetime/kst";
import { CLOSED_RE, OPEN_RE, CLOSE_RE, WEEK_START_RE } from "@/lib/classSchedule";
import { classDatesForCalendarMonth } from "@/lib/mypage/parentSchedule";
import { enrollmentStateOn, matchRosterClass, type ShuttleClassRef } from "./childShuttleRules";

/** 연간일정 → 그 달·요일 수업일(getMonthlyClassDates 를 호출부가 꽂는다 — 학부모 쪽 MonthlyClassDates 와 같은 모양) */
export type MonthlyClassDates = (yearMonth: string, dayOfWeek: string) => string[];
/** 연간일정 이벤트(loadAnnualPlanEvents 결과와 같은 모양) */
export type PlanEvent = { title: string; date: string; endDate?: string };

/** 학생 줄을 잠그는 이유 — 수강 상태 3가지 + 휴무 */
export type RiderBlockKind = "PAUSED" | "ENDED" | "NOT_STARTED" | "HOLIDAY";

/** 뱃지 글자(학부모 쪽 SHUTTLE_DAY_STATUS_TEXT 와 같은 말) */
export const RIDER_BLOCK_LABEL: Record<RiderBlockKind, string> = {
  PAUSED: "휴원",
  ENDED: "퇴원",
  NOT_STARTED: "첫 수업 전",
  HOLIDAY: "휴무",
};

/** 화면·서버가 잠긴 줄인지 알아보는 데 쓰는 글자 집합(뱃지 글자 = 잠금 표시) */
export const RIDER_BLOCK_LABELS: readonly string[] = Object.values(RIDER_BLOCK_LABEL);

const DOW_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * 명단 한 줄(요일·수업시간)의 그날 수강 상태로 잠글지.
 * classes: 그 학생의 정규 반(수강 중·휴원 중). undefined = 학생 id 가 없거나 못 읽음 → 모름(안 잠금).
 *   - 반이 하나도 없다(퇴원해 수강 중·휴원 중 반 없음) → ENDED
 *   - 그 요일·시간 반을 못 찾았다(반 이동 등) → 모름(안 잠금) — 학부모 쪽 «확인 필요»와 같은 경우
 */
export function rosterRowBlock(
  row: { weekday: number; classTime: string | null },
  classes: readonly ShuttleClassRef[] | undefined,
  ymd: string,
): Exclude<RiderBlockKind, "HOLIDAY"> | null {
  if (!classes) return null;
  if (classes.length === 0) return "ENDED";
  const cls = matchRosterClass(row.weekday, row.classTime, classes);
  if (!cls) return null;
  const state = enrollmentStateOn(cls, ymd);
  return state === "ACTIVE" ? null : state;
}

/** 이벤트가 덮는 날(UTC 날짜 칸 기준) — monthlyClassDates 의 휴무일 모으기와 같은 방식이라 같은 날을 가리킨다 */
function coversDay(event: PlanEvent, ymd: string): boolean {
  const start = new Date(event.date);
  if (Number.isNaN(start.getTime())) return false;
  const end = event.endDate ? new Date(event.endDate) : new Date(start);
  const cursor = new Date(start);
  for (let i = 0; i < 400 && cursor.getTime() <= end.getTime(); i++) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
    if (key === ymd) return true;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return false;
}

/**
 * 휴무 사유 글자 — 그날을 덮는 «학원 휴무·휴강» 일정 제목 → 없으면 그날 다른 일정 제목(예: «개천절») → 없으면 기본 문구.
 * 주차·개강·종강 표시용 일정은 사유가 아니라 건너뛴다. 너무 길면 자른다(한 줄 안내).
 */
export function holidayReason(events: readonly PlanEvent[] | null | undefined, ymd: string): string {
  const onDay = (events ?? []).filter((e) => typeof e?.title === "string" && e.title.trim() && coversDay(e, ymd));
  const closed = onDay.find((e) => CLOSED_RE.test(e.title));
  const other = onDay.find((e) => !CLOSED_RE.test(e.title) && !WEEK_START_RE.test(e.title) && !OPEN_RE.test(e.title) && !CLOSE_RE.test(e.title));
  const title = (closed ?? other)?.title.trim().replace(/\s+/g, " ");
  if (!title) return "연간일정 수업 없는 날";
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
}

export type RunHoliday = { ymd: string; title: string };

/**
 * 그날이 정규 수업 없는 날(휴무)인가. 학부모 셔틀 «휴무»와 같은 계산(classDatesForCalendarMonth).
 * 연간일정을 못 읽었거나(monthlyDates=null) 그 달·요일 수업일이 아직 없으면(확정 전) null — 안내 없이 기존대로.
 */
export function regularRunHoliday(
  ymd: string,
  monthlyDates: MonthlyClassDates | null,
  events: readonly PlanEvent[] | null,
): RunHoliday | null {
  if (!monthlyDates || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const dow = DOW_NAME[kstDow(ymd)];
  if (!dow) return null;
  const dates = classDatesForCalendarMonth(ymd.slice(0, 7), dow, null, monthlyDates);
  if (dates.length === 0) return null; // 그 달 일정 확정 전(또는 일요일처럼 계획표에 없는 요일) → 모름
  if (dates.includes(ymd)) return null;
  return { ymd, title: holidayReason(events, ymd) };
}

/**
 * 한 달의 휴무일 목록(관리자 운행표 «이 달 휴무» 한 줄용) — 날마다 regularRunHoliday 와 같은 판정.
 * 연간일정이 없거나 그 요일 일정이 확정 전이면 그 날은 빠진다(모르면 표시하지 않는다).
 */
export function monthRunHolidays(
  month: string,
  monthlyDates: MonthlyClassDates | null,
  events: readonly PlanEvent[] | null,
): (RunHoliday & { weekday: number })[] {
  if (!monthlyDates || !/^\d{4}-\d{2}$/.test(month)) return [];
  const out: (RunHoliday & { weekday: number })[] = [];
  for (let ymd = `${month}-01`; ymd.slice(0, 7) === month; ymd = addDaysKst(ymd, 1)) {
    const h = regularRunHoliday(ymd, monthlyDates, events);
    if (h) out.push({ ...h, weekday: kstDow(ymd) });
  }
  return out;
}

/**
 * 한 줄의 최종 잠금 이유 — 학부모 쪽 buildShuttleDays 와 같은 순서: 수강 상태 → 휴무.
 * (결석은 잠금이 아니다 — 기존 «결석» 뱃지·기본 미탑승 그대로)
 */
export function riderBlockOf(
  row: { weekday: number; classTime: string | null },
  classes: readonly ShuttleClassRef[] | undefined,
  ymd: string,
  holiday: RunHoliday | null,
): RiderBlockKind | null {
  return rosterRowBlock(row, classes, ymd) ?? (holiday ? "HOLIDAY" : null);
}

/** 서버 저장 거부 판정 — 잠긴 줄에는 «대기로 되돌리기»(null)만 받는다(예전에 잘못 남은 기록을 지울 수 있게). */
export function boardingRejectedForBlock(blockedLabel: string | null | undefined, status: string | null): boolean {
  return Boolean(blockedLabel) && status !== null;
}
