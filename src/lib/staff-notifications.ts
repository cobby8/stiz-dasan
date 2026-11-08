import { prisma } from "@/lib/prisma";
import type { PushDeliveryResult } from "@/lib/pushNotification";
import { processPushOutbox } from "@/lib/push-outbox";
import { notMergedStudent } from "@/lib/studentVisibility";

export type ParentRecipient = {
  studentId: string;
  studentName: string;
  userId: string;
};

export type ParentNotificationResult = {
  sent: boolean;
  duplicate: boolean;
  inAppCreated: boolean;
  push: PushDeliveryResult | null;
};

export async function getClassParentRecipients(classId: string, studentIds?: string[], sessionDate?: Date | string) {
  return prisma.$queryRawUnsafe<ParentRecipient[]>(
    `SELECT DISTINCT s.id AS "studentId", s.name AS "studentName", s."parentId" AS "userId"
     FROM "Enrollment" e
     JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
     WHERE e."classId" = $1 AND e.status = 'ACTIVE'
       AND (e."startsOn" IS NULL OR e."startsOn" <= COALESCE($3::date, (NOW() AT TIME ZONE 'Asia/Seoul')::date) OR EXISTS (
         SELECT 1 FROM "Attendance" historical JOIN "Session" prior ON prior.id=historical."sessionId"
         WHERE historical."studentId"=e."studentId" AND prior."classId"=$1
           AND prior.date::date=COALESCE($3::date, (NOW() AT TIME ZONE 'Asia/Seoul')::date)
       ))
       AND ($2::text[] IS NULL OR s.id = ANY($2::text[]))
       AND s."parentId" IS NOT NULL`,
    classId,
    studentIds?.length ? studentIds : null,
    sessionDate ?? null,
  );
}

/**
 * 학생 id 로 학부모를 바로 찾는다 — 반 수강(Enrollment)을 거치지 않는다.
 * 보강 온 아이는 이 반 수강생이 아니라 getClassParentRecipients 로는 안 잡혀 출석 알림이 빠졌다(2026-11-09 원장 승인).
 * 수신자 기준(Student.parentId)은 getClassParentRecipients 와 같다.
 */
export async function getStudentParentRecipients(studentIds: string[]) {
  if (!studentIds.length) return [] as ParentRecipient[];
  return prisma.$queryRawUnsafe<ParentRecipient[]>(
    `SELECT DISTINCT s.id AS "studentId", s.name AS "studentName", s."parentId" AS "userId"
     FROM "Student" s
     WHERE s.id = ANY($1::text[]) AND ${notMergedStudent("s")} AND s."parentId" IS NOT NULL`,
    studentIds,
  );
}

/** 앱 알림과 푸시를 서로 다른 장부 행으로 기록해 채널별 실제 결과를 보존합니다. */
export async function deliverParentNotification(input: {
  eventType: string;
  dedupeKey: string;
  recipient: ParentRecipient;
  title: string;
  message: string;
  linkUrl: string;
  sessionId?: string;
  attendanceId?: string;
  noticeId?: string;
}): Promise<ParentNotificationResult> {
  const inAppClaimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `WITH delivery AS (
       INSERT INTO "NotificationDelivery" (
         id, "eventType", "sessionId", "attendanceId", "noticeId", "studentId",
         "recipientUserId", channel, "dedupeKey", status, "attemptCount", "sentAt", "createdAt", "updatedAt"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
         'IN_APP', $7, 'SENT', 1, NOW(), NOW(), NOW()
       ) ON CONFLICT ("dedupeKey") DO NOTHING
       RETURNING id
     ), notification AS (
       INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
       SELECT gen_random_uuid()::text, $6, $1, $8, $9, $10, false, NOW()
       FROM delivery
     ) SELECT id FROM delivery`,
    input.eventType,
    input.sessionId ?? null,
    input.attendanceId ?? null,
    input.noticeId ?? null,
    input.recipient.studentId,
    input.recipient.userId,
    input.dedupeKey,
    input.title,
    input.message,
    input.linkUrl,
  );

  const pushClaimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "NotificationDelivery" (
       id, "eventType", "sessionId", "attendanceId", "noticeId", "studentId",
       "recipientUserId", channel, "dedupeKey", status, "attemptCount", "payloadJSON", "nextAttemptAt", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
       'PUSH', $7, 'PENDING', 0, $8::jsonb, NOW(), NOW(), NOW()
     ) ON CONFLICT ("dedupeKey") DO NOTHING
     RETURNING id`,
    input.eventType,
    input.sessionId ?? null,
    input.attendanceId ?? null,
    input.noticeId ?? null,
    input.recipient.studentId,
    input.recipient.userId,
    `${input.dedupeKey}:push`,
    JSON.stringify({ title: input.title, body: input.message, url: input.linkUrl, tag: input.eventType }),
  );

  // 두 장부가 모두 이미 있으면 같은 이벤트의 재호출이므로 다시 발송하지 않습니다.
  if (!pushClaimed[0]) {
    return {
      sent: false,
      duplicate: !inAppClaimed[0],
      inAppCreated: Boolean(inAppClaimed[0]),
      push: null,
    };
  }

  try {
    const processed = await processPushOutbox(1, pushClaimed[0].id);
    return {
      sent: processed.sent + processed.partial > 0,
      duplicate: false,
      inAppCreated: Boolean(inAppClaimed[0]),
      push: processed.lastPush,
    };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 200) : "PUSH_FAILED";
    return {
      sent: false,
      duplicate: false,
      inAppCreated: Boolean(inAppClaimed[0]),
      push: {
        status: "FAILED",
        subscriptionCount: 0,
        sentCount: 0,
        failedCount: 1,
        removedCount: 0,
        errorCode,
      },
    };
  }
}
