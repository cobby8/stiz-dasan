import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import { sendTrackedSms } from "@/lib/notification";
import { prisma } from "@/lib/prisma";

/**
 * 간편로그인 연결·본인인증 로그인 보안 알림(2026-10-26). 남이 내 계정에 들어오거나 붙였을 때 바로 알게 하는 안전장치.
 * 실패해도 본 처리(연결·로그인)는 이미 끝났다 — 오류는 기록만 한다.
 */
export async function notifyAccountSecurityEvent(input: {
  authUserId: string | undefined;
  eventType: "SOCIAL_LOGIN_LINKED" | "IDENTITY_LOGIN";
  body: string;
}) {
  if (!input.authUserId) return;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; phone: string | null }>>(
      `SELECT id, phone FROM "User" WHERE "authUserId" = $1 OR ("authUserId" IS NULL AND id = $1) LIMIT 1`,
      input.authUserId,
    );
    const phone = parentPhoneDigits(rows[0]?.phone);
    if (!rows[0] || !isUsablePhoneKey(phone)) return;
    await sendTrackedSms({
      eventType: input.eventType,
      eventId: `${input.eventType}:${rows[0].id}:${Date.now()}`,
      recipientPhone: phone,
      recipientRole: "PARENT",
      recipientUserId: rows[0].id,
      trigger: `SECURITY_${input.eventType}`,
      source: "SECURITY",
      audienceScope: "SECURITY",
      body: input.body,
    });
  } catch (error) {
    console.error(`[${input.eventType} notice] failed:`, error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
  }
}
