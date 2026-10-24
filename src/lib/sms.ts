import crypto from "crypto";

const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY || "";
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET || "";
const SOLAPI_SENDER = normalizeSmsNumber(process.env.SOLAPI_SENDER || "");
const SOLAPI_URL = "https://api.solapi.com/messages/v4/send";
const SOLAPI_SEND_MANY_URL = "https://api.solapi.com/messages/v4/send-many/detail";
const SOLAPI_MESSAGE_LIST_URL = "https://api.solapi.com/messages/v4/list";

const BIZPPURIO_ACCOUNT = process.env.BIZPPURIO_ACCOUNT || "";
const BIZPPURIO_PASSWORD = process.env.BIZPPURIO_PASSWORD || process.env.BIZPPURIO_API_KEY || "";
const BIZPPURIO_SENDER = normalizeSmsNumber(process.env.BIZPPURIO_SENDER || process.env.BIZPPURIO_FROM || "");
const BIZPPURIO_DEFAULT_HOST = process.env.NODE_ENV === "production"
    ? "api.bizppurio.com"
    : "dev-api.bizppurio.com";

const SMS_REQUEST_TIMEOUT_MS = 5000;
const BIZPPURIO_TOKEN_SAFETY_MS = 60_000;

export type SmsProvider = "SOLAPI" | "BIZPPURIO";

type BizppurioTokenCache = {
    token: string;
    expiresAt: number;
};

type JsonObject = Record<string, unknown>;

let bizppurioTokenCache: BizppurioTokenCache | null = null;

export type SmsSendResult = {
    ok: boolean;
    to: string;
    reason?: string;
    provider?: SmsProvider;
    groupId?: string;
    messageId?: string;
    messageType?: "SMS" | "LMS";
};

export type SmsSendOptions = {
    messageType?: "SMS" | "LMS";
};

export type SmsBulkDelivery = {
    deliveryId: string;
    to: string;
};

export type SmsBulkDeliveryStatus = "ACCEPTED" | "FAILED" | "UNCERTAIN";

export type SmsBulkDeliveryResult = {
    deliveryId: string;
    to: string;
    status: SmsBulkDeliveryStatus;
    provider: SmsProvider;
    groupId?: string;
    messageId?: string;
    reason?: string;
};

export type SmsBulkSendResult = {
    provider: SmsProvider;
    groupId?: string;
    deliveries: SmsBulkDeliveryResult[];
};

export type SolapiBatchMessageStatus = "SUCCESS" | "PENDING" | "FAILED";

export type SolapiBatchMessageResult = {
    deliveryId?: string;
    messageId?: string;
    status: SolapiBatchMessageStatus;
    statusCode?: string;
    reason?: string;
};

function normalizeSmsNumber(value: string): string {
    return value.replace(/\D/g, "");
}

function currentSmsProvider(): SmsProvider {
    const configured = (process.env.SMS_PROVIDER || "").trim().toUpperCase();
    if (configured === "BIZPPURIO" || configured === "BIZ_PPURIO" || configured === "PPURIO") return "BIZPPURIO";
    if (configured === "SOLAPI" || configured === "COOLSMS") return "SOLAPI";
    return BIZPPURIO_ACCOUNT ? "BIZPPURIO" : "SOLAPI";
}

export function getSmsProviderName(): SmsProvider {
    return currentSmsProvider();
}

export function isSmsProviderConfigured(provider: SmsProvider = currentSmsProvider()): boolean {
    if (provider === "BIZPPURIO") return Boolean(BIZPPURIO_ACCOUNT && BIZPPURIO_PASSWORD && BIZPPURIO_SENDER);
    return Boolean(SOLAPI_API_KEY && SOLAPI_API_SECRET && SOLAPI_SENDER);
}

export function smsProviderMissingReason(provider: SmsProvider = currentSmsProvider()): string | null {
    if (isSmsProviderConfigured(provider)) return null;
    const missing = provider === "BIZPPURIO"
        ? [
            ["BIZPPURIO_ACCOUNT", BIZPPURIO_ACCOUNT],
            ["BIZPPURIO_PASSWORD or BIZPPURIO_API_KEY", BIZPPURIO_PASSWORD],
            ["BIZPPURIO_SENDER or BIZPPURIO_FROM", BIZPPURIO_SENDER],
        ]
        : [
            ["SOLAPI_API_KEY", SOLAPI_API_KEY],
            ["SOLAPI_API_SECRET", SOLAPI_API_SECRET],
            ["SOLAPI_SENDER", SOLAPI_SENDER],
        ];
    const names = missing.filter(([, value]) => !value).map(([name]) => name).join(", ");
    return `${provider} SMS environment variables are missing: ${names}`;
}

function makeSolapiAuthHeader(): string {
    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString("hex");
    const signature = crypto
        .createHmac("sha256", SOLAPI_API_SECRET)
        .update(date + salt)
        .digest("hex");

    return `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

function bizppurioBaseUrl(): string {
    const host = (process.env.BIZPPURIO_HOST || BIZPPURIO_DEFAULT_HOST)
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
    return `https://${host}`;
}

function parseBizppurioExpiresAt(expired?: string): number {
    if (!expired || !/^\d{14}$/.test(expired)) {
        return Date.now() + 23 * 60 * 60 * 1000;
    }

    const year = Number(expired.slice(0, 4));
    const month = Number(expired.slice(4, 6));
    const day = Number(expired.slice(6, 8));
    const hour = Number(expired.slice(8, 10));
    const minute = Number(expired.slice(10, 12));
    const second = Number(expired.slice(12, 14));

    // Bizppurio expiry is returned as Korea local time.
    return Date.UTC(year, month - 1, day, hour - 9, minute, second);
}

function bizppurioMessageType(body: string): "sms" | "lms" {
    return Buffer.byteLength(body, "utf8") <= 90 ? "sms" : "lms";
}

export function getSmsMessageType(body: string): "SMS" | "LMS" {
    return bizppurioMessageType(body).toUpperCase() as "SMS" | "LMS";
}

async function readJsonSafely(response: Response): Promise<JsonObject | null> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function getBizppurioToken(signal: AbortSignal): Promise<string> {
    const now = Date.now();
    if (bizppurioTokenCache && bizppurioTokenCache.expiresAt - BIZPPURIO_TOKEN_SAFETY_MS > now) {
        return bizppurioTokenCache.token;
    }

    const basic = Buffer.from(`${BIZPPURIO_ACCOUNT}:${BIZPPURIO_PASSWORD}`).toString("base64");
    const response = await fetch(`${bizppurioBaseUrl()}/v1/token`, {
        method: "POST",
        signal,
        headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/json; charset=utf-8",
        },
    });
    const json = await readJsonSafely(response);
    const token = [json?.accesstoken, json?.accessToken, json?.token]
        .find((value): value is string => typeof value === "string" && value.length > 0);

    if (!response.ok || !token) {
        const reason = json?.description || json?.message || json?.code || response.status;
        throw new Error(`Bizppurio token failed: ${reason}`);
    }

    bizppurioTokenCache = {
        token,
        expiresAt: parseBizppurioExpiresAt(typeof json?.expired === "string" ? json.expired : undefined),
    };
    return token;
}

async function sendSolapiSms(
    recipientNo: string,
    body: string,
    signal: AbortSignal,
    options?: SmsSendOptions,
): Promise<SmsSendResult> {
    const messageType = options?.messageType ?? getSmsMessageType(body);
    const res = await fetch(SOLAPI_URL, {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json",
            Authorization: makeSolapiAuthHeader(),
        },
        body: JSON.stringify({
            message: {
                to: recipientNo,
                from: SOLAPI_SENDER,
                text: body,
                type: messageType,
                ...(messageType === "LMS" ? { subject: "STIZ 알림" } : {}),
            },
        }),
    });

    const json = await readJsonSafely(res);

    if (res.ok && json?.groupId) {
        return {
            ok: true,
            to: recipientNo,
            provider: "SOLAPI",
            groupId: String(json.groupId),
            messageId: typeof json.messageId === "string" ? json.messageId : undefined,
            messageType,
        };
    }

    const reason = json?.errorMessage || json?.message || json?.statusCode || JSON.stringify(json);
    console.warn("[SMS] Solapi API failed:", reason);
    return { ok: false, to: recipientNo, provider: "SOLAPI", reason: `Solapi failed: ${reason}` };
}

async function sendBizppurioSms(
    recipientNo: string,
    body: string,
    signal: AbortSignal,
    options?: SmsSendOptions,
): Promise<SmsSendResult> {
    const token = await getBizppurioToken(signal);
    const type = options?.messageType
        ? options.messageType.toLowerCase() as "sms" | "lms"
        : bizppurioMessageType(body);
    const refkey = `stiz${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`.slice(0, 32);
    const content = type === "sms"
        ? { sms: { message: body } }
        : { lms: { subject: "STIZ 알림", message: body } };

    const res = await fetch(`${bizppurioBaseUrl()}/v3/message`, {
        method: "POST",
        signal,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
            account: BIZPPURIO_ACCOUNT,
            refkey,
            type,
            from: BIZPPURIO_SENDER,
            to: recipientNo,
            content,
        }),
    });

    const json = await readJsonSafely(res);

    if (res.ok && String(json?.code) === "1000") {
        return {
            ok: true,
            to: recipientNo,
            provider: "BIZPPURIO",
            messageId: typeof json?.messagekey === "string" ? json.messagekey : refkey,
            messageType: type.toUpperCase() as "SMS" | "LMS",
        };
    }

    const reason = json?.description || json?.message || json?.code || JSON.stringify(json);
    console.warn("[SMS] Bizppurio API failed:", reason);
    return { ok: false, to: recipientNo, provider: "BIZPPURIO", reason: `Bizppurio failed: ${reason}` };
}

function solapiDeliveryId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const rawFields = (value as JsonObject).customFields;
    let fields = rawFields;
    if (typeof rawFields === "string") {
        try {
            fields = JSON.parse(rawFields) as unknown;
        } catch {
            return undefined;
        }
    }
    if (!fields || typeof fields !== "object") return undefined;
    const deliveryId = (fields as JsonObject).deliveryId;
    return typeof deliveryId === "string" && deliveryId.length > 0 ? deliveryId : undefined;
}

function solapiMessageEntries(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as JsonObject).map(([messageId, raw]) => {
        if (!raw || typeof raw !== "object") return raw;
        const item = raw as JsonObject;
        return typeof item.messageId === "string" ? item : { ...item, messageId };
    });
}

function solapiGroupId(json: JsonObject | null): string | undefined {
    const groupInfo = json?.groupInfo;
    const nested = groupInfo && typeof groupInfo === "object"
        ? (groupInfo as JsonObject).groupId
        : undefined;
    if (typeof nested === "string" && nested.length > 0) return nested;
    return typeof json?.groupId === "string" && json.groupId.length > 0 ? json.groupId : undefined;
}

function solapiMessageId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const messageId = (value as JsonObject).messageId;
    return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

function solapiFailureReason(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const item = value as JsonObject;
    const reason = item.errorMessage ?? item.reason ?? item.statusMessage ?? item.statusCode;
    return reason === undefined ? undefined : String(reason);
}

async function sendSolapiSmsBulk(
    deliveries: SmsBulkDelivery[],
    body: string,
    options?: SmsSendOptions,
): Promise<SmsBulkSendResult> {
    const messageType = options?.messageType ?? getSmsMessageType(body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SMS_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(SOLAPI_SEND_MANY_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: makeSolapiAuthHeader(),
            },
            body: JSON.stringify({
                messages: deliveries.map((delivery) => ({
                    to: normalizeSmsNumber(delivery.to),
                    from: SOLAPI_SENDER,
                    text: body,
                    type: messageType,
                    ...(messageType === "LMS" ? { subject: "STIZ 알림" } : {}),
                    customFields: { deliveryId: delivery.deliveryId },
                })),
                showMessageList: true,
                allowDuplicates: false,
            }),
        });
        const json = await readJsonSafely(response);
        const groupId = solapiGroupId(json);

        if (!response.ok) {
            const reason = json?.errorMessage ?? json?.message ?? json?.statusCode ?? response.status;
            const status: SmsBulkDeliveryStatus = response.status >= 400 && response.status < 500
                ? "FAILED"
                : "UNCERTAIN";
            return {
                provider: "SOLAPI",
                groupId,
                deliveries: deliveries.map((delivery) => ({
                    ...delivery,
                    to: normalizeSmsNumber(delivery.to),
                    status,
                    provider: "SOLAPI",
                    groupId,
                    reason: `Solapi failed: ${String(reason)}`,
                })),
            };
        }

        const accepted = solapiMessageEntries(json?.messageList);
        const failed = solapiMessageEntries(json?.failedMessageList);
        const acceptedById = new Map(accepted.map((item) => [solapiDeliveryId(item), item]));
        const failedById = new Map(failed.map((item) => [solapiDeliveryId(item), item]));

        return {
            provider: "SOLAPI",
            groupId,
            deliveries: deliveries.map((delivery) => {
                const normalizedTo = normalizeSmsNumber(delivery.to);
                const failedItem = failedById.get(delivery.deliveryId);
                if (failedItem) {
                    return {
                        deliveryId: delivery.deliveryId,
                        to: normalizedTo,
                        status: "FAILED",
                        provider: "SOLAPI",
                        groupId,
                        messageId: solapiMessageId(failedItem),
                        reason: solapiFailureReason(failedItem) ?? "Solapi explicitly rejected the message.",
                    };
                }
                const acceptedItem = acceptedById.get(delivery.deliveryId);
                if (acceptedItem) {
                    return {
                        deliveryId: delivery.deliveryId,
                        to: normalizedTo,
                        status: "ACCEPTED",
                        provider: "SOLAPI",
                        groupId,
                        messageId: solapiMessageId(acceptedItem),
                    };
                }
                return {
                    deliveryId: delivery.deliveryId,
                    to: normalizedTo,
                    status: "UNCERTAIN",
                    provider: "SOLAPI",
                    groupId,
                    reason: "Solapi response omitted this delivery.",
                };
            }),
        };
    } catch (error) {
        const reason = error instanceof Error && error.name === "AbortError"
            ? `Solapi bulk request timed out after ${SMS_REQUEST_TIMEOUT_MS}ms`
            : `Solapi bulk request failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
            provider: "SOLAPI",
            deliveries: deliveries.map((delivery) => ({
                ...delivery,
                to: normalizeSmsNumber(delivery.to),
                status: "UNCERTAIN",
                provider: "SOLAPI",
                reason,
            })),
        };
    } finally {
        clearTimeout(timeout);
    }
}

export async function sendSmsBulkDetailed(
    deliveries: SmsBulkDelivery[],
    body: string,
    options?: SmsSendOptions,
): Promise<SmsBulkSendResult> {
    if (deliveries.length === 0 || deliveries.length > 500) {
        throw new Error("SMS bulk delivery count must be between 1 and 500.");
    }
    if (new Set(deliveries.map((delivery) => delivery.deliveryId)).size !== deliveries.length) {
        throw new Error("SMS bulk deliveryId values must be unique.");
    }

    const provider = currentSmsProvider();
    if (provider === "SOLAPI") {
        const missingReason = smsProviderMissingReason(provider);
        if (missingReason) {
            return {
                provider,
                deliveries: deliveries.map((delivery) => ({
                    ...delivery,
                    to: normalizeSmsNumber(delivery.to),
                    status: "FAILED",
                    provider,
                    reason: missingReason,
                })),
            };
        }
        return sendSolapiSmsBulk(deliveries, body, options);
    }

    const results: SmsBulkDeliveryResult[] = [];
    for (const delivery of deliveries) {
        const result = await sendSmsDetailed(delivery.to, body, options);
        const uncertain = !result.ok && /timed out/i.test(result.reason ?? "");
        results.push({
            deliveryId: delivery.deliveryId,
            to: result.to,
            status: result.ok ? "ACCEPTED" : uncertain ? "UNCERTAIN" : "FAILED",
            provider,
            groupId: result.groupId,
            messageId: result.messageId,
            reason: result.reason,
        });
    }
    return { provider, deliveries: results };
}

export async function getSolapiBatchResults(groupId: string): Promise<SolapiBatchMessageResult[]> {
    if (!groupId.trim()) throw new Error("Solapi groupId is required.");
    if (!isSmsProviderConfigured("SOLAPI")) {
        throw new Error(smsProviderMissingReason("SOLAPI") ?? "Solapi is not configured.");
    }

    const results: SolapiBatchMessageResult[] = [];
    let startKey: string | undefined;
    const seenKeys = new Set<string>();

    do {
        const url = new URL(SOLAPI_MESSAGE_LIST_URL);
        url.searchParams.set("groupId", groupId);
        url.searchParams.set("limit", "500");
        if (startKey) url.searchParams.set("startKey", startKey);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SMS_REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { Authorization: makeSolapiAuthHeader() },
            });
            const json = await readJsonSafely(response);
            if (!response.ok) {
                const reason = json?.errorMessage ?? json?.message ?? json?.statusCode ?? response.status;
                throw new Error(`Solapi batch result lookup failed: ${String(reason)}`);
            }

            const messageList = solapiMessageEntries(json?.messageList);
            for (const raw of messageList) {
                if (!raw || typeof raw !== "object") continue;
                const item = raw as JsonObject;
                const statusCode = item.statusCode === undefined ? undefined : String(item.statusCode);
                const status: SolapiBatchMessageStatus = statusCode === "4000"
                    ? "SUCCESS"
                    : statusCode && !/^[23]/.test(statusCode)
                        ? "FAILED"
                        : "PENDING";
                results.push({
                    deliveryId: solapiDeliveryId(item),
                    messageId: solapiMessageId(item),
                    status,
                    statusCode,
                    reason: status === "FAILED" ? solapiFailureReason(item) : undefined,
                });
            }

            const candidate = json?.nextKey ?? json?.nextStartKey;
            startKey = typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
            if (startKey && seenKeys.has(startKey)) break;
            if (startKey) seenKeys.add(startKey);
        } finally {
            clearTimeout(timeout);
        }
    } while (startKey);

    return results;
}

export async function sendSmsDetailed(
    to: string,
    body: string,
    options?: SmsSendOptions,
): Promise<SmsSendResult> {
    const recipientNo = normalizeSmsNumber(to);
    const provider = currentSmsProvider();
    const missingReason = smsProviderMissingReason(provider);

    if (recipientNo.length < 10 || recipientNo.length > 11) {
        return { ok: false, to: recipientNo, provider, reason: "Invalid SMS recipient." };
    }

    if (missingReason) {
        // Do not print phone numbers or message bodies. Some messages include login codes or private notes.
        const maskedRecipient = recipientNo.length >= 4 ? `***${recipientNo.slice(-4)}` : "***";
        console.log(`[SMS fallback] provider=${provider} to=${maskedRecipient} bodyLength=${body.length}`);
        return { ok: false, to: recipientNo, provider, reason: missingReason };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SMS_REQUEST_TIMEOUT_MS);

    try {
        return provider === "BIZPPURIO"
            ? await sendBizppurioSms(recipientNo, body, controller.signal, options)
            : await sendSolapiSms(recipientNo, body, controller.signal, options);
    } catch (e) {
        const reason = e instanceof Error && e.name === "AbortError"
            ? `SMS request timed out after ${SMS_REQUEST_TIMEOUT_MS}ms`
            : (e as Error).message;
        console.error("[SMS] Send failed:", reason);
        return { ok: false, to: recipientNo, provider, reason: `SMS request failed: ${reason}` };
    } finally {
        clearTimeout(timeout);
    }
}

export async function sendSms(to: string, body: string): Promise<boolean> {
    const result = await sendSmsDetailed(to, body);
    return result.ok;
}

export async function sendSmsBulk(
    recipients: string[],
    body: string,
): Promise<{ total: number; success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const to of recipients) {
        const ok = await sendSms(to, body);
        if (ok) success++;
        else failed++;
    }

    return { total: recipients.length, success, failed };
}
