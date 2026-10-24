/**
 * 알림 통합 유틸 — DB 인앱 알림 + 웹 Push + SMS 발송을 한 곳에서 관리
 *
 * admin.ts에 있던 createNotificationRecord를 공용으로 분리.
 * public.ts (비로그인 신청)에서도 관리자 알림을 보낼 수 있도록.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendPushToUser, sendPushToAllParents } from "@/lib/pushNotification";
import { sendSmsDetailed, type SmsSendResult } from "@/lib/sms";
import { renderSmsTemplate } from "@/lib/smsTemplate";
import {
    sendMessageDetailed,
    type MessageDispatchResult,
} from "@/lib/message-dispatch";
import type { MessageAudience, MessageChannel } from "@/lib/message-channel-policy";
import {
    claimMessageDelivery,
    finalizeMessageDelivery,
    finalizeMessageDeliveryBatch,
    hashMessageBody,
    hashMessageRecipientPhone,
    reserveMessageDelivery,
    reserveMessageDeliveryBatch,
    type MessageLedgerSource,
} from "@/lib/message-ledger";

type SmsAudience = "ADMIN" | "COACH" | "PARENT";

type SmsDeliveryOptions = {
    eventType: string;
    recipientPhone: string;
    body: string;
    trigger?: string;
    recipientRole: SmsAudience;
    eventId?: string;
    deliveryRunId?: string;
    recipientUserId?: string | null;
    requestedChannel?: MessageChannel;
    audienceScope?: "INTERNAL" | "EXTERNAL" | "SECURITY";
    forceSms?: boolean;
    source?: MessageLedgerSource;
};

type AutomationPolicy = {
    enabled: boolean;
    // requestedChannel은 관리자가 원래 선택한 채널이며 감사 이력에서 바꾸지 않는다.
    requestedChannel: MessageChannel;
    // deliveryChannel은 이번 호출에서 실제로 먼저 시도할 채널이다.
    deliveryChannel: MessageChannel;
    fallbackEnabled: boolean;
    fallbackChannel: "SMS" | "LMS" | null;
    preselectedFallback: boolean;
};

export async function getAutomationPolicy(input: SmsDeliveryOptions): Promise<AutomationPolicy> {
    if (input.source === "SECURITY") {
        return { enabled: true, requestedChannel: "SMS", deliveryChannel: "SMS", fallbackEnabled: false, fallbackChannel: null, preselectedFallback: false };
    }
    if (!input.trigger) {
        return { enabled: false, requestedChannel: "SMS", deliveryChannel: "SMS", fallbackEnabled: false, fallbackChannel: null, preselectedFallback: false };
    }
    try {
        const rows = await prisma.$queryRawUnsafe<Array<{
            isActive: boolean;
            requestedChannel: string;
            fallbackEnabled: boolean;
            fallbackChannel: string | null;
            channelEnabled: boolean | null;
            fallbackChannelEnabled: boolean | null;
        }>>(
            `SELECT r."isActive", r."requestedChannel", r."fallbackEnabled", r."fallbackChannel",
                    cs."isEnabled" AS "channelEnabled",
                    fallback_cs."isEnabled" AS "fallbackChannelEnabled"
               FROM "MessageAutomationRule" r
               LEFT JOIN "MessageChannelSetting" cs
                 ON cs."audienceScope" = r."audienceScope"
                AND cs.channel = r."requestedChannel"
               LEFT JOIN "MessageChannelSetting" fallback_cs
                 ON fallback_cs."audienceScope" = r."audienceScope"
                AND fallback_cs.channel = r."fallbackChannel"
              WHERE r.trigger = $1 LIMIT 1`,
            input.trigger,
        );
        if (!rows.length) {
            return { enabled: false, requestedChannel: "SMS", deliveryChannel: "SMS", fallbackEnabled: false, fallbackChannel: null, preselectedFallback: false };
        }
        const configuredRequested = rows[0].requestedChannel === "KAKAO_ALIMTALK"
            ? "ALIMTALK"
            : rows[0].requestedChannel;
        const requestedChannel = ["AUTO", "SMS", "LMS", "ALIMTALK", "RCS"].includes(configuredRequested)
            ? configuredRequested as MessageChannel
            : "SMS";
        const configuredChannelEnabled = rows[0].channelEnabled === true;
        const validFallback = rows[0].fallbackEnabled
            && rows[0].fallbackChannelEnabled === true
            && (rows[0].fallbackChannel === "SMS" || rows[0].fallbackChannel === "LMS")
            ? rows[0].fallbackChannel
            : null;
        if (!configuredChannelEnabled && !validFallback) {
            return { enabled: false, requestedChannel, deliveryChannel: requestedChannel, fallbackEnabled: false, fallbackChannel: null, preselectedFallback: false };
        }
        return {
            enabled: rows[0].isActive,
            requestedChannel,
            // 기본 채널이 꺼져 있으면 해당 공급자를 호출하지 않고 검증된 대체 채널부터 보낸다.
            deliveryChannel: configuredChannelEnabled ? requestedChannel : validFallback!,
            fallbackEnabled: configuredChannelEnabled && validFallback !== null,
            fallbackChannel: validFallback,
            preselectedFallback: !configuredChannelEnabled,
        };
    } catch {
        // 코드가 먼저 배포되고 마이그레이션이 뒤따르는 짧은 구간에도 기존 SMS는 유지한다.
        return { enabled: false, requestedChannel: "SMS", deliveryChannel: "SMS", fallbackEnabled: false, fallbackChannel: null, preselectedFallback: false };
    }
}

function applyAutomationPolicyAudit(
    result: MessageDispatchResult,
    policy: AutomationPolicy,
): MessageDispatchResult {
    return {
        ...result,
        // 공급자 호출 채널과 별개로 관리자가 원래 요청한 채널을 보존한다.
        requestedChannel: policy.requestedChannel,
        fallbackUsed: policy.preselectedFallback || result.fallbackUsed,
    };
}

function messageAudience(role: SmsAudience): MessageAudience {
    return role === "PARENT" ? "EXTERNAL" : "INTERNAL";
}

function messageAudienceScope(role: SmsAudience) {
    return role === "PARENT" ? "EXTERNAL" as const : "INTERNAL" as const;
}

function normalizeSmsPhone(phone: string) {
    return phone.replace(/\D/g, "");
}

function smsDedupeKey(input: SmsDeliveryOptions) {
    const recipientNo = normalizeSmsPhone(input.recipientPhone);
    const recipientHash = hashMessageRecipientPhone(recipientNo);
    const scope = input.deliveryRunId
        ? `${input.eventId || "manual"}:${input.deliveryRunId}`
        : input.eventId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return [
        "sms",
        input.eventType,
        scope,
        input.recipientRole,
        input.trigger || "fallback",
        recipientHash,
    ].join(":");
}

async function claimSmsDelivery(input: SmsDeliveryOptions): Promise<string | null | undefined> {
    const recipientNo = normalizeSmsPhone(input.recipientPhone);
    if (!recipientNo) return null;

    try {
        const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "NotificationDelivery" (
                id, "eventType", trigger, "audienceScope", "recipientUserId", "recipientPhone",
                channel, "requestedChannel", "dedupeKey", status, "attemptCount",
                "payloadJSON", "createdAt", "updatedAt"
             ) VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4, NULL,
                'SMS', $5, $6, 'PENDING', 1, $7::jsonb, NOW(), NOW()
             ) ON CONFLICT ("dedupeKey") DO UPDATE
               SET status = 'PENDING',
                   "attemptCount" = "NotificationDelivery"."attemptCount" + 1,
                   "failedAt" = NULL,
                   "errorCode" = NULL,
                   "updatedAt" = NOW()
               -- 성공·진행 중인 문자는 다시 보내지 않고, 실패가 확정된 건만 재시도한다.
               WHERE "NotificationDelivery".status = 'FAILED'
             RETURNING id`,
            input.eventType,
            input.trigger ?? null,
            input.audienceScope ?? messageAudienceScope(input.recipientRole),
            input.recipientUserId ?? null,
            input.requestedChannel ?? "SMS",
            smsDedupeKey(input),
            JSON.stringify({
                trigger: input.trigger ?? null,
                recipientRole: input.recipientRole,
                eventId: input.eventId ?? null,
                deliveryRunId: input.deliveryRunId ?? null,
                bodyLength: input.body.length,
            }),
        );
        return rows[0]?.id;
    } catch (error) {
        // 배포 순서가 코드→DB가 된 짧은 구간에는 새 통계 컬럼 없이도 기존 장부로 안전하게 기록한다.
        try {
            const legacyRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
                `INSERT INTO "NotificationDelivery" (
                    id, "eventType", "recipientUserId", "recipientPhone", channel, "dedupeKey",
                    status, "attemptCount", "payloadJSON", "createdAt", "updatedAt"
                 ) VALUES (
                    gen_random_uuid()::text, $1, $2, NULL, 'SMS', $3,
                    'PENDING', 1, $4::jsonb, NOW(), NOW()
                 ) ON CONFLICT ("dedupeKey") DO UPDATE
                   SET status = 'PENDING',
                       "attemptCount" = "NotificationDelivery"."attemptCount" + 1,
                       "failedAt" = NULL,
                       "errorCode" = NULL,
                       "updatedAt" = NOW()
                   WHERE "NotificationDelivery".status = 'FAILED'
                 RETURNING id`,
                input.eventType,
                input.recipientUserId ?? null,
                smsDedupeKey(input),
                JSON.stringify({
                    trigger: input.trigger ?? null,
                    recipientRole: input.recipientRole,
                    eventId: input.eventId ?? null,
                    deliveryRunId: input.deliveryRunId ?? null,
                    bodyLength: input.body.length,
                }),
            );
            return legacyRows[0]?.id;
        } catch (legacyError) {
            console.error("[SMS delivery log] claim failed:", error, legacyError);
            return null;
        }
    }
}

async function finishSmsDelivery(
    deliveryId: string | null | undefined,
    result: SmsSendResult | MessageDispatchResult,
): Promise<boolean> {
    if (!deliveryId) return false;
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "NotificationDelivery"
             SET status = $2,
                 "sentAt" = CASE WHEN $2 = 'SENT' THEN NOW() ELSE "sentAt" END,
                 "failedAt" = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE "failedAt" END,
                 "errorCode" = $3,
                 provider = $4,
                 "requestedChannel" = $5,
                 "messageType" = $6,
                 channel = $6,
                 "providerGroupId" = $7,
                 "providerMessageId" = $8,
                 "fallbackUsed" = $9,
                 "unitCost" = $10,
                 "fallbackChannel" = $11,
                 "providerStatus" = $12,
                 "updatedAt" = NOW()
             WHERE id = $1`,
            deliveryId,
            result.ok ? "SENT" : "FAILED",
            result.ok ? null : (result.reason || "SMS_FAILED").slice(0, 200),
            "provider" in result ? result.provider ?? null : null,
            "requestedChannel" in result ? result.requestedChannel : "SMS",
            "actualChannel" in result ? result.actualChannel : "SMS",
            "groupId" in result ? result.groupId ?? null : null,
            "messageId" in result ? result.messageId ?? null : null,
            "fallbackUsed" in result ? result.fallbackUsed : false,
            "estimatedCostWon" in result && result.ok ? result.estimatedCostWon : null,
            "fallbackUsed" in result && result.fallbackUsed && "actualChannel" in result
                ? result.actualChannel
                : null,
            result.ok ? "ACCEPTED" : "FAILED",
        );
        return true;
    } catch (error) {
        try {
            await prisma.$executeRawUnsafe(
                `UPDATE "NotificationDelivery"
                    SET status = $2,
                        "sentAt" = CASE WHEN $2 = 'SENT' THEN NOW() ELSE "sentAt" END,
                        "failedAt" = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE "failedAt" END,
                        "errorCode" = $3,
                        "updatedAt" = NOW()
                  WHERE id = $1`,
                deliveryId,
                result.ok ? "SENT" : "FAILED",
                result.ok ? null : (result.reason || "SMS_FAILED").slice(0, 200),
            );
            return true;
        } catch (legacyError) {
            console.error("[SMS delivery log] finish failed:", error, legacyError);
            return false;
        }
    }
}

async function claimLedgerSmsDelivery(input: SmsDeliveryOptions): Promise<{
    deliveryId: string | null;
    duplicateStatus?: string | null;
}> {
    const recipientNo = normalizeSmsPhone(input.recipientPhone);
    const triggerKey = input.trigger || "missing-trigger";
    const stableEventKey = input.deliveryRunId
        ? `${input.eventType}:${triggerKey}:${input.eventId || "event"}:${input.deliveryRunId}`
        : input.eventId ? `${input.eventType}:${triggerKey}:${input.eventId}` : "";
    if (!recipientNo || !stableEventKey) return { deliveryId: null };
    try {
        const source = input.source ?? "AUTO";
        const audienceScope = input.audienceScope ?? messageAudienceScope(input.recipientRole);
        const batchId = await reserveMessageDeliveryBatch({
            source,
            stableEventKey,
            audienceScope,
            trigger: input.trigger,
            purpose: input.eventType,
            body: input.body,
            requestedChannel: input.requestedChannel ?? "SMS",
        });
        if (!batchId) return { deliveryId: null };
        const reserved = await reserveMessageDelivery({
            batchId,
            source,
            stableEventKey,
            eventType: input.eventType,
            trigger: input.trigger,
            audienceScope,
            recipientUserId: input.recipientUserId,
            recipientPhone: recipientNo,
            body: input.body,
            requestedChannel: input.requestedChannel ?? "SMS",
        });
        return { deliveryId: reserved.deliveryId, duplicateStatus: reserved.existingStatus };
    } catch (error) {
        console.error("[SMS delivery ledger] claim failed:", error);
        return { deliveryId: null };
    }
}

async function finishLedgerSmsDelivery(
    deliveryId: string,
    result: SmsSendResult | MessageDispatchResult,
): Promise<boolean> {
    try {
        await finalizeMessageDelivery({
            deliveryId,
            ok: result.ok,
            provider: "provider" in result ? result.provider ?? null : null,
            requestedChannel: "requestedChannel" in result ? result.requestedChannel : "SMS",
            actualChannel: "actualChannel" in result ? result.actualChannel : "SMS",
            providerGroupId: "groupId" in result ? result.groupId ?? null : null,
            providerMessageId: "messageId" in result ? result.messageId ?? null : null,
            providerStatus: result.ok ? "ACCEPTED" : "FAILED",
            fallbackUsed: "fallbackUsed" in result ? result.fallbackUsed : false,
            fallbackChannel: "fallbackUsed" in result && result.fallbackUsed && "actualChannel" in result
                ? result.actualChannel : null,
            unitCost: "estimatedCostWon" in result && result.ok ? result.estimatedCostWon : null,
            errorCode: result.ok ? null : (result.reason || "SMS_FAILED").slice(0, 200),
        });
        const batchRows = await prisma.$queryRawUnsafe<Array<{ batchId: string | null }>>(
            `SELECT "batchId" FROM "NotificationDelivery" WHERE id = $1 LIMIT 1`,
            deliveryId,
        );
        if (batchRows[0]?.batchId) await finalizeMessageDeliveryBatch(batchRows[0].batchId);
        return true;
    } catch (error) {
        console.error("[SMS delivery ledger] finalize failed:", error);
        return false;
    }
}

async function sendSmsForNotification(input: SmsDeliveryOptions): Promise<SmsSendResult> {
    const recipientNo = normalizeSmsPhone(input.recipientPhone);
    const policy = await getAutomationPolicy(input);
    if (!policy.enabled) {
        return { ok: false, to: recipientNo, reason: "AUTOMATION_DISABLED" };
    }
    const requestedChannel = policy.requestedChannel;
    const deliveryInput: SmsDeliveryOptions = {
        ...input,
        requestedChannel,
        audienceScope: input.audienceScope ?? messageAudienceScope(input.recipientRole),
    };
    const claim = await claimLedgerSmsDelivery(deliveryInput);
    const deliveryId = claim.deliveryId;
    if (deliveryId === null && !claim.duplicateStatus) {
        // 장부를 확보하지 못한 문자는 성공 여부를 추적할 수 없으므로 공급자 호출도 하지 않는다.
        return { ok: false, to: recipientNo, reason: "문자 장부를 만들지 못해 발송 전 중단했습니다. 잠시 후 다시 시도해주세요." };
    }
    if (deliveryId === null) {
        return claim.duplicateStatus === "SENT"
            ? { ok: true, to: recipientNo, reason: "DUPLICATE_SKIPPED" }
            : {
                ok: false,
                to: recipientNo,
                reason: "문자 발송이 처리 중이거나 결과 확인이 필요합니다. 공급자·문자 장부를 확인한 뒤 재시도 여부를 판단해주세요.",
            };
    }
    const claimed = await claimMessageDelivery(deliveryId);
    if (!claimed.claimed) {
        return {
            ok: false,
            to: recipientNo,
            reason: "발송 건이 이미 처리 중이거나 결과 확인이 필요합니다.",
        };
    }

    const dispatchResult = await sendMessageDetailed({
        to: recipientNo,
        body: input.body,
        audience: messageAudience(input.recipientRole),
        requestedChannel: policy.deliveryChannel,
        fallbackEnabled: policy.fallbackEnabled,
        fallbackChannel: policy.fallbackChannel,
        forceSms: input.forceSms,
        // 승인된 알림톡 변수 계약이 연결되기 전에는 기존 SMS/LMS로만 안전하게 대체한다.
        alimtalk: undefined,
    });
    const result = applyAutomationPolicyAudit(dispatchResult, policy);
    const finalized = await finishLedgerSmsDelivery(deliveryId, result);
    if (!finalized) {
        // 공급자 호출 뒤 결과 장부를 확정하지 못하면 자동 재전송하지 않고 운영 확인 대상으로 남긴다.
        return {
            ok: false,
            to: recipientNo,
            reason: "발송 요청은 접수됐지만 결과 장부 확정에 실패했습니다. 자동 재전송하지 말고 공급자 내역을 확인해주세요.",
        };
    }
    return result;
}

export type TrackedSmsInput = SmsDeliveryOptions;

export async function sendTrackedSms(input: TrackedSmsInput): Promise<SmsSendResult> {
    return sendSmsForNotification(input);
}

export type NotificationSmsSummary = {
    sent: number;
    failed: number;
    adminSent: number;
    adminFailed: number;
    coachSent: number;
    coachFailed: number;
    errors: string[];
};

export type FailClosedSmsDeliveryResult = {
    ok: boolean;
    status: "SENT" | "FAILED" | "SKIPPED";
    deliveryId: string | null;
    errorCode?: string;
};

export type ReservedSmsDeliveryResult = {
    ok: boolean;
    status: "PENDING" | "FAILED" | "SKIPPED";
    deliveryId: string | null;
    errorCode?: string;
};

export type SmsDeliveryLeaseState = "PENDING" | "SENDING" | "FAILED_DELIVERY_UNCERTAIN" | "TERMINAL";

export function classifySmsDeliveryLease(input: { status: string; lockedAt?: Date | string | null }, now = new Date()): SmsDeliveryLeaseState {
    if (input.status === "PENDING") return "PENDING";
    if (input.status !== "SENDING") return "TERMINAL";
    if (!input.lockedAt) return "FAILED_DELIVERY_UNCERTAIN";
    return now.getTime() - new Date(input.lockedAt).getTime() >= 2 * 60_000
        ? "FAILED_DELIVERY_UNCERTAIN"
        : "SENDING";
}

export type SmsLedgerDb = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

function privateRecipientHash(phone: string) {
    return hashMessageRecipientPhone(phone);
}

function safeSmsErrorCode(result: SmsSendResult) {
    if (result.ok) return undefined;
    const reason = result.reason || "SMS_FAILED";
    if (reason.includes("environment variables")) return "SMS_NOT_CONFIGURED";
    if (reason.includes("timed out")) return "SMS_TIMEOUT";
    return "SMS_PROVIDER_FAILED";
}

export async function expireStaleSmsDeliveries(db: SmsLedgerDb = prisma): Promise<void> {
    await db.$executeRawUnsafe(
        `UPDATE "NotificationDelivery" SET status = 'FAILED', "failedAt" = NOW(), "lockedAt" = NULL,
                "lockToken" = NULL, "errorCode" = CASE WHEN status = 'SENDING' THEN 'FAILED_DELIVERY_UNCERTAIN' ELSE 'RESERVATION_EXPIRED' END,
                "updatedAt" = NOW()
          WHERE channel = 'SMS' AND ((status = 'SENDING' AND "lockedAt" < NOW() - INTERVAL '2 minutes')
             OR (status = 'PENDING' AND "createdAt" < NOW() - INTERVAL '15 minutes'))`,
    );
}

export async function reserveFailClosedSmsDelivery(
    db: SmsLedgerDb,
    input: Omit<TrackedSmsInput, "body">,
): Promise<ReservedSmsDeliveryResult> {
    const recipientNo = normalizeSmsPhone(input.recipientPhone);
    if (recipientNo.length < 10 || recipientNo.length > 11) {
        return { ok: false, status: "FAILED", deliveryId: null, errorCode: "INVALID_RECIPIENT" };
    }
    let recipientHash: string;
    try {
        recipientHash = privateRecipientHash(recipientNo);
    } catch {
        return { ok: false, status: "FAILED", deliveryId: null, errorCode: "PRIVACY_SECRET_MISSING" };
    }
    const scope = input.deliveryRunId ? `${input.eventId || "event"}:${input.deliveryRunId}` : input.eventId;
    if (!scope) return { ok: false, status: "FAILED", deliveryId: null, errorCode: "EVENT_ID_REQUIRED" };
    const source = input.source ?? "AUTO";
    const audienceScope = source === "SECURITY"
        ? "SECURITY"
        : input.audienceScope ?? messageAudienceScope(input.recipientRole);
    const dedupeKey = ["sms-private", input.eventType, scope, input.recipientRole, input.trigger || "fallback", recipientHash].join(":");
    try {
        await expireStaleSmsDeliveries(db);
        const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO "NotificationDelivery" (
                id, source, "stableEventKey", "eventType", trigger, "audienceScope",
                "recipientUserId", "recipientPhone", "recipientPhoneHash", "recipientPhoneLast4",
                channel, "requestedChannel", "dedupeKey", status,
                "attemptCount", "payloadJSON", "nextAttemptAt", "createdAt", "updatedAt"
             ) VALUES (
                gen_random_uuid()::text, $10, $1, $2, $3, $4,
                $5, NULL, $6, $7, 'SMS', 'SMS', $8, 'PENDING',
                0, $9::jsonb, NOW(), NOW(), NOW()
             )
             ON CONFLICT ("dedupeKey") DO NOTHING RETURNING id`,
            scope,
            input.eventType,
            input.trigger ?? null,
            audienceScope,
            input.recipientUserId ?? null,
            recipientHash,
            recipientNo.slice(-4),
            dedupeKey,
            JSON.stringify({ trigger: input.trigger ?? null, recipientRole: input.recipientRole, eventId: input.eventId, deliveryRunId: input.deliveryRunId ?? null, recipientHash }),
            source,
        );
        const deliveryId = rows[0]?.id ?? null;
        return deliveryId
            ? { ok: true, status: "PENDING", deliveryId }
            : { ok: true, status: "SKIPPED", deliveryId: null, errorCode: "DUPLICATE_SKIPPED" };
    } catch {
        return { ok: false, status: "FAILED", deliveryId: null, errorCode: "DELIVERY_LEDGER_UNAVAILABLE" };
    }
}

export async function dispatchReservedSmsDelivery(input: {
    deliveryId: string;
    recipientPhone: string;
    body: string;
}): Promise<FailClosedSmsDeliveryResult> {
    const recipientNo = normalizeSmsPhone(input.recipientPhone);
    if (recipientNo.length < 10 || recipientNo.length > 11) return { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: "INVALID_RECIPIENT" };
    const lockToken = randomUUID();
    const claimed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "NotificationDelivery" SET status = 'SENDING', "lockedAt" = NOW(), "lockToken" = $2,
                "attemptCount" = "attemptCount" + 1, "updatedAt" = NOW()
          WHERE id = $1 AND channel = 'SMS' AND status = 'PENDING' RETURNING id`,
        input.deliveryId, lockToken,
    ).catch(() => []);
    if (!claimed[0]) return { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: "DELIVERY_NOT_DISPATCHABLE" };

    const deliveryRows = await prisma.$queryRawUnsafe<Array<{
        source: "AUTO" | "SECURITY" | "MANUAL";
        trigger: string | null;
        eventType: string;
        stableEventKey: string | null;
        audienceScope: "INTERNAL" | "EXTERNAL" | "SECURITY" | null;
        recipientUserId: string | null;
    }>>(
        `SELECT source, trigger, "eventType", "stableEventKey", "audienceScope", "recipientUserId"
           FROM "NotificationDelivery" WHERE id = $1 LIMIT 1`,
        input.deliveryId,
    ).catch(() => []);
    const delivery = deliveryRows[0];
    const manualReconfirmation = delivery?.source === "MANUAL" && delivery.eventType === "KAKAO_RECONFIRMATION";
    if ((!delivery?.trigger && !manualReconfirmation) || !delivery?.stableEventKey) {
        await finalizeReservedSmsWithoutDispatch({
            deliveryId: input.deliveryId,
            status: "FAILED",
            errorCode: "AUTOMATION_RULE_REQUIRED",
        });
        return { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: "AUTOMATION_RULE_REQUIRED" };
    }
    // 수동 재확인 안내만 승인 감사기록과 현재 링크·수신자·문구를 다시 대조한다.
    if (manualReconfirmation) {
        const approved = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT a.id FROM "OperationsAuditLog" a
             JOIN "ParentOperationsRequestLink" l ON l.id=a."linkId"
             JOIN "Student" s ON s.id=l."studentId"
             JOIN "User" u ON u.id=s."parentId"
             WHERE a.action='KAKAO_RECONFIRMATION_SMS_APPROVED' AND a."actorUserId" IS NOT NULL
               AND l.id=$1 AND l."revokedAt" IS NULL AND l."lastUsedAt" IS NULL AND l."expiresAt">now()+interval '30 seconds'
               AND a."detailsJson"->>'phoneHash'=$2 AND a."detailsJson"->>'bodyHash'=$3
               AND a."detailsJson"->>'parentId'=s."parentId" AND a."detailsJson"->>'studentId'=s.id
               AND a."detailsJson"->>'tokenHash'=l."tokenHash" AND a."detailsJson"->>'channel'='SMS'
               AND regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g')=$4 LIMIT 1`,
            delivery.stableEventKey, privateRecipientHash(recipientNo), hashMessageBody(input.body), recipientNo,
        ).catch(() => []);
        if (!approved.length) {
            await finalizeReservedSmsWithoutDispatch({ deliveryId: input.deliveryId, status: "SKIPPED", errorCode: "MANUAL_APPROVAL_CHANGED" });
            return { ok: false, status: "SKIPPED", deliveryId: input.deliveryId, errorCode: "MANUAL_APPROVAL_CHANGED" };
        }
    }
    const policy = manualReconfirmation ? {
        enabled: true, requestedChannel: "SMS" as const, deliveryChannel: "SMS" as const,
        fallbackEnabled: false, fallbackChannel: null, preselectedFallback: false,
    } : await getAutomationPolicy({
        source: delivery.source,
        eventType: delivery.eventType,
        eventId: delivery.stableEventKey,
        recipientPhone: recipientNo,
        recipientRole: delivery.audienceScope === "INTERNAL" ? "ADMIN" : "PARENT",
        trigger: delivery.trigger ?? undefined,
        body: input.body,
    });
    if (!policy.enabled) {
        await finalizeReservedSmsWithoutDispatch({
            deliveryId: input.deliveryId,
            status: "SKIPPED",
            errorCode: "AUTOMATION_DISABLED",
        });
        return { ok: false, status: "SKIPPED", deliveryId: input.deliveryId, errorCode: "AUTOMATION_DISABLED" };
    }
    try {
        const batchId = await reserveMessageDeliveryBatch({
            source: delivery.source,
            stableEventKey: delivery.stableEventKey,
            audienceScope: delivery.audienceScope ?? "EXTERNAL",
            trigger: delivery.trigger,
            purpose: delivery.eventType,
            body: input.body,
            requestedChannel: policy.requestedChannel,
        });
        await prisma.$executeRawUnsafe(
            `UPDATE "NotificationDelivery"
                SET "batchId" = $2, "bodyHash" = $3, "requestedChannel" = $4, "updatedAt" = NOW()
              WHERE id = $1`,
            input.deliveryId,
            batchId,
            hashMessageBody(input.body),
            policy.requestedChannel,
        );
    } catch {
        await finalizeReservedSmsWithoutDispatch({
            deliveryId: input.deliveryId,
            status: "FAILED",
            errorCode: "DELIVERY_LEDGER_UNAVAILABLE",
        });
        return { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: "DELIVERY_LEDGER_UNAVAILABLE" };
    }
    const dispatchResult = await sendMessageDetailed({
        to: recipientNo,
        body: input.body,
        audience: delivery.audienceScope === "INTERNAL" ? "INTERNAL" : "EXTERNAL",
        requestedChannel: policy.deliveryChannel,
        fallbackEnabled: policy.fallbackEnabled,
        fallbackChannel: policy.fallbackChannel,
    });
    const result = applyAutomationPolicyAudit(dispatchResult, policy);
    const errorCode = safeSmsErrorCode(result);
    try {
        await finalizeMessageDelivery({
            deliveryId: input.deliveryId,
            ok: result.ok,
            provider: result.provider,
            requestedChannel: result.requestedChannel,
            actualChannel: result.actualChannel,
            providerGroupId: result.groupId,
            providerMessageId: result.messageId,
            providerStatus: result.ok ? "ACCEPTED" : "FAILED",
            fallbackUsed: result.fallbackUsed,
            fallbackChannel: result.fallbackUsed ? result.actualChannel : null,
            unitCost: result.ok ? result.estimatedCostWon : null,
            errorCode: errorCode ?? null,
        });
        const batchRows = await prisma.$queryRawUnsafe<Array<{ batchId: string | null }>>(
            `SELECT "batchId" FROM "NotificationDelivery" WHERE id = $1 LIMIT 1`,
            input.deliveryId,
        );
        if (batchRows[0]?.batchId) await finalizeMessageDeliveryBatch(batchRows[0].batchId);
    } catch {
        return { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: "FAILED_DELIVERY_UNCERTAIN" };
    }
    return result.ok ? { ok: true, status: "SENT", deliveryId: input.deliveryId } : { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode };
}

export async function finalizeReservedSmsWithoutDispatch(input: {
    deliveryId: string;
    status: "FAILED" | "SKIPPED";
    errorCode: string;
}): Promise<void> {
    await prisma.$executeRawUnsafe(
        `UPDATE "NotificationDelivery" SET status = $2, "failedAt" = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE NULL END,
                "errorCode" = $3, "nextAttemptAt" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND channel = 'SMS' AND status IN ('PENDING', 'SENDING')`,
        input.deliveryId, input.status, input.errorCode,
    );
}

/**
 * Privacy-preserving tracked SMS for operational flows.
 * The provider is never called unless the unique delivery ledger row was claimed.
 * Message text, URLs and the raw phone number stay in memory only.
 */
export async function sendFailClosedTrackedSms(input: TrackedSmsInput): Promise<FailClosedSmsDeliveryResult> {
    const { body, ...reservationInput } = input;
    const reserved = await reserveFailClosedSmsDelivery(prisma, reservationInput);
    if (reserved.status !== "PENDING" || !reserved.deliveryId) return reserved as FailClosedSmsDeliveryResult;
    return dispatchReservedSmsDelivery({ deliveryId: reserved.deliveryId, recipientPhone: input.recipientPhone, body });
}

// ── 슬롯 → 담당 코치 전화번호 조회 ─────────────────────────────────────────
// slotKey 배열로 해당 슬롯에 배정된 코치의 phone을 조회한다.
// ClassSlotOverride(기본 슬롯)와 CustomClassSlot(커스텀 슬롯) 양쪽 모두 확인.
// phone이 있는 코치만 반환하며, 중복 번호는 제거한다.
async function getCoachPhonesBySlotKeys(slotKeys: string[]): Promise<string[]> {
    if (slotKeys.length === 0) return [];

    try {
        const phones = new Set<string>();

        // 1) 정규 ScheduleSlot과 ClassSlotOverride에서 slotKey로 코치 조회
        // slotKey가 "Mon-4" 같은 기본 슬롯인 경우
        const placeholders1 = slotKeys.map((_, i) => `$${i + 1}`).join(",");
        const scheduleCoaches = await prisma.$queryRawUnsafe<{ phone: string }[]>(
            `SELECT DISTINCT c.phone
             FROM "ScheduleSlot" ss
             JOIN "Coach" c ON c.id = ss."coachId"
             WHERE ss."slotKey" IN (${placeholders1})
               AND c.phone IS NOT NULL AND c.phone != ''`,
            ...slotKeys,
        );
        for (const row of scheduleCoaches) {
            if (row.phone) phones.add(row.phone);
        }

        const overrideCoaches = await prisma.$queryRawUnsafe<{ phone: string }[]>(
            `SELECT DISTINCT c.phone
             FROM "ClassSlotOverride" o
             JOIN "Coach" c ON c.id = o."coachId"
             WHERE o."slotKey" IN (${placeholders1})
               AND c.phone IS NOT NULL AND c.phone != ''`,
            ...slotKeys,
        );
        for (const row of overrideCoaches) {
            if (row.phone) phones.add(row.phone);
        }

        // 2) CustomClassSlot에서 id로 코치 조회
        // slotKey가 "custom-uuid" 형태인 경우 CustomClassSlot.id로 매칭
        const customKeys = slotKeys.filter(k => k.startsWith("custom-"));
        if (customKeys.length > 0) {
            const placeholders2 = customKeys.map((_, i) => `$${i + 1}`).join(",");
            const customCoaches = await prisma.$queryRawUnsafe<{ phone: string }[]>(
                `SELECT DISTINCT c.phone
                 FROM "CustomClassSlot" cs
                 JOIN "Coach" c ON c.id = cs."coachId"
                 WHERE cs.id IN (${placeholders2})
                   AND c.phone IS NOT NULL AND c.phone != ''`,
                ...customKeys,
            );
            for (const row of customCoaches) {
                if (row.phone) phones.add(row.phone);
            }
        }

        return Array.from(phones);
    } catch (e) {
        console.error("[getCoachPhonesBySlotKeys] failed:", e);
        // 조회 장애를 "담당 코치 0명"으로 오인하지 않도록 상위 요약으로 전달한다.
        throw new Error("담당 코치 조회에 실패했습니다. 잠시 후 다시 확인해주세요.");
    }
}

// ── DB 인앱 알림 생성 + 푸시 발송 ───────────────────────────────────────────
// Notification 테이블에 레코드 저장 후, 해당 사용자에게 웹 Push도 전송
export async function createNotificationRecord(data: {
    userId: string;
    type: string;      // ATTENDANCE, NOTICE, PAYMENT, TRIAL_APPLICATION, ENROLL_APPLICATION 등
    title: string;
    message: string;
    linkUrl?: string;
}) {
    try {
        // 1. DB에 인앱 알림 저장 ($queryRawUnsafe — PgBouncer 호환)
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, false, NOW())`,
            data.userId, data.type, data.title, data.message, data.linkUrl || null,
        );
        // 2. 웹 Push 발송 (실패해도 무시 — 알림 저장은 이미 완료됨)
        sendPushToUser(data.userId, {
            title: data.title,
            body: data.message,
            url: data.linkUrl || "/admin",
            tag: data.type,
        }).catch(() => {});
    } catch (e) {
        console.error("[createNotificationRecord] failed:", e);
    }
}

// ── 모든 관리자(ADMIN)에게 알림 발송 ────────────────────────────────────────
// 인앱 알림 + 웹 Push + SMS(전화번호 있으면) 동시 발송
// 추가: Coach 중 phone이 등록된 코치에게도 SMS 발송 (인앱 알림은 User 계정이 없으므로 생략)
//
// smsOptions: 템플릿 기반 SMS를 사용할 경우 adminTrigger/coachTrigger + variables 전달
// 미전달 시 기존 하드코딩 방식으로 발송 (하위 호환)
export async function notifyAdmins(
    type: string,
    title: string,
    message: string,
    linkUrl?: string,
    smsOptions?: {
        adminTrigger?: string;      // 관리자용 SMS 템플릿 트리거
        coachTrigger?: string;      // 코치용 SMS 템플릿 트리거
        variables?: Record<string, string>; // 템플릿 변수
        slotKeys?: string[];        // 해당 슬롯 키 — 있으면 담당 코치에게만 SMS, 없으면 전체 코치
        requireMatchedCoach?: boolean; // true면 전체 코치 fallback 없이 담당자 미매칭을 실패로 반환
        notifyCoaches?: boolean;       // false면 관리자 알림만 만들고 코치 조회·SMS는 생략
        eventId?: string;           // 신청/청구 등 원본 ID — SMS 중복 발송 방지와 이력 조회용
        deliveryRunId?: string;     // 재발송 시 같은 eventId 아래 새 시도 기록을 남김
    },
): Promise<NotificationSmsSummary> {
    const emptySummary: NotificationSmsSummary = {
        sent: 0,
        failed: 0,
        adminSent: 0,
        adminFailed: 0,
        coachSent: 0,
        coachFailed: 0,
        errors: [],
    };
    try {
        // ADMIN + VICE_ADMIN 역할 사용자 조회 (phone도 가져옴 — SMS 발송용)
        // 부원장(VICE_ADMIN)도 관리자 알림을 받아야 함
        const admins = await prisma.$queryRawUnsafe<{ id: string; phone: string | null }[]>(
            `SELECT id, phone FROM "User" WHERE role IN ('ADMIN', 'VICE_ADMIN')`
        );

        // 관리자용 SMS 메시지 결정: 템플릿 우선, 없으면 하드코딩 fallback
        let adminSmsMsg: string | null = null;
        if (smsOptions?.adminTrigger && smsOptions.variables) {
            adminSmsMsg = await renderSmsTemplate(smsOptions.adminTrigger, smsOptions.variables);
        }
        // 템플릿이 비활성이거나 없으면 기존 방식 fallback
        const smsTasks: Array<{ audience: "ADMIN" | "COACH"; task: Promise<SmsSendResult> }> = [];

        for (const admin of admins) {
            // 인앱 알림 + 웹 Push
            await createNotificationRecord({
                userId: admin.id,
                type,
                title,
                message,
                linkUrl,
            });

            // SMS 발송 (전화번호가 있을 때만, 실패해도 무시)
            if (admin.phone && adminSmsMsg && smsOptions?.adminTrigger) {
                smsTasks.push({
                    audience: "ADMIN",
                    task: sendSmsForNotification({
                        eventType: type,
                        eventId: smsOptions?.eventId,
                        deliveryRunId: smsOptions?.deliveryRunId,
                        recipientUserId: admin.id,
                        recipientPhone: admin.phone,
                        recipientRole: "ADMIN",
                        trigger: smsOptions?.adminTrigger,
                        body: adminSmsMsg,
                    }),
                });
            }
        }

        // Coach SMS 발송: slotKeys가 있으면 해당 슬롯 담당 코치에게만, 없으면 전체 코치에게
        let coachPhones: string[];
        if (smsOptions?.notifyCoaches === false) {
            coachPhones = [];
        } else if (smsOptions?.slotKeys && smsOptions.slotKeys.length > 0) {
            // 슬롯에 배정된 담당 코치의 전화번호만 조회
            coachPhones = await getCoachPhonesBySlotKeys(smsOptions.slotKeys);
        } else if (!smsOptions?.requireMatchedCoach) {
            // 전체 코치에게 발송 (기존 동작)
            const coaches = await prisma.$queryRawUnsafe<{ phone: string }[]>(
                `SELECT phone FROM "Coach" WHERE phone IS NOT NULL AND phone != ''`
            );
            coachPhones = coaches.map(c => c.phone).filter(Boolean);
        } else {
            coachPhones = [];
        }
        if (smsOptions?.notifyCoaches !== false && smsOptions?.requireMatchedCoach && coachPhones.length === 0) {
            emptySummary.failed = 1;
            emptySummary.coachFailed = 1;
            emptySummary.errors.push(
                smsOptions.slotKeys?.length
                    ? "담당 코치의 문자 수신 번호를 찾지 못했습니다."
                    : "승인된 반에 담당 코치 슬롯이 지정되지 않았습니다.",
            );
        }

        // 코치용 SMS 메시지 결정
        let coachSmsMsg: string | null = null;
        if (smsOptions?.coachTrigger && smsOptions.variables) {
            coachSmsMsg = await renderSmsTemplate(smsOptions.coachTrigger, smsOptions.variables);
        }
        // ADMIN 사용자 phone과 중복되는 번호는 제외 (같은 번호로 두 번 발송 방지)
        const adminPhones = new Set(admins.map(a => a.phone).filter(Boolean));
        for (const phone of coachPhones) {
            if (phone && coachSmsMsg && smsOptions?.coachTrigger && !adminPhones.has(phone)) {
                smsTasks.push({
                    audience: "COACH",
                    task: sendSmsForNotification({
                        eventType: type,
                        eventId: smsOptions?.eventId,
                        deliveryRunId: smsOptions?.deliveryRunId,
                        recipientPhone: phone,
                        recipientRole: "COACH",
                        trigger: smsOptions?.coachTrigger,
                        body: coachSmsMsg,
                    }),
                });
            }
        }

        const settled = await Promise.allSettled(smsTasks.map((entry) => entry.task));
        return settled.reduce<NotificationSmsSummary>((summary, result, index) => {
            const audience = smsTasks[index].audience;
            const ok = result.status === "fulfilled" && result.value.ok;
            if (ok) {
                summary.sent += 1;
                if (audience === "ADMIN") summary.adminSent += 1;
                else summary.coachSent += 1;
            } else {
                summary.failed += 1;
                if (audience === "ADMIN") summary.adminFailed += 1;
                else summary.coachFailed += 1;
            }
            if (!ok) {
                const reason = result.status === "fulfilled" ? result.value.reason : "SMS_SEND_REJECTED";
                if (reason) summary.errors.push(reason);
            }
            return summary;
        }, { ...emptySummary, errors: [...emptySummary.errors] });
    } catch (e) {
        // 알림 실패가 비즈니스 로직을 중단시키면 안 됨
        console.error("[notifyAdmins] failed:", e);
        return {
            ...emptySummary,
            failed: 1,
            coachFailed: smsOptions?.notifyCoaches !== false && smsOptions?.requireMatchedCoach
                ? 1
                : emptySummary.coachFailed,
            errors: [
                e instanceof Error
                    ? e.message
                    : "알림 대상 조회 또는 발송 준비 중 오류가 발생했습니다.",
            ],
        };
    }
}

// ── 학부모에게 SMS 직접 발송 (전화번호 기반, 인앱 알림 아님) ─────────────────
// 학부모 PARENT 템플릿 발송용: parentPhone으로 직접 SMS 발송
// 실패해도 메인 로직에 영향 없음 (fire-and-forget)
export async function sendParentSms(
    parentPhone: string,
    trigger: string,
    variables: Record<string, string>,
    options?: { eventType?: string; eventId?: string; deliveryRunId?: string },
): Promise<void> {
    try {
        const msg = await renderSmsTemplate(trigger, variables);
        if (msg && parentPhone) {
            await sendSmsForNotification({
                eventType: options?.eventType || trigger,
                eventId: options?.eventId,
                deliveryRunId: options?.deliveryRunId,
                recipientPhone: parentPhone,
                recipientRole: "PARENT",
                trigger,
                body: msg,
            });
        }
    } catch (e) {
        console.error(`[sendParentSms] trigger=${trigger} failed:`, e);
    }
}

// 업무 상태 기록이 실제 발송 성공 여부에 의존할 때 사용하는 결과 반환형 함수다.
// 기존 sendParentSms의 void 계약은 유지해 다른 알림 경로의 동작을 바꾸지 않는다.
export async function sendParentSmsWithResult(
    parentPhone: string,
    trigger: string,
    variables: Record<string, string>,
    options: { eventType: string; eventId: string; deliveryRunId?: string; forceSms?: boolean },
): Promise<SmsSendResult> {
    const recipientNo = normalizeSmsPhone(parentPhone);
    try {
        const msg = await renderSmsTemplate(trigger, variables);
        if (!recipientNo) return { ok: false, to: recipientNo, reason: "INVALID_RECIPIENT" };
        if (!msg) return { ok: false, to: recipientNo, reason: "SMS_TEMPLATE_UNAVAILABLE" };

        return await sendSmsForNotification({
            ...options,
            recipientPhone: recipientNo,
            recipientRole: "PARENT",
            trigger,
            body: msg,
        });
    } catch (e) {
        console.error(`[sendParentSmsWithResult] trigger=${trigger} failed:`, e);
        return {
            ok: false,
            to: recipientNo,
            reason: e instanceof Error ? e.message : "SMS_SEND_FAILED",
        };
    }
}

// ── 특정 학생들의 학부모에게 알림 ───────────────────────────────────────────
// admin.ts에서도 사용하던 함수 — 여기로 이동하여 공용화
export async function notifyParentsOfStudents(
    studentIds: string[],
    type: string,
    title: string,
    message: string,
    linkUrl?: string,
) {
    try {
        if (studentIds.length === 0) return;
        const placeholders = studentIds.map((_, i) => `$${i + 1}`).join(",");
        const parents = await prisma.$queryRawUnsafe<Array<{ parentId?: string; parentid?: string }>>(
            `SELECT DISTINCT "parentId" FROM "Student" WHERE id IN (${placeholders})`,
            ...studentIds,
        );
        for (const p of parents) {
            const parentId = p.parentId ?? p.parentid;
            if (parentId) {
                await createNotificationRecord({ userId: parentId, type, title, message, linkUrl });
            }
        }
    } catch (e) {
        console.error("[notifyParentsOfStudents] failed:", e);
    }
}

// ── 모든 학부모에게 알림 (공지사항 등) ──────────────────────────────────────
export async function notifyAllParents(
    type: string,
    title: string,
    message: string,
    linkUrl?: string,
) {
    // 1) 인앱 알림을 "단일 INSERT ... SELECT"로 일괄 생성한다.
    //    학부모가 몇 명이든 DB 왕복 1회로 끝나므로, 기존의 258명 순차 INSERT가
    //    유발하던 서버리스 타임아웃(Vercel 30초 제한) 문제를 근본적으로 제거한다.
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
             SELECT gen_random_uuid()::text, u.id, $1, $2, $3, $4, false, NOW()
             FROM "User" u WHERE u.role = 'PARENT'`,
            type, title, message, linkUrl || null,
        );
    } catch (e) {
        console.error("[notifyAllParents] insert failed:", e);
    }

    // 2) 웹 푸시는 비차단(non-blocking)·베스트에포트로 전송한다.
    //    await 하지 않으므로 공지 등록 응답을 지연시키지 않는다.
    //    (구독이 없거나 VAPID 미설정이면 내부에서 즉시 반환)
    void sendPushToAllParents({
        title,
        body: message,
        url: linkUrl || "/notices",
        tag: type,
    }).catch((e) => console.error("[notifyAllParents] push failed:", e));
}
