export interface TrialScheduleTimeCandidate {
    startTime: string;
    scheduleStartTime?: string | null;
    scheduleActiveFrom?: string | Date | null;
    scheduleActiveTo?: string | Date | null;
    startTimeOverride?: string | null;
    customStartTime?: string | null;
}

export interface TrialScheduleResolutionRow {
    overrideStart: string | null; overrideHidden: boolean | null;
    scheduleStart: string | null; scheduleDay: string | null; scheduleHidden: boolean | null;
    scheduleActiveFrom: string | Date | null; scheduleActiveTo: string | Date | null;
    customStart: string | null; customDay: string | null; customHidden: boolean | null;
    classStart: string | null; classDay: string | null; classSlotKey: string | null; className: string | null;
}

const SEOUL_TIME_ZONE = "Asia/Seoul";

function seoulDateParts(value: string | Date) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: SEOUL_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
}

export function seoulDateInputValue(value: string | Date | null) {
    return value ? seoulDateParts(value) ?? "" : "";
}

export function seoulTimeInputValue(value: string | Date | null) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: SEOUL_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("hour")}:${part("minute")}`;
}

function isScheduleActiveOnDate(candidate: TrialScheduleTimeCandidate, selectedDate: string) {
    const activeFrom = candidate.scheduleActiveFrom ? seoulDateParts(candidate.scheduleActiveFrom) : null;
    const activeTo = candidate.scheduleActiveTo ? seoulDateParts(candidate.scheduleActiveTo) : null;
    return (!activeFrom || selectedDate >= activeFrom) && (!activeTo || selectedDate <= activeTo);
}

export function resolveTrialScheduleStartTime(
    candidate: TrialScheduleTimeCandidate | null | undefined,
    selectedDate: string,
) {
    if (!candidate) return "";
    if (candidate.startTimeOverride) return candidate.startTimeOverride;
    if (candidate.scheduleStartTime && selectedDate && isScheduleActiveOnDate(candidate, selectedDate)) {
        return candidate.scheduleStartTime;
    }
    return candidate.customStartTime || candidate.startTime || "";
}

export function toSeoulScheduledDateTime(selectedDate: string, selectedTime: string) {
    const normalizedTime = /^\d{2}:\d{2}$/.test(selectedTime) ? `${selectedTime}:00` : selectedTime;
    const value = `${selectedDate}T${normalizedTime}+09:00`;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : value;
}

const TRIAL_DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TRIAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** DB 조회와 분리된 순수 시간 선택기: 실제 행 조합을 테스트하고 서버에서도 그대로 사용한다. */
export function resolveTrialScheduleFromRow(
    row: TrialScheduleResolutionRow,
    input: { selectedDate: string; slotKey: string; scheduledClassId?: string | null },
) {
    if (!/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(input.selectedDate) || !input.slotKey.trim()) {
        throw new Error("체험 날짜와 희망 수업을 확인해 주세요.");
    }
    const exactDate = new Date(`${input.selectedDate}T12:00:00+09:00`);
    if (seoulDateInputValue(exactDate) !== input.selectedDate) throw new Error("실제 달력 날짜를 확인해 주세요.");
    if (input.scheduledClassId && row.classSlotKey !== input.slotKey) throw new Error("선택한 반과 희망 시간표가 일치하지 않습니다.");
    const expectedDay = TRIAL_DAY_KEYS[exactDate.getUTCDay()];
    const scheduleActive = Boolean(row.scheduleStart) && isScheduleActiveOnDate({
        startTime: row.classStart ?? "", scheduleStartTime: row.scheduleStart,
        scheduleActiveFrom: row.scheduleActiveFrom, scheduleActiveTo: row.scheduleActiveTo,
    }, input.selectedDate);
    const sourceDay = row.overrideStart
        ? row.scheduleDay ?? row.customDay ?? row.classDay
        : scheduleActive
            ? row.scheduleDay
            : row.customStart
                ? row.customDay
                : row.classDay;
    if (!sourceDay || sourceDay !== expectedDay) throw new Error("체험 날짜의 요일과 수업 시간표가 일치하지 않습니다.");
    if (row.overrideHidden || row.scheduleHidden || row.customHidden) throw new Error("현재 숨김 처리된 수업은 안내할 수 없습니다.");
    const startTime = resolveTrialScheduleStartTime({
        startTime: row.classStart ?? "",
        startTimeOverride: row.overrideStart,
        scheduleStartTime: row.scheduleStart,
        scheduleActiveFrom: row.scheduleActiveFrom,
        scheduleActiveTo: row.scheduleActiveTo,
        customStartTime: row.customStart,
    }, input.selectedDate);
    // 비활성 ScheduleSlot은 후보에서 제외하고 다음 우선순위인 custom, Class로 내려간다.
    if (!TRIAL_TIME.test(startTime)) throw new Error("수업 시작시간을 확정할 수 없습니다.");
    const scheduledDate = toSeoulScheduledDateTime(input.selectedDate, startTime);
    if (!scheduledDate) throw new Error("체험 일시를 만들 수 없습니다.");
    return { scheduledDate, startTime, slotKey: input.slotKey, className: row.className ?? "", scheduleLabel: `${sourceDay} ${startTime}` };
}
