/**
 * 토스POS 결제 알림(PosPaymentNotice) → 사이트 청구 «납부 반영» 공용 핵심부.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 왜 따로 두나
 * ─────────────────────────────────────────────────────────────────────────
 * 납부 반영으로 가는 길이 두 개가 됐다(2026-11-10 원장 결정
 * «현장 수납은 자동화로 POS 처리 확인되면 끝내야지 승인할 필요 없어»).
 *   ① 원장이 슬랙 [사이트 납부 반영] 버튼을 눌렀을 때 (paymentNoticeActions.ts — MANUAL)
 *   ② 웹훅이 토스 재조회로 결제를 확인했고 분류가 AUTO_CANDIDATE 일 때 (paymentNoticeService.ts — AUTO)
 * 두 길이 «재확인 조건»과 «원장부 쓰기·되돌리기»를 따로 가지면 한쪽만 고쳐지는 사고가 난다.
 * 그래서 재확인 SQL 조각과 납부 함수 호출을 여기 한 곳에만 둔다.
 *
 * 돈을 지키는 규칙
 *  - Payment 를 직접 UPDATE 하지 않는다. 원장부 함수 markPaymentPaid 만 부른다(청구서·감사로그 일관성).
 *  - 선점(조건부 UPDATE 한 문장)이 1행일 때만 납부한다. 같은 청구서 두 번 반영은
 *    부분 유일 인덱스 "PosPaymentNotice_sitePaymentId_marked_key" 가 DB 에서 한 번 더 막는다.
 *  - 자동(AUTO)은 수동보다 조건이 더 엄격하다: 같은 청구에 «다른 수납 기록»이 걸려 있으면 자동으로 끝내지 않고
 *    원장 확인(슬랙 버튼)으로 남긴다 — 직원 현금·계좌 확인 대기, 진행 중이거나 보류된 «현장 결제» 요청,
 *    랠리즈 사본 청구(D4).
 */

import { prisma } from "@/lib/prisma";
import { markPaymentPaid } from "@/lib/payment-ledger";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";

/** 자동 반영이 decidedBySlackUser 칸에 남기는 표시(슬랙 사용자 ID 와 겹치지 않는 모양) */
export const AUTO_DECIDER = "SYSTEM:auto";

/**
 * 수동·자동 공통 재확인 조건(별칭 n = PosPaymentNotice). 하나라도 어긋나면 0행 → 쓰지 않는다.
 *  - 아직 납부 반영 안 됨, 청구서·원생이 정해져 있음
 *  - 다른 알림이 같은 청구서로 이미 납부 반영하지 않음
 *  - 그 원생 그 달 MONTHLY 미납이 «딱 1건»이고 금액이 같음
 *  - 같은 달 같은 금액 PAID 가 없음(이중결제)
 */
export const NOTICE_PAY_RECHECK_SQL = `
      AND n."siteMarkedPaid" = false
      AND n."sitePaymentId" IS NOT NULL
      AND n."resolvedStudentId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "PosPaymentNotice" o
                       WHERE o."sitePaymentId" = n."sitePaymentId" AND o."siteMarkedPaid" = true AND o.id <> n.id)
      AND EXISTS (SELECT 1 FROM "Payment" p
                   WHERE p.id = n."sitePaymentId" AND p."studentId" = n."resolvedStudentId"
                     AND p.type = 'MONTHLY' AND p.year = n."targetYear" AND p.month = n."targetMonth"
                     AND p.status IN ('PENDING', 'OVERDUE') AND p.amount = n.amount)
      AND (SELECT count(*) FROM "Payment" p
            WHERE p."studentId" = n."resolvedStudentId" AND p.type = 'MONTHLY'
              AND p.year = n."targetYear" AND p.month = n."targetMonth"
              AND p.status IN ('PENDING', 'OVERDUE')) = 1
      AND NOT EXISTS (SELECT 1 FROM "Payment" p
                       WHERE p."studentId" = n."resolvedStudentId" AND p.type = 'MONTHLY'
                         AND p.year = n."targetYear" AND p.month = n."targetMonth"
                         AND p.status = 'PAID' AND p.amount = n.amount)`;

/**
 * 자동(AUTO)에만 더 거는 조건 — «같은 청구에 다른 수납 기록이 있으면 사람이 본다».
 *  - 직원이 현금·계좌로 받았다고 올린 확인 요청이 대기 중이면: POS 결제까지 받으면 이중 수납일 수 있다.
 *  - «현장 결제» 요청이 열려 있거나(PENDING·SENT) 보류(HELD)·납부(PAID)면: 그 요청 쪽이 이 청구를 처리 중이다.
 *    (요청 r 이 청구를 묶었나 = 대표 청구이거나 항목에 있거나 — chargeRequestService 의 hasPaymentSql 과 같은 모양)
 *  - 랠리즈 사본 청구(D4): 랠리즈에서 결제하는 청구라 사이트가 자동으로 닫지 않는다.
 */
export const NOTICE_AUTO_EXTRA_SQL = `
      AND NOT EXISTS (SELECT 1 FROM "StaffPaymentConfirmationRequest" sr
                       WHERE sr."paymentId" = n."sitePaymentId" AND sr.status = 'PENDING')
      AND NOT EXISTS (SELECT 1 FROM "PosChargeRequest" r
                       WHERE r.status IN ('PENDING', 'SENT', 'HELD', 'PAID')
                         AND (r."paymentId" = n."sitePaymentId"
                              OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" ih
                                          WHERE ih."requestId" = r.id AND ih."paymentId" = n."sitePaymentId")))
      AND EXISTS (SELECT 1 FROM "Payment" pm
                   WHERE pm.id = n."sitePaymentId" AND ${rallyzMirrorExclusionSql("pm")})`;

const CLAIM_RETURNING_SQL = `
    RETURNING n.id, n."sitePaymentId", n."tossOrderId", n."tossPaymentId",
              to_char(n."approvedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "approvedAtUtc"`;

/**
 * [사이트 납부 반영] 버튼(원장)의 선점. 슬랙 DM 이 나간 뒤(NOTIFIED) 또는 원생을 고른 뒤(STUDENT_CHOSEN)만.
 * 동시에 두 번 눌러도 행 잠금 때문에 두 번째는 바뀐 상태(CONFIRMED)를 보고 0행이 된다.
 */
export const CLAIM_PAY_SQL = `UPDATE "PosPaymentNotice" n
      SET status = 'CONFIRMED', "siteMarkedPaid" = true,
          "decidedBySlackUser" = $2, "decidedAt" = now(), error = NULL, "updatedAt" = now()
    WHERE n.id = $1
      AND ((n.status = 'NOTIFIED' AND n.kind = 'AUTO_CANDIDATE')
           OR (n.status = 'STUDENT_CHOSEN' AND n."pickedKind" = 'AUTO_CANDIDATE'))${NOTICE_PAY_RECHECK_SQL}${CLAIM_RETURNING_SQL}`;

/**
 * 자동 반영의 선점. 처음 분류가 AUTO_CANDIDATE(메모 이름이 원생 1명과 정확히 일치 + 그 달 미납 1건 금액 일치)인
 * 알림만, DM 이 나갔든(NOTIFIED) 아직이든(PENDING)·실패했든(FAILED). 원장이 원생을 고른 알림(STUDENT_CHOSEN)은
 * 사람이 판단 중이므로 자동으로 건드리지 않는다.
 */
export const AUTO_CLAIM_PAY_SQL = `UPDATE "PosPaymentNotice" n
      SET status = 'CONFIRMED', "siteMarkedPaid" = true,
          "decidedBySlackUser" = $2, "decidedAt" = now(), error = NULL, "updatedAt" = now()
    WHERE n.id = $1
      AND n.status IN ('PENDING', 'NOTIFIED', 'FAILED') AND n.kind = 'AUTO_CANDIDATE'${NOTICE_PAY_RECHECK_SQL}${NOTICE_AUTO_EXTRA_SQL}${CLAIM_RETURNING_SQL}`;

type ClaimRow = { id: string; sitePaymentId: string; tossOrderId: string; tossPaymentId: string; approvedAtUtc: string | null };

export type NoticePayResult =
    /** 재확인 실패(또는 다른 알림과 동시 선점) — 아무것도 쓰지 않았다 */
    | { outcome: "NOT_CLAIMED" }
    /** 납부 반영됨. error 가 있으면 원장부 쓰기 중 오류가 났지만 청구는 PAID 로 확인됐다 */
    | { outcome: "PAID"; sitePaymentId: string; error: string | null }
    /** 원장부 쓰기 실패 + 청구가 미납 그대로 → 선점을 풀어 다시 처리할 수 있게 했다 */
    | { outcome: "REVERTED"; error: string };

/**
 * 선점(한 문장) → 원장부 납부(markPaymentPaid) → 실패 시 실제 청구 상태로 판단해 선점 되돌리기.
 * @param previousStatus 선점 전 알림 상태(되돌릴 때 이 값으로 돌린다)
 * @param redact 오류 문구에서 키를 가리는 함수(paymentNoticeService.redact)
 */
export async function claimNoticeAndMarkPaid(input: {
    noticeId: string;
    mode: "MANUAL" | "AUTO";
    /** MANUAL = 누른 슬랙 사용자 ID */
    slackUserId?: string;
    previousStatus: string;
    redact: (message: string) => string;
}): Promise<NoticePayResult> {
    const auto = input.mode === "AUTO";
    const decidedBy = auto ? AUTO_DECIDER : String(input.slackUserId ?? "");
    if (!auto && !decidedBy) return { outcome: "NOT_CLAIMED" };

    // ① 재확인 + 선점(한 문장). 다른 알림과 겹치면 유일 인덱스 예외 → 재확인 실패로 본다.
    let claimed: ClaimRow[] = [];
    try {
        claimed = await prisma.$queryRawUnsafe<ClaimRow[]>(auto ? AUTO_CLAIM_PAY_SQL : CLAIM_PAY_SQL, input.noticeId, decidedBy);
    } catch (error) {
        console.warn("[pos-notice] 선점 실패(다른 알림이 같은 청구서를 처리 중):", input.redact((error as Error).message));
        claimed = [];
    }
    if (claimed.length === 0) return { outcome: "NOT_CLAIMED" };

    // ② 선점 성공 → 원장부 함수로만 납부 처리(청구서·감사로그 PAYMENT_MARK_PAID 가 함께 남는다).
    const claim = claimed[0];
    try {
        await markPaymentPaid({
            paymentId: claim.sitePaymentId,
            // 자동은 «시스템이 토스 재조회로 확인» — 감사 기록에서 사람 클릭과 구분된다.
            actorType: auto ? "SYSTEM" : "ADMIN",
            actorId: auto ? `pos-notice-auto:${input.noticeId}` : `slack:${decidedBy}`,
            method: "CARD",
            provider: "TOSS_POS",
            providerOrderId: claim.tossOrderId,
            paymentKey: claim.tossPaymentId,
            paidAt: claim.approvedAtUtc ?? null,
        });
        return { outcome: "PAID", sitePaymentId: claim.sitePaymentId, error: null };
    } catch (error) {
        const message = input.redact((error as Error).message);
        console.error("[pos-notice] 납부 반영 실패:", message, { noticeId: input.noticeId, mode: input.mode });
        // 반쯤 쓰였을 수 있다 → 실제 청구서 상태를 보고 판단한다.
        const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
            `SELECT status FROM "Payment" WHERE id = $1`,
            claim.sitePaymentId,
        );
        if (rows[0]?.status !== "PAID") {
            // 납부가 안 됐으면 선점을 풀어 다시 처리할 수 있게 한다(자동이면 원장 버튼이 안전망).
            await prisma.$executeRawUnsafe(
                `UPDATE "PosPaymentNotice"
                    SET status = $2, "siteMarkedPaid" = false, "decidedBySlackUser" = NULL, "decidedAt" = NULL,
                        error = $3, "updatedAt" = now()
                  WHERE id = $1 AND status = 'CONFIRMED'`,
                input.noticeId,
                input.previousStatus,
                message,
            );
            return { outcome: "REVERTED", error: message };
        }
        await prisma.$executeRawUnsafe(`UPDATE "PosPaymentNotice" SET error = $2 WHERE id = $1`, input.noticeId, message);
        return { outcome: "PAID", sitePaymentId: claim.sitePaymentId, error: message };
    }
}
