import { trialClassPeriod } from "./trial-schedule-display";
import { resolveTrialScheduleStartTime } from "./trial-schedule-time";

const DAY_LABELS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
type DisplayClass = { dayOfWeek: string; startTime: string; endTime: string; name: string };

type PreferredDisplayClass = DisplayClass & {
    slotKey: string | null;
    startTimeOverride?: string | null;
    customStartTime?: string | null;
};

/** 실제 반 이름의 교시를 우선한다. 추가반 식별번호의 숫자는 교시가 아니다. */
export function formatPreferredSlotsShort(slotKeys: string | null, classesBySlotKey: ReadonlyMap<string, PreferredDisplayClass>) {
    const keys = [...new Set((slotKeys ?? "").split(",").map((key) => key.trim()).filter(Boolean))];
    if (keys.length === 0) return null;
    const labels = keys.map((key) => {
        const classInfo = classesBySlotKey.get(key);
        const day = classInfo && DAY_LABELS[classInfo.dayOfWeek];
        if (!classInfo || !day) return "확인 필요";
        const period = trialClassPeriod(classInfo);
        if (period) return `${day}${period}`;
        const time = resolveTrialScheduleStartTime(classInfo, "");
        return time ? `${day} ${time}` : "확인 필요";
    });
    return [...new Set(labels)].join(" / ");
}

/** 선택한 신청 월을 모두 보여준다. 시작일을 추정하거나 추가 월을 숨기지 않는다. */
export function formatEnrollmentMonthsShort(value: string | null) {
    const values = [...new Set((value ?? "").split(",").map((month) => month.trim()).filter(Boolean))];
    if (values.length === 0) return "-";
    const byYear = new Map<string, Set<number>>();
    const other: string[] = [];
    values.forEach((label) => {
        const match = label.match(/^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월$/u)
            ?? label.match(/^(\d{4})-(\d{1,2})$/u);
        const month = Number(match?.[2]);
        if (!match || month < 1 || month > 12) {
            other.push(label);
            return;
        }
        const year = match[1] ?? "";
        const months = byYear.get(year) ?? new Set<number>();
        months.add(month);
        byYear.set(year, months);
    });
    const labels = [...byYear.entries()]
        .sort(([a], [b]) => (a || "9999").localeCompare(b || "9999"))
        .map(([year, months]) => `${year ? `${year}년 ` : ""}${[...months].sort((a, b) => a - b).join("·")}월`);
    return [...labels, ...other].join(" / ");
}

/** 날짜가 없는 옛 신청을 월의 첫날로 바꾸지 않는다. */
export function formatEnrollmentStartOn(value: string | null | undefined) {
    const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : "개시일 확인 필요";
}
