/**
 * 슬랙 버튼 처리 — 토스POS 결제 알림에 원장이 답한 것을 반영한다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 돈을 지키는 규칙 (이 파일의 존재 이유)
 * ─────────────────────────────────────────────────────────────────────────
 * 1. 사이트 청구서를 "납부"로 바꾸는 길은 공용 핵심부(paymentNoticePay.ts) 하나다:
 *    [사이트 납부 반영] 버튼(CONFIRM_PAY) → 재확인 통과 → 원장부 납부 함수.
 *    (2026-11-10 원장 결정: 분류가 AUTO_CANDIDATE 면 웹훅이 같은 핵심부로 «자동» 반영한다 — paymentNoticeService.)
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
import { claimNoticeAndMarkPaid } from "./paymentNoticePay";

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

// 누른 순간의 재확인 + 선점 SQL(CLAIM_PAY_SQL)은 자동 반영과 같은 조건을 쓰도록 paymentNoticePay.ts 로 옮겼다.

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

    // [확인함] / [학원 외 결제] — 상태만 바꾼다(돈은 건드리지 않음).
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
              : `✅ 확인함 (${stamp()})`;
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

/** [사이트 납부 반영] — 원장 버튼 경로. 납부 쓰기 자체는 자동 반영과 같은 공용 핵심부(claimNoticeAndMarkPaid)만 쓴다. */
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

    // ① 누른 순간 재확인 + 선점 → ② 원장부 납부 — 자동 반영과 같은 공용 핵심부 한 곳(paymentNoticePay.ts).
    const result = await claimNoticeAndMarkPaid({
        noticeId: notice.id,
        mode: "MANUAL",
        slackUserId: ctx.userId,
        previousStatus,
        redact,
    });

    if (result.outcome === "NOT_CLAIMED") {
        // 쓰지 않았다. 지금 상태로 다시 판정해 메시지에 이유를 남긴다.
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

    if (result.outcome === "REVERTED") {
        // 납부가 안 돼 선점을 풀었다 → 다시 누를 수 있다.
        const fresh = (await loadNotice(notice.id)) ?? notice;
        await refreshNoticeMessage(fresh, { warningLine: `⚠️ 사이트 납부 반영 중 오류가 났습니다. 다시 눌러 주세요 (${stamp()})` }, where);
        return;
    }

    const fresh = (await loadNotice(notice.id)) ?? notice;
    await refreshNoticeMessage(
        fresh,
        { resultLine: `✅ 사이트 ${notice.targetMonth}월 청구 납부 반영 (${stamp()})` },
        where,
    );
}
