import crypto from "crypto";
import {
    getSmsMessageType,
    getSmsProviderName,
    sendSmsDetailed,
    type SmsProvider,
} from "@/lib/sms";
import {
    estimateMessageCost,
    isAlimtalkConfigured,
    resolveMessageChannelPolicy,
    type DeliveredMessageChannel,
    type MessageAudience,
    type MessageChannel,
} from "@/lib/message-channel-policy";
import {
    claimMessageDelivery,
    finalizeMessageDelivery,
    finalizeMessageDeliveryBatch,
    reserveMessageDelivery,
    reserveMessageDeliveryBatch,
} from "@/lib/message-ledger";

const SOLAPI_URL = "https://api.solapi.com/messages/v4/send";
const MESSAGE_REQUEST_TIMEOUT_MS = 5000;

export type MessageDispatchInput = {
    to: string;
    body: string;
    audience: MessageAudience;
    requestedChannel?: MessageChannel;
    fallbackEnabled?: boolean;
    fallbackChannel?: "SMS" | "LMS" | null;
    forceSms?: boolean;
    alimtalk?: {
        templateId: string;
        variables?: Record<string, string>;
        // 알림톡 본문(등록 문구에 값을 넣은 것). 버튼 있는 틀(청구 안내)은 body 가 «문자용(끝에 링크 줄)»이라
        // 알림톡에는 이 글자를 보낸다. 없으면 body 를 그대로 쓴다(기존 호출 동작 그대로).
        text?: string;
        // 등록 템플릿의 버튼(이름·유형이 같아야 한다). 없으면 넘기지 않는다(기존 호출 동작 그대로)
        buttons?: Array<{ buttonName: string; buttonType: string; linkMo: string; linkPc?: string }>;
    };
    rcs?: {
        templateId: string;
        brandId?: string;
    };
};

export type MessageDispatchResult = {
    ok: boolean;
    to: string;
    provider: SmsProvider;
    requestedChannel: MessageChannel;
    actualChannel: DeliveredMessageChannel;
    fallbackUsed: boolean;
    estimatedCostWon: number;
    groupId?: string;
    messageId?: string;
    reason?: string;
};

export const SECURITY_PHONE_OTP_TRIGGER = "SECURITY_PHONE_OTP";

// 인증번호는 관리자 설정과 관계없이 SMS로 고정하고 다른 채널로 우회하지 않는다.
export async function sendAuthenticationSms(to: string, body: string): Promise<boolean> {
    const stableEventKey = `${SECURITY_PHONE_OTP_TRIGGER}:${crypto.randomUUID()}`;
    try {
        const batchId = await reserveMessageDeliveryBatch({
            source: "SECURITY",
            stableEventKey,
            audienceScope: "SECURITY",
            trigger: SECURITY_PHONE_OTP_TRIGGER,
            purpose: "휴대폰 본인인증",
            body,
            requestedChannel: "SMS",
        });
        if (!batchId) return false;
        const reserved = await reserveMessageDelivery({
            batchId,
            source: "SECURITY",
            stableEventKey,
            eventType: SECURITY_PHONE_OTP_TRIGGER,
            trigger: SECURITY_PHONE_OTP_TRIGGER,
            audienceScope: "SECURITY",
            recipientPhone: to,
            body,
            requestedChannel: "SMS",
        });
        if (!reserved.deliveryId) return false;
        const claimed = await claimMessageDelivery(reserved.deliveryId);
        if (!claimed.claimed) return false;
        const result = await sendMessageDetailed({
            to,
            body,
            audience: "AUTH",
            requestedChannel: "SMS",
            fallbackEnabled: false,
            fallbackChannel: null,
        });
        await finalizeMessageDelivery({
            deliveryId: reserved.deliveryId,
            ok: result.ok,
            provider: result.provider,
            requestedChannel: "SMS",
            actualChannel: result.actualChannel,
            providerGroupId: result.groupId,
            providerMessageId: result.messageId,
            providerStatus: result.ok ? "ACCEPTED" : "FAILED",
            fallbackUsed: false,
            unitCost: result.ok ? result.estimatedCostWon : null,
            errorCode: result.ok ? null : result.reason ?? "SMS_PROVIDER_FAILED",
        });
        await finalizeMessageDeliveryBatch(batchId);
        return result.ok;
    } catch {
        return false;
    }
}

function normalizePhone(value: string): string {
    return value.replace(/\D/g, "");
}

function solapiAuthorization(): string {
    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString("hex");
    const signature = crypto
        .createHmac("sha256", process.env.SOLAPI_API_SECRET || "")
        .update(date + salt)
        .digest("hex");
    return `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY || ""}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function sendSolapiAlimtalk(input: MessageDispatchInput): Promise<MessageDispatchResult> {
    const to = normalizePhone(input.to);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MESSAGE_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(SOLAPI_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: solapiAuthorization(),
            },
            body: JSON.stringify({
                message: {
                    to,
                    from: normalizePhone(process.env.SOLAPI_SENDER || ""),
                    text: input.body,
                    kakaoOptions: {
                        pfId: process.env.SOLAPI_KAKAO_PF_ID,
                        templateId: input.alimtalk!.templateId,
                        variables: input.alimtalk?.variables,
                        ...(input.alimtalk?.buttons?.length ? { buttons: input.alimtalk.buttons } : {}),
                        // 카카오 전달 실패(접수 뒤 — 카톡 미설치 등) 시 솔라피가 문자로 대체한다. 기본값이 false 지만
                        // 실수로 꺼지지 않게 명시한다. 대체 조건: disableSms=false + from(등록 발신번호).
                        // 근거: https://solapi.com/developers/api/messages-disablesms
                        disableSms: false,
                    },
                },
            }),
        });
        const json = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (response.ok && json?.groupId) {
            return {
                ok: true,
                to,
                provider: "SOLAPI",
                requestedChannel: input.requestedChannel ?? "AUTO",
                actualChannel: "ALIMTALK",
                fallbackUsed: false,
                estimatedCostWon: estimateMessageCost("ALIMTALK"),
                groupId: String(json.groupId),
                messageId: typeof json.messageId === "string" ? json.messageId : undefined,
            };
        }
        const reason = json?.errorMessage || json?.message || json?.statusCode || response.status;
        return {
            ok: false,
            to,
            provider: "SOLAPI",
            requestedChannel: input.requestedChannel ?? "AUTO",
            actualChannel: "ALIMTALK",
            fallbackUsed: false,
            estimatedCostWon: 0,
            reason: `Solapi Alimtalk failed: ${String(reason)}`,
        };
    } catch (error) {
        const reason = error instanceof Error && error.name === "AbortError"
            ? `request timed out after ${MESSAGE_REQUEST_TIMEOUT_MS}ms`
            : error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            to,
            provider: "SOLAPI",
            requestedChannel: input.requestedChannel ?? "AUTO",
            actualChannel: "ALIMTALK",
            fallbackUsed: false,
            estimatedCostWon: 0,
            reason: `Solapi Alimtalk request failed: ${reason}`,
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function sendTextFallback(
    input: MessageDispatchInput,
    requestedChannel: MessageChannel,
    fallbackUsed: boolean,
    fallbackChannel?: "SMS" | "LMS" | null,
): Promise<MessageDispatchResult> {
    const textChannel = fallbackChannel
        ?? (requestedChannel === "LMS" ? "LMS" : undefined);
    const result = await sendSmsDetailed(
        input.to,
        input.body,
        textChannel === "LMS"
            ? { messageType: "LMS" }
            : input.forceSms
                ? { messageType: "SMS" }
                : undefined,
    );
    const actualChannel = result.messageType ?? getSmsMessageType(input.body);
    return {
        ok: result.ok,
        to: result.to,
        provider: result.provider ?? getSmsProviderName(),
        requestedChannel,
        actualChannel,
        fallbackUsed,
        estimatedCostWon: result.ok ? estimateMessageCost(actualChannel) : 0,
        groupId: result.groupId,
        messageId: result.messageId,
        reason: result.reason,
    };
}

export async function sendMessageDetailed(input: MessageDispatchInput): Promise<MessageDispatchResult> {
    const requestedChannel = input.requestedChannel ?? "AUTO";
    const policy = resolveMessageChannelPolicy({
        audience: input.audience,
        requestedChannel,
        body: input.body,
        alimtalkTemplateId: input.alimtalk?.templateId,
        fallbackEnabled: input.fallbackEnabled,
        fallbackChannel: input.fallbackChannel,
    });

    if (
        policy.primaryChannel === "ALIMTALK"
        && input.alimtalk
        && isAlimtalkConfigured(input.alimtalk.templateId)
    ) {
        // 알림톡 전용 본문이 있으면 그 글자로 보낸다. 실패 시 문자 대체는 원래 input(문자용 본문)을 쓴다
        const primary = await sendSolapiAlimtalk(
            input.alimtalk.text ? { ...input, body: input.alimtalk.text } : input,
        );
        if (primary.ok || !policy.fallbackAllowed) return primary;
        return sendTextFallback(input, requestedChannel, true, policy.fallbackChannel);
    }

    // RCS는 브랜드 등록 전에는 호출하지 않는다. 정책과 결과 타입만 미리 열고 문자로 안전하게 대체한다.
    if (policy.primaryChannel === "RCS" || policy.primaryChannel === "ALIMTALK") {
        if (!policy.fallbackAllowed) {
            return {
                ok: false,
                to: normalizePhone(input.to),
                provider: getSmsProviderName(),
                requestedChannel,
                actualChannel: policy.primaryChannel,
                fallbackUsed: false,
                estimatedCostWon: 0,
                reason: `${policy.primaryChannel} 채널이 연결되지 않아 발송하지 않았습니다.`,
            };
        }
        return sendTextFallback(input, requestedChannel, true, policy.fallbackChannel);
    }

    return sendTextFallback(input, requestedChannel, false, policy.fallbackChannel);
}
