// 납부완료(PAID) 청구의 «상태 변경» 규칙 — 외부 의존 없는 순수 규칙(화면·서버·테스트가 같은 함수를 쓴다).
//
// 왜 (2026-11-10 원장 지시): 학생 상세의 상태 묶음 버튼(완납/대기/연체/취소)으로 납부완료를 대기·취소로 바꾸면
// 실제로 받은 돈(토스 카드 승인·POS 결제·카페24)은 그대로인데 장부만 «안 받음»이 된다.
//   - 실제 결제 수단(토스 온라인·토스 POS·카페24·옛 단말기 등)으로 받은 납부완료 → 상태 변경 자체를 막는다.
//     돈을 돌려주는 길은 수납 관리 ⚡ 메뉴(«결제 취소»·«환불»)뿐이다.
//   - 사람이 적은 납부완료(MANUAL·현금·계좌이체·옛 기록 null) → «대기로 되돌리기(납부 기록 정정)»만 허용.
//     «취소»·«연체»로 바로 바꾸면 «받은 돈을 없던 일로» 만드는 것과 같아 막는다(먼저 대기로 되돌린 뒤 판단).
// 판정 기준은 «수기 목록에 있는가»다 — 모르는 결제 경로가 새로 생겨도 기본은 잠금(안전한 쪽).

/** 실제 결제 수단으로 받은 납부완료를 바꾸려 할 때 */
export const PAID_REAL_LOCKED_MESSAGE = "결제 취소·환불은 수납 관리에서 해 주세요.";
/** 수기 납부완료를 대기 말고 다른 상태로 바꾸려 할 때 */
export const PAID_MANUAL_PENDING_ONLY_MESSAGE = "직접 기록한 납부완료는 «대기로 되돌리기»만 할 수 있어요. 환불은 수납 관리에서 해 주세요.";
/** 수기로 보이지만 완료된 온라인 결제 거래가 붙어 있을 때(장부 경로가 어긋난 옛 기록) */
export const PAID_HAS_DONE_TX_MESSAGE = "완료된 온라인 결제 기록이 있어 되돌릴 수 없어요. 수납 관리에서 결제 취소·환불을 해 주세요.";
/** 교사 수납 확인(staff-billing — provider MANUAL «완료» 거래)으로 받은 납부 — 선생님이 받은 돈이라 장부만 되돌리지 않는다 */
export const PAID_STAFF_CONFIRMED_MESSAGE = "선생님 수납 확인으로 받은 기록이에요. 수납 관리에서 확인해 주세요.";
/** 실제 결제로 받은(또는 완료 거래가 붙은) 청구를 영구 삭제하려 할 때(2026-11-10 원장 승인) */
export const PAYMENT_DELETE_REAL_PAID_MESSAGE = "실제 결제로 받은 청구는 삭제할 수 없어요. 결제 취소·환불을 먼저 해 주세요.";
/** 교사 수납 확인 완료 거래가 붙은 청구를 영구 삭제하려 할 때 */
export const PAYMENT_DELETE_STAFF_CONFIRMED_MESSAGE = "선생님 수납 확인으로 받은 기록이라 삭제할 수 없어요. 환불이 필요하면 ⚡ «환불»을 먼저 해 주세요.";

/** 사람이 적은 납부(장부만 바꿔도 되는 기록)인가 — MANUAL·빈 값·null 만. 그 밖(TOSS·TOSS_POS·CAFE24_BRIDGE·TOSS_TERMINAL·모르는 값)은 실제 결제 */
export function isManualPaidProvider(provider: string | null | undefined): boolean {
    if (provider == null) return true;
    const value = String(provider).trim().toUpperCase();
    return value === "" || value === "MANUAL";
}

/** 학생 상세 화면용 — 이 청구의 상태 버튼을 어떻게 보여 줄까 */
export type PaidStatusLock =
    | "NONE"            // 납부완료가 아님 → 예전처럼 묶음 버튼
    | "REAL_LOCKED"     // 실제 결제로 받은 납부완료 → 버튼 잠금 + «수납 관리에서» 안내
    | "MANUAL_REVERT";  // 수기 납부완료 → «대기로 되돌리기»만(한 번 더 확인)

export function paidStatusLock(status: string, paidProvider: string | null | undefined): PaidStatusLock {
    if (status !== "PAID") return "NONE";
    return isManualPaidProvider(paidProvider) ? "MANUAL_REVERT" : "REAL_LOCKED";
}

/** 서버가 DB 에서 다시 읽은 청구 1건(화면이 보낸 값은 믿지 않는다) */
export type PaymentStatusRow = {
    status: string;
    paidProvider: string | null;
    /** 이 청구에 «완료(DONE)» 결제 거래(토스 등 — provider 가 MANUAL 이 아닌 것)가 있는가 */
    hasDoneTransaction?: boolean;
    /** 교사 수납 확인으로 생긴 «완료» 거래(provider MANUAL)가 있는가 */
    hasManualDoneTransaction?: boolean;
};

export type PaymentStatusDecision =
    | { ok: true; kind: "NORMAL" }         // 납부완료가 아닌 청구의 상태 변경(예전 그대로)
    | { ok: true; kind: "REVERT_PAID" }    // 수기 납부완료 → 대기(납부 기록 정정)
    | { ok: false; code: "REAL_PAYMENT" | "MANUAL_PENDING_ONLY" | "HAS_DONE_TX" | "STAFF_CONFIRMED"; message: string };

/**
 * 현재 상태(DB) + 바꾸려는 상태 → 허용/거절.
 * PAID·REFUNDED 로 «바꾸는» 것은 이 함수 밖(updatePaymentStatus 첫 줄)에서 이미 막는다.
 */
export function judgePaymentStatusChange(current: PaymentStatusRow, nextStatus: string): PaymentStatusDecision {
    if (current.status !== "PAID") return { ok: true, kind: "NORMAL" };
    // 납부완료 → 납부완료(같은 값)는 화면이 보내지 않지만, 와도 바꿀 것이 없으니 «대기만 허용» 규칙으로 거절한다
    if (!isManualPaidProvider(current.paidProvider)) {
        return { ok: false, code: "REAL_PAYMENT", message: PAID_REAL_LOCKED_MESSAGE };
    }
    if (nextStatus !== "PENDING") {
        return { ok: false, code: "MANUAL_PENDING_ONLY", message: PAID_MANUAL_PENDING_ONLY_MESSAGE };
    }
    if (current.hasDoneTransaction) {
        return { ok: false, code: "HAS_DONE_TX", message: PAID_HAS_DONE_TX_MESSAGE };
    }
    // 교사 수납 확인 기록도 «완료 거래»라 막는다 — 다만 온라인 결제가 아니므로 문구를 정확히(보안 리뷰 참고 2026-11-10)
    if (current.hasManualDoneTransaction) {
        return { ok: false, code: "STAFF_CONFIRMED", message: PAID_STAFF_CONFIRMED_MESSAGE };
    }
    return { ok: true, kind: "REVERT_PAID" };
}

/**
 * 수납 기록 «영구 삭제»를 막을 이유(없으면 null) — 2026-11-10 원장 승인.
 * 실제 결제(수기 목록이 아닌 결제 경로)로 납부완료인 청구, 완료(DONE) 결제 거래가 붙은 청구는 지우지 않는다.
 * 돈은 그대로인데 기록만 사라지기 때문이다. 화면(⚡ 메뉴 잠금)·서버(deletePayment·deleteStudent)가 같은 함수를 쓴다.
 */
export function paymentDeleteBlockReason(row: PaymentStatusRow): string | null {
    if (row.hasDoneTransaction) return PAYMENT_DELETE_REAL_PAID_MESSAGE;
    if (row.status === "PAID" && !isManualPaidProvider(row.paidProvider)) return PAYMENT_DELETE_REAL_PAID_MESSAGE;
    if (row.hasManualDoneTransaction) return PAYMENT_DELETE_STAFF_CONFIRMED_MESSAGE;
    return null;
}
