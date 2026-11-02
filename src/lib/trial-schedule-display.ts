import { resolveTrialScheduleStartTime, seoulDateInputValue, seoulTimeInputValue } from "./trial-schedule-time";

/** 수업 키의 UUID나 학년 숫자를 교시로 읽지 않도록 표시와 저장에 같은 규칙을 쓴다. */
const DAYS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
const DAY_CODES = Object.fromEntries(Object.entries(DAYS).flatMap(([code, label]) => [[label, code], [`${label}요일`, code], [code, code]]));

export type TrialDisplayClass = {
    name: string; slotKey: string | null; dayOfWeek: string; startTime: string; endTime: string;
    program?: { name: string } | null;
    startTimeOverride?: string | null; endTimeOverride?: string | null;
    scheduleStartTime?: string | null; scheduleEndTime?: string | null;
    scheduleActiveFrom?: string | Date | null; scheduleActiveTo?: string | Date | null;
    customStartTime?: string | null; customEndTime?: string | null;
};

export function trialClassPeriod(classInfo: Pick<TrialDisplayClass, "name" | "slotKey">) {
    const namedPeriod = classInfo.name.match(/(\d+)\s*교시/u)?.[1];
    if (namedPeriod) return namedPeriod;
    return classInfo.slotKey?.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)-(\d+)$/)?.[1] ?? "";
}

export function trialClassShortLabel(classInfo: TrialDisplayClass) {
    const day = DAYS[classInfo.dayOfWeek] || classInfo.dayOfWeek;
    // 추가반은 교시가 없을 수 있다. 식별번호 대신 확인 가능한 시작 시각을 쓴다.
    return `${day}${trialClassPeriod(classInfo) || classInfo.startTime}`;
}

export function trialClassTimeRange(classInfo: TrialDisplayClass, selectedDate = "") {
    const start = resolveTrialScheduleStartTime(classInfo, selectedDate);
    const active = selectedDate
        && (!classInfo.scheduleActiveFrom || selectedDate >= seoulDateInputValue(classInfo.scheduleActiveFrom))
        && (!classInfo.scheduleActiveTo || selectedDate <= seoulDateInputValue(classInfo.scheduleActiveTo));
    const end = classInfo.endTimeOverride || (active && classInfo.scheduleEndTime)
        || classInfo.customEndTime || classInfo.endTime;
    return [start, end].filter(Boolean).join("~");
}

export function trialConfirmedClassShortLabel(classInfo: TrialDisplayClass, scheduledDate: string | null, alwaysShowTime = false) {
    const actualTime = seoulTimeInputValue(scheduledDate);
    const classTime = resolveTrialScheduleStartTime(classInfo, seoulDateInputValue(scheduledDate));
    const period = trialClassPeriod(classInfo);
    const day = DAYS[classInfo.dayOfWeek] || classInfo.dayOfWeek;
    // 교시가 없는 추가반은 저장된 실제 확정시각을 바로 표시한다.
    if (!period) return `${day}${actualTime || classTime}`;
    const label = `${day}${period}`;
    return actualTime && (alwaysShowTime || actualTime !== classTime) ? `${label} · ${actualTime}` : label;
}

export function normalizedTrialPreferencePatch(data: Record<string, unknown>, previous: Record<string, unknown>) {
    const day = data.preferredDay !== undefined ? data.preferredDay : previous.preferredDay;
    const period = data.preferredPeriod !== undefined ? data.preferredPeriod : previous.preferredPeriod;
    const clean = (value: unknown) => typeof value === "string" ? value.trim() || null : null;
    if (data.preferredDay === undefined && data.preferredPeriod === undefined) return {};
    const dayCode = DAY_CODES[clean(day) ?? ""];
    const periodNumber = clean(period)?.match(/^(\d+)(?:\s*교시)?$/)?.[1];
    const derivedKey = dayCode && periodNumber ? `${dayCode}-${periodNumber}` : null;
    const previousKey = clean(previous.preferredSlotKey);
    const unchanged = clean(day) === clean(previous.preferredDay) && clean(period) === clean(previous.preferredPeriod);
    // UUID 추가반과 희망값이 없는 옛 신청은 그대로 둔다. 서로 다른 정규 키만 바로잡는다.
    if (unchanged && (!derivedKey || !previousKey || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)-\d+$/.test(previousKey)
        || previousKey === derivedKey)) return {};
    if (clean(day) || clean(period)) {
        if (!dayCode || !periodNumber) throw new Error("희망 요일과 교시를 함께 확인해 주세요.");
    }
    return { preferredDay: dayCode ? DAYS[dayCode] : null, preferredPeriod: periodNumber ?? null,
        preferredSlotKey: derivedKey };
}
