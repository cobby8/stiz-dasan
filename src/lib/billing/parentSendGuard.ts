// 학부모 청구 안내(청구서 링크·미납 알림) 사이트 발송 잠금 장치.
//
// 지금 사실(2026-11-14): 옛 학원 관리 서비스 「랠리즈」는 더 쓰지 않는다. 청구·납부 안내는 사이트가 보내고,
// 토스 온라인 결제도 승인이 끝나 사이트 결제 링크로 실제 결제가 된다.
// 잠금 스위치는 그대로 둔다 — 기본값은 "잠금"이고 환경변수 BILLING_PARENT_SEND_ENABLED="1" 일 때만 발송한다
// (스위치를 끄면 언제든 학부모 발송을 한 번에 멈출 수 있다).
//
// 랠리즈 시절 청구의 «장부용 사본»(Payment)은 지금도 남아 있다. 사본은 사이트 결제·안내·자동 반영에서 빠지고,
// 원장이 랠리즈 쪽 청구를 취소한 뒤 «사이트로 풀어 준» 사본만 일반 청구처럼 다룬다(rallyzMirrorExclusionSql).
//
// 이 파일은 다른 모듈을 import 하지 않는다(테스트에서 그대로 실행하기 위해).

/** 잠금 상태에서 서버가 돌려주는 안내 문구 */
export const BILLING_PARENT_SEND_LOCKED_MESSAGE =
    "학부모 청구 안내 발송은 잠겨 있습니다(발송 스위치를 켜면 열립니다).";

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

/** 랠리즈 청구서의 장부용 사본임을 남긴 감사기록(PaymentAuditLog.action) */
export const RALLYZ_MIRROR_AUDIT_ACTION = "RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR";

/**
 * «사이트로 풀어 준 사본» 표시(PaymentAuditLog.action) — 2026-11-14 랠리즈 은퇴 2단계.
 * 원장이 랠리즈 쪽 청구를 취소한 미납 사본에만 붙인다(원장·총괄이 DB 로 직접).
 * 이 기록이 있는 결제는 더 이상 사본으로 보지 않는다 → 사이트 결제·POS 자동 반영·미납 안내·휴원 정산에 일반 청구로 들어온다.
 */
export const RALLYZ_MIRROR_RELEASED_ACTION = "RALLYZ_MIRROR_RELEASED_TO_SITE";

/**
 * «이 결제는 랠리즈 사본이 아니다(= 일반 청구다)»가 참인 SQL 조건.
 * 사본 = method 가 'RALLYZ' 이거나 PaymentAuditLog 에 사본 기록(RALLYZ_MIRROR_AUDIT_ACTION)이 있는 결제.
 * 다만 «사이트로 풀어 준» 기록(RALLYZ_MIRROR_RELEASED_ACTION)이 있으면 사본이어도 일반 청구로 본다.
 *   참 = (사본이 아니다) OR (풀어 준 기록이 있다)
 * (description 문구로 판별하지 않는다 — 문구는 바뀔 수 있다)
 *
 * 반환값은 반드시 «전체를 괄호로» 감싼다. 사용처가 `AND ${...}` 와 `NOT (${...})` 두 모양으로 쓰는데,
 * 안에 OR 이 있어 괄호가 없으면 `A AND x OR y` 가 `(A AND x) OR y` 로 읽혀 앞의 조건이 통째로 무시된다.
 * @param paymentAlias Payment 테이블 별칭 (예: "p") — 코드에 적힌 고정 글자만 넘긴다(사용자 입력 금지)
 */
export function rallyzMirrorExclusionSql(paymentAlias: string): string {
    return `(
              (
                COALESCE(${paymentAlias}.method, '') <> 'RALLYZ'
                AND NOT EXISTS (
                  SELECT 1
                  FROM "PaymentAuditLog" mirror_log
                  WHERE mirror_log."paymentId" = ${paymentAlias}.id
                    AND mirror_log.action = '${RALLYZ_MIRROR_AUDIT_ACTION}'
                )
              )
              OR EXISTS (
                SELECT 1
                FROM "PaymentAuditLog" release_log
                WHERE release_log."paymentId" = ${paymentAlias}.id
                  AND release_log.action = '${RALLYZ_MIRROR_RELEASED_ACTION}'
              )
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
