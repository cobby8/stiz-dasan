/**
 * 학부모 «체험 신청 확인·변경·취소» — 순수 규칙(외부 import 없음: 테스트가 그대로 실행한다).
 *
 * 조회 열쇠는 신청 때 적은 «아이 이름 + 학부모 휴대폰». 번호는 숫자만 비교한다.
 * 진행 중(접수·연락·체험 확정) 신청만 보이고, 체험이 끝났거나 등록으로 넘어간 신청은 바꿀 수 없다.
 * 체험비를 이미 낸 신청은 취소할 때 환불 계좌(은행·계좌번호·예금주)를 받는다(관리자 화면에서만 보인다).
 * 입금 대기 계좌가 열려 있거나 이중 결제(환불 확인 필요)인 신청은 취소를 학원 문의로 보낸다.
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
    | "REFUND_REVIEW" // 이중 결제 등 학원이 먼저 확인해야 하는 결제 상태 → 취소는 학원 문의
    | "DEPOSIT_WAITING"; // 무통장입금 계좌가 열려 있음 → 취소는 학원 문의

export const TRIAL_SELF_SERVICE_BLOCK_MESSAGE: Record<TrialSelfServiceBlock, string> = {
    CLOSED: "이미 마감된 신청이라 온라인으로 바꿀 수 없어요. 학원으로 문의해 주세요.",
    PROGRESSED: "체험 이후 단계(수강신청·등록)로 넘어간 신청이라 온라인으로 바꿀 수 없어요. 학원으로 문의해 주세요.",
    TRIAL_PASSED: "확정된 체험 시간이 지나 온라인으로 바꿀 수 없어요. 학원으로 문의해 주세요.",
    REFUND_REVIEW: "결제 확인이 필요한 신청이라 온라인 취소가 어려워요. 학원으로 연락해 주세요.",
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

/** 취소를 막는 사유(없으면 null) — 변경 사유 + 결제 상태(결제 완료는 막지 않고 환불 계좌를 받는다) */
export function trialSelfServiceCancelBlock(lead: TrialSelfServiceLead, nowMs = Date.now()): TrialSelfServiceBlock | null {
    const changeBlock = trialSelfServiceChangeBlock(lead, nowMs);
    if (changeBlock) return changeBlock;
    const fee = String(lead.trialFeePaymentStatus ?? "");
    if (fee === "NEEDS_REFUND") return "REFUND_REVIEW";
    if (fee === "WAITING_FOR_DEPOSIT") return "DEPOSIT_WAITING";
    return null;
}

/** 취소할 때 환불 계좌가 필요한가 — 학원이 입금 확인했거나 온라인 결제가 끝난 신청 */
export function trialSelfServiceNeedsRefund(lead: TrialSelfServiceLead): boolean {
    return Boolean(lead.trialFeeConfirmed) || lead.trialFeePaymentStatus === "PAID";
}

/** 환불 받을 은행(체육관 대관 보증금 환불과 같은 목록 — 화면 선택지 = 서버 허용 목록) */
export const TRIAL_REFUND_BANKS = [
    "KB국민은행", "신한은행", "우리은행", "하나은행", "NH농협은행", "지역농축협", "IBK기업은행",
    "카카오뱅크", "토스뱅크", "케이뱅크", "SC제일은행", "한국씨티은행", "새마을금고", "신협", "우체국",
    "수협은행", "KDB산업은행", "iM뱅크(대구)", "부산은행", "경남은행", "광주은행", "전북은행", "제주은행",
] as const;

export type TrialRefundAccountCheck =
    | { ok: true; refundBank: string; refundAccount: string; refundHolder: string }
    | { ok: false; message: string };

/** 환불 계좌 3칸 검사 — 화면과 서버가 같은 함수를 쓴다. 계좌번호는 숫자만 10~16자리 */
export function checkTrialRefundAccount(input: { refundBank?: unknown; refundAccount?: unknown; refundHolder?: unknown }): TrialRefundAccountCheck {
    const refundBank = String(input.refundBank ?? "");
    if (!(TRIAL_REFUND_BANKS as readonly string[]).includes(refundBank)) return { ok: false, message: "환불 받을 은행을 골라 주세요." };
    const refundAccount = String(input.refundAccount ?? "").replace(/\D/g, "");
    if (!/^\d{10,16}$/.test(refundAccount)) return { ok: false, message: "환불 계좌번호를 숫자 10~16자리로 입력해 주세요." };
    const refundHolder = String(input.refundHolder ?? "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (!refundHolder) return { ok: false, message: "환불 계좌 예금주를 입력해 주세요." };
    return { ok: true, refundBank, refundAccount, refundHolder };
}

/** 계좌번호 가리기 — 끝 4자리만 «****1234» */
export function maskRefundAccount(account: string | null | undefined): string {
    const digits = String(account ?? "").replace(/\D/g, "");
    return digits.length >= 4 ? `****${digits.slice(-4)}` : "****";
}

export function formatWon(amount: number): string {
    return `${String(Math.trunc(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
}

/** 원장 환불 알림 문자 규칙(MessageAutomationRule.trigger) — /admin/sms 에서 끄고 켠다 */
export const TRIAL_REFUND_ADMIN_TRIGGER = "TRIAL_REFUND_REQUEST_ADMIN";

/** 환불 알림 받는 사람: 원장 김수빈(ADMIN) 계정. TRIAL_REFUND_NOTIFY_USER_IDS(쉼표 구분)로 바꿀 수 있다. */
export const DEFAULT_TRIAL_REFUND_NOTIFY_USER_IDS = ["6e66c3a4-9046-4a60-a56c-fc48d43e775d"];

export function resolveTrialRefundNotifyUserIds(envValue: string | null | undefined): string[] {
    const ids = String(envValue ?? "").split(",").map((v) => v.trim()).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    return ids.length > 0 ? ids : DEFAULT_TRIAL_REFUND_NOTIFY_USER_IDS;
}

/** 원장 환불 알림 문자 —아이 이름·체험 일정·금액·관리자 화면 링크만(계좌번호는 넣지 않는다) */
export function trialRefundAdminSmsBody(input: { childName: string; scheduleText: string; amount: number; adminUrl: string }): string {
    return [
        "[STIZ] 체험 취소 환불 요청",
        `${input.childName} · ${input.scheduleText}`,
        `환불 ${formatWon(input.amount)} (계좌는 관리자 화면에서 확인)`,
        input.adminUrl,
    ].join("\n");
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

export function trialSelfCancelNote(reason: string | null | undefined, refund?: { bank: string; account: string; amount: number } | null): string {
    const trimmed = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const base = trimmed ? `학부모 온라인 취소: ${trimmed}` : "학부모 온라인 취소";
    // 이력에는 계좌번호를 가려서만 남긴다(전체 번호는 환불 요청 표에만)
    return refund ? `${base} · 환불 계좌 접수(${refund.bank} ${maskRefundAccount(refund.account)}, ${formatWon(refund.amount)})` : base;
}
