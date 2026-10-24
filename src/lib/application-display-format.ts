// 신청 화면에서만 쓰는 전화번호·수업 표시 규칙을 한곳에 둡니다.
export function formatPhoneInput(value: string) {
    const nums = value.replace(/\D/g, "").slice(0, 11);
    if (nums.length > 7) return `${nums.slice(0, 3)}-${nums.slice(3, 7)}-${nums.slice(7)}`;
    if (nums.length > 3) return `${nums.slice(0, 3)}-${nums.slice(3)}`;
    return nums;
}

const DAY_LABELS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
type DisplayClass = { dayOfWeek: string; startTime: string; endTime: string; name: string; program?: { name: string } | null };

export function formatClassLabel(classInfo: DisplayClass) {
    const dayLabel = DAY_LABELS[classInfo.dayOfWeek] || classInfo.dayOfWeek;
    const programName = classInfo.program?.name ? ` · ${classInfo.program.name}` : "";
    return `${dayLabel} ${classInfo.startTime}~${classInfo.endTime} · ${classInfo.name}${programName}`;
}
