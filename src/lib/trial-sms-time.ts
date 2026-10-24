const SEOUL_TIME_ZONE = "Asia/Seoul";

const trialSmsDateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: SEOUL_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});

/**
 * 체험 일정 문자는 서버의 실행 지역과 관계없이 한국 학원 시간으로 표시한다.
 */
export function formatTrialSmsDateTime(value: Date | string | null | undefined): string {
    if (!value) return "";

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const parts = Object.fromEntries(
        trialSmsDateTimeFormatter
            .formatToParts(date)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
    );

    return `${parts.year}년 ${parts.month}월 ${parts.day}일 (${parts.weekday}) ${parts.hour}:${parts.minute}`;
}

/**
 * DB에서 읽은 Date 또는 ISO 문자열에 관리자가 확정한 시각이 포함됐는지 판별한다.
 * 날짜 전용 문자열은 자정 시각으로 오해하지 않도록 명시적으로 제외한다.
 */
export function hasExplicitTrialTime(value: Date | string | null | undefined): boolean {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    return typeof value === "string"
        && /T\d{2}:\d{2}/.test(value)
        && !Number.isNaN(new Date(value).getTime());
}

type LegacyTrialPlaceholderContext = {
    scheduledDate: Date | string | null | undefined;
    trialDate: Date | string | null | undefined;
    status?: string | null;
    scheduledClassId?: string | null;
};

/**
 * 예전 신청서가 희망일을 scheduledDate에 그대로 복사한 흔적만 제한적으로 찾는다.
 * UTC 자정 하나만 보지 않고 원본 희망일과 동일하며 확정 상태/반 근거도 없을 때만 placeholder다.
 */
export function isLegacyTrialDatePlaceholder(context: LegacyTrialPlaceholderContext): boolean {
    if (!context.scheduledDate || !context.trialDate) return false;

    const scheduled = context.scheduledDate instanceof Date
        ? context.scheduledDate
        : new Date(context.scheduledDate);
    const trial = context.trialDate instanceof Date ? context.trialDate : new Date(context.trialDate);
    if (Number.isNaN(scheduled.getTime()) || Number.isNaN(trial.getTime())) return false;

    const sameOriginalInstant = scheduled.getTime() === trial.getTime();
    const isLegacyUtcMidnight = scheduled.getUTCHours() === 0
        && scheduled.getUTCMinutes() === 0
        && scheduled.getUTCSeconds() === 0
        && scheduled.getUTCMilliseconds() === 0;
    // 반 ID가 없는 오래된 행도 SCHEDULED라면 관리자가 시간을 확정한 기록으로 존중한다.
    const hasConfirmationEvidence = context.status === "SCHEDULED";

    return sameOriginalInstant && isLegacyUtcMidnight && !hasConfirmationEvidence;
}

/**
 * 담당자 문자 수업 라벨의 시각도 저장된 확정시각과 맞춘다.
 * 예: canonical이 `Sat 10:50`이어도 확정값이 11:10이면 `Sat 11:10`으로 표시한다.
 */
export function formatTrialScheduleLabel(canonicalLabel: string, confirmedDate: Date | string): string {
    const confirmedText = formatTrialSmsDateTime(confirmedDate);
    const confirmedTime = confirmedText.match(/(\d{2}:\d{2})$/)?.[1];
    if (!confirmedTime) return canonicalLabel;

    const labelWithoutTime = canonicalLabel.replace(/\s+\d{2}:\d{2}$/, "").trim();
    return [labelWithoutTime, confirmedTime].filter(Boolean).join(" ");
}
