import { deliverOperationalNotification, type OperationalNotificationDeliveryResult } from "@/lib/operational-notification-delivery";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildDriverLookupContext, selectAssignedDriverIds, type AssignedDriverRow } from "@/lib/operational-driver-resolution";

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

async function resolveAssignedDrivers(context: DriverContext): Promise<{ recipients: Recipient[]; needsConfirmation: boolean }> {
  const lookup = buildDriverLookupContext(context.serviceDate, context.direction);
  if (!lookup || !context.studentId.trim()) return { recipients: [], needsConfirmation: true };
  const rows = await prisma.$queryRawUnsafe<AssignedDriverRow[]>(
    `SELECT vehicle->>'driverUserId' AS "driverUserId", u.id AS "validDriverId", r.direction
       FROM "RegularDispatchRoute" r
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload->'vehicles','[]'::jsonb)) vehicle
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(vehicle->'stops','[]'::jsonb)) stop
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(stop->'students','[]'::jsonb)) student
       LEFT JOIN "User" u ON u.id=vehicle->>'driverUserId' AND u.role='DRIVER'
      WHERE r."serviceMonth"=$1 AND r."dayOfWeek"=$2
        AND r.direction = ANY($3::text[]) AND student->>'requestId'=$4`,
    lookup.serviceMonth,
    lookup.dayOfWeek,
    lookup.directions,
    context.studentId,
  );
  const selected = selectAssignedDriverIds(rows);
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
