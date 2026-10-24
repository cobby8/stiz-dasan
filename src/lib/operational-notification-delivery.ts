import { prisma } from "@/lib/prisma";
import { processPushOutbox } from "@/lib/push-outbox";
import type { PushDeliveryResult } from "@/lib/pushNotification";

export type OperationalNotificationDeliveryResult = {
  recipientUserId: string;
  duplicate: boolean;
  inAppCreated: boolean;
  inAppStatus: "SENT" | "FAILED";
  push: PushDeliveryResult | null;
  pushStatus: string | null;
  pushErrorCode: string | null;
  pushAttemptCount: number;
};

/**
 * 운영진 한 명에게 보내는 인앱 알림과 웹푸시를 채널별 장부에 남긴다.
 * 인앱 Notification과 IN_APP SENT 행은 같은 SQL 문장에서 만들어져 둘 중 하나만 남지 않는다.
 */
export async function deliverOperationalNotification(input: {
  stableEventKey: string;
  eventType: string;
  trigger: string;
  studentId?: string;
  recipientUserId: string;
  title: string;
  message: string;
  linkUrl: string;
}): Promise<OperationalNotificationDeliveryResult> {
  const baseDedupeKey = `${input.stableEventKey}:${input.recipientUserId}`;
  const claimed = await prisma.$queryRawUnsafe<{ inAppDeliveryId: string | null; pushDeliveryId: string | null }[]>(
    `WITH in_app_delivery AS (
       INSERT INTO "NotificationDelivery" (
         id, source, "stableEventKey", "eventType", trigger, "audienceScope",
         "studentId", "recipientUserId", channel, "requestedChannel", "dedupeKey",
         status, "attemptCount", "sentAt", "createdAt", "updatedAt"
       ) VALUES (
         gen_random_uuid()::text, 'AUTO', $1, $2, $3, 'INTERNAL',
         $4, $5, 'IN_APP', 'IN_APP', $6, 'SENT', 1, NOW(), NOW(), NOW()
       ) ON CONFLICT ("dedupeKey") DO NOTHING
       RETURNING id
     ), notification AS (
       INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
       SELECT gen_random_uuid()::text, $5, $2, $7, $8, $9, false, NOW()
       FROM in_app_delivery
     ), push_delivery AS (
       INSERT INTO "NotificationDelivery" (
         id, source, "stableEventKey", "eventType", trigger, "audienceScope",
         "studentId", "recipientUserId", channel, "requestedChannel", "dedupeKey",
         status, "attemptCount", "payloadJSON", "nextAttemptAt", "createdAt", "updatedAt"
       ) VALUES (
         gen_random_uuid()::text, 'AUTO', $1, $2, $3, 'INTERNAL',
         $4, $5, 'PUSH', 'PUSH', $10, 'PENDING', 0, $11::jsonb, NOW(), NOW(), NOW()
       ) ON CONFLICT ("dedupeKey") DO NOTHING
       RETURNING id
     )
     SELECT (SELECT id FROM in_app_delivery) AS "inAppDeliveryId",
            (SELECT id FROM push_delivery) AS "pushDeliveryId"`,
    input.stableEventKey,
    input.eventType,
    input.trigger,
    input.studentId ?? null,
    input.recipientUserId,
    `${baseDedupeKey}:in-app`,
    input.title,
    input.message,
    input.linkUrl,
    `${baseDedupeKey}:push`,
    JSON.stringify({ title: input.title, body: input.message, url: input.linkUrl, tag: input.eventType }),
  );
  const inAppCreated = Boolean(claimed[0]?.inAppDeliveryId);
  const pushDeliveryId = claimed[0]?.pushDeliveryId ?? null;

  if (!pushDeliveryId) {
    const existing = await prisma.$queryRawUnsafe<{ status: string; errorCode: string | null; attemptCount: number }[]>(
      `SELECT status, "errorCode", "attemptCount" FROM "NotificationDelivery" WHERE "dedupeKey" = $1 LIMIT 1`,
      `${baseDedupeKey}:push`,
    );
    return {
      recipientUserId: input.recipientUserId,
      duplicate: !inAppCreated,
      inAppCreated,
      inAppStatus: "SENT",
      push: null,
      pushStatus: existing[0]?.status ?? null,
      pushErrorCode: existing[0]?.errorCode ?? null,
      pushAttemptCount: existing[0]?.attemptCount ?? 0,
    };
  }

  const processed = await processPushOutbox(1, pushDeliveryId);
  const stored = await prisma.$queryRawUnsafe<{ status: string; errorCode: string | null; attemptCount: number }[]>(
    `SELECT status, "errorCode", "attemptCount" FROM "NotificationDelivery" WHERE id = $1 LIMIT 1`,
    pushDeliveryId,
  );
  return {
    recipientUserId: input.recipientUserId,
    duplicate: false,
    inAppCreated,
    inAppStatus: "SENT",
    push: processed.lastPush,
    pushStatus: stored[0]?.status ?? null,
    pushErrorCode: stored[0]?.errorCode ?? null,
    pushAttemptCount: stored[0]?.attemptCount ?? 0,
  };
}
