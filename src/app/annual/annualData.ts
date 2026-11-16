import { getAcademySettings, getClasses, getAnnualEvents } from "@/lib/queries";
import { fetchGoogleCalendarEvents } from "@/lib/googleCalendar";
import {
    getMonthClassSchedule,
    computeClassDatesFromRange,
    parseAcademicYearMonth,
    WEEK_START_RE,
    OPEN_RE,
    CLOSE_RE,
    CLOSED_RE,
} from "@/lib/classSchedule";
import type { SerializedEvent } from "./AnnualEventsClient";

// 연간일정 화면의 자료 준비 — 공개 /annual 과 선생님 앱 «일정»(/staff/annual)이 같이 쓴다(2026-11-16 원장 지시
// «일정은 사이트와 동일하게 동작하도록»). 두 화면이 같은 함수·같은 부품(AnnualEventsClient)을 써서 어긋나지 않는다.
// 내용은 /annual/page.tsx 에 있던 그대로 옮겼다(계산을 바꾸지 않았다).

// Class.dayOfWeek("Mon","Tue"…) → JS getDay() 숫자
const DOW_MAP: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

export type AnnualPageData = {
    /** 학원 대표 전화(공개 화면의 문의 배너용) */
    phone: string;
    allEvents: SerializedEvent[];
    classDays: number[];
    yearlySchedules: Record<number, Record<number, Record<number, string[]>>>;
};

export async function loadAnnualPageData(): Promise<AnnualPageData> {
    // DB 일정도 함께 조회하여 구글 캘린더 이벤트와 합침
    const [settings, classes, dbEvents] = await Promise.all([
        getAcademySettings() as Promise<any>,
        getClasses() as Promise<any[]>,
        getAnnualEvents() as Promise<any[]>,
    ]);

    const phone = settings.contactPhone || "010-0000-0000";
    const icsUrl = settings.googleCalendarIcsUrl as string | null;

    // 구글 캘린더 이벤트 fetch
    const googleEvents = icsUrl ? await fetchGoogleCalendarEvents(icsUrl) : [];

    // ── 구글 이벤트 직렬화 (Date → ISO string) ──
    const googleSerialized: SerializedEvent[] = googleEvents.map((e) => {
        // "n월 개강/종강/n주차" 이벤트는 제목의 n월을 수강월로 사용 (실제 날짜와 무관)
        const academicRE = OPEN_RE.test(e.title) ? OPEN_RE
                         : CLOSE_RE.test(e.title) ? CLOSE_RE
                         : WEEK_START_RE.test(e.title) ? WEEK_START_RE
                         : null;
        const parsed = academicRE ? parseAcademicYearMonth(e.title, academicRE, e.date) : null;
        return {
            id: e.id,
            title: e.title,
            date: e.date.toISOString(),
            endDate: e.endDate?.toISOString(),
            description: e.description,
            category: e.category,
            isAllDay: e.isAllDay,
            url: e.url,
            source: "google" as const,
            academicYear:  parsed?.academicYear,
            academicMonth: parsed?.academicMonth,
        };
    });

    // ── DB 이벤트를 동일 SerializedEvent 형식으로 변환 ──
    const dbSerialized: SerializedEvent[] = dbEvents.map((e: any) => ({
        id: String(e.id),
        title: e.title,
        date: new Date(e.date).toISOString(),
        endDate: e.endDate ? new Date(e.endDate).toISOString() : undefined,
        description: e.description ?? undefined,
        category: e.category ?? "일반",
        isAllDay: true,       // DB 이벤트는 기본 종일 이벤트 취급
        source: "db" as const,
    }));

    // ── 중복 제거: 같은 날짜(YYYY-MM-DD) + 제목이면 구글 이벤트 우선 ──
    // 구글 캘린더에 이미 등록된 일정을 관리자가 DB에도 넣은 경우를 방지
    const googleKeySet = new Set(
        googleSerialized.map((e) => `${e.date.slice(0, 10)}|${e.title}`)
    );
    const uniqueDbEvents = dbSerialized.filter(
        (e) => !googleKeySet.has(`${e.date.slice(0, 10)}|${e.title}`)
    );

    // ── 합치고 날짜순 정렬 ──
    const allEvents: SerializedEvent[] = [
        ...googleSerialized,
        ...uniqueDbEvents,
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // ── 서버에서 월별 수업일자 계산 ──────────────────────────────────
    // 1. Class 레코드에서 수업 요일(숫자) 도출
    const classDays: number[] = [
        ...new Set(
            classes
                .map((c: any) => DOW_MAP[c.dayOfWeek])
                .filter((n: number | undefined) => n !== undefined)
        ),
    ].sort((a, b) => a - b);

    // ── 수업일자 계산 (두 방식 모두 지원) ────────────────────────────────────
    // yearlySchedules: { 수강연도: { 수강월(0-11): { 요일(0-6): [ISO날짜...] } } }
    const yearlySchedules: Record<number, Record<number, Record<number, string[]>>> = {};

    if (classDays.length > 0) {
        // 1. "학원 휴무" 이벤트 날짜 수집 (다일 이벤트 포함, UTC 기준)
        const closedDateSet = new Set<string>();
        for (const ev of allEvents) {
            if (!CLOSED_RE.test(ev.title)) continue;
            const start = new Date(ev.date);
            const end   = ev.endDate ? new Date(ev.endDate) : new Date(start);
            const cur   = new Date(start);
            while (cur.getTime() <= end.getTime()) {
                closedDateSet.add(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth()+1).padStart(2,"0")}-${String(cur.getUTCDate()).padStart(2,"0")}`);
                cur.setUTCDate(cur.getUTCDate() + 1);
            }
        }

        // 2. "n월 개강 / n월 종강" 이벤트 수집 → 방식 A (범위 기반)
        const openByAYM:  Record<string, string> = {}; // key → ISO 개강일
        const closeByAYM: Record<string, string> = {}; // key → ISO 종강일
        for (const ev of allEvents) {
            for (const [re, store] of [[OPEN_RE, openByAYM], [CLOSE_RE, closeByAYM]] as const) {
                const parsed = parseAcademicYearMonth(ev.title, re, new Date(ev.date));
                if (parsed) store[`${parsed.academicYear}-${parsed.academicMonth}`] = ev.date.slice(0, 10);
            }
        }

        // 3. "n월 n주차 시작" 이벤트 수집 → 방식 B (fallback)
        const weekStartsByAYM: Record<string, { date: string }[]> = {};
        for (const ev of allEvents) {
            const parsed = parseAcademicYearMonth(ev.title, WEEK_START_RE, new Date(ev.date));
            if (!parsed) continue;
            const key = `${parsed.academicYear}-${parsed.academicMonth}`;
            if (!weekStartsByAYM[key]) weekStartsByAYM[key] = [];
            weekStartsByAYM[key].push({ date: ev.date });
        }

        // 4. 두 방식을 합쳐서 yearlySchedules 계산
        const allKeys = new Set([...Object.keys(openByAYM), ...Object.keys(weekStartsByAYM)]);
        for (const key of allKeys) {
            const [yearStr, monStr] = key.split("-");
            const year = Number(yearStr), mon = Number(monStr);
            if (!yearlySchedules[year]) yearlySchedules[year] = {};

            const allWeekdays = [1, 2, 3, 4, 5, 6]; // 월~토
            if (openByAYM[key] && closeByAYM[key]) {
                // 방식 A: 개강~종강 범위 기반 (공휴일 자동 제외)
                yearlySchedules[year][mon] = computeClassDatesFromRange(
                    openByAYM[key], closeByAYM[key], allWeekdays, closedDateSet,
                );
            } else if (weekStartsByAYM[key]) {
                // 방식 B: n주차 시작 이벤트 기반 (fallback)
                yearlySchedules[year][mon] = getMonthClassSchedule(
                    weekStartsByAYM[key], allWeekdays, closedDateSet,
                );
            }
        }
    }

    return { phone, allEvents, classDays, yearlySchedules };
}
