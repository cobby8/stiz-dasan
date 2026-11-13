/**
 * «토스는 승인됐는데 장부엔 안 들어간 결제» 다시 맞추기 — 순수 판정 규칙 (2026-11-13, 점검표 c5 근본 수정)
 *
 * 왜 필요한가:
 *   학부모 카드 결제는 «토스 승인(돈이 나감) → 우리 장부(Payment·청구서) 반영» 두 단계다. 그 사이에
 *   DB 오류·서버 시간 초과·네트워크 끊김이 나면 돈은 빠졌는데 청구는 미납으로 남는다.
 *   토스 웹훅이 오면 고쳐지지만 웹훅도 놓칠 수 있다. 그래서 주기 점검(cron)이 «승인 진행 중(IN_PROGRESS)인 채
 *   멈춘 거래»를 토스에 다시 물어 보고, 이 규칙으로 무엇을 할지 정한다.
 *
 * 여기는 판단만 한다(DB·토스 호출 없음). 실제 반영은 payment-ledger.ts 의 같은 멱등 함수
 * (finalizeVerifiedTossPayment)가 한다 — 학부모 승인·웹훅·점검 어느 쪽이 먼저 와도 한 번만 반영된다.
 */

/** 점검 대상이 되려면 마지막 움직임(updatedAt) 뒤 이만큼 조용해야 한다 — 진행 중인 승인과 겹치지 않게(승인 잠금 10분과 같음) */
export const TOSS_RECONCILE_QUIET_MINUTES = 10;
/** 이보다 오래된 거래는 점검하지 않는다(그 전에 «확인 필요» 경고가 이미 나갔다) */
export const TOSS_RECONCILE_WINDOW_DAYS = 7;
/** 토스에 «그런 결제 없음»·«중단됨»이라도 이만큼 지나야 실패로 닫는다(결제창 인증은 10분 안에 사라진다) */
export const TOSS_RECONCILE_CLOSE_AFTER_MINUTES = 60;
/** 이만큼 지나도 결론이 안 나면 원장에게 «확인 필요»를 보낸다 */
export const TOSS_RECONCILE_ALERT_AFTER_MINUTES = 24 * 60;

/** 토스 결제 조회 결과(payment-ledger 의 TossLookupResult 와 같은 모양) */
export type ReconcileLookup =
    | { kind: "verified"; payment: Record<string, unknown> }
    | { kind: "rejected"; status: number }
    | { kind: "retryable"; reason: string };

/**
 * 판정에 필요한 거래 정보 — ageMinutes = 마지막 움직임(updatedAt)부터 지난 분(DB 시계로 잰 값).
 * 결제 번호(paymentKey)는 비교하지 않는다: 점검은 «우리가 만든» 주문 번호로 토스에 묻고, 같은 주문 번호에
 * 결제창을 다시 연 경우 거래에 적힌 번호가 실제 승인된 번호와 다를 수 있기 때문이다(주문 번호 + 금액이 기준).
 */
export type ReconcileTx = {
    orderId: string;
    amount: number;
    ageMinutes: number;
};

export type ReconcileStep =
    /** 토스 완료·주문·금액 일치 → 멱등 반영 함수로 장부 반영 */
    | { action: "FINALIZE" }
    /** 무통장입금 계좌가 발급돼 있었다 → «입금 대기»로 기록(돈은 아직 안 들어옴) */
    | { action: "VA_ISSUED" }
    /** 토스 승인은 됐는데 금액이 다르다 → 반영하지 않고 원장 경고 */
    | { action: "REVIEW"; code: string; headline: string }
    /** 토스에서 승인되지 않은 것이 확실 → 거래를 실패로 닫는다(돈 안 나감) */
    | { action: "CLOSE"; code: string }
    /** 아직 판단 못 함 — 다음 점검에 다시 본다 */
    | { action: "WAIT"; reason: string };

const NOT_APPROVED_STATUSES = new Set(["ABORTED", "EXPIRED"]);
const CANCELED_STATUSES = new Set(["CANCELED", "PARTIAL_CANCELED"]);
const PENDING_STATUSES = new Set(["READY", "IN_PROGRESS"]);

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

/** 오래 결론이 안 나면 WAIT 대신 원장 경고로 바꾼다 */
function waitOrAlert(tx: ReconcileTx, reason: string): ReconcileStep {
    if (tx.ageMinutes >= TOSS_RECONCILE_ALERT_AFTER_MINUTES) {
        return {
            action: "REVIEW",
            code: "TOSS_RECONCILE_UNRESOLVED",
            headline: `[결제 확인 필요] 하루가 지나도 토스 승인 여부를 확정하지 못한 결제가 있습니다(${reason}). 토스 상점관리자에서 결제 여부를 확인해 주세요.`,
        };
    }
    return { action: "WAIT", reason };
}

/**
 * 승인 진행 중(IN_PROGRESS)에 멈춘 거래 1건을 토스 조회 결과로 판정한다.
 * - 금액은 «서버 DB 거래 금액»과만 비교한다(학부모가 보낸 값은 쓰지 않는다).
 * - 확실히 승인 안 된 경우만 닫는다. 애매하면 기다리고, 오래 애매하면 원장에게 묻는다.
 */
export function decideTossReconcile(tx: ReconcileTx, lookup: ReconcileLookup): ReconcileStep {
    if (lookup.kind === "retryable") return waitOrAlert(tx, `토스 조회 실패 ${lookup.reason}`);
    if (lookup.kind === "rejected") {
        // 404 = 토스에 그런 결제가 없다 = 승인 안 됨. 단 방금 생긴 거래면 조금 더 기다린다.
        if (lookup.status === 404) {
            return tx.ageMinutes >= TOSS_RECONCILE_CLOSE_AFTER_MINUTES
                ? { action: "CLOSE", code: "TOSS_PAYMENT_NOT_FOUND" }
                : { action: "WAIT", reason: "토스에 결제 없음(대기)" };
        }
        // 401·403 등 = 키·권한 문제 — 결제 여부를 모르니 닫지 않는다
        return waitOrAlert(tx, `토스 조회 거부 ${lookup.status}`);
    }

    const payment = lookup.payment;
    const status = str(payment.status) ?? "";
    const orderId = str(payment.orderId);
    const paymentKey = str(payment.paymentKey);
    const amount = typeof payment.totalAmount === "number" ? payment.totalAmount : Number(payment.totalAmount);

    // 다른 주문의 응답이면 이 거래에 쓰지 않는다
    if (orderId !== tx.orderId) {
        return {
            action: "REVIEW",
            code: "TOSS_RECONCILE_ORDER_MISMATCH",
            headline: "[결제 확인 필요] 토스 조회 결과의 주문 번호가 장부 거래와 달라 반영하지 않았습니다.",
        };
    }

    if (status === "DONE" || status === "WAITING_FOR_DEPOSIT") {
        if (!Number.isFinite(amount) || amount !== Number(tx.amount)) {
            // 금액이 다르면 절대 «납부»로 바꾸지 않는다 — 사람이 보고 환불·재청구를 판단
            return {
                action: "REVIEW",
                code: "TOSS_AMOUNT_MISMATCH",
                headline: `[결제 확인 필요] 토스 결제 금액(${Number.isFinite(amount) ? amount.toLocaleString("ko-KR") : "?"}원)이 청구 금액과 달라 장부에 반영하지 않았습니다. 환불 여부를 확인해 주세요.`,
            };
        }
        if (status === "DONE" && !paymentKey) return waitOrAlert(tx, "토스 결제 번호 없음");
        return status === "DONE" ? { action: "FINALIZE" } : { action: "VA_ISSUED" };
    }
    if (NOT_APPROVED_STATUSES.has(status)) return { action: "CLOSE", code: `TOSS_${status}` };
    if (status === "PARTIAL_CANCELED") {
        // 일부만 취소 = 남은 금액은 결제된 상태 — 장부는 자동으로 못 맞춘다(어느 몫이 남았는지 모름). 전액 취소와 할 일이 달라 문구를 나눈다.
        return {
            action: "REVIEW",
            code: "TOSS_PARTIAL_CANCELED_BEFORE_LEDGER",
            headline: "[결제 확인 필요] 장부에 반영되기 전에 토스에서 «일부만» 취소된 결제가 있습니다. 남은 금액은 결제된 상태라 청구에 직접 반영하거나 나머지를 환불해 주세요.",
        };
    }
    if (CANCELED_STATUSES.has(status)) {
        // 승인됐다가 장부 반영 전에 전액 취소된 결제 — 장부는 미납 그대로가 맞지만, 사람이 한 번 확인하게 알린다
        return {
            action: "REVIEW",
            code: "TOSS_CANCELED_BEFORE_LEDGER",
            headline: "[결제 확인 필요] 장부에 반영되기 전에 토스에서 전액 취소된 결제가 있습니다. 청구는 미납 그대로입니다 — 환불이 끝났는지 확인해 주세요.",
        };
    }
    if (PENDING_STATUSES.has(status)) return waitOrAlert(tx, `토스 상태 ${status}`);
    return waitOrAlert(tx, `토스 상태 ${status || "알 수 없음"}`);
}
