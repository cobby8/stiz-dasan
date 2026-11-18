/**
 * 학부모 «체험 신청 확인·변경·취소» — 순수 규칙(외부 import 없음: 테스트가 그대로 실행한다).
 *
 * 조회 열쇠는 신청 때 적은 «아이 이름 + 학부모 휴대폰». 번호는 숫자만 비교한다.
 * 진행 중(접수·연락·체험 확정) 신청만 보이고, 체험이 끝났거나 등록으로 넘어간 신청은 바꿀 수 없다.
 * 체험비를 이미 냈거나 입금 대기 계좌가 열린 신청은 일정 변경만 되고 취소는 학원 문의로 보낸다(환불 때문).
 */

/** 학부모가 볼 수 있는(진행 중) 신청 상태 — 공개 신청서의 «기존 신청 불러오기»와 같은 기준 */
export const TRIAL_SELF_SERVICE_ACTIVE_STATUSES = ["NEW", "CONTACTED", "SCHEDULED"] as const;

export type TrialSelfServiceLead = {
    status: string | null | undefined;
    scheduledDate: string | Date | null | undefined;
    attendedDate?: string | Date | null;
    convertedDate?: string | Date | null;
    convertedStudentId?: string | null;
    enrollApplicationId?: string | null;
    enrollApplicationReceivedAt?: string | Date | null;
    trialFeeConfirmed?: boolean | null;
    trialFeePaymentStatus?: string | null;
};

export type TrialSelfServiceBlock =
    | "CLOSED" // 진행 중 상태가 아님(참석·등록·종료·취소)
    | "PROGRESSED" // 참석 기록·수강신청서·등록이 이미 있음
    | "TRIAL_PASSED" // 확정된 체험 시각이 지났음
    | "PAID" // 체험비 결제·입금 확인 완료 → 취소는 학원 문의(환불)
    | "DEPOSIT_WAITING"; // 무통장입금 계좌가 열려 있음 → 취소는 학원 문의

export const TRIAL_SELF_SERVICE_BLOCK_MESSAGE: Record<TrialSelfServiceBlock, string> = {
    CLOSED: "이미 마감된 신청이라 온라인으로 바꿀 수 없어요. 학원으로 문의해 주세요.",
    PROGRESSED: "체험 이후 단계(수강신청·등록)로 넘어간 신청이라 온라인으로 바꿀 수 없어요. 학원으로 문의해 주세요.",
    TRIAL_PASSED: "확정된 체험 시간이 지나 온라인으로 바꿀 수 없어요. 학원으로 문의해 주세요.",
    PAID: "체험수업비 결제가 끝난 신청은 온라인 취소가 어려워요. 환불 안내를 위해 학원으로 연락해 주세요.",
    DEPOSIT_WAITING: "입금 대기 중인 계좌가 있어 온라인 취소가 어려워요. 학원으로 연락해 주세요.",
};

function timeOf(value: string | Date | null | undefined): number | null {
    if (!value) return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** 일정 변경을 막는 사유(없으면 null) — 서버가 잠근 DB 값으로 다시 판단한다 */
export function trialSelfServiceChangeBlock(lead: TrialSelfServiceLead, nowMs = Date.now()): TrialSelfServiceBlock | null {
    if (!(TRIAL_SELF_SERVICE_ACTIVE_STATUSES as readonly string[]).includes(String(lead.status ?? ""))) return "CLOSED";
    if (lead.attendedDate || lead.convertedDate || lead.convertedStudentId || lead.enrollApplicationId || lead.enrollApplicationReceivedAt) {
        return "PROGRESSED";
    }
    const scheduledMs = timeOf(lead.scheduledDate);
    if (lead.status === "SCHEDULED" && scheduledMs !== null && scheduledMs <= nowMs) return "TRIAL_PASSED";
    return null;
}

/** 취소를 막는 사유(없으면 null) — 변경 사유 + 결제 상태 */
export function trialSelfServiceCancelBlock(lead: TrialSelfServiceLead, nowMs = Date.now()): TrialSelfServiceBlock | null {
    const changeBlock = trialSelfServiceChangeBlock(lead, nowMs);
    if (changeBlock) return changeBlock;
    const fee = String(lead.trialFeePaymentStatus ?? "");
    if (lead.trialFeeConfirmed || fee === "PAID" || fee === "NEEDS_REFUND") return "PAID";
    if (fee === "WAITING_FOR_DEPOSIT") return "DEPOSIT_WAITING";
    return null;
}

/** 조회 입력 정리 — 이름은 앞뒤 공백만, 번호는 숫자만(10~11자리). 맞지 않으면 null */
export function normalizeTrialLookupInput(input: { childName?: unknown; parentPhone?: unknown }): { childName: string; phoneDigits: string } | null {
    const childName = typeof input.childName === "string" ? input.childName.trim() : "";
    const phoneDigits = typeof input.parentPhone === "string" ? input.parentPhone.replace(/\D/g, "") : "";
    if (!childName || childName.length > 40) return null;
    if (phoneDigits.length < 10 || phoneDigits.length > 11) return null;
    return { childName, phoneDigits };
}

/** 학부모 화면용 상태 이름(관리자 내부 용어는 쓰지 않는다) */
export function trialSelfServiceStatusLabel(status: string | null | undefined): string {
    if (status === "SCHEDULED") return "체험 확정";
    if (status === "CONTACTED") return "상담 진행 중";
    if (status === "NEW") return "접수 완료";
    return "마감";
}

export type TrialScheduleSnapshot = { trialDate: string | null; trialDay: string | null; trialPeriod: string | null };

/** «11월 20일(목) 4교시» — 비어 있는 칸은 건너뛴다 */
export function trialScheduleText(value: TrialScheduleSnapshot): string {
    const parts: string[] = [];
    if (value.trialDate && /^\d{4}-\d{2}-\d{2}$/.test(value.trialDate)) {
        const [, month, day] = value.trialDate.split("-");
        parts.push(`${Number(month)}월 ${Number(day)}일${value.trialDay ? `(${value.trialDay})` : ""}`);
    } else if (value.trialDay) {
        parts.push(`${value.trialDay}요일`);
    }
    if (value.trialPeriod) parts.push(`${value.trialPeriod}교시`);
    return parts.join(" ") || "일정 미입력";
}

export function sameTrialSchedule(a: TrialScheduleSnapshot, b: TrialScheduleSnapshot): boolean {
    return (a.trialDate ?? "") === (b.trialDate ?? "")
        && (a.trialDay ?? "") === (b.trialDay ?? "")
        && (a.trialPeriod ?? "") === (b.trialPeriod ?? "");
}

/** 관리자 이력(ApplicationContactLog.note)에 남길 문장 — 연락처 등 개인정보는 넣지 않는다 */
export function trialSelfChangeNote(before: TrialScheduleSnapshot, after: TrialScheduleSnapshot, releasedSchedule: boolean): string {
    const base = `학부모 온라인 일정 변경: ${trialScheduleText(before)} → ${trialScheduleText(after)}`;
    return releasedSchedule ? `${base} (확정했던 체험 일정은 풀림 — 다시 확정 필요)` : base;
}

export function trialSelfCancelNote(reason: string | null | undefined): string {
    const trimmed = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return trimmed ? `학부모 온라인 취소: ${trimmed}` : "학부모 온라인 취소";
}
