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
 *  - Payment 를 직접 UPDATE 하지 않는다. 원장부 함수 markPaymentsPaidTogether(1건)만 부른다(청구서·감사로그 일관성).
 *    이 함수는 «미납 + 금액 그대로»일 때만 바꾸고 0행이면 예외로 전부 되돌린다 — 선점과 납부 사이에
 *    다른 경로(현장 결제·직원 수납 승인·관리자 기록)가 먼저 납부해도 덮어쓰지 않는다(2026-11-10 검수).
 *  - 선점(조건부 UPDATE 한 문장)이 1행일 때만 납부한다. 같은 청구서 두 번 반영은
 *    부분 유일 인덱스 "PosPaymentNotice_sitePaymentId_marked_key" 가 DB 에서 한 번 더 막는다.
 *  - 자동(AUTO)은 수동보다 조건이 더 엄격하다: 같은 청구에 «다른 수납 기록»이 걸려 있으면 자동으로 끝내지 않고
 *    원장 확인(슬랙 버튼)으로 남긴다 — 직원 현금·계좌 확인 대기, 진행 중이거나 보류된 «현장 결제» 요청,
 *    랠리즈 사본 청구(D4).
 */

import { prisma } from "@/lib/prisma";
import { markPaymentsPaidTogether } from "@/lib/payment-ledger";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { buildConflictWarning } from "./payment-notice.mjs";

/** 자동 반영이 decidedBySlackUser 칸에 남기는 표시(슬랙 사용자 ID 와 겹치지 않는 모양) */
export const AUTO_DECIDER = "SYSTEM:auto";

/**
 * «다른 경로가 먼저 납부(CONFLICT)»로 끝난 알림의 표시. 상태는 CONFIRMED + siteMarkedPaid=false 로 닫아 둔다 —
 * 열린 상태(NOTIFIED·FAILED 등)로 두면 자동 반영 재실행·스윕 DM 이 버튼을 되살려 경고가 사라진다(2026-11-10 검수).
 */
export const CONFLICT_DECIDER = "SYSTEM:conflict";

/** 감사 기록 action — CONFLICT 경고를 알림마다 한 번만(actorId = pos-notice-conflict:<알림 id>) */
export const CONFLICT_WARN_ACTION = "POS_NOTICE_PAID_ELSEWHERE";

/**
 * 경고를 «한 번만» 남긴다: key 로 advisory lock 을 잡고, 같은 action·actorId 감사 기록이 없을 때만 넣는다.
 * 넣었으면 true(= 이번에 알려야 한다). 취소 경고·이중 수납 경고가 같이 쓴다.
 */
export async function recordWarningOnce(input: {
    lockKey: string;
    paymentId: string | null;
    actorId: string;
    action: string;
    title: string;
    metadata: Record<string, unknown>;
}): Promise<boolean> {
    return prisma.$transaction(async (db) => {
        await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, input.lockKey);
        const inserted = await db.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
             SELECT gen_random_uuid()::text, $1, NULL, NULL, 'SYSTEM', $2, $3, $4, $5::jsonb, NOW()
              WHERE NOT EXISTS (SELECT 1 FROM "PaymentAuditLog" a WHERE a.action = $3 AND a."actorId" = $2)
             RETURNING id`,
            input.paymentId,
            input.actorId,
            input.action,
            input.title,
            JSON.stringify(input.metadata),
        );
        return inserted.length > 0;
    });
}

/** 관리자 알림 벨(ADMIN·VICE_ADMIN) 한 줄 — 슬랙을 놓쳐도 사이트에서 보이게. 실패는 호출한 쪽이 잡는다. */
export async function notifyAdminBell(title: string, message: string, linkUrl = "/admin/finance"): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
         SELECT gen_random_uuid()::text, u.id, 'PAYMENT', $1, $2, $3, false, NOW()
           FROM "User" u WHERE u.role IN ('ADMIN', 'VICE_ADMIN')`,
        title,
        message,
        linkUrl,
    );
}

/**
 * CONFLICT 알림: 감사 기록 1줄(중복 방지) + 관리자 알림 벨 «이중 수납 확인 필요(학생·청구·금액)».
 * 슬랙 DM 결과 줄은 호출한 쪽(버튼·자동)이 고친다. 실패해도 납부 결과(쓰지 않음)는 바뀌지 않는다.
 */
async function alertConflict(noticeId: string, sitePaymentId: string, mode: string, redact: (m: string) => string) {
    try {
        const rows = await prisma.$queryRawUnsafe<{ studentName: string | null; year: number | null; month: number | null; amount: number; kstDateTime: string }[]>(
            `SELECT s.name AS "studentName", p.year, p.month, n.amount::float8 AS amount,
                    COALESCE(to_char(n."approvedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'), '') AS "kstDateTime"
               FROM "PosPaymentNotice" n
               JOIN "Payment" p ON p.id = n."sitePaymentId"
               LEFT JOIN "Student" s ON s.id = p."studentId" -- 경고 문구용 이름만(병합 여부 s."mergedIntoStudentId" 무관 — 그 청구의 이름)
              WHERE n.id = $1 /* conflict-info */`,
            noticeId,
        );
        const info = rows[0];
        const text = buildConflictWarning({
            studentName: info?.studentName ?? null,
            year: info?.year ?? null,
            month: info?.month ?? null,
            amount: Number(info?.amount ?? 0),
            kstDateTime: info?.kstDateTime ?? "",
        }) as { title: string; message: string };
        const first = await recordWarningOnce({
            lockKey: `pos-notice-conflict:${noticeId}`,
            paymentId: sitePaymentId,
            actorId: `pos-notice-conflict:${noticeId}`,
            action: CONFLICT_WARN_ACTION,
            title: text.title,
            metadata: { noticeId, mode },
        });
        if (first) await notifyAdminBell(text.title, text.message);
    } catch (error) {
        console.error("[pos-notice] 이중 수납 경고 기록 실패:", redact((error as Error).message), { noticeId });
    }
}

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
    RETURNING n.id, n."sitePaymentId", n."tossOrderId", n."tossPaymentId", n.amount::int AS amount,
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

type ClaimRow = {
    id: string;
    sitePaymentId: string;
    tossOrderId: string;
    tossPaymentId: string;
    amount: number;
    approvedAtUtc: string | null;
};

export type NoticePayResult =
    /** 재확인 실패(또는 다른 알림과 동시 선점) — 아무것도 쓰지 않았다 */
    | { outcome: "NOT_CLAIMED" }
    /** 납부 반영됨. error 가 있으면 원장부 쓰기 뒤 오류가 났지만 이 결제로 PAID 된 것을 확인했다 */
    | { outcome: "PAID"; sitePaymentId: string; error: string | null }
    /** 원장부 쓰기 실패 + 청구가 미납 그대로 → 선점을 풀어 다시 처리할 수 있게 했다 */
    | { outcome: "REVERTED"; error: string }
    /** 선점과 납부 사이에 «다른 경로»가 먼저 납부했다(0행) → 쓰지 않았다. 알림은 닫힌 채(CONFLICT 표시)·감사 기록·알림 벨. 이중 수납 확인 필요 */
    | { outcome: "CONFLICT"; sitePaymentId: string; error: string };

/** 원장 DM 결과 줄 — 다른 경로가 먼저 납부해 반영하지 않았을 때(버튼·자동 공통 문구) */
export const CONFLICT_RESULT_TEXT = "⚠️ 이미 다른 경로로 납부됨 — 이중 수납 확인 필요(이 POS 결제는 사이트에 반영하지 않았습니다)";

/** 선점 되돌리기(납부가 안 됐을 때). CONFIRMED 인 것만 — 다른 처리가 이미 상태를 바꿨으면 건드리지 않는다. */
async function releaseClaim(noticeId: string, previousStatus: string, message: string) {
    await prisma.$executeRawUnsafe(
        `UPDATE "PosPaymentNotice"
            SET status = $2, "siteMarkedPaid" = false, "decidedBySlackUser" = NULL, "decidedAt" = NULL,
                error = $3, "updatedAt" = now()
          WHERE id = $1 AND status = 'CONFIRMED'`,
        noticeId,
        previousStatus,
        message,
    );
}

/**
 * 선점(한 문장) → 원장부 납부(markPaymentsPaidTogether 1건) → 실패 시 실제 청구 상태로 판단해 선점 되돌리기.
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
    //    1건짜리 «묶음» 함수를 쓰는 이유: «미납 + 금액 그대로 + 종류»일 때만 바꾸는 조건부 UPDATE 라서,
    //    선점 뒤 다른 경로가 먼저 납부했으면 0행 → 예외 → 아무것도 안 쓰고 되돌린다(덮어쓰기 금지).
    const claim = claimed[0];
    try {
        await markPaymentsPaidTogether({
            items: [{ paymentId: claim.sitePaymentId, amount: Number(claim.amount) }],
            // 자동은 «시스템이 토스 재조회로 확인» — 감사 기록에서 사람 클릭과 구분된다.
            actorType: auto ? "SYSTEM" : "ADMIN",
            actorId: auto ? `pos-notice-auto:${input.noticeId}` : `slack:${decidedBy}`,
            method: "CARD",
            provider: "TOSS_POS",
            providerOrderId: claim.tossOrderId,
            paymentKey: claim.tossPaymentId,
            paidAt: claim.approvedAtUtc ?? null,
            bundle: { source: "POS_NOTICE", noticeId: input.noticeId, mode: input.mode },
        });
        return { outcome: "PAID", sitePaymentId: claim.sitePaymentId, error: null };
    } catch (error) {
        const message = input.redact((error as Error).message);
        console.error("[pos-notice] 납부 반영 실패:", message, { noticeId: input.noticeId, mode: input.mode });
        // 실제 청구 상태로 판단한다: 이 결제로 PAID 인가 / 다른 경로로 PAID 인가 / 아직 미납인가.
        const rows = await prisma.$queryRawUnsafe<{ status: string; providerPaymentKey: string | null }[]>(
            `SELECT status, "providerPaymentKey" FROM "Payment" WHERE id = $1`,
            claim.sitePaymentId,
        );
        const row = rows[0];
        if (row?.status === "PAID" && row.providerPaymentKey === claim.tossPaymentId) {
            // 이 결제로 납부는 끝났고 그 뒤(캐시 무효화 등)에서 오류 — 결과는 납부 반영.
            await prisma.$executeRawUnsafe(`UPDATE "PosPaymentNotice" SET error = $2 WHERE id = $1`, input.noticeId, message);
            return { outcome: "PAID", sitePaymentId: claim.sitePaymentId, error: message };
        }
        if (row?.status === "PAID") {
            // 다른 경로가 먼저 납부(0행) — 돈이 두 번 들어왔을 수 있다. 사람이 확인해야 한다.
            // 선점은 «닫힌 채»로 바꾼다(siteMarkedPaid=false · CONFIRMED · CONFLICT 표시) — 다시 열면
            // 자동 반영 재실행·스윕 DM 이 버튼을 되살려 경고 결과 줄이 사라진다.
            await prisma.$executeRawUnsafe(
                `UPDATE "PosPaymentNotice"
                    SET "siteMarkedPaid" = false, "decidedBySlackUser" = $2, "decidedAt" = now(),
                        error = $3, "updatedAt" = now()
                  WHERE id = $1 AND status = 'CONFIRMED'`,
                input.noticeId,
                CONFLICT_DECIDER,
                `CONFLICT: ${message}`.slice(0, 1000),
            );
            await alertConflict(input.noticeId, claim.sitePaymentId, input.mode, input.redact);
            return { outcome: "CONFLICT", sitePaymentId: claim.sitePaymentId, error: message };
        }
        // 아직 미납이므로 선점을 풀어 다시 처리할 수 있게 한다(siteMarkedPaid=false — 납부한 것처럼 남지 않게).
        await releaseClaim(input.noticeId, input.previousStatus, message);
        return { outcome: "REVERTED", error: message };
    }
}
