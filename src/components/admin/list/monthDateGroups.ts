import { toKstYmd } from "@/lib/datetime/kst";

/**
 * «지난 기록»이 중심인 목록(출결 이력·수업 리포트)의 달별 묶음.
 * 입력 순서를 그대로 지키며(서버가 최신순으로 주면 최신 달부터) 같은 달끼리 모은다.
 * 날짜는 KST 모듈로 "YYYY-MM-DD" 로 바꾼 뒤 문자열로만 다룬다 —
 * toISOString·toLocaleDateString 은 서버(UTC)에서 한국 자정 기록을 전날로 찍는다.
 * 같은 묶음을 화면마다 따로 만들면 한쪽만 고쳐지는 사고가 나서 한 곳에 둔다.
 */
export function groupByKstMonth<T>(
    items: T[],
    dateOf: (item: T) => Date | string,
): { month: string; label: string; items: { item: T; ymd: string }[] }[] {
    const groups: { month: string; label: string; items: { item: T; ymd: string }[] }[] = [];
    for (const item of items) {
        const ymd = toKstYmd(dateOf(item));
        const month = ymd.slice(0, 7);
        let group = groups.find((g) => g.month === month);
        if (!group) {
            const [year, mon] = month.split("-");
            group = { month, label: year && mon ? `${year}년 ${Number(mon)}월` : "날짜 미정", items: [] };
            groups.push(group);
        }
        group.items.push({ item, ymd });
    }
    return groups;
}
