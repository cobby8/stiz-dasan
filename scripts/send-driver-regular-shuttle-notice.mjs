import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const NOTICE_URL = "https://www.stiz-dasan.kr/driver/857ab62da09ccba8c832cc2415f2f09c";
const STABLE_EVENT_KEY = "internal:driver-notice:regular-shuttle-editor:2026-09-03:v2";
const NOTICE_BODY = `[STIZ] 정규 셔틀 운행표가 업데이트되었습니다.

아래 링크에서 확정 운행 순서를 확인하실 수 있고,
정차 카드를 이동해 순서를 바꾸거나 시간을 수정한 뒤 저장하실 수 있습니다.

${NOTICE_URL}

탑승/하차 체크도 기존처럼 사용해 주세요.`;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function privacySecret() {
  const value = process.env.MESSAGE_PRIVACY_HMAC_SECRET?.trim();
  if (value && Buffer.byteLength(value, "utf8") >= 32) return value;
  const fallback =
    value ||
    process.env.NOTIFICATION_PRIVACY_SECRET?.trim() ||
    process.env.PARENT_ACCOUNT_CLAIM_SECRET?.trim() ||
    process.env.INVITE_OTP_SECRET?.trim() ||
    "development-only-notification-privacy-secret";
  return Buffer.byteLength(fallback, "utf8") >= 32
    ? fallback
    : "development-only-notification-privacy-secret";
}

function phoneHash(phone) {
  return crypto.createHmac("sha256", privacySecret()).update(normalizePhone(phone)).digest("hex");
}

function bodyHash(body) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

function phoneLast4(phone) {
  return normalizePhone(phone).slice(-4) || null;
}

function dedupeKey(eventKey, recipientPhoneHash) {
  return ["message", "manual", eventKey, recipientPhoneHash, "unversioned"].join(":");
}

function maskPhone(phone) {
  const digits = normalizePhone(phone);
  return digits.length >= 4 ? `***-****-${digits.slice(-4)}` : "보호됨";
}

function messageType(body) {
  return Buffer.byteLength(body, "utf8") <= 90 ? "SMS" : "LMS";
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function currentProvider() {
  const configured = (process.env.SMS_PROVIDER || "").trim().toUpperCase();
  if (["BIZPPURIO", "BIZ_PPURIO", "PPURIO"].includes(configured)) return "BIZPPURIO";
  if (["SOLAPI", "COOLSMS"].includes(configured)) return "SOLAPI";
  return process.env.BIZPPURIO_ACCOUNT ? "BIZPPURIO" : "SOLAPI";
}

function requireSmsConfig(provider) {
  const missing = [];
  if (provider === "BIZPPURIO") {
    if (!process.env.BIZPPURIO_ACCOUNT) missing.push("BIZPPURIO_ACCOUNT");
    if (!process.env.BIZPPURIO_PASSWORD && !process.env.BIZPPURIO_API_KEY) missing.push("BIZPPURIO_PASSWORD/BIZPPURIO_API_KEY");
    if (!process.env.BIZPPURIO_SENDER && !process.env.BIZPPURIO_FROM) missing.push("BIZPPURIO_SENDER/BIZPPURIO_FROM");
  } else {
    if (!process.env.SOLAPI_API_KEY) missing.push("SOLAPI_API_KEY");
    if (!process.env.SOLAPI_API_SECRET) missing.push("SOLAPI_API_SECRET");
    if (!process.env.SOLAPI_SENDER) missing.push("SOLAPI_SENDER");
  }
  if (missing.length > 0) throw new Error(`SMS 설정 누락: ${missing.join(", ")}`);
}

function solapiAuthHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", process.env.SOLAPI_API_SECRET || "").update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function sendSolapi(to, body, signal) {
  const type = messageType(body);
  const response = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: solapiAuthHeader(),
    },
    body: JSON.stringify({
      message: {
        to,
        from: normalizePhone(process.env.SOLAPI_SENDER),
        text: body,
        type,
        ...(type === "LMS" ? { subject: "STIZ 알림" } : {}),
      },
    }),
  });
  const json = await readJsonSafely(response);
  if (response.ok && json?.groupId) {
    return {
      ok: true,
      provider: "SOLAPI",
      groupId: String(json.groupId),
      messageId: typeof json.messageId === "string" ? json.messageId : null,
      messageType: type,
      providerStatus: "ACCEPTED",
    };
  }
  return { ok: false, provider: "SOLAPI", errorCode: String(json?.errorMessage || json?.message || json?.statusCode || response.status) };
}

function bizppurioBaseUrl() {
  const defaultHost = process.env.NODE_ENV === "production" ? "api.bizppurio.com" : "dev-api.bizppurio.com";
  const host = (process.env.BIZPPURIO_HOST || defaultHost).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}`;
}

async function getBizppurioToken(signal) {
  const account = process.env.BIZPPURIO_ACCOUNT || "";
  const password = process.env.BIZPPURIO_PASSWORD || process.env.BIZPPURIO_API_KEY || "";
  const response = await fetch(`${bizppurioBaseUrl()}/v1/token`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Basic ${Buffer.from(`${account}:${password}`).toString("base64")}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const json = await readJsonSafely(response);
  const token = [json?.accesstoken, json?.accessToken, json?.token].find((value) => typeof value === "string" && value.length > 0);
  if (!response.ok || !token) throw new Error(`Bizppurio 토큰 실패: ${json?.description || json?.message || json?.code || response.status}`);
  return token;
}

async function sendBizppurio(to, body, signal) {
  const token = await getBizppurioToken(signal);
  const type = messageType(body).toLowerCase();
  const refkey = `stiz${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`.slice(0, 32);
  const response = await fetch(`${bizppurioBaseUrl()}/v3/message`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      account: process.env.BIZPPURIO_ACCOUNT,
      refkey,
      type,
      from: normalizePhone(process.env.BIZPPURIO_SENDER || process.env.BIZPPURIO_FROM),
      to,
      content: type === "sms" ? { sms: { message: body } } : { lms: { subject: "STIZ 알림", message: body } },
    }),
  });
  const json = await readJsonSafely(response);
  if (response.ok && String(json?.code) === "1000") {
    return {
      ok: true,
      provider: "BIZPPURIO",
      groupId: null,
      messageId: typeof json?.messagekey === "string" ? json.messagekey : refkey,
      messageType: type.toUpperCase(),
      providerStatus: "ACCEPTED",
    };
  }
  return { ok: false, provider: "BIZPPURIO", errorCode: String(json?.description || json?.message || json?.code || response.status) };
}

async function sendSms(to, body) {
  const provider = currentProvider();
  requireSmsConfig(provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    return provider === "BIZPPURIO"
      ? await sendBizppurio(to, body, controller.signal)
      : await sendSolapi(to, body, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSolapiAuthOnly() {
  requireSmsConfig("SOLAPI");
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto
    .createHmac("sha256", process.env.SOLAPI_API_SECRET || "")
    .update(date + salt)
    .digest("hex");
  const response = await fetch("https://api.solapi.com/messages/v4/list?limit=1", {
    headers: {
      Authorization: `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
    },
  });
  const json = await readJsonSafely(response);
  return {
    ok: response.ok,
    status: response.status,
    message: json?.errorMessage || json?.message || json?.statusCode || null,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--auth-check")) {
    console.log(JSON.stringify(await checkSolapiAuthOnly(), null, 2));
    return;
  }
  const drivers = await prisma.user.findMany({
    where: { role: "DRIVER" },
    select: { id: true, name: true, phone: true },
    orderBy: { name: "asc" },
  });
  const driver = drivers.find((user) => user.name === "김영중") || drivers[0];
  if (!driver?.phone) throw new Error("활성 기사님 연락처를 찾지 못했습니다.");

  const normalizedPhone = normalizePhone(driver.phone);
  const recipientHash = phoneHash(normalizedPhone);
  const dedupe = dedupeKey(STABLE_EVENT_KEY, recipientHash);

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      recipient: `${driver.name} ${maskPhone(normalizedPhone)}`,
      messageType: messageType(NOTICE_BODY),
      provider: currentProvider(),
      stableEventKey: STABLE_EVENT_KEY,
    }, null, 2));
    return;
  }

  const batchRows = await prisma.$queryRawUnsafe(
    `INSERT INTO "MessageDeliveryBatch" (
       id, source, "audienceScope", trigger, purpose, "actorName", reason, "bodyHash",
       "stableEventKey", "requestedChannel", status, "totalCount", "successCount", "failureCount", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, 'MANUAL', 'INTERNAL', 'DRIVER_NOTICE',
       '기사님 정규 셔틀 운행표 안내', 'Codex', '정규 셔틀 운행표 확인 및 순서·시간 수정 안내',
       $1, $2, 'SMS', 'PROCESSING', 0, 0, 0, NOW(), NOW()
     ) ON CONFLICT DO NOTHING RETURNING id`,
    bodyHash(NOTICE_BODY),
    STABLE_EVENT_KEY,
  );
  const batchId = batchRows[0]?.id || (await prisma.messageDeliveryBatch.findFirst({
    where: { source: "MANUAL", stableEventKey: STABLE_EVENT_KEY },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  }))?.id;
  if (!batchId) throw new Error("문자 발송 장부 배치를 만들지 못했습니다.");

  const deliveryRows = await prisma.$queryRawUnsafe(
    `INSERT INTO "NotificationDelivery" (
       id, "batchId", source, "stableEventKey", "eventType", trigger, "audienceScope",
       "recipientUserId", "recipientPhone", "recipientPhoneHash", "recipientPhoneLast4",
       "bodyHash", channel, "requestedChannel", "dedupeKey", status, "attemptCount", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, 'MANUAL', $2, 'DRIVER_NOTICE', 'DRIVER_NOTICE', 'INTERNAL',
       $3, NULL, $4, $5, $6, 'SMS', 'SMS', $7, 'PENDING', 0, NOW(), NOW()
     )
     ON CONFLICT ("dedupeKey") DO NOTHING
     RETURNING id`,
    batchId,
    STABLE_EVENT_KEY,
    driver.id,
    recipientHash,
    phoneLast4(normalizedPhone),
    bodyHash(NOTICE_BODY),
    dedupe,
  );

  const deliveryId = deliveryRows[0]?.id;
  if (!deliveryId) {
    const existing = await prisma.notificationDelivery.findUnique({
      where: { dedupeKey: dedupe },
      select: { status: true, recipientPhoneLast4: true },
    });
    console.log(JSON.stringify({
      skipped: true,
      reason: "이미 같은 안내문자 장부가 있습니다.",
      recipient: `${driver.name} ${existing?.recipientPhoneLast4 ? `***-****-${existing.recipientPhoneLast4}` : maskPhone(normalizedPhone)}`,
      status: existing?.status || "UNKNOWN",
    }, null, 2));
    return;
  }

  await prisma.messageDeliveryBatch.update({
    where: { id: batchId },
    data: { totalCount: { increment: 1 } },
  });

  const claimed = await prisma.$executeRawUnsafe(
    `UPDATE "NotificationDelivery"
       SET status='SENDING', "lockedAt"=NOW(), "lockToken"=$2, "attemptCount"="attemptCount"+1, "updatedAt"=NOW()
     WHERE id=$1 AND status='PENDING'`,
    deliveryId,
    crypto.randomUUID(),
  );
  if (Number(claimed) !== 1) throw new Error("발송 장부 잠금에 실패했습니다.");

  const result = await sendSms(normalizedPhone, NOTICE_BODY);
  await prisma.notificationDelivery.update({
    where: { id: deliveryId },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      sentAt: result.ok ? new Date() : null,
      failedAt: result.ok ? null : new Date(),
      provider: result.provider,
      requestedChannel: "SMS",
      channel: "SMS",
      messageType: result.messageType,
      providerGroupId: result.groupId,
      providerMessageId: result.messageId,
      providerStatus: result.providerStatus || (result.ok ? "ACCEPTED" : "FAILED"),
      fallbackUsed: false,
      errorCode: result.ok ? null : result.errorCode?.slice(0, 500),
      lockedAt: null,
      lockToken: null,
      nextAttemptAt: null,
    },
  });

  const counts = await prisma.notificationDelivery.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  const successCount = counts.find((row) => row.status === "SENT")?._count._all || 0;
  const failureCount = counts
    .filter((row) => ["FAILED", "SKIPPED", "UNCERTAIN"].includes(row.status))
    .reduce((sum, row) => sum + row._count._all, 0);
  const pendingCount = counts
    .filter((row) => ["PENDING", "SENDING"].includes(row.status))
    .reduce((sum, row) => sum + row._count._all, 0);

  await prisma.messageDeliveryBatch.update({
    where: { id: batchId },
    data: {
      successCount,
      failureCount,
      status: pendingCount > 0 ? "PROCESSING" : result.ok ? "SENT" : "FAILED",
      completedAt: pendingCount > 0 ? null : new Date(),
    },
  });

  console.log(JSON.stringify({
    sent: result.ok,
    recipient: `${driver.name} ${maskPhone(normalizedPhone)}`,
    provider: result.provider,
    messageType: result.messageType,
    batchId,
    deliveryId,
    error: result.ok ? null : result.errorCode,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
