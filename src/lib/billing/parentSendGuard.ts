// 학부모 청구 안내(청구서 링크·미납 알림) 사이트 발송 잠금 장치.
//
// 왜 필요한가: 실제 청구·납부 안내는 「랠리즈」 앱이 학부모에게 보낸다.
// 사이트의 월 청구(Payment)는 대부분 랠리즈 청구서의 장부용 사본이고,
// 토스 온라인 결제는 아직 심사 중이라 사이트 결제 링크를 열어도 결제가 안 된다.
// 그래서 기본값은 "잠금"이고, 토스 라이브 이후 환경변수로만 다시 켠다.
//
// 이 파일은 다른 모듈을 import 하지 않는다(테스트에서 그대로 실행하기 위해).

/** 잠금 상태에서 서버가 돌려주는 안내 문구 */
export const BILLING_PARENT_SEND_LOCKED_MESSAGE =
    "학부모 청구 안내는 랠리즈에서 보냅니다(사이트 발송 잠금).";

/**
 * 사이트에서 학부모 청구 안내를 보내도 되는지 판정한다.
 * 환경변수 BILLING_PARENT_SEND_ENABLED 가 정확히 "1" 일 때만 허용한다.
 * ("true", " 1", "yes" 등은 모두 잠금 — 실수로 켜지는 일을 막는다)
 */
export function isBillingParentSendEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.BILLING_PARENT_SEND_ENABLED === "1";
}

/**
 * 랠리즈 사본 청구를 발송 대상에서 빼는 SQL 조건.
 * - method = 'RALLYZ' 인 결제
 * - 또는 PaymentAuditLog 에 RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR 기록이 있는 결제
 * 둘 중 하나라도 해당하면 제외한다. (description 문구로 판별하지 않는다 — 문구는 바뀔 수 있다)
 * @param paymentAlias Payment 테이블 별칭 (예: "p")
 */
export function rallyzMirrorExclusionSql(paymentAlias: string): string {
    return `COALESCE(${paymentAlias}.method, '') <> 'RALLYZ'
              AND NOT EXISTS (
                SELECT 1
                FROM "PaymentAuditLog" mirror_log
                WHERE mirror_log."paymentId" = ${paymentAlias}.id
                  AND mirror_log.action = 'RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR'
              )`;
}

export type UnpaidRowForParent = {
    parentId: string | null;
    studentId: string;
    amount: number | string;
};

export type ParentUnpaidSummary = {
    parentId: string;
    studentIds: string[];
    count: number;
    total: number;
};

/**
 * 미납 건을 학부모별로 묶어 "그 학부모 자녀의 미납만" 건수·금액을 계산한다.
 * (예전에는 학원 전체 합계를 모든 학부모에게 똑같이 보내는 버그가 있었다)
 * 학부모가 연결되지 않은 학생의 미납은 앱 알림 대상이 아니므로 뺀다.
 */
export function summarizeUnpaidByParent(rows: UnpaidRowForParent[]): ParentUnpaidSummary[] {
    const byParent = new Map<string, ParentUnpaidSummary>();
    for (const row of rows) {
        if (!row.parentId) continue;
        let summary = byParent.get(row.parentId);
        if (!summary) {
            summary = { parentId: row.parentId, studentIds: [], count: 0, total: 0 };
            byParent.set(row.parentId, summary);
        }
        if (!summary.studentIds.includes(row.studentId)) summary.studentIds.push(row.studentId);
        summary.count += 1;
        summary.total += Number(row.amount) || 0;
    }
    return [...byParent.values()];
}
