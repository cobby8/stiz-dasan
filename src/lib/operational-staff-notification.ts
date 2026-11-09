import { deliverOperationalNotification, type OperationalNotificationDeliveryResult } from "@/lib/operational-notification-delivery";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildDriverLookupContext, selectRosterDriverIds } from "@/lib/operational-driver-resolution";

export type OperationalRecipientSummary = {
  admin: "NOTIFIED" | "NOT_FOUND";
  coach: "NOTIFIED" | "NOT_FOUND" | "NOT_APPLICABLE";
  driver: "NOTIFIED" | "NEEDS_CONFIRMATION" | "NOT_APPLICABLE";
  recipientCount: number;
  deliveredCount: number;
  failedCount: number;
  deliveries: Array<OperationalNotificationDeliveryResult & { role: string }>;
};

type Recipient = { id: string; role: string };
type DriverContext = { studentId: string; serviceDate: string; direction?: "PICKUP" | "DROPOFF" | "BOTH" };

async function resolveRecipients(input: { classId?: string; includeCoach: boolean }) {
  return prisma.$queryRawUnsafe<Recipient[]>(
    `WITH recipients AS (
       SELECT u.id, u.role::text AS role FROM "User" u WHERE u.role IN ('ADMIN','VICE_ADMIN')
       UNION
       SELECT u.id, u.role::text AS role FROM "Class" c
         JOIN "User" u ON u.id=c."instructorId" AND u.role='INSTRUCTOR'
        WHERE $1::boolean AND c.id=$2
       UNION
       SELECT u.id, u.role::text AS role FROM "Class" c
         JOIN "ScheduleSlot" ss ON ss."slotKey"=c."slotKey"
         JOIN "Coach" co ON co.id=ss."coachId"
         JOIN "User" u ON u.id=co."userId" AND u.role='INSTRUCTOR'
        WHERE $1::boolean AND c.id=$2
       UNION
       SELECT u.id, u.role::text AS role FROM "Class" c
         JOIN "ClassSlotOverride" o ON o."slotKey"=c."slotKey"
         JOIN "Coach" co ON co.id=o."coachId"
         JOIN "User" u ON u.id=co."userId" AND u.role='INSTRUCTOR'
        WHERE $1::boolean AND c.id=$2
     ) SELECT DISTINCT id, role FROM recipients`,
    input.includeCoach,
    input.classId ?? null,
  );
}

// 기사 역할 조건 — 명단 변경 기사님 알림(regularRosterNotify)·기사 새 학생 배정 권한과 같다(주 역할 또는 승인된 추가 역할, 탈퇴 제외).
const DRIVER_CONDITION = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;

// 6단계(2026-11-09): 저장 노선(RegularDispatchRoute)에서 차량 기사를 찾지 않는다 — 셔틀 명단이 정본.
// 그날(그 달 이하 최신 명단 달·요일·방향) 명단에 그 학생이 있으면 현재 기사 역할 전원에게 보낸다.
// 명단에 없거나 기사 계정이 없으면 아무에게도 보내지 않고 원장 알림에 «담당 기사 확인 필요»를 붙인다(종전과 같은 보류).
async function resolveAssignedDrivers(context: DriverContext): Promise<{ recipients: Recipient[]; needsConfirmation: boolean }> {
  const lookup = buildDriverLookupContext(context.serviceDate, context.direction);
  if (!lookup || !context.studentId.trim()) return { recipients: [], needsConfirmation: true };
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT u.id FROM "User" u
      WHERE u."withdrawnAt" IS NULL AND ${DRIVER_CONDITION}
        AND EXISTS (
          SELECT 1 FROM "RegularShuttleStop" s
           WHERE s."serviceMonth" = (SELECT max("serviceMonth") FROM "RegularShuttleStop" WHERE "serviceMonth" <= $1)
             AND s.weekday = $2 AND s.direction = ANY($3::text[]) AND s."studentId" = $4)
      ORDER BY u.id`,
    lookup.serviceMonth,
    lookup.weekday,
    lookup.rosterDirections,
    context.studentId,
  );
  const selected = selectRosterDriverIds(rows.map((row) => row.id));
  return {
    recipients: selected.driverIds.map((id) => ({ id, role: "DRIVER" })),
    needsConfirmation: selected.needsConfirmation,
  };
}

/** 원장·담당 코치·기사 계정에 인앱 알림을 만들고 웹 푸시를 시도한다. */
export async function notifyOperationalStaff(input: {
  type: string;
  title: string;
  message: string;
  linkUrl: string;
  staffLinkUrl?: string;
  classId?: string;
  includeCoach?: boolean;
  includeDriver?: boolean;
  driverContext?: DriverContext;
  stableEventKey?: string;
  eventType?: string;
  studentId?: string;
}): Promise<OperationalRecipientSummary> {
  const includeCoach = input.includeCoach === true;
  const includeDriver = input.includeDriver === true;
  const recipients = await resolveRecipients({ classId: input.classId, includeCoach });
  const driverResolution = includeDriver && input.driverContext
    ? await resolveAssignedDrivers(input.driverContext)
    : { recipients: [] as Recipient[], needsConfirmation: includeDriver };
  const allRecipients = [...recipients, ...driverResolution.recipients]
    .filter((recipient, index, list) => list.findIndex((candidate) => candidate.id === recipient.id) === index);
  // 기존 수강변경 호출부는 아직 원본 이벤트 키 계약이 없다. 결석·셔틀은 호출부가 안정 키를 반드시 넘긴다.
  const stableEventKey = input.stableEventKey ?? `operational:${input.type}:${randomUUID()}`;
  const eventType = input.eventType ?? input.type;

  const attempted = await Promise.allSettled(allRecipients.map(async (recipient) => ({
    role: recipient.role,
    ...await deliverOperationalNotification({
      stableEventKey,
      eventType,
      trigger: input.type,
      studentId: input.studentId,
      recipientUserId: recipient.id,
      title: input.title,
      message: driverResolution.needsConfirmation && (recipient.role === "ADMIN" || recipient.role === "VICE_ADMIN")
        ? `${input.message} · 담당 기사 확인 필요`
        : input.message,
      linkUrl: recipient.role === "ADMIN" || recipient.role === "VICE_ADMIN"
        ? input.linkUrl
        : (input.staffLinkUrl ?? input.linkUrl),
    }),
  })));
  const deliveries = attempted.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const successfulDeliveries = deliveries.filter((delivery) => delivery.inAppCreated || delivery.duplicate);
  const failedCount = attempted.length - successfulDeliveries.length;
  for (const result of attempted) {
    if (result.status === "rejected") console.error("[operational-staff-notification] 전달 장부 기록 실패:", result.reason);
  }

  const roles = new Set(successfulDeliveries.map((recipient) => recipient.role));
  return {
    admin: roles.has("ADMIN") || roles.has("VICE_ADMIN") ? "NOTIFIED" : "NOT_FOUND",
    coach: includeCoach ? (roles.has("INSTRUCTOR") ? "NOTIFIED" : "NOT_FOUND") : "NOT_APPLICABLE",
    driver: includeDriver ? (roles.has("DRIVER") ? "NOTIFIED" : "NEEDS_CONFIRMATION") : "NOT_APPLICABLE",
    recipientCount: allRecipients.length,
    deliveredCount: successfulDeliveries.length,
    failedCount,
    deliveries,
  };
}
