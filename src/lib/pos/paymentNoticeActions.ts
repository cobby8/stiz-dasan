/**
 * 슬랙 버튼 처리 — 토스POS 결제 알림에 원장이 답한 것을 반영한다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 돈을 지키는 규칙 (이 파일의 존재 이유)
 * ─────────────────────────────────────────────────────────────────────────
 * 1. 사이트 청구서를 "납부"로 바꾸는 길은 **단 하나**:
 *    [랠리즈 처리함 · 사이트 납부 반영] 버튼(CONFIRM_PAY) → 재확인 통과 → markPaymentPaid.
 *    Payment 를 직접 UPDATE 하지 않는다(청구서·감사로그가 어긋난다).
 * 2. 재확인은 **누른 순간** DB 에서 한 문장(조건부 UPDATE)으로 한다:
 *    - 알림이 아직 '확인 대기' 상태인가(두 번 눌러도 두 번째는 0건)
 *    - 그 원생의 그 달 MONTHLY 미납(PENDING/OVERDUE)이 **딱 1건**이고 금액이 같은가
 *    - 같은 달 같은 금액 PAID 가 없는가(이중결제)
 *    - 다른 알림이 이미 그 청구서로 납부 반영하지 않았는가(+ DB 부분 유일 인덱스가 한 번 더 막는다)
 *    하나라도 어긋나면 **쓰지 않고** 메시지에 이유를 적는다.
 * 3. 원생을 고르는 버튼(PICK)은 돈을 쓰지 않는다. 고른 뒤 최종 확인 버튼을 한 번 더 눌러야 한다
 *    → 돈이 움직이려면 **두 번** 눌러야 한다(원생 고르기 → 확인).
 * 4. 원장(SLACK_OWNER_USER_ID) 확인은 라우트에서 먼저 한다. 여기서도 한 번 더 막는다.
 */

import { prisma } from "@/lib/prisma";
import { markPaymentPaid } from "@/lib/payment-ledger";
import { respondEphemeral } from "@/lib/slack/client";
import {
    effectiveKind,
    loadNotice,
    recheckForStudent,
    redact,
    refreshNoticeMessage,
    type NoticeRow,
} from "./paymentNoticeService";
import { NOTICE_KIND, PICK_KINDS, kstStamp } from "./payment-notice.mjs";

export type SlackNoticeAction =
    | { type: "CONFIRM_PAY"; noticeId: string }
    | { type: "ACK"; noticeId: string }
    | { type: "IGNORE"; noticeId: string }
    | { type: "PICK"; noticeId: string; studentId: string };

export type SlackActionContext = {
    userId: string;
    responseUrl: string;
    /** 슬랙이 알려준 메시지 위치(DB 에 없을 때만 쓴다) */
    channel?: string | null;
    ts?: string | null;
};

const stamp = () => kstStamp() as string;

/** 결정이 끝났으면 다시 누를 수 없는 상태 */
const OPEN_STATUSES = ["NOTIFIED", "STUDENT_CHOSEN"];

/** 지금 이 알림이 [사이트 납부 반영]을 받을 수 있는 상태인가 */
function canConfirmPay(n: NoticeRow): boolean {
    return (
        effectiveKind(n) === NOTICE_KIND.AUTO_CANDIDATE &&
        OPEN_STATUSES.includes(n.status) &&
        !n.siteMarkedPaid &&
        !!n.sitePaymentId &&
        !!n.resolvedStudentId &&
        n.targetYear != null &&
        n.targetMonth != null
    );
}

/**
 * 누른 순간의 재확인 + 선점을 **한 문장**으로. 조건이 모두 맞을 때만 1행이 바뀐다.
 * 동시에 두 번 눌러도 행 잠금 때문에 두 번째는 바뀐 상태(CONFIRMED)를 보고 0행이 된다.
 * 다른 알림이 같은 청구서를 동시에 선점하면 부분 유일 인덱스가 예외로 막는다.
 */
const CLAIM_PAY_SQL = `UPDATE "PosPaymentNotice" n
      SET status = 'CONFIRMED', "siteMarkedPaid" = true,
          "decidedBySlackUser" = $2, "decidedAt" = now(), error = NULL, "updatedAt" = now()
    WHERE n.id = $1
      AND n."siteMarkedPaid" = false
      AND n."sitePaymentId" IS NOT NULL
      AND n."resolvedStudentId" IS NOT NULL
      AND ((n.status = 'NOTIFIED' AND n.kind = 'AUTO_CANDIDATE')
           OR (n.status = 'STUDENT_CHOSEN' AND n."pickedKind" = 'AUTO_CANDIDATE'))
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
                         AND p.status = 'PAID' AND p.amount = n.amount)
    RETURNING n.id, n."sitePaymentId", n."tossOrderId", n."tossPaymentId",
              to_char(n."approvedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "approvedAtUtc"`;

/** 버튼 1번 처리. 예외는 호출한 쪽(라우트)이 잡아 원장에게 알린다. */
export async function handleSlackNoticeAction(action: SlackNoticeAction, ctx: SlackActionContext): Promise<void> {
    // 이중 잠금: 라우트가 이미 막았어도 여기서 한 번 더 확인한다.
    const owner = (process.env.SLACK_OWNER_USER_ID ?? "").trim();
    if (!owner || ctx.userId !== owner) {
        await respondEphemeral(ctx.responseUrl, "권한이 없습니다");
        return;
    }

    const notice = await loadNotice(action.noticeId);
    if (!notice) {
        await respondEphemeral(ctx.responseUrl, "알림을 찾지 못했습니다.");
        return;
    }
    const where = { channel: ctx.channel, ts: ctx.ts };

    if (action.type === "CONFIRM_PAY") return confirmPay(notice, ctx, where);
    if (action.type === "PICK") return pickStudent(notice, action.studentId, ctx, where);

    // [랠리즈 처리함] / [확인함] / [학원 외 결제] — 상태만 바꾼다(돈은 건드리지 않음).
    const nextStatus = action.type === "IGNORE" ? "IGNORED" : "CONFIRMED";
    const done = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosPaymentNotice"
            SET status = $2, "decidedBySlackUser" = $3, "decidedAt" = now(), "updatedAt" = now()
          WHERE id = $1 AND status IN ('NOTIFIED', 'STUDENT_CHOSEN')
          RETURNING id`,
        notice.id,
        nextStatus,
        ctx.userId,
    );
    if (done.length === 0) {
        await respondEphemeral(ctx.responseUrl, "이미 처리된 알림입니다.");
        return;
    }
    const resultLine =
        action.type === "IGNORE"
            ? `➖ 학원 외 결제로 처리 (${stamp()})`
            : effectiveKind(notice) === NOTICE_KIND.ALREADY_PAID
              ? `✅ 이중결제 여부 확인함 (${stamp()})`
              : `✅ 랠리즈 처리 확인 (${stamp()})`;
    const fresh = (await loadNotice(notice.id)) ?? notice;
    await refreshNoticeMessage(fresh, { resultLine }, where);
}

/** 원생 고르기 — 고른 원생으로 청구서를 다시 맞춰 보고, 최종 확인 버튼을 띄운다(돈은 안 씀). */
async function pickStudent(
    notice: NoticeRow,
    studentId: string,
    ctx: SlackActionContext,
    where: { channel?: string | null; ts?: string | null },
) {
    if (notice.status !== "NOTIFIED" || !PICK_KINDS.has(notice.kind)) {
        await respondEphemeral(ctx.responseUrl, "이미 처리된 알림입니다.");
        return;
    }
    const students = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "Student" WHERE id = $1 AND "mergedIntoStudentId" IS NULL`,
        studentId,
    );
    if (students.length === 0) {
        await respondEphemeral(ctx.responseUrl, "원생을 찾지 못했습니다(병합·삭제됐을 수 있습니다).");
        return;
    }
    const check = await recheckForStudent(notice, studentId);
    const updated = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosPaymentNotice"
            SET status = 'STUDENT_CHOSEN', "resolvedStudentId" = $2, "pickedKind" = $3,
                "sitePaymentId" = $4, "updatedAt" = now()
          WHERE id = $1 AND status = 'NOTIFIED'
            AND kind IN ('NO_MEMO', 'AMBIGUOUS', 'NOT_IN_ROSTER')
          RETURNING id`,
        notice.id,
        studentId,
        check.kind,
        check.kind === NOTICE_KIND.AUTO_CANDIDATE ? check.sitePaymentId : null,
    );
    if (updated.length === 0) {
        await respondEphemeral(ctx.responseUrl, "이미 처리된 알림입니다.");
        return;
    }
    const fresh = await loadNotice(notice.id);
    if (fresh) await refreshNoticeMessage(fresh, {}, where);
}

/** [랠리즈 처리함 · 사이트 납부 반영] — 이 프로젝트에서 POS 결제로 돈을 쓰는 유일한 경로. */
async function confirmPay(
    notice: NoticeRow,
    ctx: SlackActionContext,
    where: { channel?: string | null; ts?: string | null },
) {
    if (!canConfirmPay(notice)) {
        await respondEphemeral(ctx.responseUrl, "이미 처리됐거나 납부 반영할 수 없는 알림입니다.");
        return;
    }
    const previousStatus = notice.status;

    // ① 누른 순간 재확인 + 선점(한 문장). 다른 알림과 겹치면 유일 인덱스 예외 → 재확인 실패로 본다.
    let claimed: { id: string; sitePaymentId: string; tossOrderId: string; tossPaymentId: string; approvedAtUtc: string | null }[] = [];
    try {
        claimed = await prisma.$queryRawUnsafe(CLAIM_PAY_SQL, notice.id, ctx.userId);
    } catch (error) {
        console.warn("[pos-notice] 선점 실패(다른 알림이 같은 청구서를 처리 중):", redact((error as Error).message));
        claimed = [];
    }

    if (claimed.length === 0) {
        // 쓰지 않는다. 지금 상태로 다시 판정해 메시지에 이유를 남긴다.
        const again = await recheckForStudent(notice, notice.resolvedStudentId as string);
        await prisma.$executeRawUnsafe(
            `UPDATE "PosPaymentNotice"
                SET status = 'STUDENT_CHOSEN', "pickedKind" = $2, "sitePaymentId" = $3, "updatedAt" = now()
              WHERE id = $1 AND status IN ('NOTIFIED', 'STUDENT_CHOSEN') AND "siteMarkedPaid" = false`,
            notice.id,
            again.kind,
            again.kind === NOTICE_KIND.AUTO_CANDIDATE ? again.sitePaymentId : null,
        );
        const fresh = (await loadNotice(notice.id)) ?? notice;
        await refreshNoticeMessage(
            fresh,
            { warningLine: `⚠️ 사이트 납부 반영을 하지 않았습니다 — 누른 시점에 청구서 상태가 달라졌습니다 (${stamp()})` },
            where,
        );
        return;
    }

    // ② 선점 성공 → 원장부 함수로만 납부 처리(청구서·감사로그 일관성).
    const claim = claimed[0];
    try {
        await markPaymentPaid({
            paymentId: claim.sitePaymentId,
            actorType: "ADMIN",
            actorId: `slack:${ctx.userId}`,
            method: "CARD",
            provider: "TOSS_POS",
            providerOrderId: claim.tossOrderId,
            paymentKey: claim.tossPaymentId,
            paidAt: claim.approvedAtUtc ?? null,
        });
    } catch (error) {
        const message = redact((error as Error).message);
        console.error("[pos-notice] 납부 반영 실패:", message, { noticeId: notice.id });
        // 반쯤 쓰였을 수 있다 → 실제 청구서 상태를 보고 판단한다.
        const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
            `SELECT status FROM "Payment" WHERE id = $1`,
            claim.sitePaymentId,
        );
        if (rows[0]?.status !== "PAID") {
            // 납부가 안 됐으면 선점을 풀어 다시 누를 수 있게 한다.
            await prisma.$executeRawUnsafe(
                `UPDATE "PosPaymentNotice"
                    SET status = $2, "siteMarkedPaid" = false, "decidedBySlackUser" = NULL, "decidedAt" = NULL,
                        error = $3, "updatedAt" = now()
                  WHERE id = $1 AND status = 'CONFIRMED'`,
                notice.id,
                previousStatus,
                message,
            );
            const fresh = (await loadNotice(notice.id)) ?? notice;
            await refreshNoticeMessage(fresh, { warningLine: `⚠️ 사이트 납부 반영 중 오류가 났습니다. 다시 눌러 주세요 (${stamp()})` }, where);
            return;
        }
        await prisma.$executeRawUnsafe(`UPDATE "PosPaymentNotice" SET error = $2 WHERE id = $1`, notice.id, message);
    }

    const fresh = (await loadNotice(notice.id)) ?? notice;
    await refreshNoticeMessage(
        fresh,
        { resultLine: `✅ 랠리즈 처리 확인 · 사이트 ${notice.targetMonth}월 청구 납부 반영 (${stamp()})` },
        where,
    );
}
