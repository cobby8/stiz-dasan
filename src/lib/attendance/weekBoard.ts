/**
 * 출결 «주간 보드» 순수 규칙 (2026-11-14 원장 «10월 1주차, 10월 2주차처럼 주 단위로 보고 싶다»).
 *
 * - 주 = 월요일 ~ 일요일.
 * - «N월 M주차» = 그 주의 **목요일이 속한 달**의 M번째 목요일(ISO 주와 같은 원리 — 주가 두 달에 걸치면
 *   날이 더 많은 쪽 달로 친다). 예) 2026-09-28(월)~10-04(일) 주는 목요일이 10/01 → «10월 1주차».
 * - 날짜 계산은 전부 공용 KST 모듈만 쓴다(서버 getDay 금지 규칙).
 * - DB·next 의존이 없는 순수 모듈이라 테스트에서 그대로 실행한다(tests/attendance-week-board.test.mjs).
 */
import { addDaysKst, isKstYmd, kstDow, kstLabel } from "@/lib/datetime/kst";

/** 이 날짜가 든 주의 월요일. 잘못된 입력은 "". */
export function mondayOf(ymd: string): string {
    if (!isKstYmd(ymd)) return "";
    // 0=일 … 6=토 → 월요일까지 거슬러 갈 날 수(월=0, 일=6)
    const back = (kstDow(ymd) + 6) % 7;
    return addDaysKst(ymd, -back);
}

// 볼 수 있는 기간(날짜별 화면의 날짜 입력 min/max 와 같다)
export const WEEK_MIN_YMD = "2020-01-01";
export const WEEK_MAX_YMD = "2030-12-31";

/** 주소창·API 로 받은 시작일을 월요일로 보정. 형식이 틀리거나 기간(2020~2030) 밖이면 오늘이 든 주. */
export function normalizeWeekStart(input: unknown, todayYmd: string): string {
    const raw = typeof input === "string" ? input.trim() : "";
    const ok = isKstYmd(raw) && raw >= WEEK_MIN_YMD && raw <= WEEK_MAX_YMD;
    return ok ? mondayOf(raw) : mondayOf(todayYmd);
}

/** 이 주(월~일)가 볼 수 있는 기간과 하루라도 겹치는가 — 이전/다음 주 버튼을 막는 데 쓴다. */
export function isWeekInRange(monday: string): boolean {
    const start = mondayOf(monday);
    if (!start) return false;
    return addDaysKst(start, 6) >= WEEK_MIN_YMD && start <= WEEK_MAX_YMD;
}

/** 월요일부터 7일("YYYY-MM-DD" 배열). */
export function weekDays(monday: string): string[] {
    const start = mondayOf(monday);
    if (!start) return [];
    return Array.from({ length: 7 }, (_, i) => addDaysKst(start, i));
}

/** 주를 앞뒤로 옮긴다(delta 주). */
export function shiftWeek(monday: string, delta: number): string {
    const start = mondayOf(monday);
    if (!start || !Number.isInteger(delta)) return start;
    return addDaysKst(start, delta * 7);
}

/** 이 주가 «몇 월 몇 주차»인지 — 목요일 기준. */
export function weekOfMonth(monday: string): { year: number; month: number; week: number } | null {
    const start = mondayOf(monday);
    if (!start) return null;
    const thursday = addDaysKst(start, 3);
    const [year, month, day] = thursday.split("-").map(Number);
    // 그 달의 몇 번째 목요일인가 = 1~7일이면 1번째, 8~14일이면 2번째 …
    return { year, month, week: Math.ceil(day / 7) };
}

/** "11월 2주차" */
export function weekTitle(monday: string): string {
    const w = weekOfMonth(monday);
    return w ? `${w.month}월 ${w.week}주차` : "";
}

/** "11/9~11/15" (요일 없이 짧게) */
export function weekRangeLabel(monday: string): string {
    const days = weekDays(monday);
    if (days.length !== 7) return "";
    const short = (ymd: string) => {
        const [, m, d] = ymd.split("-").map(Number);
        return `${m}/${d}`;
    };
    return `${short(days[0])}~${short(days[6])}`;
}

const DAY_SHORT = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * 카드 머리줄의 짧은 반 이름 — 원생 «반별» 보기와 같은 «월4» 모양.
 * 정규반 이름에 «N교시»가 있으면 «요일+N», 없으면(특강 등) 원래 이름 그대로.
 */
export function shortLessonName(name: string, ymd: string): string {
    const period = /(\d+)\s*교시/.exec(name ?? "");
    const dow = kstDow(ymd);
    if (period && Number.isInteger(dow)) return `${DAY_SHORT[dow]}${period[1]}`;
    return name ?? "";
}

/** 보드에 찍는 한 학생의 상태. */
export type BoardStatus = "PRESENT" | "ABSENT" | "LATE" | "UNMARKED" | "PLANNED" | "REPORTED";

/**
 * 저장된 출결 → 보드 상태.
 * 기록이 있으면 그 값. 없으면 오늘 이후 수업은 «예정»(미리 결석 신고가 있으면 «결석 신고»),
 * 오늘·지난 수업은 «미확인».
 */
export function boardStatusOf(
    status: string | null | undefined,
    lessonYmd: string,
    todayYmd: string,
    hasAbsenceReport = false,
): BoardStatus {
    if (status === "PRESENT" || status === "ABSENT" || status === "LATE") return status;
    if (lessonYmd > todayYmd) return hasAbsenceReport ? "REPORTED" : "PLANNED";
    return "UNMARKED";
}

/**
 * «질병·부상» 표시 — 입력 패널과 같은 기준: 결석 + 정규반(특강 회차 아님) + 신고 사유가 질병·부상.
 */
export function showsIllness(student: { status: string | null | undefined; absenceReport?: { reason: string } | null }, sessionDateId: string | null | undefined): boolean {
    return student.status === "ABSENT" && !sessionDateId && student.absenceReport?.reason === "ILLNESS_INJURY";
}

/** 카드 오른쪽 집계(출석·결석·지각·미확인·예정 건수). */
export function countBoardStatuses(
    students: ReadonlyArray<{ status: string | null | undefined; absenceReport?: unknown }>,
    lessonYmd: string,
    todayYmd: string,
): Record<BoardStatus, number> {
    const counts: Record<BoardStatus, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, UNMARKED: 0, PLANNED: 0, REPORTED: 0 };
    for (const s of students) counts[boardStatusOf(s.status, lessonYmd, todayYmd, !!s.absenceReport)] += 1;
    return counts;
}

/** 카드 순서: 날짜(월→일) → 시작 시간 → 반 이름. */
export function compareWeekLessons(
    a: { date: string; lesson: { startTime: string; name: string } },
    b: { date: string; lesson: { startTime: string; name: string } },
): number {
    return a.date.localeCompare(b.date)
        || a.lesson.startTime.localeCompare(b.lesson.startTime)
        || a.lesson.name.localeCompare(b.lesson.name, "ko");
}

/** 카드 머리줄의 날짜 «11/10(화)» — kstLabel 을 그대로 쓴다(화면·테스트가 같은 함수). */
export function lessonDayLabel(ymd: string): string {
    return kstLabel(ymd);
}

/**
 * 동시에 limit 개까지만 돌리는 map. DB 연결(PgBouncer)을 한꺼번에 몰지 않으려고 쓴다.
 * 결과 순서는 입력 순서와 같다.
 */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: width }, worker));
    return results;
}
