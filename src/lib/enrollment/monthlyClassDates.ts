import { getAcademySettings, getAnnualEvents } from "@/lib/queries";
import { fetchGoogleCalendarEvents } from "@/lib/googleCalendar";
import type { GoogleCalendarReadOptions } from "@/lib/googleCalendar";
import {
  computeClassDatesFromRange,
  getMonthClassSchedule,
  parseAcademicYearMonth,
  WEEK_START_RE,
  OPEN_RE,
  CLOSE_RE,
  CLOSED_RE,
} from "@/lib/classSchedule";

/**
 * 연간 계획표에서 "그 반이 그 달에 며칠 수업하는지"를 읽는다.
 *
 * 원장이 구글 캘린더에 "N월 M주차"(또는 "N월 개강/종강")를 넣어 **월별 요일당 4회로 맞춰**
 * 운영한다. 달력에서 요일을 세면 5회로 잡히는 달이 있어 회당 단가가 실제보다 싸진다.
 *
 * 계산 방식은 공개 연간일정표(/annual)와 **똑같은 함수**를 쓴다. 두 화면이 다른 방식으로
 * 계산하면 학부모가 보는 일정과 청구 근거가 어긋난다.
 */

const DOW_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

type CalendarEvent = { title: string; date: string; endDate?: string };

/** 캘린더 이벤트를 한 번만 읽어 여러 반에 재사용한다(승인 화면에서 여러 건을 계산한다). */
export async function loadAnnualPlanEvents(): Promise<CalendarEvent[]> {
  return (await loadAnnualPlanEventsWithSource()).events;
}

/** 청구는 실패를 숨기지 않고, 거래 밖에서 읽은 동일 공식 일정을 검토·발행에 사용한다. */
export async function loadAnnualPlanEventsWithSource(options: GoogleCalendarReadOptions = {}, storedSource?: {settings:{googleCalendarIcsUrl?:string|null}|null;dbEvents:Array<{title:string;date:Date|string;endDate?:Date|string|null}>}): Promise<{ kind: "DB" | "DB_AND_ICS"; events: CalendarEvent[] }> {
  const [settings, dbEvents] = storedSource ? [storedSource.settings,storedSource.dbEvents] : await Promise.all([
    getAcademySettings() as Promise<any>,
    getAnnualEvents() as Promise<any[]>,
  ]);
  const icsUrl = settings?.googleCalendarIcsUrl as string | null;
  const googleEvents = icsUrl ? await fetchGoogleCalendarEvents(icsUrl, options) : [];

  return { kind: icsUrl ? "DB_AND_ICS" : "DB", events: [
    ...googleEvents.map((event) => ({
      title: event.title,
      date: event.date.toISOString(),
      endDate: event.endDate?.toISOString(),
    })),
    ...dbEvents.map((event: any) => ({
      title: event.title,
      date: new Date(event.date).toISOString(),
      endDate: event.endDate ? new Date(event.endDate).toISOString() : undefined,
    })),
  ] };
}

/** "학원 휴무·휴강" 이벤트가 덮는 날짜(다일 이벤트 포함). */
function collectClosedDates(events: CalendarEvent[]): Set<string> {
  const closed = new Set<string>();
  for (const event of events) {
    if (!CLOSED_RE.test(event.title)) continue;
    const start = new Date(event.date);
    const end = event.endDate ? new Date(event.endDate) : new Date(start);
    const cursor = new Date(start);
    while (cursor.getTime() <= end.getTime()) {
      closed.add(
        `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`,
      );
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return closed;
}

/**
 * 특정 요일 반의 그달 수업일. 계획표에 그달 정보가 없으면 빈 배열을 돌려준다.
 * 빈 배열이면 일할 계산을 하지 않는다(추측해서 청구하지 않는다).
 *
 * @param yearMonth "YYYY-MM" (수강월 기준)
 */
export function getMonthlyClassDates(
  events: CalendarEvent[],
  yearMonth: string,
  dayOfWeek: string,
): string[] {
  const dayIndex = DOW_INDEX[dayOfWeek];
  if (dayIndex === undefined) return [];

  const [year, month] = yearMonth.split("-").map(Number);
  // 계획표의 "수강월"은 0-indexed 로 파싱된다(/annual 과 같은 규칙).
  const key = `${year}-${month - 1}`;
  const closedDates = collectClosedDates(events);

  let openIso: string | null = null;
  let closeIso: string | null = null;
  const weekStarts: { date: string }[] = [];

  for (const event of events) {
    const eventDate = new Date(event.date);
    const open = parseAcademicYearMonth(event.title, OPEN_RE, eventDate);
    if (open && `${open.academicYear}-${open.academicMonth}` === key) openIso = event.date.slice(0, 10);
    const close = parseAcademicYearMonth(event.title, CLOSE_RE, eventDate);
    if (close && `${close.academicYear}-${close.academicMonth}` === key) closeIso = event.date.slice(0, 10);
    const week = parseAcademicYearMonth(event.title, WEEK_START_RE, eventDate);
    if (week && `${week.academicYear}-${week.academicMonth}` === key) weekStarts.push({ date: event.date });
  }

  // 방식 A(개강~종강 범위)를 우선하고, 없으면 방식 B(주차 시작) — /annual 과 같은 순서.
  if (openIso && closeIso) {
    return computeClassDatesFromRange(openIso, closeIso, [dayIndex], closedDates)[dayIndex] ?? [];
  }
  if (weekStarts.length > 0) {
    return getMonthClassSchedule(weekStarts, [dayIndex], closedDates)[dayIndex] ?? [];
  }
  return [];
}
