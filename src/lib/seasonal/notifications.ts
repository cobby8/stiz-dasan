import "server-only";
import {
  dispatchReservedSmsDelivery,
  finalizeReservedSmsWithoutDispatch,
  reserveFailClosedSmsDelivery,
  resolveParentMessage,
  type SmsLedgerDb,
} from "@/lib/notification";
import { renderSmsTemplateResult } from "@/lib/smsTemplate";
import { prisma } from "@/lib/prisma";

export const SEASONAL_SMS_MAX_BYTES = 2000;

export function seasonalSmsBytes(body: string) {
  return Buffer.byteLength(body, "utf8");
}

export const SEASONAL_SMS_TRIGGERS = {
  received: "SPECIAL_APPLICATION_RECEIVED_PARENT",
  approved: "SPECIAL_APPLICATION_APPROVED_PARENT",
  waitlisted: "SPECIAL_APPLICATION_WAITLISTED_PARENT",
  rejected: "SPECIAL_APPLICATION_REJECTED_PARENT",
  cancelled: "SPECIAL_APPLICATION_CANCELLED_PARENT",
  accountActivation: "SPECIAL_ACCOUNT_ACTIVATION_PARENT",
  paymentRequest: "SPECIAL_PAYMENT_REQUEST_PARENT",
} as const;

export type SeasonalSmsTrigger = typeof SEASONAL_SMS_TRIGGERS[keyof typeof SEASONAL_SMS_TRIGGERS];
export type SeasonalSmsDeliveryResult = {
  ok: boolean;
  status: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  deliveryId: string | null;
  errorCode?: string;
  requiresReissue?: boolean;
};
export type SeasonalSmsReservationResult = SeasonalSmsDeliveryResult;

export type SendSeasonalParentSmsInput = {
  trigger: SeasonalSmsTrigger;
  applicationId: string;
  itemId?: string | null;
  recipientPhone: string;
  recipientUserId?: string | null;
  variables: Record<string, string>;
  /** Only explicit manual retries receive a new opaque run id. */
  deliveryRunId?: string;
};

function stableSeasonalEventId(input: Pick<SendSeasonalParentSmsInput, "applicationId" | "itemId" | "trigger">) {
  return [input.applicationId, input.itemId || "application", input.trigger].join(":");
}

function requiresFreshSecret(trigger: SeasonalSmsTrigger) {
  return trigger === SEASONAL_SMS_TRIGGERS.accountActivation;
}

export async function reserveSeasonalParentSms(
  db: SmsLedgerDb,
  input: Omit<SendSeasonalParentSmsInput, "variables">,
): Promise<SeasonalSmsReservationResult> {
  if (!input.applicationId.trim()) return { ok: false, status: "FAILED", deliveryId: null, errorCode: "APPLICATION_ID_REQUIRED" };
  const reserved = await reserveFailClosedSmsDelivery(db, {
    eventType: "SPECIAL_PROGRAM_NOTIFICATION",
    eventId: stableSeasonalEventId(input),
    deliveryRunId: input.deliveryRunId,
    recipientUserId: input.recipientUserId,
    recipientPhone: input.recipientPhone,
    recipientRole: "PARENT",
    trigger: input.trigger,
  });
  return { ...reserved, ...(requiresFreshSecret(input.trigger) ? { requiresReissue: true } : {}) };
}

/**
 * 학원 대표 전화 — 특강 문자 7종의 «문의: #{학원전화}» 가 빈칸으로 나가던 버그(2026-11-09) 수정.
 * 호출부가 7곳이라 각각 고치지 않고, 보내기 직전 이 한 곳에서 채운다. 조회 실패는 빈 값(금고 기본값이 대신 채움).
 */
async function academyContactPhone(): Promise<string> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ contactPhone: string | null }>>(
      `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    );
    return String(rows[0]?.contactPhone ?? "").trim();
  } catch {
    return "";
  }
}

export async function dispatchSeasonalParentSms(input: {
  deliveryId: string;
  trigger: SeasonalSmsTrigger;
  recipientPhone: string;
  variables: Record<string, string>;
}): Promise<SeasonalSmsDeliveryResult> {
  // 호출부가 학원 전화를 넘기지 않았으면 설정값으로 채운다
  const variables = input.variables.academyPhone?.trim()
    ? input.variables
    : { ...input.variables, academyPhone: await academyContactPhone() };
  const rendered = await renderSmsTemplateResult(input.trigger, variables);
  if (!rendered.ok) {
    const result: SeasonalSmsDeliveryResult = { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: rendered.reason };
    await finalizeReservedSmsWithoutDispatch({ deliveryId: input.deliveryId, status: "FAILED", errorCode: rendered.reason });
    return { ...result, ...(requiresFreshSecret(input.trigger) && !result.ok ? { requiresReissue: true } : {}) };
  }
  // 알림톡 금고 트리거(특강 결제 요청·취소·접수·승인·대기)는 코드 틀 본문 + 알림톡 정보로 보낸다
  const message = resolveParentMessage(input.trigger, variables, rendered.body);
  if (seasonalSmsBytes(message.body) > SEASONAL_SMS_MAX_BYTES) {
    await finalizeReservedSmsWithoutDispatch({ deliveryId: input.deliveryId, status: "FAILED", errorCode: "MESSAGE_TOO_LONG" });
    return { ok: false, status: "FAILED", deliveryId: input.deliveryId, errorCode: "MESSAGE_TOO_LONG", ...(requiresFreshSecret(input.trigger) ? { requiresReissue: true } : {}) };
  }
  const result = await dispatchReservedSmsDelivery({
    deliveryId: input.deliveryId,
    recipientPhone: input.recipientPhone,
    body: message.body,
    alimtalk: message.alimtalk,
  });
  return { ...result, ...(requiresFreshSecret(input.trigger) && !result.ok ? { requiresReissue: true } : {}) };
}

export async function sendSeasonalParentSms(input: SendSeasonalParentSmsInput): Promise<SeasonalSmsDeliveryResult> {
  const { variables, ...reservationInput } = input;
  const reserved = await reserveSeasonalParentSms(prisma, reservationInput);
  if (reserved.status !== "PENDING" || !reserved.deliveryId) return reserved;
  return dispatchSeasonalParentSms({ deliveryId: reserved.deliveryId, trigger: input.trigger, recipientPhone: input.recipientPhone, variables });
}
