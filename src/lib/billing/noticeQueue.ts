/**
 * 청구서 안내·미납 안내 «발송 대기열» — 순수 규칙 + DB 인자 연결부(2026-11-13).
 *
 * ■ 왜 바꿨나
 *   예전 sendInvoiceLinksForMonth 는 청구서 «발송됨»(sentAt)을 먼저 전부 찍고 문자를 한 통씩 보냈다.
 *   서버 60초 한도에 끊기면 뒷사람은 못 받았는데도 «발송됨»이 되어 다시 눌러도 안 나갔다.
 *
 * ■ 지금 흐름(가입 안내와 같은 대기열)
 *   1) 예약: 이 파일이 대상을 고르고(planInvoiceNotices / planUnpaidNotices) 연결표(BillingNoticeDelivery)에
 *      한 통씩 행을 만든 뒤 문자 대기열(reserveManualMessageQueue)에 넣는다. 같은 안내는 noticeKey 부분 유일 인덱스로 한 번만.
 *   2) 발송: 매분 cron(manual-message-dispatch)이 묶음으로 보낸다. 보내기 직전에 잠금·/admin/sms 규칙을 다시 본다
 *      (message-ledger 의 claimManualMessageQueue → checkBillingSendRule).
 *   3) 결과: 대기열 묶음이 정리될 때(finalizeMessageDeliveryBatch) applyBillingNoticeResults 가 «실제 성공(SENT)한 건만»
 *      청구서 sentAt·결제 notifiedAt(미납이면 lastReminderAt·reminderCount)을 찍는다. 실패한 건은 다시 누르면 이어 보낸다.
 *
 * ⚠️ 이 파일은 prisma·next 를 import 하지 않는다(테스트에서 가짜 DB 로 실행). DB 는 인자로 받는다.
 */
import { randomUUID } from "node:crypto";
import { isBillingParentSendEnabled } from "@/lib/billing/parentSendGuard";
import { isBillingQuietHour } from "@/lib/billing/quietHours";
import {
    BILLING_BUTTON_NAME,
    BILLING_LINK_BASE,
    billingPathForInvoices,
    buildBillingAlimtalkMessage,
    formatBillingDueDate,
} from "@/lib/messaging/parent-alimtalk-templates";

// ─────────────────────────────── 타입 ───────────────────────────────

/** raw SQL 두 개만 쓰는 최소 DB 모양(prisma 또는 트랜잭션 클라이언트) */
export type NoticeDb = {
    $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
};
/** 트랜잭션 실행기 — 연결부가 prisma.$transaction 을 감싸서 넘긴다 */
export type NoticeTx = <R>(fn: (db: NoticeDb) => Promise<R>) => Promise<R>;

export type BillingNoticeKind = "INVOICE" | "UNPAID";
export type BillingNoticeChannel = "ALIMTALK" | "SMS" | "APP_ONLY";
/** 발송 직전 다시 확인하는 규칙의 트리거(/admin/sms 문자 틀·자동 발송 규칙 이름) */
export type BillingGuardTrigger = "BILLING_INVOICE_PARENT" | "UNPAID_PARENT";

export const BILLING_NOTICE_TRIGGER: Record<BillingNoticeKind, BillingGuardTrigger> = {
    INVOICE: "BILLING_INVOICE_PARENT",
    UNPAID: "UNPAID_PARENT",
};

/** 같은 noticeKey 를 다시 예약하지 못하게 막는 «살아 있는» 상태 — 마이그레이션의 부분 유일 인덱스와 같은 집합 */
export const BILLING_NOTICE_ACTIVE_STATUSES = ["QUEUED", "SENT", "UNCERTAIN", "APP_ONLY"] as const;
/** 미납 안내 간격 — 마지막 미납 안내 뒤 이 날수가 지나야 다시 보낸다 */
export const UNPAID_REMINDER_INTERVAL_DAYS = 3;
/** 예약만 되고 대기열에 못 들어간 행을 «실패»로 돌리는 시간(분) — 다시 누르면 이어 보낸다 */
export const STALE_QUEUED_MINUTES = 10;
/**
 * 대기열에서 이만큼(시간) 넘게 기다린 청구 안내는 보내지 않고 만료한다(야간 대기 최대 11시간 + 여유).
 * cron 이 오래 멈췄다 살아났을 때 하루 지난 안내가 한꺼번에 나가지 않게 막는 상한이다.
 */
export const BILLING_NOTICE_MAX_WAIT_HOURS = 24;
export const BILLING_NOTICE_EXPIRED_CODE = "BILLING_NOTICE_EXPIRED";
/** 보내기 직전에 보니 이미 다 납부(또는 취소·환불)된 안내 — 보내지 않고 닫는다 */
export const BILLING_ALREADY_SETTLED_CODE = "BILLING_ALREADY_SETTLED";
/** «끝난» 결제 상태 — 이 상태만 남았으면 안내할 게 없다 */
export const BILLING_SETTLED_PAYMENT_STATUSES = ["PAID", "REFUNDED", "CANCELED"] as const;

/** 문자 대기열 한 칸(message-ledger 의 ManualQueueItem 과 같은 모양 + 연결용 id) */
export type BillingQueueItem = {
    recipient: string;
    body: string;
    deliveryId: string;
    guard: BillingGuardTrigger;
    kakao?: {
        kind: "ALIMTALK";
        templateId: string;
        variables: Record<string, string>;
        buttons?: Array<{ buttonName: string; buttonType: string; linkMo: string; linkPc?: string }>;
        smsBody: string;
    };
};

/** 학부모에게 나갈 안내 한 통(예약 전 계획) */
export type PlannedNotice = {
    noticeKey: string;
    studentId: string;
    studentName: string;
    parentId: string;
    invoiceIds: string[];
    paymentIds: string[];
    channel: BillingNoticeChannel;
    /** APP_ONLY 인 이유(번호 없음·틀 값 비어 있음) */
    reason?: "NO_PHONE" | "TEMPLATE_VALUES_MISSING";
    /** 문자·알림톡으로 보낼 때만 */
    recipient?: string;
    body?: string;
    kakao?: BillingQueueItem["kakao"];
    /** 앱 알림 금액 표시용 */
    amount: number;
    /** 같은 청구서로 예전에 예약한 적이 있으면 앱 알림을 다시 만들지 않는다(재시도 = 문자만) */
    hadPriorNotice: boolean;
};

export type UnlinkedNotice = { studentId: string; studentName: string; invoiceIds: string[]; paymentIds: string[] };

// ─────────────────────────────── 순수 규칙 ───────────────────────────────

/** 전화번호 숫자만 — 10~11자리가 아니면 빈 값(문자 대상 아님) */
export function normalizeNoticePhone(phone: string | null | undefined): string {
    const digits = String(phone ?? "").replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 11 ? digits : "";
}

/** 청구서 안내 열쇠 — 같은 청구서는 한 번만. 강제 재발송은 «그날 한 번»(두 번 눌러도 한 번) */
export function invoiceNoticeKey(invoiceId: string, resendYmd?: string | null): string {
    return resendYmd ? `invoice:${invoiceId}:resend:${resendYmd}` : `invoice:${invoiceId}`;
}

/**
 * 미납 안내 열쇠 — 한국 날짜 + 결제 id(정렬). 날짜가 들어가 있어서 3일 뒤 같은 묶음을 다시 보낼 수 있고,
 * 같은 날 두 번 누르면 같은 열쇠라 한 번만 나간다.
 */
export function unpaidNoticeKey(kstYmd: string, paymentIds: string[]): string {
    return `unpaid:${kstYmd}:${[...paymentIds].sort().join(",")}`;
}

/** 본문에 결제 링크가 없으면 «청구서 확인하기: 링크» 줄을 붙인다(관리자가 문구에서 링크 변수를 지워도 링크는 나가게) */
export function ensureBillingLink(body: string, link: string): string {
    return body.includes(link) ? body : `${body.trimEnd()}\n${BILLING_BUTTON_NAME}: ${link}`;
}

export type InvoiceNoticeRow = {
    invoiceId: string;
    paymentId: string;
    studentId: string;
    studentName: string | null;
    parentId: string | null;
    phone: string | null;
    amount: number | string | null;
    dueYmd: string | null;
    hadPriorNotice?: boolean | null;
};

/**
 * 청구서 안내 계획 — 청구서 한 장 = 안내 한 통.
 *  - 학부모 미연결 → unlinked(조용히 빠지지 않고 화면에 이름이 나온다)
 *  - 알림톡 id 있음 → 알림톡(거절되면 cron 이 같은 본문+링크를 문자로)
 *  - 알림톡 id 없음 → 같은 본문+링크를 문자(LMS)로
 *  - 번호 없음·틀 값 비어 있음 → 앱 알림만
 */
export function planInvoiceNotices(
    rows: InvoiceNoticeRow[],
    opts: { month: number; academyPhone: string; templateId: string; resendYmd?: string | null },
): { notices: PlannedNotice[]; unlinked: UnlinkedNotice[] } {
    const notices: PlannedNotice[] = [];
    const unlinked: UnlinkedNotice[] = [];
    for (const row of rows) {
        const studentName = String(row.studentName ?? "").trim();
        const base = {
            noticeKey: invoiceNoticeKey(row.invoiceId, opts.resendYmd),
            studentId: row.studentId,
            studentName,
            invoiceIds: [row.invoiceId],
            paymentIds: [row.paymentId],
            amount: Number(row.amount ?? 0) || 0,
            hadPriorNotice: Boolean(row.hadPriorNotice),
        };
        if (!row.parentId) {
            unlinked.push({ studentId: row.studentId, studentName, invoiceIds: base.invoiceIds, paymentIds: base.paymentIds });
            continue;
        }
        const parentId = row.parentId;
        let message: ReturnType<typeof buildBillingAlimtalkMessage>;
        try {
            message = buildBillingAlimtalkMessage("BILLING_INVOICE_PARENT", {
                childName: studentName,
                billingMonth: `${opts.month}월`,
                amount: base.amount.toLocaleString("ko-KR"),
                dueDate: formatBillingDueDate(row.dueYmd),
                academyPhone: opts.academyPhone,
            }, `payments/${row.invoiceId}`);
        } catch {
            // 학생명·납부기한이 비어 빈칸 문장이 될 때 — 문자는 보내지 않고 앱 알림만
            notices.push({ ...base, parentId, channel: "APP_ONLY", reason: "TEMPLATE_VALUES_MISSING" });
            continue;
        }
        const recipient = normalizeNoticePhone(row.phone);
        if (!recipient) {
            notices.push({ ...base, parentId, channel: "APP_ONLY", reason: "NO_PHONE" });
            continue;
        }
        if (opts.templateId) {
            notices.push({
                ...base, parentId, channel: "ALIMTALK", recipient, body: message.body,
                kakao: { kind: "ALIMTALK", templateId: opts.templateId, variables: message.variables, buttons: [message.button], smsBody: message.smsBody },
            });
        } else {
            // 알림톡 틀 id 가 아직 없을 때 — 같은 본문 + «청구서 확인하기: 링크» 를 문자(LMS)로
            notices.push({ ...base, parentId, channel: "SMS", recipient, body: message.smsBody });
        }
    }
    return { notices, unlinked };
}

export type UnpaidNoticeRow = {
    paymentId: string;
    invoiceId: string | null;
    studentId: string;
    studentName: string | null;
    parentId: string | null;
    phone: string | null;
    amount: number | string | null;
};

/**
 * 미납 안내 계획 — 한 학생의 미납을 한 통으로 묶는다.
 *  - 알림톡 id(ALIMTALK_TPL_BILLING_UNPAID) 있음 → 미납 알림톡(버튼 = 결제 링크)
 *  - 없거나 틀을 못 채움 → /admin/sms 의 미납 문자 틀(render) + 결제 링크 줄
 */
export function planUnpaidNotices(
    rows: UnpaidNoticeRow[],
    opts: {
        kstYmd: string;
        academyPhone: string;
        templateId: string;
        /** /admin/sms 미납 문자 틀을 변수로 채운 본문(연결부가 DB 틀로 만든다) */
        renderSms: (variables: Record<string, string>) => string;
    },
): { notices: PlannedNotice[]; unlinked: UnlinkedNotice[] } {
    const byStudent = new Map<string, { studentName: string; parentId: string | null; phone: string | null; paymentIds: string[]; invoiceIds: Array<string | null>; total: number }>();
    for (const row of rows) {
        let group = byStudent.get(row.studentId);
        if (!group) {
            group = { studentName: String(row.studentName ?? "").trim(), parentId: row.parentId, phone: row.phone, paymentIds: [], invoiceIds: [], total: 0 };
            byStudent.set(row.studentId, group);
        }
        group.paymentIds.push(row.paymentId);
        group.invoiceIds.push(row.invoiceId);
        group.total += Number(row.amount ?? 0) || 0;
    }
    const notices: PlannedNotice[] = [];
    const unlinked: UnlinkedNotice[] = [];
    for (const [studentId, group] of byStudent) {
        const paymentIds = [...group.paymentIds].sort();
        const invoiceIds = group.invoiceIds.filter((id): id is string => Boolean(id));
        if (!group.parentId) {
            unlinked.push({ studentId, studentName: group.studentName, invoiceIds, paymentIds });
            continue;
        }
        const path = billingPathForInvoices(group.invoiceIds);
        const link = `${BILLING_LINK_BASE}${path}`;
        const base = {
            noticeKey: unpaidNoticeKey(opts.kstYmd, paymentIds),
            studentId,
            studentName: group.studentName,
            parentId: group.parentId,
            invoiceIds,
            paymentIds,
            amount: group.total,
            hadPriorNotice: false,
        };
        const recipient = normalizeNoticePhone(group.phone);
        if (!recipient) {
            notices.push({ ...base, channel: "APP_ONLY", reason: "NO_PHONE" });
            continue;
        }
        const variables = {
            childName: group.studentName,
            unpaidCount: String(paymentIds.length),
            totalAmount: group.total.toLocaleString("ko-KR"),
            academyPhone: opts.academyPhone,
            paymentLink: link,
        };
        if (opts.templateId) {
            try {
                const message = buildBillingAlimtalkMessage("UNPAID_PARENT", variables, path);
                notices.push({
                    ...base, channel: "ALIMTALK", recipient, body: message.body,
                    kakao: { kind: "ALIMTALK", templateId: opts.templateId, variables: message.variables, buttons: [message.button], smsBody: message.smsBody },
                });
                continue;
            } catch {
                // 틀을 못 채우면 아래 문자로
            }
        }
        notices.push({ ...base, channel: "SMS", recipient, body: ensureBillingLink(opts.renderSms(variables), link) });
    }
    return { notices, unlinked };
}

/** /admin/sms 규칙 한 줄(문자 틀 + 자동 발송 규칙 + 채널 설정) */
export type BillingRuleRow = {
    templateActive: boolean | null;
    ruleActive: boolean | null;
    channelEnabled: boolean | null;
    fallbackEnabled: boolean | null;
    fallbackChannel: string | null;
    fallbackChannelEnabled: boolean | null;
};

export type BillingRuleDecision =
    | { ok: true }
    | { ok: false; code: "BILLING_PARENT_SEND_LOCKED" | "SMS_TEMPLATE_DISABLED" | "AUTOMATION_RULE_DISABLED" | "CHANNEL_DISABLED"; message: string };

/**
 * 청구 안내를 지금 보내도 되는가 — 예약할 때와 cron 이 실제로 보내기 직전에 «같은 함수»로 본다.
 * 판정은 notification.ts 의 getAutomationPolicy 와 같다(규칙 켜짐 + 기본 채널 켜짐 또는 문자 대체 채널 켜짐).
 */
export function decideBillingSendRule(row: BillingRuleRow | null | undefined, sendEnabled: boolean): BillingRuleDecision {
    if (!sendEnabled) return { ok: false, code: "BILLING_PARENT_SEND_LOCKED", message: "학부모 청구 안내 발송이 잠겨 있습니다(BILLING_PARENT_SEND_ENABLED)." };
    if (!row || row.templateActive !== true) {
        return { ok: false, code: "SMS_TEMPLATE_DISABLED", message: "/admin/sms 에서 이 안내의 문자 틀이 꺼져 있습니다." };
    }
    if (row.ruleActive !== true) {
        return { ok: false, code: "AUTOMATION_RULE_DISABLED", message: "/admin/sms 에서 이 안내의 자동 발송 규칙이 꺼져 있습니다." };
    }
    const fallbackOk = row.fallbackEnabled === true && row.fallbackChannelEnabled === true
        && (row.fallbackChannel === "SMS" || row.fallbackChannel === "LMS");
    if (row.channelEnabled !== true && !fallbackOk) {
        return { ok: false, code: "CHANNEL_DISABLED", message: "/admin/sms 에서 이 안내의 발송 채널이 꺼져 있습니다." };
    }
    return { ok: true };
}

export type NoticeProgressRow = { channel: string; status: string; errorCode?: string | null };
export type NoticeProgress = {
    total: number;
    queued: number;
    sent: number;
    failed: number;
    uncertain: number;
    appOnly: number;
    /** 보내기 전에 이미 납부·취소돼 보내지 않은 건(실패 아님) */
    settled: number;
    alimtalk: number;
    sms: number;
};

/** 화면 진행 상황(예약 N·발송 N·실패 N) — 같은 안내의 최신 행만 넘겨받는다 */
export function summarizeNoticeProgress(rows: NoticeProgressRow[]): NoticeProgress {
    const out: NoticeProgress = { total: rows.length, queued: 0, sent: 0, failed: 0, uncertain: 0, appOnly: 0, settled: 0, alimtalk: 0, sms: 0 };
    for (const row of rows) {
        if (row.status === "QUEUED") out.queued += 1;
        else if (row.status === "FAILED" && row.errorCode === BILLING_ALREADY_SETTLED_CODE) out.settled += 1;
        else if (row.status === "SENT") out.sent += 1;
        else if (row.status === "FAILED") out.failed += 1;
        else if (row.status === "UNCERTAIN") out.uncertain += 1;
        else if (row.status === "APP_ONLY") out.appOnly += 1;
        if (row.channel === "ALIMTALK") out.alimtalk += 1;
        else if (row.channel === "SMS") out.sms += 1;
    }
    return out;
}

/** 예약 결과 문구 — «알림톡 N통·문자 N통·앱 알림만 N건·대상 아님(학부모 미연결) N건» */
export function describeReservation(input: {
    label: string;
    queued: PlannedNotice[];
    skippedActive: number;
    unlinked: UnlinkedNotice[];
    /** 지금 시각(테스트용). 밤 9시~아침 8시(KST)면 «아침 8시에 보내집니다»로 안내한다 */
    nowMs?: number;
}): string {
    const alimtalk = input.queued.filter((n) => n.channel === "ALIMTALK").length;
    const sms = input.queued.filter((n) => n.channel === "SMS").length;
    const appOnly = input.queued.filter((n) => n.channel === "APP_ONLY").length;
    const parts = [
        `알림톡 ${alimtalk}통`,
        `문자 ${sms}통`,
        `앱 알림만 ${appOnly}건`,
        `대상 아님(학부모 미연결) ${input.unlinked.length}건`,
    ];
    // 야간(KST 21:00~08:00)에 예약하면 cron 이 아침 8시까지 기다린다 — 원장이 «왜 안 나가지?» 하지 않게 미리 알린다
    const when = isBillingQuietHour(input.nowMs ?? Date.now())
        ? "밤 9시~아침 8시라 아침 8시에 차례로 나갑니다"
        : "1~2분 안에 차례로 나갑니다";
    const head = alimtalk + sms > 0
        ? `${input.label} 발송을 예약했습니다(${when}).`
        : `${input.label} — 문자로 보낼 건은 없습니다.`;
    const names = input.unlinked.map((u) => u.studentName || "(이름 없음)");
    const unlinkedText = names.length > 0
        ? ` 학부모 미연결: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` 외 ${names.length - 10}명` : ""}.`
        : "";
    const skippedText = input.skippedActive > 0 ? ` 이미 예약·발송된 ${input.skippedActive}건은 다시 보내지 않았습니다.` : "";
    return `${head} ${parts.join(" · ")}.${unlinkedText}${skippedText}`;
}

// ─────────────────────────────── DB 연결부 ───────────────────────────────

/** /admin/sms 규칙 한 줄을 읽어 판정한다(예약 시점·cron 발송 시점 공용) */
export async function checkBillingSendRule(
    db: NoticeDb,
    trigger: BillingGuardTrigger,
    env: Record<string, string | undefined> = process.env,
): Promise<BillingRuleDecision> {
    const sendEnabled = isBillingParentSendEnabled(env);
    if (!sendEnabled) return decideBillingSendRule(null, false);
    const rows = await db.$queryRawUnsafe<BillingRuleRow[]>(
        `SELECT t."isActive" AS "templateActive", r."isActive" AS "ruleActive",
                cs."isEnabled" AS "channelEnabled", r."fallbackEnabled", r."fallbackChannel",
                fallback_cs."isEnabled" AS "fallbackChannelEnabled"
           FROM "SmsTemplate" t
           LEFT JOIN "MessageAutomationRule" r ON r.trigger = t.trigger
           LEFT JOIN "MessageChannelSetting" cs
             ON cs."audienceScope" = r."audienceScope" AND cs.channel = r."requestedChannel"
           LEFT JOIN "MessageChannelSetting" fallback_cs
             ON fallback_cs."audienceScope" = r."audienceScope" AND fallback_cs.channel = r."fallbackChannel"
          WHERE t.trigger = $1
          LIMIT 1`,
        trigger,
    );
    return decideBillingSendRule(rows[0], true);
}

const ACTIVE_STATUS_SQL = BILLING_NOTICE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * 미납 안내를 «다시 보내면 안 되는» 연결표 행 조건. 대상 조회(admin.ts)와 예약 잠금 안이 같은 조건을 쓴다.
 *  - QUEUED: 아직 나가는 중
 *  - UNCERTAIN: 갔는지 모름 → 기간 없이 막는다(청구서 안내와 같게 · 관리자 «결과 확인 필요»로 본다)
 *  - SENT·APP_ONLY: 3일 안에 이미 안내함
 * @param alias 연결표 별칭(예: "n")  @param daysParam 간격 날수 자리표(예: "$1")
 */
export function unpaidBlockingNoticeSql(alias: string, daysParam: string): string {
    return `${alias}.status IN ('QUEUED', 'UNCERTAIN')
         OR (${alias}.status IN ('SENT', 'APP_ONLY') AND ${alias}."createdAt" > NOW() - make_interval(days => ${daysParam}::int))`;
}

/**
 * 안내가 «실제로 전달된» 청구서·결제에 기록을 남긴다.
 *  - 청구서 안내: 청구서 sentAt(처음 한 번)·ISSUED→SENT, 결제 notifiedAt(처음 한 번)
 *  - 미납 안내: 위 + 결제·청구서 lastReminderAt·reminderCount+1 (3일 간격 판정의 기준)
 */
export async function markNoticeTargetsDelivered(db: NoticeDb, kind: BillingNoticeKind, invoiceIds: string[], paymentIds: string[]) {
    const reminder = kind === "UNPAID";
    if (invoiceIds.length > 0) {
        await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoice"
                SET "sentAt" = COALESCE("sentAt", NOW()),
                    status = CASE WHEN status = 'ISSUED' THEN 'SENT' ELSE status END,
                    ${reminder ? `"lastReminderAt" = NOW(), "reminderCount" = COALESCE("reminderCount", 0) + 1,` : ""}
                    "updatedAt" = NOW()
              WHERE id = ANY($1::text[])`,
            invoiceIds,
        );
    }
    if (paymentIds.length > 0) {
        await db.$executeRawUnsafe(
            `UPDATE "Payment"
                SET "notifiedAt" = COALESCE("notifiedAt", NOW()),
                    ${reminder ? `"lastReminderAt" = NOW(), "reminderCount" = COALESCE("reminderCount", 0) + 1,` : ""}
                    "updatedAt" = NOW()
              WHERE id = ANY($1::text[])`,
            paymentIds,
        );
    }
}

export type ReserveQueueFn = (input: {
    requestId: string;
    purpose: string;
    reason: string;
    body: string;
    recipients: string[];
    items: BillingQueueItem[];
}) => Promise<{ batchId: string }>;

/**
 * 안내 예약 — 연결표에 행을 만들고(같은 열쇠의 살아 있는 행이 있으면 건너뜀) 문자 대기열에 넣는다.
 * 앱 알림만 행은 그 자리에서 «전달됨»으로 기록한다(앱 알림은 이미 만들어졌으므로).
 * 대기열에 못 넣으면 행을 FAILED 로 돌려 다시 누르면 이어 보낼 수 있게 한다(문자는 하나도 안 나감).
 */
export async function reserveBillingNotices(input: {
    db: NoticeDb;
    tx: NoticeTx;
    kind: BillingNoticeKind;
    periodKey: string;
    notices: PlannedNotice[];
    actorUserId: string | null;
    reserveQueue: ReserveQueueFn;
    label: string;
    newId?: () => string;
}): Promise<{ queued: PlannedNotice[]; skippedActive: number; batchId: string | null; queueFailed: boolean }> {
    const newId = input.newId ?? randomUUID;
    const trigger = BILLING_NOTICE_TRIGGER[input.kind];
    const inserted = await input.tx(async (db) => {
        // 같은 종류의 예약은 한 번에 하나씩(두 사람이 동시에 눌러도 열쇠 검사가 겹치지 않게)
        await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `billing-notice:${input.kind}`);
        const queued: Array<PlannedNotice & { rowId: string; deliveryId: string | null }> = [];
        for (const notice of input.notices) {
            // 미납: 같은 결제가 들어 있는 «살아 있는» 안내가 있으면 건너뛴다(잠금 안에서 다시 확인 — 대상 조회와
            // 예약 사이에 다른 관리자가 예약했거나, 같은 날 묶음이 바뀌어 열쇠가 달라진 경우 · 검수 4번)
            if (input.kind === "UNPAID" && notice.paymentIds.length > 0) {
                const overlap = await db.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT n.id FROM "BillingNoticeDelivery" n
                      WHERE n.kind = 'UNPAID' AND n."paymentIds" && $1::text[]
                        AND (${unpaidBlockingNoticeSql("n", "$2")})
                      LIMIT 1`,
                    notice.paymentIds, UNPAID_REMINDER_INTERVAL_DAYS,
                );
                if (overlap.length > 0) continue;
            }
            const rowId = newId();
            const deliveryId = notice.channel === "APP_ONLY" ? null : newId();
            const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
                `INSERT INTO "BillingNoticeDelivery" (
                    id, kind, "noticeKey", "periodKey", "studentId", "studentName", "invoiceIds", "paymentIds",
                    channel, status, "deliveryId", "actorUserId", "createdAt", "updatedAt", "finalizedAt"
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10, $11, $12, NOW(), NOW(),
                           CASE WHEN $10 = 'APP_ONLY' THEN NOW() ELSE NULL END)
                 ON CONFLICT ("noticeKey") WHERE status IN (${ACTIVE_STATUS_SQL}) DO NOTHING
                 RETURNING id`,
                rowId, input.kind, notice.noticeKey, input.periodKey, notice.studentId, notice.studentName || null,
                notice.invoiceIds, notice.paymentIds, notice.channel,
                notice.channel === "APP_ONLY" ? "APP_ONLY" : "QUEUED", deliveryId, input.actorUserId,
            );
            if (rows.length > 0) queued.push({ ...notice, rowId, deliveryId });
        }
        // 앱 알림만 = 이미 전달된 것으로 본다(같은 트랜잭션 — 행과 기록이 함께 남거나 함께 안 남는다)
        const appOnly = queued.filter((n) => n.channel === "APP_ONLY");
        await markNoticeTargetsDelivered(
            db, input.kind,
            appOnly.flatMap((n) => n.invoiceIds),
            appOnly.flatMap((n) => n.paymentIds),
        );
        return queued;
    });

    const skippedActive = input.notices.length - inserted.length;
    const toQueue = inserted.filter((n) => n.channel !== "APP_ONLY" && n.deliveryId && n.recipient && n.body);
    if (toQueue.length === 0) {
        return { queued: inserted, skippedActive, batchId: null, queueFailed: false };
    }
    const items: BillingQueueItem[] = toQueue.map((n) => ({
        recipient: n.recipient!,
        body: n.body!,
        deliveryId: n.deliveryId!,
        guard: trigger,
        ...(n.kakao ? { kakao: n.kakao } : {}),
    }));
    let batchId: string;
    try {
        const queued = await input.reserveQueue({
            // 연결표 첫 행 id 로 요청 id 를 만든다 — 예약마다 다르고, 같은 예약을 두 번 넣지 않는다
            requestId: `billing-${input.kind.toLowerCase()}-${toQueue[0].rowId}`,
            purpose: input.label,
            reason: `${input.label} — 관리자 발송 예약(${input.periodKey})`,
            body: `${input.label} ${input.periodKey}`,
            recipients: items.map((item) => item.recipient),
            items,
        });
        batchId = queued.batchId;
    } catch (error) {
        console.error("[billing-notice] 문자 대기열 예약 실패", error);
        // ⚠️ 이미 대기열(NotificationDelivery)에 들어간 행은 QUEUED 그대로 둔다 — cron 이 보낼 것이므로
        // 여기서 FAILED 로 바꾸면 «다시 누르기»가 새 행을 만들어 두 통이 나간다(검수 H1 · 2026-11-13).
        // 예약 응답만 잃은 경우(커밋은 됐는데 연결이 끊김)도 같은 이유로 대기열 행 존재로 판단한다.
        const failedCount = await input.db.$executeRawUnsafe(
            `UPDATE "BillingNoticeDelivery"
                SET status = 'FAILED', "errorCode" = 'QUEUE_RESERVE_FAILED', "finalizedAt" = NOW(), "updatedAt" = NOW()
              WHERE id = ANY($1::text[]) AND status = 'QUEUED'
                AND NOT EXISTS (SELECT 1 FROM "NotificationDelivery" d WHERE d.id = "BillingNoticeDelivery"."deliveryId")`,
            toQueue.map((n) => n.rowId),
        ).catch(() => null);
        // 0행 = 전부 대기열에 들어가 있었다 → 실패가 아니다(결과 반영이 deliveryId 로 이어 붙인다)
        if (failedCount === 0) return { queued: inserted, skippedActive, batchId: null, queueFailed: false };
        return {
            queued: inserted.filter((n) => n.channel === "APP_ONLY"),
            skippedActive,
            batchId: null,
            queueFailed: true,
        };
    }
    // 묶음 번호 기록은 «있으면 좋은 정보»일 뿐 — 실패해도 예약은 성공이다(결과 반영은 대기열 행의 batchId·deliveryId 로 찾는다)
    try {
        await input.db.$executeRawUnsafe(
            `UPDATE "BillingNoticeDelivery" SET "batchId" = $2, "updatedAt" = NOW() WHERE id = ANY($1::text[])`,
            toQueue.map((n) => n.rowId), batchId,
        );
    } catch (error) {
        console.warn("[billing-notice] 묶음 번호 기록 실패(발송에는 영향 없음):", error instanceof Error ? error.message : error);
    }
    return { queued: inserted, skippedActive, batchId, queueFailed: false };
}

/**
 * 발송 결과 반영 — 문자 대기열(NotificationDelivery) 결과를 연결표로 옮기고, 성공한 건만 청구서·결제에 기록한다.
 * batchId 를 주면 그 묶음만, null 이면 전체(매일 cron 의 정리용 — 예약만 되고 대기열에 못 들어간 행도 실패로 돌린다).
 * 여러 번 불러도 결과가 같다(QUEUED 행만 바꾼다).
 */
export async function applyBillingNoticeResults(db: NoticeDb, tx: NoticeTx, batchId: string | null) {
    return tx(async (t) => {
        const settled = await t.$queryRawUnsafe<Array<{ kind: BillingNoticeKind; status: string; invoiceIds: string[]; paymentIds: string[] }>>(
            `UPDATE "BillingNoticeDelivery" n
                SET status = CASE WHEN d.status = 'SENT' THEN 'SENT'
                                  WHEN d.status IN ('FAILED', 'SKIPPED') THEN 'FAILED'
                                  ELSE 'UNCERTAIN' END,
                    "errorCode" = d."errorCode",
                    "finalizedAt" = NOW(),
                    "updatedAt" = NOW()
               FROM "NotificationDelivery" d
              WHERE d.id = n."deliveryId"
                AND n.status = 'QUEUED'
                AND d.status IN ('SENT', 'FAILED', 'SKIPPED', 'UNCERTAIN')
                AND ($1::text IS NULL OR d."batchId" = $1)  -- 대기열 행의 묶음 번호(연결표 batchId 기록이 실패해도 찾는다)
            RETURNING n.kind, n.status, n."invoiceIds", n."paymentIds"`,
            batchId,
        );
        // 예약만 되고 대기열 행이 끝내 안 생긴 것(서버가 중간에 끊김) — 실패로 돌려 다시 누르면 이어 보낸다
        const stale = await t.$executeRawUnsafe(
            `UPDATE "BillingNoticeDelivery" n
                SET status = 'FAILED', "errorCode" = 'QUEUE_NOT_RESERVED', "finalizedAt" = NOW(), "updatedAt" = NOW()
              WHERE n.status = 'QUEUED'
                AND n."createdAt" < NOW() - make_interval(mins => $2::int)
                AND ($1::text IS NULL OR n."batchId" = $1)
                AND NOT EXISTS (SELECT 1 FROM "NotificationDelivery" d WHERE d.id = n."deliveryId")`,
            batchId, STALE_QUEUED_MINUTES,
        );
        const result = { sent: 0, failed: 0, uncertain: 0, stale: Number(stale) || 0 };
        for (const kind of ["INVOICE", "UNPAID"] as const) {
            const sentRows = settled.filter((row) => row.kind === kind && row.status === "SENT");
            await markNoticeTargetsDelivered(
                t, kind,
                [...new Set(sentRows.flatMap((row) => row.invoiceIds ?? []))],
                [...new Set(sentRows.flatMap((row) => row.paymentIds ?? []))],
            );
        }
        for (const row of settled) {
            if (row.status === "SENT") result.sent += 1;
            else if (row.status === "FAILED") result.failed += 1;
            else result.uncertain += 1;
        }
        return result;
    });
}

/**
 * 보내기 직전 확인 — 이 대기열 행들 중 «안내 대상 결제가 전부 이미 끝난(납부·취소·환불)» 것의 id.
 * 청구서 안내(INVOICE)도 paymentIds 에 그 청구서의 결제가 들어 있어 같은 기준으로 본다.
 * 결제 목록이 비어 있는 행은 판단할 수 없으니 그대로 보낸다. (삭제된 결제 = 받을 돈 없음 → 끝난 것으로 본다)
 */
export async function findSettledBillingDeliveries(db: NoticeDb, deliveryIds: string[]): Promise<string[]> {
    if (deliveryIds.length === 0) return [];
    const settled = BILLING_SETTLED_PAYMENT_STATUSES.map((s) => `'${s}'`).join(", ");
    const rows = await db.$queryRawUnsafe<Array<{ deliveryId: string }>>(
        `SELECT n."deliveryId"
           FROM "BillingNoticeDelivery" n
          WHERE n."deliveryId" = ANY($1::text[])
            AND cardinality(n."paymentIds") > 0
            AND NOT EXISTS (
              SELECT 1 FROM "Payment" p
               WHERE p.id = ANY(n."paymentIds") AND p.status NOT IN (${settled})
            )`,
        deliveryIds,
    );
    return rows.map((row) => row.deliveryId);
}

/**
 * 너무 오래 기다린 청구 안내 대기열 행을 만료(FAILED)한다 — 돌려주는 값은 정리할 묶음 id.
 * 묶음 정리(finalizeMessageDeliveryBatch → applyBillingNoticeResults)가 연결표도 실패로 닫는다 → 다시 누르면 이어 보낸다.
 */
export async function expireOverdueBillingQueue(db: NoticeDb): Promise<string[]> {
    const rows = await db.$queryRawUnsafe<Array<{ batchId: string | null }>>(
        `UPDATE "NotificationDelivery" d
            SET status = 'FAILED', "errorCode" = $2, "failedAt" = NOW(), "payloadJSON" = NULL,
                "lockedAt" = NULL, "lockToken" = NULL, "updatedAt" = NOW()
          WHERE d.source = 'MANUAL' AND d.trigger = 'MANUAL_MESSAGE' AND d.status = 'PENDING'
            AND d."createdAt" < NOW() - make_interval(hours => $1::int)
            AND EXISTS (SELECT 1 FROM "BillingNoticeDelivery" bn WHERE bn."deliveryId" = d.id)
          RETURNING d."batchId"`,
        BILLING_NOTICE_MAX_WAIT_HOURS, BILLING_NOTICE_EXPIRED_CODE,
    );
    return [...new Set(rows.flatMap((row) => (row.batchId ? [row.batchId] : [])))];
}

/** 화면 진행 상황 — 같은 안내(noticeKey)는 가장 최근 행만 센다(실패 뒤 다시 보낸 건이 두 번 세지지 않게) */
export async function loadBillingNoticeProgress(
    db: NoticeDb,
    kind: BillingNoticeKind,
    periodKey: string,
    /** true 면 이 기간 밖의 «결과 확인 필요»(UNCERTAIN)도 함께 센다(미납 — 기간 없이 다시 보내기를 막으므로) */
    opts: { includeAllUncertain?: boolean } = {},
) {
    const rows = await db.$queryRawUnsafe<Array<NoticeProgressRow & { studentName: string | null; errorCode: string | null }>>(
        `SELECT DISTINCT ON ("noticeKey") channel, status, "studentName", "errorCode"
           FROM "BillingNoticeDelivery"
          WHERE kind = $1 AND ("periodKey" = $2 OR ($3::boolean AND status = 'UNCERTAIN'))
          ORDER BY "noticeKey", "createdAt" DESC`,
        kind, periodKey, opts.includeAllUncertain === true,
    );
    return {
        ...summarizeNoticeProgress(rows),
        // 이미 납부돼 안 보낸 건은 «실패» 이름에서 뺀다(다시 보낼 필요 없음)
        failedNames: rows.filter((r) => (r.status === "FAILED" && r.errorCode !== BILLING_ALREADY_SETTLED_CODE) || r.status === "UNCERTAIN").map((r) => r.studentName || "(이름 없음)").slice(0, 20),
    };
}
