import ical from "node-ical";

export interface GoogleCalendarEvent {
    id: string;
    title: string;
    date: Date;
    endDate?: Date;
    description?: string;
    category: string;
    isAllDay: boolean;
    url?: string;
    source: "google";
}
export type GoogleCalendarReadOptions = { strict?: boolean; fresh?: boolean };

// isRecurring: Google Calendar 반복 이벤트 여부 (recurringEventId 또는 recurrenceid 존재 시 true)
// 텍스트 키워드 기반 분류가 우선이고, 키워드 매칭이 안 되면 반복 여부로 "정기행사" 판별
function inferCategory(summary: string, description?: string, isRecurring = false): string {
    const text = `${summary} ${description || ""}`.toLowerCase();
    // "경기" 제거 — 농구교실에서 "경기"는 일반 수업/연습 맥락이 많아 대회로 오분류됨
    if (text.includes("대회") || text.includes("tournament")) return "대회";
    if (text.includes("방학") || text.includes("휴강") || text.includes("휴무") || text.includes("휴가") || text.includes("vacation")) return "방학";
    if (text.includes("특별") || text.includes("행사") || text.includes("event")) return "특별행사";
    if (text.includes("정기") || text.includes("정례")) return "정기행사";
    // 키워드 매칭 없지만 반복 이벤트면 정기행사로 분류
    if (isRecurring) return "정기행사";
    return "일반";
}

/**
 * node-ical은 VALUE=DATE 종일 이벤트를 "로컬 자정" Date로 파싱합니다.
 * 서버가 KST(UTC+9)이면 "2026-03-03T00:00:00+09:00" = "2026-03-02T15:00:00Z"가 되어
 * toISOString()으로 변환 시 하루 앞당겨지는 버그가 발생합니다.
 *
 * 이 함수는 로컬 날짜 성분(getFullYear/Month/Date)을 그대로 읽어
 * UTC 자정 Date로 정규화합니다. 어떤 서버 시간대에서도 올바른 날짜를 보장합니다.
 */
function normalizeAllDayDate(d: Date): Date {
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** ICS URL에서 Google Calendar ID 추출
 *  예: https://calendar.google.com/calendar/ical/{calendarId}/private-.../basic.ics
 */
function extractCalendarId(icsUrl: string): string | null {
    const m = icsUrl.match(/\/calendar\/ical\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : null;
}

/** Google Calendar API v3 사용 (캐시 없음, 실시간)
 *  GOOGLE_CALENDAR_API_KEY 환경변수 필요
 */
async function fetchViaCalendarAPI(
    calendarId: string,
    apiKey: string,
    options: GoogleCalendarReadOptions = {},
): Promise<GoogleCalendarEvent[]> {
    const now = new Date();
    const timeMin = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)).toISOString();
    const timeMax = new Date(Date.UTC(now.getUTCFullYear() + 2, 0, 1)).toISOString();

    const url =
        `https://www.googleapis.com/calendar/v3/calendars/` +
        `${encodeURIComponent(calendarId)}/events` +
        `?key=${apiKey}&singleEvents=true&maxResults=2500` +
        `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;

    const res = await fetch(url, options.fresh ? { cache: "no-store" } : { next: { revalidate: 300 } });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Google Calendar API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    if (options.strict && (!Array.isArray(data.items) || data.nextPageToken)) throw new Error("공식 일정 전체를 확인하지 못했습니다.");

    const result: GoogleCalendarEvent[] = [];
    for (const item of data.items ?? []) {
        const summary: string = item.summary || "제목 없음";
        const isAllDay = !!item.start?.date; // date면 종일, dateTime이면 시간지정

        let startDate: Date;
        let endDate: Date | undefined;

        if (isAllDay) {
            // "YYYY-MM-DD" 형식 → 시간대 문제 없이 UTC 자정으로 변환
            const [sy, sm, sd] = (item.start.date as string).split("-").map(Number);
            startDate = new Date(Date.UTC(sy, sm - 1, sd));

            if (item.end?.date) {
                // DTEND는 exclusive → -1일 처리
                const [ey, em, ed] = (item.end.date as string).split("-").map(Number);
                const excl = new Date(Date.UTC(ey, em - 1, ed));
                const incl = new Date(excl.getTime() - 86400_000);
                if (incl.getTime() !== startDate.getTime()) {
                    endDate = incl;
                }
            }
        } else {
            startDate = new Date(item.start.dateTime);
            if (item.end?.dateTime) endDate = new Date(item.end.dateTime);
        }

        // 반복 이벤트는 singleEvents=true로 이미 전개됨 (별도 처리 불필요)
        // recurringEventId가 있으면 원래 반복 이벤트에서 전개된 인스턴스
        const isRecurring = !!item.recurringEventId;
        result.push({
            id: `gcal-${item.id}`,
            title: summary,
            date: startDate,
            endDate,
            description: item.description,
            category: inferCategory(summary, item.description, isRecurring),
            isAllDay,
            url: item.htmlLink,
            source: "google",
        });
    }

    return result.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** ICS 파싱 방식 (fallback) */
async function fetchViaICS(icsUrl: string, options: GoogleCalendarReadOptions = {}): Promise<GoogleCalendarEvent[]> {
    const res = await fetch(icsUrl, options.fresh ? { cache: "no-store" } : { next: { revalidate: 300 } });
    if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
    const icsText = await res.text();
    if (options.strict && (!icsText.includes("BEGIN:VCALENDAR") || !icsText.includes("END:VCALENDAR"))) throw new Error("공식 일정 형식이 올바르지 않습니다.");
    const events = ical.sync.parseICS(icsText) as Record<string, any>;
    const result: GoogleCalendarEvent[] = [];

    for (const key in events) {
        const event = events[key] as any;
        if (event.type !== "VEVENT") continue;

        const summary = event.summary || "제목 없음";
        const start = event.start;
        const end = event.end;
        if (!start) continue;

        if ((event as any).rrule) {
            if (options.strict) throw new Error("반복 일정 전체를 확인하지 못했습니다.");
            continue;
        }

        const isAllDay = (event as any).datetype === "date";
        const startDate = isAllDay ? normalizeAllDayDate(new Date(start)) : new Date(start);

        let endDate: Date | undefined;
        if (end) {
            if (isAllDay) {
                const raw = new Date(end);
                raw.setDate(raw.getDate() - 1);
                const adjusted = normalizeAllDayDate(raw);
                if (adjusted.getTime() !== startDate.getTime()) {
                    endDate = adjusted;
                }
            } else {
                endDate = new Date(end);
            }
        }

        // recurrenceid가 있으면 반복 이벤트에서 수정된 인스턴스
        const isRecurring = !!(event as any).recurrenceid;
        result.push({
            id: `gcal-${key}`,
            title: summary,
            date: startDate,
            endDate,
            description: event.description,
            category: inferCategory(summary, event.description, isRecurring),
            isAllDay,
            url: (event as any).url || undefined,
            source: "google",
        });
    }

    return result.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function fetchGoogleCalendarEvents(icsUrl: string, options: GoogleCalendarReadOptions = {}): Promise<GoogleCalendarEvent[]> {
    const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;

    // API 키가 있으면 Google Calendar API v3 사용 (실시간, 캐시 없음)
    if (apiKey) {
        const calendarId = extractCalendarId(icsUrl);
        if (calendarId) {
            try {
                return await fetchViaCalendarAPI(calendarId, apiKey, options);
            } catch (e) {
                if (!options.strict) console.error("Calendar API failed, falling back to ICS:", e);
            }
        }
    }

    // fallback: ICS 파싱
    try {
        return await fetchViaICS(icsUrl, options);
    } catch (e) {
        if (options.strict) throw new Error("공식 일정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        console.error("Failed to fetch Google Calendar ICS:", e);
        return [];
    }
}
