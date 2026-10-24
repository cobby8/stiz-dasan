import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { sendPushToUser, type PushDeliveryResult } from "@/lib/pushNotification";
import { PUSH_OUTBOX_LEASE_SECONDS, PUSH_OUTBOX_MAX_ATTEMPTS, pushRetryDelaySeconds, shouldRetryPush } from "@/lib/push-outbox-policy";

type PushPayload = { title: string; body: string; url?: string; tag?: string; retrySubscriptionIds?: string[] };
type ClaimedDelivery = { id: string; recipientUserId: string; payloadJSON: PushPayload; attemptCount: number; lockToken: string };
export type PushOutboxResult = { processed: number; sent: number; partial: number; skipped: number; retried: number; failed: number; lastPush: PushDeliveryResult | null };

function finalStatus(push: PushDeliveryResult) {
  if (push.status === "SENT") return "SENT";
  if (push.status === "PARTIAL") return "PARTIAL";
  if (push.status === "NO_SUBSCRIPTION" || push.status === "NOT_CONFIGURED") return "SKIPPED";
  return "FAILED";
}

async function claimPushDeliveries(limit: number, deliveryId?: string) {
  const lockToken = randomUUID();
  return prisma.$queryRawUnsafe<ClaimedDelivery[]>(
    `WITH exhausted AS (
       UPDATE "NotificationDelivery"
       SET status = 'FAILED', "failedAt" = NOW(), "errorCode" = 'PUSH_MAX_ATTEMPTS_EXHAUSTED',
           "payloadJSON" = NULL,
           "lockedAt" = NULL, "lockToken" = NULL, "updatedAt" = NOW()
       WHERE channel = 'PUSH' AND status = 'PENDING' AND "attemptCount" >= $1
         AND "lockedAt" IS NOT NULL AND "lockedAt" < NOW() - ($2 * INTERVAL '1 second')
       RETURNING id
     ), candidates AS (
       SELECT id FROM "NotificationDelivery"
       WHERE channel = 'PUSH' AND status = 'PENDING' AND "attemptCount" < $1
         AND COALESCE("nextAttemptAt", "createdAt") <= NOW()
         AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - ($2 * INTERVAL '1 second'))
         AND ($3::text IS NULL OR id = $3)
       ORDER BY COALESCE("nextAttemptAt", "createdAt"), "createdAt"
       FOR UPDATE SKIP LOCKED LIMIT $4
     )
     UPDATE "NotificationDelivery" d
     SET "lockedAt" = NOW(), "lockToken" = $5, "attemptCount" = d."attemptCount" + 1,
         "updatedAt" = NOW(), "errorCode" = NULL
     FROM candidates c WHERE d.id = c.id
     RETURNING d.id, d."recipientUserId", d."payloadJSON", d."attemptCount", d."lockToken"`,
    PUSH_OUTBOX_MAX_ATTEMPTS, PUSH_OUTBOX_LEASE_SECONDS, deliveryId ?? null,
    Math.max(1, Math.min(100, limit)), lockToken,
  );
}

async function completeClaim(claim: ClaimedDelivery, push: PushDeliveryResult) {
  const status = finalStatus(push);
  const errorCode = status === "SENT" ? null : push.errorCode ?? push.status;
  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery"
     SET status = $3, "sentAt" = CASE WHEN $3 IN ('SENT', 'PARTIAL') THEN NOW() ELSE NULL END,
         "failedAt" = CASE WHEN $3 IN ('FAILED', 'PARTIAL') THEN NOW() ELSE NULL END,
         "payloadJSON" = NULL,
         "errorCode" = $4, "lockedAt" = NULL, "lockToken" = NULL, "updatedAt" = NOW()
     WHERE id = $1 AND "lockToken" = $2`,
    claim.id, claim.lockToken, status, errorCode,
  );
  return status;
}

async function retryPartialClaim(claim: ClaimedDelivery, push: PushDeliveryResult) {
  const retryIds = push.failedSubscriptionIds ?? [];
  if (retryIds.length === 0 || claim.attemptCount >= PUSH_OUTBOX_MAX_ATTEMPTS) return false;
  const payloadJSON = { ...claim.payloadJSON, retrySubscriptionIds: retryIds };
  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery"
     SET status = 'PENDING', "payloadJSON" = $3::jsonb,
         "nextAttemptAt" = NOW() + ($4 * INTERVAL '1 second'),
         "sentAt" = NOW(), "failedAt" = NULL, "errorCode" = 'PARTIAL_DELIVERY_RETRY_SCHEDULED',
         "lockedAt" = NULL, "lockToken" = NULL, "updatedAt" = NOW()
     WHERE id = $1 AND "lockToken" = $2`,
    claim.id, claim.lockToken, JSON.stringify(payloadJSON), pushRetryDelaySeconds(claim.attemptCount),
  );
  return true;
}

async function failClaim(claim: ClaimedDelivery, error: unknown) {
  const errorCode = error instanceof Error ? error.message.slice(0, 200) : "PUSH_FAILED";
  const retry = claim.attemptCount < PUSH_OUTBOX_MAX_ATTEMPTS && shouldRetryPush(errorCode);
  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery"
     SET status = CASE WHEN $3 THEN 'PENDING' ELSE 'FAILED' END,
         "nextAttemptAt" = CASE WHEN $3 THEN NOW() + ($4 * INTERVAL '1 second') ELSE NULL END,
         "failedAt" = CASE WHEN $3 THEN NULL ELSE NOW() END,
         "errorCode" = $5, "payloadJSON" = CASE WHEN $3 THEN "payloadJSON" ELSE NULL END,
         "lockedAt" = NULL, "lockToken" = NULL, "updatedAt" = NOW()
     WHERE id = $1 AND "lockToken" = $2`,
    claim.id, claim.lockToken, retry, pushRetryDelaySeconds(claim.attemptCount), errorCode,
  );
  return retry;
}

export async function processPushOutbox(limit = 20, deliveryId?: string): Promise<PushOutboxResult> {
  const result: PushOutboxResult = { processed: 0, sent: 0, partial: 0, skipped: 0, retried: 0, failed: 0, lastPush: null };
  const claims = await claimPushDeliveries(limit, deliveryId);
  for (const claim of claims) {
    result.processed += 1;
    try {
      if (!claim.recipientUserId || !claim.payloadJSON?.title || !claim.payloadJSON?.body) throw new Error("INVALID_PUSH_OUTBOX_PAYLOAD");
      const { retrySubscriptionIds, ...publicPayload } = claim.payloadJSON;
      const push = await sendPushToUser(
        claim.recipientUserId,
        publicPayload,
        retrySubscriptionIds?.length ? { subscriptionIds: retrySubscriptionIds } : undefined,
      );
      result.lastPush = push;
      if (push.status === "FAILED") throw new Error(push.errorCode ?? "PUSH_DELIVERY_FAILED");
      if (push.status === "PARTIAL" && await retryPartialClaim(claim, push)) {
        result.partial += 1;
        result.retried += 1;
        continue;
      }
      const status = await completeClaim(claim, push);
      if (status === "SENT") result.sent += 1;
      else if (status === "PARTIAL") result.partial += 1;
      else result.skipped += 1;
    } catch (error) {
      if (await failClaim(claim, error)) result.retried += 1;
      else result.failed += 1;
    }
  }
  return result;
}
