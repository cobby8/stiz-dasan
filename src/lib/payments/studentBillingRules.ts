// 학생 상세 «청구/수납» 탭의 청구서 발행·수정 규칙 — 순수 판정 모듈(2026-11-09 원장 지시).
//
// 왜 따로 두나: 서버 액션(createPayment·updateUnpaidPayment)은 DB·인증이 얽혀 실행 테스트가 어렵다.
// «무엇을 막고 무엇을 허용하나»만 여기 모아 두면 tests/student-billing-rules.test.mjs 가 실제로 돌려 본다.
// 화면(StudentBillingModals)과 서버가 같은 판정을 쓴다 — 한쪽만 고치는 사고를 막는다.
//
// ⚠️ prisma·next 를 import 하지 않는다(테스트 로더가 순수 모듈만 조립한다).

import { isKstYmd } from "@/lib/datetime/kst";

// ── 청구 유형 ────────────────────────────────────────────────────────────────
export const BILLING_TYPES = ["MONTHLY", "SHUTTLE", "UNIFORM", "OTHER"] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
    MONTHLY: "수강료",
    SHUTTLE: "셔틀비",
    UNIFORM: "유니폼",
    OTHER: "기타",
};

/** 수강료·셔틀비는 반(수업)을 꼭 골라야 한다 — createPayment 의 기존 규칙과 같다 */
export function billingTypeNeedsClass(type: string): boolean {
    return type === "MONTHLY" || type === "SHUTTLE";
}

// ── 청구 준비(작업대) 차단 조건 ──────────────────────────────────────────────
/**
 * 청구 준비(작업대) 쓰기가 켜져 있나 — 환경변수 STIZ_BILLING_WORKBENCH_WRITES_ENABLED 가 정확히 "true" 일 때만.
 * (api/admin/billing-workbench/route.ts 의 enabled() 와 같은 기준 — 테스트가 두 곳을 비교한다)
 */
export function isBillingWorkbenchWritesEnabled(env: Record<string, string | undefined>): boolean {
    return env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true";
}

/**
 * 수동 청구(createPayment)를 «청구 준비에서 검토해 주세요»로 막아야 하나.
 * 예전엔 «작업대 표가 DB 에 있으면» 막았는데, 작업대 쓰기가 꺼져 있으면 수강료를 아무 데서도 발행할 수 없었다
 * (신규생 수강료 발행 불가 — 2026-11-09). 이제 «작업대 쓰기가 켜져 있을 때만» 막는다.
 */
export function manualChargeBlockedByWorkbench(type: string, workbenchWritesEnabled: boolean): boolean {
    return billingTypeNeedsClass(type) && workbenchWritesEnabled;
}

// ── 청구 월 결정 ─────────────────────────────────────────────────────────────
const YM_PATTERN = /^(\d{4})-(\d{2})$/;
const YMD_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

export type BillingPeriod = { year: number; month: number };

/**
 * 청구의 연·월을 정한다.
 * 1) 화면이 보낸 청구 월("YYYY-MM")이 있으면 그것.
 * 2) 없으면(수납 관리 화면 등 기존 호출부) 납부기한 문자열 "YYYY-MM-DD" 의 앞부분.
 * 예전엔 new Date(dueDate).getMonth() 를 써서, 서버(UTC)·입력 형식에 따라 1일 00:00 이 전달로 밀릴 수 있었다.
 * Date 객체를 거치지 않고 문자열만 본다.
 */
export function resolveBillingPeriod(input: { billingMonth?: string | null; dueDate: string }): BillingPeriod {
    const billingMonth = input.billingMonth?.trim();
    if (billingMonth) {
        const matched = YM_PATTERN.exec(billingMonth);
        const year = matched ? Number(matched[1]) : NaN;
        const month = matched ? Number(matched[2]) : NaN;
        if (!matched || year < 2000 || year > 2999 || month < 1 || month > 12) {
            throw new Error("청구 월이 올바르지 않습니다.");
        }
        return { year, month };
    }
    const matched = YMD_PREFIX.exec(input.dueDate?.trim() ?? "");
    if (!matched || !isKstYmd(`${matched[1]}-${matched[2]}-${matched[3]}`)) {
        throw new Error("납부 기한이 올바르지 않습니다.");
    }
    return { year: Number(matched[1]), month: Number(matched[2]) };
}

/** "YYYY-MM-DD" 로만 받는다(실제로 있는 날짜인지까지 확인) */
export function normalizeDueYmd(value: string | null | undefined): string {
    const text = (value ?? "").trim();
    if (!isKstYmd(text)) throw new Error("납부 기한이 올바르지 않습니다.");
    return text;
}

/** 청구 월 "YYYY-MM" → 그 달 수강료 화면 기본 설명(예: «11월 수강료») */
export function defaultBillingDescription(type: string, billingMonth: string): string {
    const matched = YM_PATTERN.exec(billingMonth);
    const label = BILLING_TYPE_LABELS[type as BillingType] ?? "청구";
    return matched ? `${Number(matched[2])}월 ${label}` : label;
}

// ── 중복 청구 판정 ───────────────────────────────────────────────────────────
/** «살아 있는» 청구 = 취소·환불이 아닌 것(미납·연체·납부완료) */
export const ALIVE_PAYMENT_STATUSES = ["PENDING", "OVERDUE", "PAID"] as const;

export type ChargeKey = {
    studentId: string;
    classId: string | null;
    year: number;
    month: number;
    type: string;
};

export type ExistingCharge = ChargeKey & { id: string; status: string; amount: number; description?: string | null };

/** 같은 학생·반·청구 월·유형에 살아 있는 청구인가(반 없음끼리도 같은 반으로 본다) */
export function isDuplicateCharge(existing: ExistingCharge, target: ChargeKey): boolean {
    return existing.studentId === target.studentId
        && (existing.classId ?? null) === (target.classId ?? null)
        && Number(existing.year) === target.year
        && Number(existing.month) === target.month
        && existing.type === target.type
        && (ALIVE_PAYMENT_STATUSES as readonly string[]).includes(existing.status);
}

export function findDuplicateCharges(existing: ExistingCharge[], target: ChargeKey): ExistingCharge[] {
    return existing.filter((row) => isDuplicateCharge(row, target));
}

// ── 미납 청구 수정 가능 여부 ─────────────────────────────────────────────────
/** 수정 가능한 청구 상태(미납·연체) — cancelUnpaidPayment 와 같은 집합 */
export const EDITABLE_PAYMENT_STATUSES = ["PENDING", "OVERDUE"] as const;
/** 수정 가능한 청구서 상태 — cancelUnpaidPayment 와 같은 집합 */
export const EDITABLE_INVOICE_STATUSES = ["ISSUED", "SENT", "OVERDUE"] as const;

/**
 * POS 요청이 이 청구를 «묶고» 있나 — 수납 목록(getPaymentPosInfo)·영구 삭제(deletePayment)와 같은 기준.
 * 열림(PENDING·SENT)·납부(PAID)·보류(HELD) 이거나, 결제 취소가 진행 중(cancelState 있음)이면 묶임.
 */
export const POS_LOCKING_REQUEST_STATUSES = ["PENDING", "SENT", "PAID", "HELD"] as const;

export function isPosRequestLocking(status: string, cancelState: string | null | undefined): boolean {
    return (POS_LOCKING_REQUEST_STATUSES as readonly string[]).includes(status) || cancelState != null;
}

/**
 * 학부모 온라인 결제가 «진행 중»인 거래 상태 — 결제창을 열었거나(READY·IN_PROGRESS) 가상계좌 입금을 기다리는 중.
 * 이때 금액을 바꾸면 토스 승인 금액과 청구 금액이 어긋난다.
 */
export const PARENT_CHECKOUT_ACTIVE_TX_STATUSES = ["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT"] as const;

export type EditabilityInput = {
    status: string;
    invoiceStatus?: string | null;
    /** POS 요청(열림·납부·보류·취소 진행)에 묶였나 */
    posLocked?: boolean;
    /** 학부모 결제(단건·묶음) 거래가 진행 중인가 */
    parentCheckoutActive?: boolean;
};

/** 수정할 수 없으면 그 이유(한국어), 수정할 수 있으면 null */
export function unpaidEditBlockReason(input: EditabilityInput): string | null {
    if (!(EDITABLE_PAYMENT_STATUSES as readonly string[]).includes(input.status)) {
        return "미납·연체 청구만 수정할 수 있어요.";
    }
    if (input.posLocked) return "현장 결제(POS) 요청에 묶인 청구는 수정할 수 없어요.";
    if (input.parentCheckoutActive) return "학부모 결제가 진행 중인 청구는 수정할 수 없어요.";
    // 청구서가 아직 없는 옛 청구(invoiceStatus 없음)는 서버가 거절한다 — 화면에서도 같은 이유로 막는다
    if (!input.invoiceStatus || !(EDITABLE_INVOICE_STATUSES as readonly string[]).includes(input.invoiceStatus)) {
        return "현재 청구서 상태에서는 수정할 수 없어요.";
    }
    return null;
}

export type UnpaidEditInput = { amount: number; description?: string | null; dueDate: string };
export type UnpaidEditPatch = { amount: number; description: string | null; dueDate: string };

/** 수정 입력을 검사·정리한다(서버가 다시 부른다 — 화면 검사를 믿지 않는다) */
/** 청구 설명 최대 길이 — 발행(createPayment)·수정(updateUnpaidPayment)이 같은 규칙 */
export const BILLING_DESCRIPTION_MAX = 200;

/** 설명을 정리한다(앞뒤 공백 제거, 비면 null, 200자 넘으면 거절) */
export function normalizeBillingDescription(value: string | null | undefined): string | null {
    const description = (value ?? "").trim();
    if (description.length > BILLING_DESCRIPTION_MAX) throw new Error(`설명은 ${BILLING_DESCRIPTION_MAX}자 이내로 적어 주세요.`);
    return description || null;
}

export function validateUnpaidEdit(input: UnpaidEditInput): UnpaidEditPatch {
    const amount = Number(input.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("청구 금액은 1원 이상의 정수여야 합니다.");
    return { amount, description: normalizeBillingDescription(input.description), dueDate: normalizeDueYmd(input.dueDate) };
}

/** 완료(DONE) 결제 거래가 있으면 수정·취소하지 않는다(환불 절차로) — cancelUnpaidPayment 와 같은 문구 */
export const DONE_TRANSACTION_BLOCK_MESSAGE = "완료된 결제 거래가 있어 수정할 수 없습니다. 환불 절차를 사용해 주세요.";

/** 재무 소유자(원장) 역할인가 — 서버 requireFinanceOwner 와 화면 메뉴 표시가 같은 기준 */
export function isFinanceOwnerRole(role: string | null | undefined): boolean {
    return role === "ADMIN";
}

/**
 * 발행 창 기본 납부기한 = max(그 달 청구 기한, 오늘). 전월 말일(약관 기한)이 이미 지났으면 오늘로 —
 * 지난 날짜가 기본으로 들어가 발행하자마자 연체가 되는 일을 막는다(신규생 월중 개시).
 */
export function defaultIssueDueDate(monthlyDueYmd: string, todayYmd: string): string {
    if (!isKstYmd(monthlyDueYmd)) return todayYmd;
    return monthlyDueYmd < todayYmd ? todayYmd : monthlyDueYmd;
}

/**
 * 기한을 바꾼 뒤의 청구 상태 — 연체였는데 기한을 오늘 이후로 늘리면 미납으로 되돌린다.
 * (미납 → 연체 전환은 매일 도는 markOverduePayments 가 맡는다. 여기서 앞당겨 바꾸지 않는다)
 */
export function statusAfterDueDateEdit(currentStatus: string, nextDueYmd: string, todayYmd: string): string {
    if (currentStatus === "OVERDUE" && nextDueYmd >= todayYmd) return "PENDING";
    return currentStatus;
}

/** 기한이 이미 지났나(화면 안내용 — «발행하면 바로 연체로 보일 수 있어요») */
export function isDueDatePast(dueYmd: string, todayYmd: string): boolean {
    return isKstYmd(dueYmd) && dueYmd < todayYmd;
}
