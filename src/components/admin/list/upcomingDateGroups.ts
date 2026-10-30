import { addDaysKst, kstDow } from "@/lib/datetime/kst";

/**
 * «앞으로 할 일»이 중심인 목록(보강·결석 신고)의 날짜 묶음.
 * 오늘 / 이번 주 / 다음 주 / 이후 / 지난 건 — 가까운 앞날이 먼저 보이고, 지난 건은 맨 아래.
 * 주 시작은 월요일. 달력 계산은 KST 모듈로만 한다(서버 UTC·PC KST 차이로 하루 밀리는 사고 방지).
 * 같은 묶음을 화면마다 따로 만들면 한쪽만 고쳐지는 사고가 나서 한 곳에 둔다.
 */
export type UpcomingDateGroupKey = "today" | "thisWeek" | "nextWeek" | "later" | "past";

export const UPCOMING_DATE_GROUP_ORDER: UpcomingDateGroupKey[] = ["today", "thisWeek", "nextWeek", "later", "past"];

/** ymd·today 는 둘 다 KST 달력 날짜("YYYY-MM-DD"). 날짜가 비어 있으면 «지난 건»으로 본다. */
export function upcomingDateGroupOf(ymd: string, today: string): UpcomingDateGroupKey {
    const weekStart = addDaysKst(today, -((kstDow(today) + 6) % 7));
    const nextWeekStart = addDaysKst(weekStart, 7);
    const afterNextWeekStart = addDaysKst(weekStart, 14);
    if (ymd < today) return "past";
    if (ymd === today) return "today";
    if (ymd < nextWeekStart) return "thisWeek";
    if (ymd < afterNextWeekStart) return "nextWeek";
    return "later";
}

/**
 * 항목을 묶음별로 나눈다. 앞날 묶음은 가까운 날부터, «지난 건»은 최근부터.
 * labels 로 화면마다 이름만 바꾼다(예: past = "지난 보강" / "지난 결석").
 */
export function groupByUpcomingDate<T>(
    items: T[],
    ymdOf: (item: T) => string,
    today: string,
    labels: Record<UpcomingDateGroupKey, string>,
): { key: UpcomingDateGroupKey; label: string; items: T[] }[] {
    const buckets = new Map<UpcomingDateGroupKey, T[]>();
    for (const item of items) {
        const key = upcomingDateGroupOf(ymdOf(item), today);
        const bucket = buckets.get(key) ?? [];
        bucket.push(item);
        buckets.set(key, bucket);
    }
    return UPCOMING_DATE_GROUP_ORDER
        .filter((key) => buckets.has(key))
        .map((key) => {
            const sorted = [...buckets.get(key)!].sort((a, b) => {
                const ay = ymdOf(a);
                const by = ymdOf(b);
                return key === "past" ? by.localeCompare(ay) : ay.localeCompare(by);
            });
            return { key, label: labels[key], items: sorted };
        });
}
