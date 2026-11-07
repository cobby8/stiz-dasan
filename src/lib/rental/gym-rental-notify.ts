/**
 * 체육관 대관 알림 — 원장님 문자·슬랙·앱 알림 + 신청자 안내 문자(꺼 둠).
 *
 * 발송은 기존 장부 경로(sendTrackedSms → NotificationDelivery)만 쓴다. 장부를 못 잡으면 보내지 않는다.
 * 알림 실패가 신청·상태 변경을 되돌리지 않게, 모든 함수는 오류를 삼키고 로그만 남긴다.
 *
 * 스위치
 *  - 원장 알림: /admin/sms 의 «체육관 대관 신청 접수 (관리자)» 규칙. 끄면 문자·슬랙·앱 알림 모두 멈춘다.
 *  - 신청자 문자: 환경변수 RENTAL_APPLICANT_SMS_ENABLED="1" **그리고** /admin/sms 의 신청자 규칙 3종이 켜져야 나간다.
 */
import { prisma } from "@/lib/prisma";
import { createNotificationRecord, sendTrackedSms } from "@/lib/notification";
import { postMessage } from "@/lib/slack/client";
import {
  buildRentalAdminAlert,
  buildRentalApprovedApplicantSms,
  buildRentalConfirmedApplicantSms,
  buildRentalReceivedApplicantSms,
  resolveRentalBankAccount,
  type RentalMessageInput,
} from "@/lib/rental/gym-rental-rules";

export const RENTAL_EVENT_TYPE = "GYM_RENTAL_REQUEST";
export const RENTAL_ADMIN_TRIGGER = "RENTAL_NEW_ADMIN";
export const RENTAL_APPLICANT_TRIGGERS = {
  received: "RENTAL_RECEIVED_APPLICANT",
  approved: "RENTAL_APPROVED_APPLICANT",
  confirmed: "RENTAL_CONFIRMED_APPLICANT",
} as const;

/** 기본 수신자: 원장 김수빈·권혜미(둘 다 ADMIN). RENTAL_NOTIFY_USER_IDS(쉼표 구분)로 바꿀 수 있다. */
export const DEFAULT_RENTAL_NOTIFY_USER_IDS = [
  "6e66c3a4-9046-4a60-a56c-fc48d43e775d",
  "2a66e1a5-e36d-4db3-885c-de3475f5d8b2",
];

export function resolveRentalNotifyUserIds(envValue: string | null | undefined): string[] {
  const ids = String(envValue ?? "").split(",").map((v) => v.trim()).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  return ids.length > 0 ? ids : DEFAULT_RENTAL_NOTIFY_USER_IDS;
}

export function rentalBankAccount(): string {
  return resolveRentalBankAccount(process.env.RENTAL_BANK_ACCOUNT);
}

export function isRentalApplicantSmsEnabled(): boolean {
  return process.env.RENTAL_APPLICANT_SMS_ENABLED === "1";
}

type RentalRow = RentalMessageInput & { id: string };

async function isAdminAlertRuleActive(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ isActive: boolean }>>(
      `SELECT "isActive" FROM "MessageAutomationRule" WHERE trigger = $1 LIMIT 1`,
      RENTAL_ADMIN_TRIGGER,
    );
    return rows[0]?.isActive === true;
  } catch {
    return false;
  }
}

/** 새 신청 → 원장님 2명에게 문자 + 앱 알림, 슬랙 한 번 */
export async function notifyAdminsOfRentalRequest(request: RentalRow): Promise<void> {
  try {
    if (!(await isAdminAlertRuleActive())) return; // 원장님이 /admin/sms 에서 끈 경우(시험 때도 이걸로 막는다)
    const body = buildRentalAdminAlert(request);
    const ids = resolveRentalNotifyUserIds(process.env.RENTAL_NOTIFY_USER_IDS);
    // 관리자 역할인 계정만(설정값이 잘못돼 학부모 번호로 새는 일 방지)
    const admins = await prisma.$queryRawUnsafe<Array<{ id: string; phone: string | null }>>(
      `SELECT id, phone FROM "User" WHERE id = ANY($1::text[]) AND role IN ('ADMIN','VICE_ADMIN')`,
      ids,
    );
    const tasks: Promise<unknown>[] = [];
    for (const admin of admins) {
      tasks.push(createNotificationRecord({
        userId: admin.id,
        type: RENTAL_EVENT_TYPE,
        title: "체육관 대관 신청",
        message: `${request.applicantName} · ${request.rentalDate} ${request.startHour}시~${request.endHour}시`,
        linkUrl: "/admin/rental",
      }));
      if (admin.phone) {
        tasks.push(sendTrackedSms({
          eventType: RENTAL_EVENT_TYPE,
          eventId: request.id,
          trigger: RENTAL_ADMIN_TRIGGER,
          recipientRole: "ADMIN",
          recipientUserId: admin.id,
          recipientPhone: admin.phone,
          body,
        }));
      }
    }
    const slackChannel = (process.env.RENTAL_SLACK_CHANNEL || process.env.SLACK_OWNER_USER_ID || "").trim();
    if (slackChannel) tasks.push(postMessage({ channel: slackChannel, text: body }));
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") console.error("[gym-rental] admin alert failed:", (result.reason as Error)?.message);
    }
  } catch (error) {
    console.error("[gym-rental] admin alert failed:", (error as Error).message);
  }
}

/** 신청자 안내 문자 — 스위치가 꺼져 있으면 아무것도 하지 않는다 */
export async function sendRentalApplicantSms(
  kind: keyof typeof RENTAL_APPLICANT_TRIGGERS,
  request: RentalRow,
): Promise<void> {
  if (!isRentalApplicantSmsEnabled()) return;
  try {
    const body = kind === "received"
      ? buildRentalReceivedApplicantSms(request)
      : kind === "approved"
        ? buildRentalApprovedApplicantSms(request, rentalBankAccount())
        : buildRentalConfirmedApplicantSms(request);
    await sendTrackedSms({
      eventType: RENTAL_EVENT_TYPE,
      eventId: request.id,
      trigger: RENTAL_APPLICANT_TRIGGERS[kind],
      recipientRole: "PARENT",
      recipientPhone: request.applicantPhone,
      body,
    });
  } catch (error) {
    console.error("[gym-rental] applicant sms failed:", (error as Error).message);
  }
}
