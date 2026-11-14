// 수납 관리(/admin/finance) 응답을 역할에 맞게 가린다 — 2026-11-14 원장 결정(부원장 금액 가림).
//
// 왜 순수 함수로 따로 두나:
//   - 수납 목록은 unstable_cache(getCachedAdminFinancePayload)로 «역할과 무관하게» 공유된다.
//     캐시 키를 역할별로 쪼개면 같은 데이터를 두 벌 들고 무효화도 두 번 해야 한다.
//     그래서 캐시에서 «꺼낸 뒤» 이 함수로 가린다(화면 page.tsx 와 GET /api/admin/finance 둘 다 같은 함수).
//   - DB·next 의존이 없어야 테스트가 실제로 돌려 볼 수 있다(tests/vice-admin-finance-access.test.mjs).
//
// 규칙(moneyAccess 한 곳):
//   - 원장(ADMIN) = 원본 그대로(같은 객체를 돌려준다 — 화면이 지금과 픽셀 단위로 같다)
//   - 부원장 = 미납(PENDING·OVERDUE) 청구의 금액만 보이고, 납부 완료·취소·환불 금액은 null.
//             월 요약(총 청구·납부 완료·미납 합계·건수)은 전부 null — 수납률도 여기서 계산되므로 같이 사라진다.

import { canSeeAllMoney, canSeePaymentAmount, maskPaymentAmount } from "../auth/moneyAccess";

/** 월 요약 — 부원장에게는 모든 칸이 null */
export type FinanceSummaryView = {
    totalCount: number | null;
    totalAmount: number | null;
    paidAmount: number | null;
    unpaidAmount: number | null;
    paidCount: number | null;
    unpaidCount: number | null;
};

/** 부원장에게 보내는 빈 요약(건수까지 숨긴다 — «이번 달 몇 건 납부»도 규모 정보라서) */
export const HIDDEN_FINANCE_SUMMARY: FinanceSummaryView = {
    totalCount: null,
    totalAmount: null,
    paidAmount: null,
    unpaidAmount: null,
    paidCount: null,
    unpaidCount: null,
};

type PaymentLike = { amount?: number | null; status?: string | null };

/**
 * 금액을 가리는 청구 행에서 같이 비우는 칸(2026-11-14 검수 S1).
 * 영수증·청구서(결제 페이지) 링크·승인번호를 열면 납부 완료 금액이 그대로 보이므로 금액과 함께 뺀다.
 * 화면은 이 값이 없으면 «청구서»·«링크복사»·«영수증 열기»를 그리지 않는다.
 */
export const MASKED_PAYMENT_LINK_KEYS = ["receiptUrl", "invoiceCheckoutUrl", "invoiceId", "providerOrderId"] as const;

/**
 * 수납 관리 응답(payments + summary + 그 밖의 칸)을 역할에 맞게 가린다.
 * 그 밖의 칸(결제 설정 상태 등)은 손대지 않는다.
 */
export function maskFinancePayloadForRole<T extends { payments: PaymentLike[]; summary: object }>(
    payload: T,
    role: string | null | undefined,
): Omit<T, "summary"> & { summary: T["summary"] | FinanceSummaryView } {
    // 원장: 원본 그대로(복사도 하지 않는다)
    if (canSeeAllMoney(role)) return payload;
    return {
        ...payload,
        // 청구 행의 돈 필드는 amount 하나뿐이다(getPayments). 미납 행은 그대로, 나머지는 null
        payments: payload.payments.map((payment) =>
            maskPaymentAmount(payment, role, MASKED_PAYMENT_LINK_KEYS as unknown as (keyof typeof payment)[])) as T["payments"],
        summary: HIDDEN_FINANCE_SUMMARY,
    };
}

// ── 현장 결제(토스 POS) 요청 보기 ─────────────────────────────────────────────
// 부원장도 ⚡현장 결제를 한다(미납 청구만 요청 가능 — 서버 SQL 이 PENDING·OVERDUE 만 받는다).
// 다만 «청구서의 가장 최근 요청» 조회는 이미 납부된 청구의 요청을 돌려줄 수 있다.
// 판단 기준 = 요청 상태가 아니라 «묶인 청구(Payment)의 지금 상태»(2026-11-14 검수 S2):
//   묶인 청구가 하나라도 미납(PENDING·OVERDUE)이 아니면(또는 상태를 모르면) 금액·면세·항목 금액을 모두 null.

type ChargeItemAmount = { amount: number | null };

/** 금액 칸(합계·면세·항목 금액)이 null 일 수 있는 요청 보기 */
export type ChargeViewAmountsMasked<V extends { items: ChargeItemAmount[] }> = Omit<V, "amount" | "taxFreeAmount" | "items"> & {
    amount: number | null;
    taxFreeAmount: number | null;
    items: Array<Omit<V["items"][number], "amount"> & { amount: number | null }>;
};

export function maskChargeRequestViewForRole<
    V extends { status: string; amount: number | null; taxFreeAmount: number | null; items: ChargeItemAmount[] },
>(
    view: V | null,
    role: string | null | undefined,
    /** 묶인 청구들의 지금 상태(DB 에서 읽은 값). 비었으면 «모름» → 가린다 */
    paymentStatuses: readonly (string | null | undefined)[],
): ChargeViewAmountsMasked<V> | null {
    if (!view) return null;
    // 원장이거나, 묶인 청구가 전부 아직 미납이면 그대로
    const allUnpaid = paymentStatuses.length > 0 && paymentStatuses.every((status) => canSeePaymentAmount(role, status));
    if (canSeeAllMoney(role) || allUnpaid) return view as unknown as ChargeViewAmountsMasked<V>;
    return {
        ...view,
        amount: null,
        taxFreeAmount: null,
        items: view.items.map((item) => ({ ...item, amount: null })),
    } as unknown as ChargeViewAmountsMasked<V>;
}

// ── 수강 변경·휴원 신청 행 ───────────────────────────────────────────────────
// 부원장은 휴원·반 변경 신청을 «승인·거절»만 한다. 반 변경 차액(proration)·휴원 수강료 처리 미리보기
// (낸 돈·미납 합계)·이미 한 처리 기록(환불·이월액)은 학원 돈 정보라 서버 응답에서 null 로 뺀다.
// 화면(EnrollmentChangesClient)은 이 세 칸이 있을 때만 금액·정산 버튼을 그리므로 부원장에게는 저절로 숨는다.

export function maskEnrollmentChangeRowForRole<
    R extends { proration: unknown; settlementPreview: unknown; settlement: unknown },
>(row: R, role: string | null | undefined): R {
    if (canSeeAllMoney(role)) return row;
    // 세 칸 모두 원래 타입이 null 을 허용한다(AdminChangeRequestRow)
    return { ...row, proration: null, settlementPreview: null, settlement: null } as R;
}

// ── 학생 상세(getStudentActivity) ────────────────────────────────────────────
// 부원장에게는 학생 상세 «청구/수납» 탭이 닫힌다 → 청구 목록(payments)을 통째로 비우고,
// 월별 장부 기록의 «낸 돈»(paymentAmount)·이월액(carryOverAmount)을 null 로 뺀다.
// 월 수강료·셔틀비(tuitionAmount·shuttleFee)는 가격표와 같은 안내 가격이라 그대로 둔다.
// 화면(page.tsx)과 다시 읽기 API(/api/admin/students/[id]/activity) 둘 다 이 함수를 쓴다.

export function maskStudentActivityForRole<
    D extends { payments: unknown[]; monthlyHistory: Array<{ paymentAmount: number | null; carryOverAmount: number | null }> },
>(data: D, role: string | null | undefined): D {
    if (canSeeAllMoney(role)) return data;
    return {
        ...data,
        payments: [],
        monthlyHistory: data.monthlyHistory.map((history) => ({ ...history, paymentAmount: null, carryOverAmount: null })),
    } as D;
}
