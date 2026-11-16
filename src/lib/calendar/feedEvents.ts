/**
 * «내 캘린더에 연동» — 무엇을 내보낼지 정하는 **순수 규칙**(DB·next 를 쓰지 않는다. 테스트가 그대로 실행한다).
 *
 * 항목(kind) 세 가지
 *   academy  학원 일정(개강·종강·휴무·행사) — 누구나
 *   teaching 내 수업 시간표 — 선생님
 *   children 우리 아이 수업 — 학부모
 * (셔틀 운행 시간은 넣지 않았다 — 운행표가 «월별 명단 + 그날 변경·휴무»를 합쳐 그날그날 만들어져
 *  «요일별 고정 시각»으로 단순하게 뽑을 수 없다.)
 *
 * 날짜 계산은 @/lib/datetime/kst 만 쓴다(서버는 UTC, 학원은 KST).
 */
import { addMonthsYm, isKstYmd, kstAt, toKstYmd } from "@/lib/datetime/kst";
import { icsUid, type IcsEvent } from "./ics";

export const CALENDAR_KINDS = ["academy", "teaching", "children"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/** 화면에 보이는 이름 */
export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = {
  academy: "학원 일정",
  teaching: "내 수업 시간표",
  children: "우리 아이 수업",
};

/** 항목마다 붙는 한 줄 설명 */
export const CALENDAR_KIND_HINTS: Record<CalendarKind, string> = {
  academy: "개강·종강·휴무·행사",
  teaching: "내가 맡은 반의 수업 시간",
  children: "아이가 다니는 반의 수업 시간",
};

/** 로그인이 필요한 항목(주소에 본인 확인 값이 들어간다) */
export const PERSONAL_KINDS: readonly CalendarKind[] = ["teaching", "children"];

/** 쉼표 목록·배열 어느 쪽이든 받아, 아는 항목만 정해진 순서로(중복 제거) */
export function parseCalendarKinds(raw: unknown): CalendarKind[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const wanted = new Set(list.map((item) => String(item).trim()));
  return CALENDAR_KINDS.filter((kind) => wanted.has(kind));
}

/** 역할로 고를 수 있는 항목. 학원 일정은 누구나 */
export function allowedCalendarKinds(access: { teacher: boolean; parent: boolean } | null | undefined): CalendarKind[] {
  const kinds: CalendarKind[] = ["academy"];
  if (access?.teacher) kinds.push("teaching");
  if (access?.parent) kinds.push("children");
  return kinds;
}

/** 요청한 항목 중 «지금 허용된 것»만 남긴다 — 주소를 만들 때와 캘린더가 받아 갈 때 둘 다 이 함수로 거른다 */
export function filterCalendarKinds(requested: readonly CalendarKind[], allowed: readonly CalendarKind[]): CalendarKind[] {
  return CALENDAR_KINDS.filter((kind) => requested.includes(kind) && allowed.includes(kind));
}

export function hasPersonalKind(kinds: readonly CalendarKind[]): boolean {
  return kinds.some((kind) => PERSONAL_KINDS.includes(kind));
}

/** 내보내는 범위 — 지난달부터 다다음달까지("YYYY-MM" 네 개) */
export function feedMonths(todayYmd: string): string[] {
  const ym = String(todayYmd ?? "").slice(0, 7);
  return [-1, 0, 1, 2].map((delta) => addMonthsYm(ym, delta)).filter(Boolean);
}

/** 연간일정표 한 줄(공개 /annual 의 allEvents 와 같은 모양) */
export type AcademyEventLike = {
  id: string;
  title: string;
  /** ISO 시각. 종일 일정은 «그 날짜의 UTC 자정»으로 들어온다(연간일정 화면과 같은 약속) */
  date: string;
  endDate?: string;
  description?: string;
  isAllDay?: boolean;
  source?: string;
};

/** 학원 일정 → 캘린더 일정. 종일 일정의 끝 날짜는 «포함»으로 넘긴다(다음 날로 바꾸는 일은 ics.ts 가 한다) */
export function academyEventsToIcs(events: readonly AcademyEventLike[]): IcsEvent[] {
  const out: IcsEvent[] = [];
  for (const ev of events) {
    if (!ev?.title) continue;
    const uid = icsUid("academy", ev.source ?? "site", ev.id);
    const description = ev.description || undefined;
    if (ev.isAllDay === false) {
      // 시간 지정 일정 — 저장된 시각 그대로
      const startMs = new Date(ev.date).getTime();
      if (!Number.isFinite(startMs)) continue;
      const endMs = ev.endDate ? new Date(ev.endDate).getTime() : NaN;
      out.push({ uid, title: ev.title, description, allDay: false, startMs, endMs });
      continue;
    }
    // 종일 일정 — 연간일정 달력(annualCalendar.ts)과 같은 방식으로 KST 달력 날짜를 읽는다
    const startYmd = toKstYmd(ev.date);
    if (!isKstYmd(startYmd)) continue;
    const endYmd = ev.endDate ? toKstYmd(ev.endDate) : "";
    out.push({ uid, title: ev.title, description, allDay: true, startYmd, endYmd: isKstYmd(endYmd) ? endYmd : null });
  }
  return out;
}

export type FeedClass = {
  id: string;
  name: string;
  /** "Mon" … "Sun" */
  dayOfWeek: string;
  /** "HH:MM"(KST) */
  startTime: string;
  endTime: string;
  location?: string | null;
};

/**
 * 한 반의 수업일 목록 — 범위 안 달마다 연간일정 기준 수업일을 모은다(휴무는 원본 계산이 이미 뺀다).
 * monthlyDates 는 getMonthlyClassDates(events, ym, dow) 를 감싼 함수(이 모듈이 DB 를 모르게 하려고 받는다).
 * startsOn(수강 시작일) 이전 날짜는 뺀다.
 */
export function classDatesInRange(
  months: readonly string[],
  dayOfWeek: string,
  startsOn: string | null | undefined,
  monthlyDates: (yearMonth: string, dayOfWeek: string) => string[],
): string[] {
  const out = new Set<string>();
  for (const month of months) {
    for (const raw of monthlyDates(month, dayOfWeek)) {
      const ymd = String(raw ?? "").slice(0, 10);
      if (!isKstYmd(ymd)) continue;
      if (startsOn && isKstYmd(startsOn) && ymd < startsOn) continue;
      out.add(ymd);
    }
  }
  return Array.from(out).sort();
}

/**
 * 반 수업일 × 수업 시간 → 캘린더 일정.
 * uidScope 는 같은 반이라도 «누구의 일정인지»를 가른다(아이별 일정이 서로 덮어쓰지 않게).
 * 수업 시간이 "HH:MM" 이 아니면 그날 종일 일정으로 넣는다(일정을 통째로 잃지 않게).
 */
export function classSessionsToIcs(input: {
  cls: FeedClass;
  dates: readonly string[];
  title: string;
  uidScope: string;
}): IcsEvent[] {
  const { cls, dates, title, uidScope } = input;
  const timed = /^\d{1,2}:\d{2}/.test(cls.startTime ?? "") && /^\d{1,2}:\d{2}/.test(cls.endTime ?? "");
  const out: IcsEvent[] = [];
  for (const ymd of dates) {
    if (!isKstYmd(ymd)) continue;
    const uid = icsUid(uidScope, cls.id, ymd);
    const location = cls.location || undefined;
    if (!timed) {
      out.push({ uid, title, location, allDay: true, startYmd: ymd });
      continue;
    }
    // KST 수업 시각 → 절대 시각. 캘린더에는 UTC 로 나간다(KST 00:00 = 전날 UTC 15:00)
    out.push({ uid, title, location, allDay: false, startMs: kstAt(ymd, cls.startTime), endMs: kstAt(ymd, cls.endTime) });
  }
  return out;
}
