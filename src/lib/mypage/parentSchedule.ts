// 학부모 «일정» 탭의 한 달 달력 계산 (2026-11-09 원장 지시).
// 일정 탭 = 연간일정(행사·휴무) · 우리 아이 수업일자 · 출결을 «한 달 단위»로 보는 화면이다.
// DB·네트워크를 부르지 않는 순수 함수만 둔다 — 화면(ScheduleHub)과 테스트가 같은 계산을 쓴다.
// 날짜는 전부 "YYYY-MM-DD"/"YYYY-MM" 문자열로 다루고, 변환은 공용 KST 모듈만 쓴다.
import { addDaysKst, isKstYmd, kstDow, toKstYmd } from "@/lib/datetime/kst";
import { CLOSED_RE, WEEK_START_RE } from "@/lib/classSchedule";

const YM_RE = /^(\d{4})-(\d{2})$/;

export type AttendanceKey = "PRESENT" | "LATE" | "ABSENT";

/** 출결 상태 → 칸 표시 키(기존 기록 화면과 같은 판정: PRESENT/ABSENT 외에는 지각) */
export function attendanceKeyOf(status: string): AttendanceKey {
    return status === "PRESENT" ? "PRESENT" : status === "ABSENT" ? "ABSENT" : "LATE";
}

/** ?month= 값이 올바른 "YYYY-MM" 이면 그대로, 아니면 오늘(KST)이 속한 달 */
export function parseMonthParam(raw: unknown, todayYmd: string): string {
    const m = YM_RE.exec(String(raw ?? ""));
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}`;
    return todayYmd.slice(0, 7);
}

/** "YYYY-MM" 에 달 더하기/빼기 (달력 숫자만 센다 — 시간대 개입 없음) */
export function shiftMonth(ym: string, delta: number): string {
    const [y, mo] = ym.split("-").map(Number);
    const index = y * 12 + (mo - 1) + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** "2026-11" → "2026년 11월" */
export function monthTitle(ym: string): string {
    const [y, mo] = ym.split("-").map(Number);
    return `${y}년 ${mo}월`;
}

/** 그 달의 마지막 날짜 수 (Date.UTC 는 시간대와 무관한 달력 계산) */
function daysInMonth(ym: string): number {
    const [y, mo] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** "8/14(금)" 처럼 짧은 날짜 — 화면 한 줄 행용 */
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;
export function shortDay(ymd: string): string {
    if (!isKstYmd(ymd)) return "";
    const [, mo, d] = ymd.split("-").map(Number);
    return `${mo}/${d}(${DOW_KO[kstDow(ymd)]})`;
}

export type PlanEvent = { title: string; date: string; endDate?: string };

export type ScheduleEventRow = { startYmd: string; endYmd: string; title: string; closed: boolean };

export type MonthCell = {
    ymd: string;
    day: number;
    isToday: boolean;
    /** 우리 아이 수업일(연간일정 기준) */
    isClass: boolean;
    /** 학원 휴무일 */
    closed: boolean;
    /** 그날 출결(여러 건이면 결석 > 지각 > 출석 순으로 하나) */
    attendance: AttendanceKey | null;
    /** 행사가 있는 날(휴무 제외) */
    hasEvent: boolean;
};

export type ParentMonthView = {
    month: string;
    /** 일~토 7칸씩. 그 달이 아닌 칸은 null(빈칸) */
    weeks: (MonthCell | null)[][];
    summary: { classCount: number; present: number; late: number; absent: number };
    events: ScheduleEventRow[];
};

/** 이벤트의 시작~끝 KST 날짜(끝은 포함). 끝이 없거나 앞서면 하루짜리 */
function eventRange(ev: PlanEvent): { start: string; end: string } | null {
    const start = toKstYmd(ev.date);
    if (!isKstYmd(start)) return null;
    const endRaw = ev.endDate ? toKstYmd(ev.endDate) : "";
    const end = isKstYmd(endRaw) && endRaw >= start ? endRaw : start;
    return { start, end };
}

/**
 * 한 달 화면 데이터.
 * - events: 연간일정(구글 캘린더 + 관리자 등록 일정). «N월 N주차» 같은 운영용 표시는 목록에서 뺀다.
 * - classDates: 우리 아이 수업일(연간일정 기준 계산 결과). 그 달 밖 날짜는 무시한다.
 * - attendance: 출결 기록(날짜는 어떤 형식이든 KST 달력 날짜로 바꿔 센다).
 */
export function buildParentMonth({
    month,
    todayYmd,
    events,
    classDates,
    attendance,
}: {
    month: string;
    todayYmd: string;
    events: PlanEvent[];
    classDates: string[];
    attendance: { status: string; date: Date | string }[];
}): ParentMonthView {
    const first = `${month}-01`;
    const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
    const inMonth = (ymd: string) => ymd >= first && ymd <= last;

    // 1) 행사·휴무 — 같은 날짜+제목은 한 번만(구글과 관리자 등록이 겹치는 경우, /annual 과 같은 규칙)
    const seen = new Set<string>();
    const rows: ScheduleEventRow[] = [];
    const closedDays = new Set<string>();
    const eventDays = new Set<string>();
    for (const ev of events) {
        if (WEEK_START_RE.test(ev.title)) continue; // 주차 표시는 학원 운영용이라 학부모 화면에 안 보인다
        const range = eventRange(ev);
        if (!range || range.end < first || range.start > last) continue; // 이 달과 겹치지 않음
        const key = `${range.start}|${ev.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const closed = CLOSED_RE.test(ev.title);
        rows.push({ startYmd: range.start, endYmd: range.end, title: ev.title, closed });
        // 달력 칸 표시용으로 이 달 안의 날짜만 펼친다(긴 방학도 최대 한 달치)
        let cursor = range.start < first ? first : range.start;
        const stop = range.end > last ? last : range.end;
        while (cursor && cursor <= stop) {
            (closed ? closedDays : eventDays).add(cursor);
            cursor = addDaysKst(cursor, 1);
        }
    }
    rows.sort((a, b) => (a.startYmd === b.startYmd ? a.title.localeCompare(b.title) : a.startYmd < b.startYmd ? -1 : 1));

    // 2) 수업일 — 휴무일은 이미 빠져 있지만, 한 번 더 걸러 «휴무인데 수업 표시»가 없게 한다
    const classDays = new Set(classDates.filter((d) => isKstYmd(d) && inMonth(d) && !closedDays.has(d)));

    // 3) 출결 — 같은 날 여러 건이면 결석 > 지각 > 출석
    const rank: Record<AttendanceKey, number> = { ABSENT: 3, LATE: 2, PRESENT: 1 };
    const attendanceByDay = new Map<string, AttendanceKey>();
    const summary = { classCount: classDays.size, present: 0, late: 0, absent: 0 };
    for (const record of attendance) {
        const ymd = toKstYmd(record.date);
        if (!isKstYmd(ymd) || !inMonth(ymd)) continue;
        const key = attendanceKeyOf(record.status);
        if (key === "PRESENT") summary.present++;
        else if (key === "ABSENT") summary.absent++;
        else summary.late++;
        const prev = attendanceByDay.get(ymd);
        if (!prev || rank[key] > rank[prev]) attendanceByDay.set(ymd, key);
    }

    // 4) 달력 칸 — 일요일 시작, 앞뒤 빈칸은 null
    const cells: (MonthCell | null)[] = Array.from({ length: kstDow(first) }, () => null);
    for (let ymd = first; ymd && ymd <= last; ymd = addDaysKst(ymd, 1)) {
        cells.push({
            ymd,
            day: Number(ymd.slice(8, 10)),
            isToday: ymd === todayYmd,
            isClass: classDays.has(ymd),
            closed: closedDays.has(ymd),
            attendance: attendanceByDay.get(ymd) ?? null,
            hasEvent: eventDays.has(ymd),
        });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: (MonthCell | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    return { month, weeks, summary, events: rows };
}

/**
 * 한 반의 «이 달 달력에 보일» 수업일.
 * 연간일정의 «수강월»은 달력 달과 어긋날 수 있다(예: 11월 5번째 월요일이 12월 수강월 1주차).
 * 그래서 앞·이번·다음 수강월을 모두 계산해 이 달력 달에 드는 날짜만 모은다.
 * monthlyDates = getMonthlyClassDates(events, "YYYY-MM", dayOfWeek) — 공개 연간일정·청구와 같은 함수를 넣는다.
 */
export function classDatesForCalendarMonth(
    month: string,
    dayOfWeek: string,
    startsOn: string | null | undefined,
    monthlyDates: (yearMonth: string, dayOfWeek: string) => string[],
): string[] {
    const out = new Set<string>();
    for (const delta of [-1, 0, 1]) {
        for (const d of monthlyDates(shiftMonth(month, delta), dayOfWeek)) {
            if (d.slice(0, 7) !== month) continue;
            if (startsOn && isKstYmd(startsOn) && d < startsOn) continue; // 개시일 전 수업은 표시하지 않는다
            out.add(d);
        }
    }
    return Array.from(out).sort(); // Array.from — 테스트의 옛 변환(ES5)에서도 Set 이 비지 않게
}

/** "YYYY-MM-DD" 에서 N개월 전 날짜(그 달에 없는 날은 말일로) */
export function monthsBeforeYmd(ymd: string, months: number): string {
    const [y, mo, d] = ymd.split("-").map(Number);
    const target = shiftMonth(`${y}-${String(mo).padStart(2, "0")}`, -months);
    const day = Math.min(d, daysInMonth(target));
    return `${target}-${String(day).padStart(2, "0")}`;
}

/**
 * 소식 탭 공지 — 게시일(KST)이 3개월 이내인 것만.
 * 단, 고정(중요) 공지는 오래돼도 남기고 맨 앞에 둔다(학원이 일부러 고정한 안내라서).
 * 같은 묶음 안의 순서는 들어온 그대로.
 */
export function recentNotices<T extends { createdAt: Date | string; isPinned?: boolean | null }>(list: T[], todayYmd: string, months = 3): T[] {
    const cutoff = monthsBeforeYmd(todayYmd, months);
    const kept = list.filter((n) => {
        if (n.isPinned) return true; // 고정 공지는 기간과 무관
        const ymd = toKstYmd(n.createdAt);
        return isKstYmd(ymd) && ymd >= cutoff;
    });
    return [...kept.filter((n) => n.isPinned), ...kept.filter((n) => !n.isPinned)];
}
