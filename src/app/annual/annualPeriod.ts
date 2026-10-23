export interface AnnualPeriod {
    year: number;
    /** 1월은 0, 12월은 11이다. 기존 수강월 자료와 같은 기준을 쓴다. */
    month: number;
}

export function getKoreanAnnualPeriod(now: Date = new Date()): AnnualPeriod {
    // 휴대폰의 시간대가 달라도 학원에서 사용하는 한국의 현재 월을 보여준다.
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Seoul", year: "numeric", month: "numeric",
    }).formatToParts(now);
    return {
        year: Number(parts.find((part) => part.type === "year")?.value),
        month: Number(parts.find((part) => part.type === "month")?.value) - 1,
    };
}

export function isSameAnnualPeriod(a: AnnualPeriod, b: AnnualPeriod): boolean {
    return a.year === b.year && a.month === b.month;
}
