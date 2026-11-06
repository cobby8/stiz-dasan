// 연간일정 «달력형» 계산 — 화면과 떼어 두어 날짜 경계(월말·연말·여러 날 일정)를 테스트로 고정한다.
// 날짜는 "YYYY-MM-DD" 문자열로만 다루고, 요일·날짜 더하기는 UTC 달력으로 계산해 기기 시간대가 끼어들지 않게 한다.
import { toKstYmd } from "@/lib/datetime/kst";

export interface CalendarEventLike {
    id: string;
    title: string;
    date: string;
    endDate?: string;
    /** 시간 지정 일정은 끝나는 «시각»이라 자정에 끝나면 그 날은 빼야 한다 */
    isAllDay?: boolean;
}

export interface CalendarCell {
    ymd: string;
    day: number;
    /** 고른 달에 속한 날인지(앞뒤 달의 날은 흐리게 보여 준다) */
    inMonth: boolean;
    /** 0=일요일 … 6=토요일 */
    dow: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymdOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 고른 달(month: 0=1월)을 일요일부터 시작하는 주 단위 칸으로 나눈다. 앞뒤 달 날짜로 빈칸을 채운다. */
export function buildMonthGrid(year: number, month: number): CalendarCell[][] {
    const first = new Date(Date.UTC(year, month, 1));
    const start = new Date(first);
    start.setUTCDate(1 - first.getUTCDay());
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const weekCount = Math.ceil((first.getUTCDay() + lastDay) / 7);
    const weeks: CalendarCell[][] = [];
    const cur = new Date(start);
    for (let w = 0; w < weekCount; w++) {
        const week: CalendarCell[] = [];
        for (let d = 0; d < 7; d++) {
            week.push({ ymd: ymdOf(cur), day: cur.getUTCDate(), inMonth: cur.getUTCMonth() === month, dow: d });
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
        weeks.push(week);
    }
    return weeks;
}

// 여러 날 일정을 하루씩 펼칠 때의 상한 — 잘못 입력된 긴 기간이 화면을 멈추지 않게 한다.
const MAX_SPAN_DAYS = 120;

/** 일정의 실제 날짜(KST 달력)를 기준으로, 달력에 보이는 날마다 걸리는 일정을 모은다. 여러 날 일정은 기간 안 모든 날에 넣는다. */
export function eventsByDay<T extends CalendarEventLike>(events: T[], cells: CalendarCell[][]): Map<string, T[]> {
    const visible = new Set(cells.flat().map((c) => c.ymd));
    const map = new Map<string, T[]>();
    for (const ev of events) {
        const startYmd = toKstYmd(ev.date);
        if (!startYmd) continue;
        // 시간 일정이 밤 12시에 끝나면 다음 날 칸으로 번지지 않게 1ms 앞으로 당겨 읽는다
        const endRaw = ev.endDate && (ev.isAllDay === false ? new Date(new Date(ev.endDate).getTime() - 1) : ev.endDate);
        let endYmd = (endRaw && toKstYmd(endRaw)) || startYmd;
        if (endYmd < startYmd) endYmd = startYmd; // 끝이 시작보다 앞서게 잘못 입력돼도 시작일에는 보인다
        const [y, m, d] = startYmd.split("-").map(Number);
        const cur = new Date(Date.UTC(y, m - 1, d));
        for (let i = 0; i < MAX_SPAN_DAYS; i++) {
            const ymd = ymdOf(cur);
            if (ymd > endYmd) break;
            if (visible.has(ymd)) {
                const list = map.get(ymd) ?? [];
                list.push(ev);
                map.set(ymd, list);
            }
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
    }
    return map;
}
