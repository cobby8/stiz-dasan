import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type MessageLedgerSource = "AUTO" | "MANUAL" | "SECURITY";

function privacySecret() {
  const value = process.env.MESSAGE_PRIVACY_HMAC_SECRET?.trim();
  if (value && Buffer.byteLength(value, "utf8") >= 32) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("MESSAGE_PRIVACY_HMAC_SECRET_INVALID");
  }
  const developmentValue =
    value ||
    process.env.NOTIFICATION_PRIVACY_SECRET?.trim() ||
    process.env.PARENT_ACCOUNT_CLAIM_SECRET?.trim() ||
    process.env.INVITE_OTP_SECRET?.trim() ||
    "development-only-notification-privacy-secret";
  return Buffer.byteLength(developmentValue, "utf8") >= 32
    ? developmentValue
    : "development-only-notification-privacy-secret";
}

export function normalizeMessagePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

/** 전화번호 원문 대신 검색·중복 제거에 사용할 비가역 HMAC을 만듭니다. */
export function hashMessageRecipientPhone(phone: string) {
  return createHmac("sha256", privacySecret())
    .update(normalizeMessagePhone(phone))
    .digest("hex");
}

/** 본문 원문을 장부에 남기지 않고 어떤 문안이 발송됐는지만 확인합니다. */
export function hashMessageBody(body: string) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function messagePhoneLast4(phone: string) {
  return normalizeMessagePhone(phone).slice(-4) || null;
}

type ManualQueuePayload = { recipient: string; body: string };

function queueEncryptionKey() {
  return createHash("sha256").update(privacySecret(), "utf8").digest();
}

function sealManualQueuePayload(payload: ManualQueuePayload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", queueEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
}

function openManualQueuePayload(value: unknown): ManualQueuePayload {
  const payload = value as { v?: number; iv?: string; tag?: string; data?: string };
  if (payload?.v !== 1 || !payload.iv || !payload.tag || !payload.data) throw new Error("MANUAL_QUEUE_PAYLOAD_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", queueEncryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8"));
}

/** 관리자 대량 문자를 하나의 트랜잭션으로 예약합니다. 같은 requestId의 재요청은 기존 배치를 반환합니다. */
export async function reserveManualMessageQueue(input: {
  requestId: string; actorUserId: string; actorName?: string | null; purpose: string; reason: string;
  audienceScope: "INTERNAL" | "EXTERNAL"; body: string; recipients: string[];
}) {
  const stableEventKey = `manual:bulk:${input.actorUserId}:${input.requestId}`;
  const recipientSetHash = createHash("sha256").update(input.recipients.join(","), "utf8").digest("hex");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, stableEventKey);
    const existing = await tx.$queryRawUnsafe<Array<{ id: string; bodyHash: string | null; totalCount: number; recipientSetHash: string | null }>>(
      `SELECT id, "bodyHash", "totalCount", "metadataJSON"->>'recipientSetHash' AS "recipientSetHash" FROM "MessageDeliveryBatch" WHERE source='MANUAL' AND "stableEventKey"=$1 ORDER BY "createdAt" DESC LIMIT 1`, stableEventKey,
    );
    if (existing[0]) {
      if (existing[0].bodyHash !== hashMessageBody(input.body) || existing[0].totalCount !== input.recipients.length || existing[0].recipientSetHash !== recipientSetHash) {
        throw new Error("같은 요청 ID에 다른 발송 내용이 사용되었습니다.");
      }
      return { batchId: existing[0].id, created: false };
    }
    const batchId = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO "MessageDeliveryBatch" (id,source,"audienceScope",trigger,"actorUserId","actorName",purpose,reason,"bodyHash","stableEventKey","requestedChannel",status,"totalCount","successCount","failureCount","metadataJSON","createdAt","updatedAt") VALUES ($1,'MANUAL',$2,'MANUAL_MESSAGE',$3,$4,$5,$6,$7,$8,'SMS','PROCESSING',$9,0,0,$10::jsonb,NOW(),NOW())`,
      batchId, input.audienceScope, input.actorUserId, input.actorName ?? null, input.purpose, input.reason,
      hashMessageBody(input.body), stableEventKey, input.recipients.length, JSON.stringify({ recipientSetHash }),
    );
    for (const recipient of input.recipients) {
      const phoneHash = hashMessageRecipientPhone(recipient);
      await tx.$executeRawUnsafe(
        `INSERT INTO "NotificationDelivery" (id,"batchId",source,"stableEventKey","eventType",trigger,"audienceScope","recipientPhoneHash","recipientPhoneLast4","bodyHash",channel,"requestedChannel","dedupeKey",status,"attemptCount","payloadJSON","createdAt","updatedAt") VALUES ($1,$2,'MANUAL',$3,'MANUAL_MESSAGE','MANUAL_MESSAGE',$4,$5,$6,$7,'SMS','SMS',$8,'PENDING',0,$9::jsonb,NOW(),NOW())`,
        randomUUID(), batchId, stableEventKey, input.audienceScope, phoneHash, messagePhoneLast4(recipient),
        hashMessageBody(input.body), buildMessageDedupeKey({ source: "MANUAL", eventKey: stableEventKey, recipientPhoneHash: phoneHash }),
        JSON.stringify(sealManualQueuePayload({ recipient, body: input.body })),
      );
    }
    return { batchId, created: true };
  });
}

export async function claimManualMessageQueue(limit = 10) {
  return prisma.$transaction(async (tx) => {
    // 공급자 호출 뒤 서버가 끊겼을 수 있으므로 stale SENDING은 절대 재전송하지 않습니다.
    const stale = await tx.$queryRawUnsafe<Array<{ batchId: string | null }>>(
      `UPDATE "NotificationDelivery" SET status='UNCERTAIN', "errorCode"='STALE_SENDING_UNCERTAIN', "payloadJSON"=NULL, "lockedAt"=NULL, "lockToken"=NULL, "updatedAt"=NOW() WHERE source='MANUAL' AND trigger='MANUAL_MESSAGE' AND status='SENDING' AND COALESCE("providerStatus",'') <> 'ACCEPTED' AND "lockedAt" < NOW() - INTERVAL '10 minutes' RETURNING "batchId"`,
    );
    const finalizeBatchIds = new Set(stale.flatMap((row) => row.batchId ? [row.batchId] : []));
    const token = randomUUID();
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; batchId: string; payloadJSON: unknown }>>(
      `WITH next_batch AS (
         SELECT "batchId" FROM "NotificationDelivery"
          WHERE source='MANUAL' AND trigger='MANUAL_MESSAGE' AND status='PENDING' AND "payloadJSON" IS NOT NULL
          ORDER BY "createdAt" ASC LIMIT 1
       ), picked AS (
         SELECT id FROM "NotificationDelivery"
          WHERE source='MANUAL' AND trigger='MANUAL_MESSAGE' AND status='PENDING' AND "payloadJSON" IS NOT NULL
            AND "batchId"=(SELECT "batchId" FROM next_batch)
          ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT $1
       ) UPDATE "NotificationDelivery" d SET status='SENDING', "lockedAt"=NOW(), "lockToken"=$2,
           "attemptCount"="attemptCount"+1, "updatedAt"=NOW()
         FROM picked WHERE d.id=picked.id RETURNING d.id, d."batchId", d."payloadJSON"`,
      Math.max(1, Math.min(limit, 500)), token,
    );
    const claimed: Array<{ id: string; batchId: string; recipient: string; body: string }> = [];
    for (const row of rows) {
      try {
        claimed.push({ id: row.id, batchId: row.batchId, ...openManualQueuePayload(row.payloadJSON) });
      } catch {
        // 손상된 한 행 때문에 정상 큐 전체가 롤백되지 않도록 해당 행만 안전 격리합니다.
        await tx.$executeRawUnsafe(
          `UPDATE "NotificationDelivery" SET status='UNCERTAIN', "errorCode"='QUEUE_PAYLOAD_DECRYPT_FAILED', "payloadJSON"=NULL, "lockedAt"=NULL, "lockToken"=NULL, "updatedAt"=NOW() WHERE id=$1`,
          row.id,
        );
        finalizeBatchIds.add(row.batchId);
      }
    }
    for (const row of claimed) finalizeBatchIds.add(row.batchId);
    return { items: claimed, finalizeBatchIds: [...finalizeBatchIds] };
  });
}

/** Solapi가 묶음 요청을 접수한 상태입니다. 최종 성공은 결과 조회 뒤에만 확정합니다. */
export async function markManualMessageAccepted(input: {
  deliveryId: string;
  providerGroupId: string;
  providerMessageId?: string | null;
  messageType?: string | null;
}) {
  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery"
        SET status='SENDING', provider='SOLAPI', "providerGroupId"=$2, "providerMessageId"=$3,
            "providerStatus"='ACCEPTED', "messageType"=COALESCE($4,"messageType"),
            "payloadJSON"=NULL, "lockedAt"=NULL, "lockToken"=NULL, "updatedAt"=NOW()
      WHERE id=$1 AND source='MANUAL' AND trigger='MANUAL_MESSAGE' AND status='SENDING'`,
    input.deliveryId, input.providerGroupId, input.providerMessageId ?? null, input.messageType ?? null,
  );
}

export async function markManualMessageUncertain(deliveryIds: string[], errorCode: string) {
  if (deliveryIds.length === 0) return;
  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery" SET status='UNCERTAIN', "errorCode"=$2, "payloadJSON"=NULL,
        "lockedAt"=NULL, "lockToken"=NULL, "updatedAt"=NOW()
      WHERE id = ANY($1::text[]) AND status='SENDING'`,
    deliveryIds, errorCode.slice(0, 500),
  );
}

/** 최종 결과를 기다리는 Solapi 그룹을 개인정보 없이 조회합니다. */
export async function getPendingManualSolapiGroups(limit = 20) {
  return prisma.$queryRawUnsafe<Array<{ providerGroupId: string; batchId: string }>>(
    `SELECT "providerGroupId", MIN("batchId") AS "batchId"
       FROM "NotificationDelivery"
      WHERE source='MANUAL' AND trigger='MANUAL_MESSAGE' AND status='SENDING'
        AND provider='SOLAPI' AND "providerStatus"='ACCEPTED' AND "providerGroupId" IS NOT NULL
      GROUP BY "providerGroupId" ORDER BY MIN("updatedAt") ASC LIMIT $1`,
    Math.max(1, Math.min(limit, 100)),
  );
}

export async function getPendingManualSolapiDeliveries(groupId: string) {
  return prisma.$queryRawUnsafe<Array<{ id: string; providerMessageId: string | null; batchId: string; acceptedAt: Date }>>(
    `SELECT id,"providerMessageId","batchId","updatedAt" AS "acceptedAt" FROM "NotificationDelivery"
      WHERE source='MANUAL' AND trigger='MANUAL_MESSAGE' AND status='SENDING'
        AND provider='SOLAPI' AND "providerStatus"='ACCEPTED' AND "providerGroupId"=$1`,
    groupId,
  );
}

export async function finalizeManualSolapiResult(input: {
  deliveryId: string; ok: boolean; providerStatus: string; errorCode?: string | null;
}) {
  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery" SET status=$2, "providerStatus"=$3, "errorCode"=$4,
        "sentAt"=CASE WHEN $2='SENT' THEN NOW() ELSE NULL END,
        "failedAt"=CASE WHEN $2='FAILED' THEN NOW() ELSE NULL END,
        "updatedAt"=NOW()
      WHERE id=$1 AND status='SENDING' AND provider='SOLAPI'`,
    input.deliveryId, input.ok ? "SENT" : "FAILED", input.providerStatus,
    input.ok ? null : (input.errorCode ?? input.providerStatus).slice(0, 500),
  );
}

export async function getManualMessageBatchStatus(batchId: string) {
  const batches = await prisma.$queryRawUnsafe<Array<{ id: string; status: string; totalCount: number }>>(
    `SELECT id,status,"totalCount" FROM "MessageDeliveryBatch" WHERE id=$1 AND source='MANUAL' LIMIT 1`, batchId,
  );
  if (!batches[0]) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; status: string; providerStatus: string | null; recipientPhoneLast4: string | null; errorCode: string | null }>>(
    `SELECT id,status,"providerStatus","recipientPhoneLast4","errorCode" FROM "NotificationDelivery" WHERE "batchId"=$1 ORDER BY "createdAt" ASC`, batchId,
  );
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const pending = count("PENDING");
  const processing = count("SENDING");
  const accepted = rows.filter((r) => r.status === "SENDING" && r.providerStatus === "ACCEPTED").length;
  const success = count("SENT");
  const failed = count("FAILED");
  const uncertain = count("UNCERTAIN");
  const status = pending + processing > 0
    ? "PROCESSING"
    : uncertain > 0
      ? "PARTIAL"
      : success === rows.length
        ? "SENT"
        : success > 0
          ? "PARTIAL"
          : "FAILED";
  return {
    batchId, status, total: rows.length, pending, processing, accepted, success, failed, uncertain,
    recipients: rows.map((r) => ({ id: r.id, recipient: r.recipientPhoneLast4 ? `***-****-${r.recipientPhoneLast4}` : "보호됨", status: r.status, providerStatus: r.providerStatus, reason: r.errorCode })),
  };
}

const AUDIT_SAFE_KEYS = new Set([
  "trigger",
  "name",
  "target",
  "audienceScope",
  "isActive",
  "requestedChannel",
  "fallbackEnabled",
  "fallbackChannel",
  "provider",
  "priority",
  "templateId",
  "description",
]);

/**
 * 감사로그에는 허용된 운영 필드만 남기며 본문은 원문 대신 해시로 치환합니다.
 * 공급자 키·전화번호 같은 설정 객체의 나머지 값은 저장하지 않습니다.
 */
export function sanitizeMessageSettingAuditSnapshot(
  input: Record<string, unknown> | null | undefined,
) {
  if (!input) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (AUDIT_SAFE_KEYS.has(key)) safe[key] = value;
  }
  if (typeof input.body === "string") safe.bodyHash = hashMessageBody(input.body);
  return safe;
}

/** 같은 사건·수신자·템플릿 조합의 중복 발송을 막는 안정적인 키입니다. */
export function buildMessageDedupeKey(input: {
  source: "AUTO" | "MANUAL" | "SECURITY";
  eventKey: string;
  recipientPhoneHash: string;
  templateVersion?: string | null;
}) {
  return [
    "message",
    input.source.toLowerCase(),
    input.eventKey.trim(),
    input.recipientPhoneHash,
    input.templateVersion?.trim() || "unversioned",
  ].join(":");
}

export async function reserveMessageDeliveryBatch(input: {
  source: MessageLedgerSource;
  stableEventKey: string;
  audienceScope: "INTERNAL" | "EXTERNAL" | "SECURITY";
  trigger?: string | null;
  purpose: string;
  actorUserId?: string | null;
  actorName?: string | null;
  reason?: string | null;
  body: string;
  requestedChannel?: string | null;
  templateId?: string | null;
  templateVersion?: string | null;
}) {
  const insertSql = `INSERT INTO "MessageDeliveryBatch" (
       id, source, "audienceScope", trigger, purpose, "actorUserId", "actorName", reason, "bodyHash",
       "stableEventKey", "requestedChannel", "templateId", "templateVersion",
       status, "totalCount", "successCount", "failureCount", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       'PROCESSING', 0, 0, 0, NOW(), NOW()
     ) ON CONFLICT DO NOTHING RETURNING id`;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    insertSql,
    input.source,
    input.audienceScope,
    input.trigger ?? null,
    input.purpose,
    input.actorUserId ?? null,
    input.actorName ?? null,
    input.reason ?? null,
    hashMessageBody(input.body),
    input.stableEventKey,
    input.requestedChannel ?? "SMS",
    input.templateId ?? null,
    input.templateVersion ?? null,
  );
  if (rows[0]?.id) return rows[0].id;
  const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "MessageDeliveryBatch"
      WHERE source = $1 AND "stableEventKey" = $2
      ORDER BY "createdAt" DESC LIMIT 1`,
    input.source,
    input.stableEventKey,
  );
  return existing[0]?.id ?? null;
}

export async function reserveMessageDelivery(input: {
  batchId: string;
  source: MessageLedgerSource;
  stableEventKey: string;
  eventType: string;
  trigger?: string | null;
  audienceScope: "INTERNAL" | "EXTERNAL" | "SECURITY";
  recipientUserId?: string | null;
  recipientPhone: string;
  body: string;
  requestedChannel?: string | null;
  templateId?: string | null;
  templateVersion?: string | null;
}) {
  const recipientPhoneHash = hashMessageRecipientPhone(input.recipientPhone);
  const dedupeKey = buildMessageDedupeKey({
    source: input.source,
    eventKey: input.stableEventKey,
    recipientPhoneHash,
    templateVersion: input.templateVersion,
  });
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "NotificationDelivery" (
         id, "batchId", source, "stableEventKey", "eventType", trigger, "audienceScope",
         "recipientUserId", "recipientPhone", "recipientPhoneHash", "recipientPhoneLast4",
         "bodyHash", "templateId", "templateVersion", channel, "requestedChannel",
         "dedupeKey", status, "attemptCount", "createdAt", "updatedAt"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
         $7, NULL, $8, $9, $10, $11, $12, 'SMS', $13,
         $14, 'PENDING', 0, NOW(), NOW()
       )
       ON CONFLICT ("dedupeKey") DO NOTHING
       RETURNING id`,
      input.batchId,
      input.source,
      input.stableEventKey,
      input.eventType,
      input.trigger ?? null,
      input.audienceScope,
      input.recipientUserId ?? null,
      recipientPhoneHash,
      messagePhoneLast4(input.recipientPhone),
      hashMessageBody(input.body),
      input.templateId ?? null,
      input.templateVersion ?? null,
      input.requestedChannel ?? "SMS",
      dedupeKey,
    );
    if (rows[0]?.id) {
      await tx.$executeRawUnsafe(
        `UPDATE "MessageDeliveryBatch"
            SET "totalCount" = "totalCount" + 1, "updatedAt" = NOW()
          WHERE id = $1`,
        input.batchId,
      );
      return { deliveryId: rows[0].id, dedupeKey, existingStatus: null };
    }
    const existing = await tx.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM "NotificationDelivery" WHERE "dedupeKey" = $1 LIMIT 1`,
      dedupeKey,
    );
    return { deliveryId: null, dedupeKey, existingStatus: existing[0]?.status ?? null };
  });
}

export async function claimMessageDelivery(deliveryId: string) {
  const lockToken = randomUUID();
  const rows = await prisma.$queryRawUnsafe<Array<{ lockToken: string }>>(
    `UPDATE "NotificationDelivery"
        SET status = 'SENDING', "lockedAt" = NOW(), "lockToken" = $2,
            "attemptCount" = "attemptCount" + 1, "updatedAt" = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING "lockToken"`,
    deliveryId,
    lockToken,
  );
  return {
    claimed: rows[0]?.lockToken === lockToken,
    lockToken: rows[0]?.lockToken ?? null,
  };
}

/**
 * channel 컬럼이 CHECK 제약으로 허용하는 값. 여기 없는 값을 넣으면 UPDATE 자체가 터진다.
 *
 * ⚠️ 2026-08-03 실제 사고: 호출부가 **메시지 종류(LMS)를 channel 에 넘겼다**.
 *    장문 문자는 전부 이 제약에 걸려 장부 기록이 실패했고, 호출부는 그 예외를 "발송 실패"로
 *    표시했다. 실제로는 문자가 이미 나간 뒤라, 원장이 실패로 보고 다시 눌러 **중복 발송**됐다.
 *    그래서 여기서 값을 걸러 낸다 — 장부 기록 문제가 절대 발송 판정을 흔들면 안 된다.
 */
const ALLOWED_DELIVERY_CHANNELS = new Set([
  "IN_APP", "PUSH",                       // 알림 계열
  "SMS", "LMS", "ALIMTALK", "RCS",        // DeliveredMessageChannel (message-channel-policy.ts)
  "KAKAO_ALIMTALK",                       // 저장돼 있는 구 표기. 조회 코드가 이 값을 그대로 기대한다.
]);

export async function finalizeMessageDelivery(input: {
  deliveryId: string;
  ok: boolean;
  provider?: string | null;
  requestedChannel?: string | null;
  /** 실제 전달 **채널**(IN_APP/PUSH/SMS). 메시지 종류(SMS/LMS)를 여기 넣지 말 것. */
  actualChannel?: string | null;
  /** 메시지 **종류**(SMS/LMS 등). channel 과 별개 칸에 기록된다. */
  messageType?: string | null;
  providerGroupId?: string | null;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  fallbackUsed?: boolean;
  fallbackChannel?: string | null;
  unitCost?: number | null;
  errorCode?: string | null;
}) {
  const rawChannel = input.actualChannel ?? null;
  const safeChannel = rawChannel && ALLOWED_DELIVERY_CHANNELS.has(rawChannel) ? rawChannel : null;
  if (rawChannel && !safeChannel) {
    // 값을 버리되 조용히 넘기지 않는다 — 잘못된 호출을 찾을 단서를 남긴다.
    console.warn(`[ledger] 허용되지 않는 channel 값 무시: ${rawChannel} (deliveryId=${input.deliveryId})`);
  }
  // messageType 을 따로 안 준 호출부는 예전처럼 actualChannel 을 종류로 쓰던 곳이다(SMS/LMS).
  const messageType = input.messageType ?? rawChannel ?? null;

  await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery"
        SET status = $2,
            "sentAt" = CASE WHEN $2 = 'SENT' THEN NOW() ELSE NULL END,
            "failedAt" = CASE WHEN $2 = 'FAILED' THEN NOW() ELSE NULL END,
            provider = $3, "requestedChannel" = $4, channel = COALESCE($5, channel),
            "messageType" = COALESCE($13, "messageType"),
            "providerGroupId" = $6, "providerMessageId" = $7,
            "providerStatus" = $8, "fallbackUsed" = $9, "fallbackChannel" = $10,
            "unitCost" = $11, "errorCode" = $12, "lockedAt" = NULL, "lockToken" = NULL,
            "nextAttemptAt" = NULL,
            "payloadJSON" = CASE WHEN source = 'MANUAL' AND trigger = 'MANUAL_MESSAGE' THEN NULL ELSE "payloadJSON" END,
            "updatedAt" = NOW()
      WHERE id = $1`,
    input.deliveryId,
    input.ok ? "SENT" : "FAILED",
    input.provider ?? null,
    input.requestedChannel ?? null,
    safeChannel,
    input.providerGroupId ?? null,
    input.providerMessageId ?? null,
    input.providerStatus ?? (input.ok ? "ACCEPTED" : "FAILED"),
    input.fallbackUsed ?? false,
    input.fallbackChannel ?? null,
    input.unitCost ?? null,
    input.errorCode ?? null,
    messageType,
  );
}

export async function finalizeMessageDeliveryBatch(batchId: string) {
  await prisma.$executeRawUnsafe(
    `UPDATE "MessageDeliveryBatch" b
        SET "successCount" = counts.success_count,
            "failureCount" = counts.failure_count,
            "totalCount" = counts.total_count,
            status = CASE
              WHEN counts.pending_count > 0 THEN 'PROCESSING'
              WHEN counts.uncertain_count > 0 THEN 'PARTIAL'
              WHEN counts.success_count = counts.total_count THEN 'SENT'
              WHEN counts.success_count > 0 THEN 'PARTIAL'
              ELSE 'FAILED'
            END,
            "completedAt" = CASE WHEN counts.pending_count = 0 THEN NOW() ELSE NULL END,
            "updatedAt" = NOW()
       FROM (
         SELECT "batchId", COUNT(*)::int AS total_count,
                COUNT(*) FILTER (WHERE status = 'SENT')::int AS success_count,
                COUNT(*) FILTER (WHERE status IN ('FAILED', 'SKIPPED', 'UNCERTAIN'))::int AS failure_count,
                COUNT(*) FILTER (WHERE status = 'UNCERTAIN')::int AS uncertain_count,
                COUNT(*) FILTER (WHERE status IN ('PENDING', 'SENDING'))::int AS pending_count
           FROM "NotificationDelivery" WHERE "batchId" = $1 GROUP BY "batchId"
       ) counts
      WHERE b.id = counts."batchId"`,
    batchId,
  );
}
