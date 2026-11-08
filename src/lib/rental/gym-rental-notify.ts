/**
 * 체육관 대관 알림 — 원장님 문자·슬랙·앱 알림 + 신청자 안내 문자(꺼 둠).
 *
 * 발송은 기존 장부 경로(sendTrackedSms → NotificationDelivery)만 쓴다. 장부를 못 잡으면 보내지 않는다.
 * 알림 실패가 신청·상태 변경을 되돌리지 않게, 모든 함수는 오류를 삼키고 로그만 남긴다.
 *
 * 스위치
 *  - 원장 알림: /admin/sms 의 «체육관 대관 신청 접수 (관리자)» 규칙. 끄면 문자·슬랙·앱 알림 모두 멈춘다.
 *  - 신청자 승인·확정 문자: 환경변수 RENTAL_APPLICANT_SMS_ENABLED="1" **그리고** /admin/sms 규칙이 켜져야 나간다.
 *  - 신청자 접수 문자: 전용 환경변수 RENTAL_APPLICANT_RECEIVED_SMS_ENABLED="1" **그리고** 규칙이 켜져야 나간다.
 */
import "server-only";
import { prisma } from "@/lib/prisma";
import { createNotificationRecord, sendTrackedSms } from "@/lib/notification";
import { postMessage } from "@/lib/slack/client";
import {
  buildRentalAdminAlert,
  buildRentalApprovedApplicantSms,
  buildRentalConfirmedApplicantSms,
  buildRentalReceivedApplicantSms,
  rentalAdminSmsWindowKey,
  rentalTimeText,
  RENTAL_ADMIN_SMS_WINDOW_MS,
  type RentalMessageInput,
} from "@/lib/rental/gym-rental-rules";

// ── 입금 계좌(서버 전용) ──────────────────────────────────────────────────
// 계좌는 이 파일에만 둔다. 이 파일은 prisma 를 import 하는 서버 전용 모듈이라 손님 브라우저 번들에 실리지 않는다.
// (공개 화면이 import 하는 gym-rental-rules.ts 에 두면 번들에 그대로 들어간다 — 테스트가 번들 경로를 검사)
/** 기본 입금 계좌 — 환경변수 RENTAL_BANK_ACCOUNT 가 있으면 그 값을 쓴다. */
export const DEFAULT_RENTAL_BANK_ACCOUNT = "하나은행 55491019425407 (예금주 권혜미)";

export function resolveRentalBankAccount(envValue: string | null | undefined): string {
  const value = String(envValue ?? "").trim();
  return value || DEFAULT_RENTAL_BANK_ACCOUNT;
}

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

/** 승인·확정 문자 스위치 */
export function isRentalApplicantSmsEnabled(): boolean {
  return process.env.RENTAL_APPLICANT_SMS_ENABLED === "1";
}

/**
 * 접수 문자 전용 스위치 — 누구나 남의 번호를 적어 신청할 수 있어서, 접수 문자는 «아무에게나 문자 보내기»가 될 수 있다.
 * 그래서 승인·확정 스위치와 따로 둔다. 이 값이 "1" 이 아니면 접수 문자는 절대 나가지 않는다.
 */
export function isRentalReceivedSmsEnabled(): boolean {
  return process.env.RENTAL_APPLICANT_RECEIVED_SMS_ENABLED === "1";
}

type RentalRow = RentalMessageInput & { id: string; createdAt?: Date | string | null };

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

/**
 * 새 신청 → 원장님 2명에게 문자 + 앱 알림, 슬랙(건별).
 * 문자는 10분 창마다 한 통으로 묶는다: 그 창의 첫 신청만 문자를 보내고(장부 키 = 창 번호라 같은 창은 중복으로 걸러짐),
 * 본문에 «승인 대기 N건»을 붙인다. 같은 창의 나머지 신청은 슬랙·앱 알림·관리자 화면으로 본다.
 */
export async function notifyAdminsOfRentalRequest(request: RentalRow): Promise<void> {
  try {
    if (!(await isAdminAlertRuleActive())) return; // 원장님이 /admin/sms 에서 끈 경우(시험 때도 이걸로 막는다)
    const createdAtMs = request.createdAt ? new Date(request.createdAt).getTime() : Date.now();
    const windowStartMs = Math.floor(createdAtMs / RENTAL_ADMIN_SMS_WINDOW_MS) * RENTAL_ADMIN_SMS_WINDOW_MS;
    const stats = await prisma.$queryRawUnsafe<Array<{ earlier: number; pending: number }>>(
      `SELECT COUNT(*) FILTER (WHERE "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz AND id <> $3)::int AS earlier,
              COUNT(*) FILTER (WHERE status = 'REQUESTED')::int AS pending
         FROM "GymRentalRequest"`,
      new Date(windowStartMs).toISOString(),
      new Date(createdAtMs).toISOString(),
      request.id,
    );
    // 같은 10분 창에 먼저 들어온 신청이 있으면 이번 건은 문자를 보내지 않는다(그 창의 문자는 이미 나갔다)
    const sendSms = Number(stats[0]?.earlier ?? 0) === 0;
    const body = buildRentalAdminAlert(request, Math.max(1, Number(stats[0]?.pending ?? 1)));
    const smsEventId = rentalAdminSmsWindowKey(createdAtMs);
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
        // 시간 표시는 규칙 모듈의 공용 함수("20:40~22:10 (1시간 30분)")
        message: `${request.applicantName} · ${request.rentalDate} ${rentalTimeText(request)}`,
        linkUrl: "/admin/rental",
      }));
      if (admin.phone && sendSms) {
        tasks.push(sendTrackedSms({
          eventType: RENTAL_EVENT_TYPE,
          // 장부 중복 키 = 10분 창 — 동시에 두 건이 «첫 건»으로 판정돼도 문자는 한 통만 나간다
          eventId: smsEventId,
          trigger: RENTAL_ADMIN_TRIGGER,
          recipientRole: "ADMIN",
          recipientUserId: admin.id,
          recipientPhone: admin.phone,
          body,
        }));
      }
    }
    const slackChannel = (process.env.RENTAL_SLACK_CHANNEL || process.env.SLACK_OWNER_USER_ID || "").trim();
    // 슬랙은 건별로 보낸다(묶지 않음)
    if (slackChannel) tasks.push(postMessage({ channel: slackChannel, text: buildRentalAdminAlert(request) }));
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
  // 접수 문자는 전용 스위치, 승인·확정 문자는 공용 스위치. 둘 다 /admin/sms 규칙도 켜져 있어야 나간다.
  if (kind === "received" ? !isRentalReceivedSmsEnabled() : !isRentalApplicantSmsEnabled()) return;
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
