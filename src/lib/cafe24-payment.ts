import crypto from "node:crypto";

export const CAFE24_PAYMENT_PROVIDER = "CAFE24_BRIDGE";
export const DEFAULT_CAFE24_PAYMENT_API_URL = "https://custom.stiz.kr/api/payments/cafe24/checkout";
export const STIZ_PAYMENT_PARTNER_ID = "dasan";

export type Cafe24PaymentBridgePayload = {
    partnerRequestId: string;
    invoiceId: string;
    invoiceNo: string;
    paymentId: string;
    amount: number;
    orderName: string;
    customer: {
        name: string;
        phone: string | null;
        email: string | null;
    };
    returnUrls: {
        successUrl: string;
        failUrl: string;
        webhookUrl: string;
    };
    metadata: {
        source: "stiz-dasan";
        studentName: string;
    };
};

export type Cafe24PaymentBridgeResponse = {
    success?: boolean;
    ok?: boolean;
    checkoutUrl?: string;
    paymentUrl?: string;
    redirectUrl?: string;
    orderId?: string;
    cafe24OrderId?: string;
    providerOrderId?: string;
    paymentKey?: string;
    receiptUrl?: string;
    expiresAt?: string;
    message?: string;
    error?: string;
};

export type Cafe24PaymentBridgeConfig = {
    provider: typeof CAFE24_PAYMENT_PROVIDER;
    apiUrl: string;
    apiUrlConfigured: boolean;
    apiUrlValid: boolean;
    secretConfigured: boolean;
    secretFormatValid: boolean;
    ready: boolean;
};

export class Cafe24PaymentBridgeError extends Error {
    statusCode: number | null;
    retryable: boolean;

    constructor(message: string, options: { statusCode?: number | null; retryable: boolean }) {
        super(message);
        this.name = "Cafe24PaymentBridgeError";
        this.statusCode = options.statusCode ?? null;
        this.retryable = options.retryable;
    }
}

function readString(value: unknown) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isHttpUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
}

function readBridgeSecret() {
    return process.env.CAFE24_PAYMENT_BRIDGE_SECRET?.trim()
        || process.env.STIZ_PARTNER_SECRET?.trim()
        || "";
}

export function canonicalCafe24PaymentJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalCafe24PaymentJson(item)).join(",")}]`;
    }
    return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalCafe24PaymentJson((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
}

export function getCafe24PaymentBridgeConfig(): Cafe24PaymentBridgeConfig {
    const configuredUrl = process.env.CAFE24_PAYMENT_BRIDGE_URL?.trim()
        || process.env.STIZ_CAFE24_PAYMENT_API_URL?.trim()
        || "";
    const apiUrl = configuredUrl || DEFAULT_CAFE24_PAYMENT_API_URL;
    const secret = readBridgeSecret();
    const secretFormatValid = /^[a-fA-F0-9]{64}$/.test(secret);

    return {
        provider: CAFE24_PAYMENT_PROVIDER,
        apiUrl,
        apiUrlConfigured: Boolean(configuredUrl),
        apiUrlValid: isHttpUrl(apiUrl),
        secretConfigured: Boolean(secret),
        secretFormatValid,
        ready: Boolean(configuredUrl && isHttpUrl(apiUrl) && secretFormatValid),
    };
}

export function getCafe24PaymentCheckoutUrl(response: Cafe24PaymentBridgeResponse | Record<string, unknown>) {
    const record = response as Record<string, unknown>;
    return readString(record.checkoutUrl)
        || readString(record.paymentUrl)
        || readString(record.redirectUrl);
}

export function buildCafe24PaymentBridgePayload(input: {
    partnerRequestId: string;
    invoiceId: string;
    invoiceNo: string;
    paymentId: string;
    amount: number;
    orderName: string;
    customerName: string;
    customerPhone: string | null;
    customerEmail: string | null;
    studentName: string;
    successUrl: string;
    failUrl: string;
    webhookUrl: string;
}): Cafe24PaymentBridgePayload {
    return {
        partnerRequestId: input.partnerRequestId,
        invoiceId: input.invoiceId,
        invoiceNo: input.invoiceNo,
        paymentId: input.paymentId,
        amount: input.amount,
        orderName: input.orderName,
        customer: {
            name: input.customerName,
            phone: input.customerPhone,
            email: input.customerEmail,
        },
        returnUrls: {
            successUrl: input.successUrl,
            failUrl: input.failUrl,
            webhookUrl: input.webhookUrl,
        },
        metadata: {
            source: "stiz-dasan",
            studentName: input.studentName,
        },
    };
}

export function signCafe24PaymentPayload(input: {
    secret: string;
    timestamp: number;
    payload: unknown;
}) {
    return crypto
        .createHmac("sha256", input.secret)
        .update(`${input.timestamp}.${STIZ_PAYMENT_PARTNER_ID}.${canonicalCafe24PaymentJson(input.payload)}`, "utf8")
        .digest("hex");
}

export function verifyCafe24PaymentSignature(input: {
    payload: unknown;
    timestamp: string | null;
    signature: string | null;
    now?: number;
}) {
    const secret = readBridgeSecret();
    if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret)) return false;
    const timestamp = Number(input.timestamp || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 10 * 60) return false;

    const expected = signCafe24PaymentPayload({ secret, timestamp, payload: input.payload });
    const actual = input.signature || "";
    if (expected.length !== actual.length) return false;

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function postCafe24PaymentCheckout(payload: Cafe24PaymentBridgePayload) {
    const config = getCafe24PaymentBridgeConfig();
    const secret = readBridgeSecret();

    if (!config.apiUrlConfigured) {
        throw new Cafe24PaymentBridgeError("본사 카페24 결제 브리지 URL 설정이 필요합니다.", {
            retryable: false,
        });
    }
    if (!config.apiUrlValid) {
        throw new Cafe24PaymentBridgeError("본사 카페24 결제 브리지 URL 형식이 올바르지 않습니다.", {
            retryable: false,
        });
    }
    if (!config.secretConfigured || !config.secretFormatValid) {
        throw new Cafe24PaymentBridgeError("본사 연동 서명 비밀키 설정이 필요합니다.", {
            retryable: false,
        });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signCafe24PaymentPayload({ secret, timestamp, payload });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
        const response = await fetch(config.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-STIZ-Partner": STIZ_PAYMENT_PARTNER_ID,
                "X-STIZ-Timestamp": String(timestamp),
                "X-STIZ-Signature": signature,
                "X-STIZ-Purpose": "cafe24-payment-checkout",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const body = await response.json().catch(() => ({})) as Cafe24PaymentBridgeResponse;
        const checkoutUrl = getCafe24PaymentCheckoutUrl(body);

        if (!response.ok || body.success === false || body.ok === false) {
            throw new Cafe24PaymentBridgeError(body.error || body.message || `본사 카페24 결제 요청 실패 (${response.status})`, {
                statusCode: response.status,
                retryable: response.status >= 500 || response.status === 429,
            });
        }
        if (!checkoutUrl || !isHttpUrl(checkoutUrl)) {
            throw new Cafe24PaymentBridgeError("본사에서 유효한 카페24 결제 링크를 받지 못했습니다.", {
                statusCode: response.status,
                retryable: false,
            });
        }

        return { ...body, checkoutUrl };
    } finally {
        clearTimeout(timeout);
    }
}
