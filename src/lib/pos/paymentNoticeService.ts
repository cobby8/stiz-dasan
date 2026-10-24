/**
 * 토스POS 결제 → 슬랙 DM 알림 — 서버 실행부 (웹훅 처리 · DM 보내기 · 스윕)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 이 파일이 하는 일 / 절대 하지 않는 일
 * ─────────────────────────────────────────────────────────────────────────
 * 하는 일  : ① 웹훅이 알려준 주문을 토스에 **다시 조회**(GET 전용)
 *           ② 카드·승인 결제마다 `PosPaymentNotice` 한 줄(결제 ID 로 중복 차단)
 *           ③ 원장에게 슬랙 DM("랠리즈에서 현장결제 처리하셨나요?")
 * 안 하는 일: Payment · PaymentInvoice 를 **절대 쓰지 않는다.**
 *           사이트 납부 반영은 원장이 버튼을 눌렀을 때 paymentNoticeActions.ts 에서만 한다.
 *
 * 판단 로직은 ./payment-notice.mjs(순수 모듈) 한 벌이다. 여기는 DB·토스·슬랙 입출력만 한다.
 */

import { prisma } from "@/lib/prisma";
import { postMessage, updateMessage, type SlackBlock } from "@/lib/slack/client";
import { fetchTossOrderById } from "./tossplaceClient";
import { parseMemoNames, redactSecrets } from "./tossplace-match.mjs";
import {
    NOTICE_KIND,
    PICK_KINDS,
    buildCandidateList,
    buildNoticeMessage,
    classifyInvoiceRows,
    classifyNotice,
    extractNoticePayments,
    extractOrderIdFromWebhook,
    resolveNoticeStudent,
    resolveNoticeTarget,
    rowsForStudentMonth,
} from "./payment-notice.mjs";

// 순수 JS(.mjs) 함수는 TS 가 인자 타입을 좁게 추론한다 → 이 파일에서만 느슨하게 받는다.
const classify = classifyNotice as (input: any) => any;
const buildMessage = buildNoticeMessage as (input: any) => { text: string; blocks: SlackBlock[] };
const candidatesOf = buildCandidateList as (input: any) => { candidates: RosterStudent[]; overflow: number };
const invoiceKindOf = classifyInvoiceRows as (input: any) => {
    kind: string;
    sitePaymentId: string | null;
    siteAmounts: number[];
    reason: string;
};
const whoOf = resolveNoticeStudent as (input: any) => { status: string; student: RosterStudent | null; nameCandidates: RosterStudent[] };
const rowsFor = rowsForStudentMonth as (rows: any[], studentId: string, year: number | null, month: number | null) => SiteRow[];

// ───────────────────────────── 타입 ─────────────────────────────

export type RosterStudent = { id: string; name: string; classes: string[] };
export type SiteRow = { id: string; studentId: string; amount: number; status: string; type: string; year: number; month: number };

/** DM 을 다시 그릴 때 필요한 알림 한 줄(화면용으로 KST 문자열까지 SQL 에서 만든다). */
export type NoticeRow = {
    id: string;
    tossPaymentId: string;
    tossOrderId: string;
    amount: number;
    kstDateTime: string;
    kstDate: string;
    lineItems: string | null;
    memo: string | null;
    resolvedStudentId: string | null;
    studentName: string | null;
    targetYear: number | null;
    targetMonth: number | null;
    sitePaymentId: string | null;
    kind: string;
    pickedKind: string | null;
    status: string;
    slackChannel: string | null;
    slackTs: string | null;
    siteMarkedPaid: boolean;
};

// ───────────────────────────── SQL ─────────────────────────────

/** 수강 중(ACTIVE)인 원생 + 다니는 반 이름. 병합돼 흡수된 원생은 뺀다. 조회 전용. */
const ROSTER_SQL = `SELECT s.id, s.name, array_agg(DISTINCT c.name) AS classes
                      FROM "Student" s
                      JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
                      JOIN "Class" c ON c.id = e."classId"
                     WHERE s."mergedIntoStudentId" IS NULL
                     GROUP BY s.id, s.name`;

/** 청구월의 월 수강료 청구서(결제수단·결제일 무관). 조회 전용. */
const MONTH_ROWS_SQL = `SELECT id, "studentId", amount, status, type, year, month
                          FROM "Payment"
                         WHERE type = 'MONTHLY' AND year = $1::int AND month = $2::int`;

/** 결제 1건 = 1줄. 같은 결제가 또 오면(주문 알림 + 결제 알림) DB 가 두 번째를 막는다. */
const INSERT_NOTICE_SQL = `INSERT INTO "PosPaymentNotice" (
        "tossPaymentId", "tossOrderId", "amount", "approvedAt", "lineItems", "memo",
        "resolvedStudentId", "targetYear", "targetMonth", "sitePaymentId", "kind", "status"
      ) VALUES ($1, $2, $3::bigint, $4::timestamptz, $5, $6, $7, $8::int, $9::int, $10, $11, 'PENDING')
      ON CONFLICT ("tossPaymentId") DO NOTHING
      RETURNING id`;

/**
 * 알림 읽기. approvedAt 은 timestamptz 라 AT TIME ZONE 을 **한 번만** 건다.
 * (무tz 컬럼이었다면 두 번 걸어야 한다 — 이 표는 timestamptz 로 만들었다.)
 */
export const NOTICE_SELECT_SQL = `SELECT n.id, n."tossPaymentId", n."tossOrderId", n.amount::float8 AS amount,
            COALESCE(to_char(n."approvedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'), '') AS "kstDateTime",
            COALESCE(to_char(n."approvedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD'), '') AS "kstDate",
            n."lineItems", n.memo, n."resolvedStudentId", s.name AS "studentName",
            n."targetYear", n."targetMonth", n."sitePaymentId", n.kind, n."pickedKind", n.status,
            n."slackChannel", n."slackTs", n."siteMarkedPaid"
       FROM "PosPaymentNotice" n
       LEFT JOIN "Student" s ON s.id = n."resolvedStudentId"
      WHERE n.id = $1`;

// ───────────────────────────── 도우미 ─────────────────────────────

const readEnv = (name: string) => (typeof process.env[name] === "string" ? (process.env[name] as string).trim() : "");

/** 에러 문구에 키가 새지 않도록 거른다. */
export function redact(message: string): string {
    const secrets = [
        process.env.TOSS_PLACE_ACCESS_KEY,
        process.env.TOSS_PLACE_ACCESS_SECRET,
        process.env.SLACK_BOT_TOKEN,
        process.env.SLACK_SIGNING_SECRET,
        process.env.DATABASE_URL,
        process.env.DIRECT_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    return redactSecrets(message, secrets).slice(0, 1000);
}

export async function loadRoster(): Promise<RosterStudent[]> {
    const rows = await prisma.$queryRawUnsafe<{ id: string; name: string; classes: string[] | null }[]>(ROSTER_SQL);
    return rows.map((r) => ({ id: r.id, name: r.name, classes: (r.classes ?? []).filter(Boolean) }));
}

export async function loadMonthRows(year: number | null, month: number | null): Promise<SiteRow[]> {
    if (year == null || month == null) return [];
    const rows = await prisma.$queryRawUnsafe<SiteRow[]>(MONTH_ROWS_SQL, year, month);
    return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function loadNotice(noticeId: string): Promise<NoticeRow | null> {
    const rows = await prisma.$queryRawUnsafe<NoticeRow[]>(NOTICE_SELECT_SQL, noticeId);
    const row = rows[0];
    return row ? { ...row, amount: Number(row.amount) } : null;
}

/** 저장해 둔 메모(" / " 로 이어 붙인 원문)에서 이름 후보를 다시 뽑는다. */
export function memoNamesFromStored(memo: string | null): string[] {
    const parts = String(memo ?? "").split(" / ").map((m) => ({ memo: m }));
    return parseMemoNames({ lineItems: parts }).names as string[];
}

/** 지금 화면에 보여야 할 분류(원장이 원생을 골랐으면 그 뒤의 분류). */
export function effectiveKind(notice: Pick<NoticeRow, "status" | "kind" | "pickedKind">): string {
    return notice.status === "STUDENT_CHOSEN" && notice.pickedKind ? notice.pickedKind : notice.kind;
}

/**
 * 알림 1건의 메시지(블록)를 DB 기준으로 다시 만든다.
 * resultLine 이 있으면 버튼 없이 결과만, warningLine 은 버튼을 남긴 채 경고만 붙인다.
 */
export async function renderNotice(
    notice: NoticeRow,
    extra: { resultLine?: string | null; warningLine?: string | null } = {},
): Promise<{ text: string; blocks: SlackBlock[] }> {
    const kind = effectiveKind(notice);
    let siteAmounts: number[] = [];
    let reason = "";
    let candidates: RosterStudent[] = [];
    let overflow = 0;

    // 원생이 정해져 있으면 금액 비교 문구를 위해 그 달 청구서를 다시 본다(표시용 · 조회 전용).
    if (!extra.resultLine && notice.resolvedStudentId && notice.targetYear != null) {
        const rows = rowsFor(await loadMonthRows(notice.targetYear, notice.targetMonth), notice.resolvedStudentId, notice.targetYear, notice.targetMonth);
        const target = resolveNoticeTarget(notice.memo ?? "", notice.kstDate) as { months: string[] };
        const check = invoiceKindOf({ rows, amount: notice.amount, multiMonth: target.months.length > 1, hasTarget: true });
        siteAmounts = check.siteAmounts;
        reason = check.reason;
    }
    // 원생 고르기 버튼 후보(반 이름이 같은 원생 + 메모 이름 후보)
    if (!extra.resultLine && PICK_KINDS.has(kind) && notice.status !== "STUDENT_CHOSEN") {
        const roster = await loadRoster();
        const who = whoOf({ memoRaw: notice.memo ?? "", memoNames: memoNamesFromStored(notice.memo), students: roster });
        const list = candidatesOf({
            kind,
            students: roster,
            classTitles: String(notice.lineItems ?? "").split(", "),
            nameCandidates: who.nameCandidates,
        });
        candidates = list.candidates;
        overflow = list.overflow;
    }

    return buildMessage({
        notice: {
            id: notice.id,
            amount: notice.amount,
            kstDateTime: notice.kstDateTime,
            lineItems: notice.lineItems,
            memo: notice.memo,
            targetYear: notice.targetYear,
            targetMonth: notice.targetMonth,
        },
        kind,
        picked: notice.status === "STUDENT_CHOSEN",
        studentName: notice.studentName,
        siteAmounts,
        reason,
        candidates,
        overflow,
        resultLine: extra.resultLine ?? null,
        warningLine: extra.warningLine ?? null,
    });
}

/** 이미 보낸 DM 을 고친다(버튼 제거·결과 줄). 채널·ts 가 없으면 아무것도 안 한다. */
export async function refreshNoticeMessage(
    notice: NoticeRow,
    extra: { resultLine?: string | null; warningLine?: string | null } = {},
    fallback: { channel?: string | null; ts?: string | null } = {},
): Promise<void> {
    const channel = notice.slackChannel ?? fallback.channel ?? null;
    const ts = notice.slackTs ?? fallback.ts ?? null;
    if (!channel || !ts) return;
    const message = await renderNotice(notice, extra);
    await updateMessage({ channel, ts, text: message.text, blocks: message.blocks });
}

// ───────────────────────────── DM 보내기 ─────────────────────────────

/**
 * 알림 1건을 DM 으로 보낸다. **한 결제에 DM 한 통**을 지키는 순서:
 *  ① 먼저 상태를 NOTIFIED 로 "선점"한다(조건부 UPDATE — 동시에 두 곳이 와도 한 곳만 성공)
 *  ② 보낸다  ③ 채널·ts 를 적는다.  실패하면 FAILED + 사유(스윕이 10분마다 다시 시도).
 * 선점 뒤 서버가 죽어 ts 가 비어 있는 NOTIFIED 는 5분이 지나면 다시 보낼 수 있다.
 */
export async function sendNotice(noticeId: string): Promise<"SENT" | "SKIPPED" | "FAILED"> {
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosPaymentNotice"
            SET status = 'NOTIFIED', error = NULL, "updatedAt" = now()
          WHERE id = $1
            AND (status IN ('PENDING', 'FAILED')
                 OR (status = 'NOTIFIED' AND "slackTs" IS NULL AND "updatedAt" < now() - interval '5 minutes'))
          RETURNING id`,
        noticeId,
    );
    if (claimed.length === 0) return "SKIPPED";

    try {
        const owner = readEnv("SLACK_OWNER_USER_ID");
        if (!owner) throw new Error("원장 슬랙 ID(SLACK_OWNER_USER_ID)가 설정되지 않아 DM 을 보내지 못했습니다.");
        const notice = await loadNotice(noticeId);
        if (!notice) return "SKIPPED";
        const message = await renderNotice(notice);
        const sent = await postMessage({ channel: owner, text: message.text, blocks: message.blocks });
        await prisma.$executeRawUnsafe(
            `UPDATE "PosPaymentNotice"
                SET "slackChannel" = $2, "slackTs" = $3, "updatedAt" = now()
              WHERE id = $1`,
            noticeId,
            sent.channel,
            sent.ts,
        );
        return "SENT";
    } catch (error) {
        const message = redact((error as Error).message);
        console.error("[pos-notice] DM 실패:", message, { noticeId });
        await prisma.$executeRawUnsafe(
            `UPDATE "PosPaymentNotice" SET status = 'FAILED', error = $2, "updatedAt" = now()
              WHERE id = $1 AND status = 'NOTIFIED' AND "slackTs" IS NULL`,
            noticeId,
            message,
        );
        return "FAILED";
    }
}

// ───────────────────────────── 웹훅 처리 ─────────────────────────────

async function markEvent(eventRowId: string, status: "RECEIVED" | "IGNORED", note: string) {
    await prisma.$executeRawUnsafe(
        `UPDATE "PosWebhookEvent"
            SET status = $2, note = $3, "processedAt" = now()
          WHERE id = $1 AND "processedAt" IS NULL`,
        eventRowId,
        status,
        note.slice(0, 1000),
    );
}

/** 처리 못 하고 남겨 둘 때(스윕이 다시 시도) 사유만 적는다. processedAt 은 비워 둔다. */
async function noteEvent(eventRowId: string, note: string) {
    await prisma.$executeRawUnsafe(
        `UPDATE "PosWebhookEvent" SET note = $2 WHERE id = $1 AND "processedAt" IS NULL`,
        eventRowId,
        note.slice(0, 1000),
    );
}

/**
 * 저장된 웹훅 1건을 처리한다: 주문 ID → 토스 재조회 → 카드·승인 결제마다 알림 기록 + DM.
 * 여러 번 불려도 안전하다(알림은 결제 ID 로, DM 은 선점 UPDATE 로 한 번만).
 */
export async function processPosWebhookEvent(eventRowId: string): Promise<{ notices: number; note: string }> {
    const events = await prisma.$queryRawUnsafe<{ id: string; eventType: string | null; payload: unknown; processedAt: Date | null }[]>(
        `SELECT id, "eventType", payload, "processedAt" FROM "PosWebhookEvent" WHERE id = $1`,
        eventRowId,
    );
    const event = events[0];
    if (!event || event.processedAt) return { notices: 0, note: "이미 처리됨" };

    const type = String(event.eventType ?? "");
    // 주문·결제 알림만 다룬다. 그 밖의 종류는 IGNORED 로 표시해 다시 보지 않는다.
    if (type && !type.startsWith("order.") && !type.startsWith("payment.")) {
        await markEvent(eventRowId, "IGNORED", `다루지 않는 알림 종류: ${type}`);
        return { notices: 0, note: "IGNORED" };
    }
    const { orderId, reason } = extractOrderIdFromWebhook(event.payload) as { orderId: string; reason: string };
    if (!orderId) {
        await markEvent(eventRowId, "IGNORED", reason);
        return { notices: 0, note: reason };
    }

    const accessKey = readEnv("TOSS_PLACE_ACCESS_KEY");
    const secretKey = readEnv("TOSS_PLACE_ACCESS_SECRET");
    const merchantId = readEnv("TOSS_PLACE_MERCHANT_ID");
    if (!accessKey || !secretKey || !/^\d+$/.test(merchantId)) {
        const note = "토스플레이스 접속 정보가 없어 주문을 조회하지 못했습니다(스윕이 다시 시도).";
        await noteEvent(eventRowId, note);
        return { notices: 0, note };
    }

    let order: unknown;
    try {
        ({ order } = await fetchTossOrderById({ merchantId, orderId, accessKey, secretKey }));
    } catch (error) {
        const note = `주문 조회 실패(스윕이 다시 시도): ${redact((error as Error).message)}`;
        await noteEvent(eventRowId, note);
        return { notices: 0, note };
    }

    const payments = extractNoticePayments(order) as ReturnType<typeof extractNoticePayments>;
    if (payments.length > 0) {
        const roster = await loadRoster();
        for (const p of payments) {
            const target = resolveNoticeTarget(p.memoRaw, p.kstDate) as { year: number | null; month: number | null };
            const result = classify({
                memoRaw: p.memoRaw,
                memoNames: p.memoNames,
                students: roster,
                amount: p.amount,
                kstDate: p.kstDate,
                siteRows: await loadMonthRows(target.year, target.month),
            });
            await prisma.$queryRawUnsafe<{ id: string }[]>(
                INSERT_NOTICE_SQL,
                p.tossPaymentId,
                p.tossOrderId,
                p.amount,
                p.approvedAtIso,
                p.lineItems || null,
                p.memoRaw || null,
                result.resolvedStudentId,
                result.targetYear,
                result.targetMonth,
                result.sitePaymentId,
                result.kind,
            );
            // 새로 넣었든 이미 있었든 id 를 찾아 DM 을 시도한다(이미 보냈으면 선점 UPDATE 가 막는다).
            const ids = await prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM "PosPaymentNotice" WHERE "tossPaymentId" = $1`,
                p.tossPaymentId,
            );
            if (ids[0]) await sendNotice(ids[0].id);
        }
    }
    const note = payments.length > 0 ? `카드 승인 결제 ${payments.length}건 알림` : "카드 승인 결제 없음";
    await markEvent(eventRowId, "RECEIVED", note);
    return { notices: payments.length, note };
}

// ───────────────────────────── 스윕(10분마다) ─────────────────────────────

/**
 * 놓친 것 줍기: ① 처리 안 된 웹훅(오래된 것부터 조금씩) ② DM 이 안 나간 알림.
 * 사흘/이레가 지난 것은 더 붙잡지 않는다(계속 실패하는 1건이 매번 시간을 먹지 않게).
 */
export async function runPosNoticeSweep(): Promise<{ events: number; sent: number; failed: number }> {
    const events = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "PosWebhookEvent"
          WHERE "processedAt" IS NULL AND status = 'RECEIVED'
            AND "receivedAt" > now() - interval '3 days'
          ORDER BY "receivedAt" ASC
          LIMIT 10`,
    );
    for (const e of events) {
        try {
            await processPosWebhookEvent(e.id);
        } catch (error) {
            console.error("[pos-notice-sweep] 웹훅 처리 실패:", redact((error as Error).message), { id: e.id });
        }
    }

    const pending = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "PosPaymentNotice"
          WHERE (status IN ('PENDING', 'FAILED')
                 OR (status = 'NOTIFIED' AND "slackTs" IS NULL AND "updatedAt" < now() - interval '5 minutes'))
            AND "createdAt" > now() - interval '7 days'
          ORDER BY "createdAt" ASC
          LIMIT 20`,
    );
    let sent = 0;
    let failed = 0;
    for (const n of pending) {
        const r = await sendNotice(n.id);
        if (r === "SENT") sent += 1;
        if (r === "FAILED") failed += 1;
    }
    return { events: events.length, sent, failed };
}

/** 원생을 고른 뒤·재확인 실패 뒤 다시 판정할 때 쓰는 공용 함수(버튼 처리에서 사용). */
export async function recheckForStudent(
    notice: Pick<NoticeRow, "amount" | "memo" | "kstDate" | "targetYear" | "targetMonth">,
    studentId: string,
) {
    const rows = rowsFor(await loadMonthRows(notice.targetYear, notice.targetMonth), studentId, notice.targetYear, notice.targetMonth);
    const target = resolveNoticeTarget(notice.memo ?? "", notice.kstDate) as { months: string[] };
    return invoiceKindOf({
        rows,
        amount: notice.amount,
        multiMonth: target.months.length > 1,
        hasTarget: notice.targetYear != null && notice.targetMonth != null,
    });
}

export { NOTICE_KIND };
