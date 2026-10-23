"use server";

import { prisma } from "@/lib/prisma";
import { requireStaffClassAccess } from "@/lib/staff-class-access";
import { deliverParentNotification, getClassParentRecipients } from "@/lib/staff-notifications";
import { getStaffClassContacts } from "@/lib/staff-contacts";
import { createHash } from "node:crypto";
import { summarizeDeliveryStatus, type DeliveryStatusRow } from "@/lib/parent-staff-status";

export async function loadStaffClassContacts(classId: string) {
  return getStaffClassContacts(classId);
}

export async function createStaffClassNotice(input: { classId: string; title: string; content: string; operationId: string; resumeDelivery?: boolean }) {
  const classId = input.classId.trim();
  const title = input.title.trim();
  const content = input.content.trim();
  if (!classId || !title || !content) return { ok: false as const, message: "공지 제목과 내용을 입력해 주세요." };

  const access = await requireStaffClassAccess(classId);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.operationId ?? "")) return { ok: false as const, message: "공지 작업 정보를 확인해 주세요." };
  // 작성자·반·작업 ID로 고정 ID를 만든다. 응답이 유실되어도 같은 공지가 두 번 생기지 않는다.
  const noticeId = createHash("sha256").update(JSON.stringify([access.staff.appUserId, classId, input.operationId])).digest("hex");
  const notices = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Notice" (id, "authorUserId", title, content, "targetType", "targetClassIds", "sentAt", "createdAt", "updatedAt")
     VALUES ($5, $1, $2, $3, 'CLASS', $4, NOW(), NOW(), NOW()) ON CONFLICT (id) DO NOTHING RETURNING id`,
    access.staff.appUserId, title, content, JSON.stringify([classId]), noticeId,
  );
  const saved = await findOwnedNotice(noticeId, classId, access.staff.appUserId);
  if (!saved || saved.title !== title || saved.content !== content) return { ok: false as const, message: "이미 저장된 공지와 내용이 다릅니다. 저장 결과를 확인한 뒤 새 공지를 작성해 주세요." };
  if (!notices[0] && !input.resumeDelivery) return noticeStatus(saved.id, classId);
  try {
  let recipients = await getClassParentRecipients(classId);
  if (input.resumeDelivery) {
    // 원래 수신자 근거가 있는 사람만 복구한다. 뒤늦게 입반한 학부모를 새 대상으로 추가하지 않는다.
    const originals = await prisma.$queryRawUnsafe<{ studentId: string; recipientUserId: string }[]>(
      `SELECT DISTINCT "studentId", "recipientUserId" FROM "NotificationDelivery" WHERE "noticeId"=$1 AND "eventType"='CLASS_NOTICE'`, noticeId,
    );
    const originalKeys = new Set(originals.map((row) => `${row.studentId}:${row.recipientUserId}`));
    if (originalKeys.size === 0) return { ...await noticeStatus(noticeId, classId), deliveryResumeHeld: true };
    recipients = recipients.filter((recipient) => originalKeys.has(`${recipient.studentId}:${recipient.userId}`));
  }
  const attempted = await Promise.allSettled(recipients.map((recipient) => deliverParentNotification({
    eventType: "CLASS_NOTICE",
    dedupeKey: `notice:${noticeId}:student:${recipient.studentId}:user:${recipient.userId}`,
    recipient,
    title,
    message: content,
    linkUrl: "/notices",
    noticeId,
  })));
  const deliveries = attempted.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  const pushSentCount = deliveries.filter((delivery) => delivery.sent).length;
  const inAppCreatedCount = deliveries.filter((delivery) => delivery.inAppCreated).length;
  const duplicateCount = deliveries.filter((delivery) => delivery.duplicate).length;
  const noSubscriptionCount = deliveries.filter(
    (delivery) => delivery.push?.status === "NO_SUBSCRIPTION",
  ).length;
  const pushFailedCount = deliveries.filter(
    (delivery) => delivery.push?.status === "FAILED" || delivery.push?.status === "PARTIAL",
  ).length;
  const pushSkippedCount = deliveries.filter(
    (delivery) => delivery.push?.status === "NOT_CONFIGURED",
  ).length;

  return {
    ok: true as const,
    noticeId,
    recipientCount: recipients.length,
    inAppCreatedCount,
    pushSentCount,
    pushFailedCount,
    pushSkippedCount,
    noSubscriptionCount,
    duplicateCount,
    deliveryLookupFailed: false,
    deliveryAttemptFailedCount: attempted.filter((item) => item.status === "rejected").length,
    notificationStatus: await readNoticeDeliveryStatus(noticeId),
  };
  } catch {
    // 수신자 조회나 전달 장부가 실패해도 앞서 저장한 공지의 ID와 성공 상태는 보존한다.
    return { ok: true as const, noticeId, notificationStatus: await readNoticeDeliveryStatus(noticeId), deliveryLookupFailed: true };
  }
}

async function findOwnedNotice(noticeId: string, classId: string, authorUserId: string) {
  const rows = await prisma.$queryRawUnsafe<{ id: string; title: string; content: string }[]>(
    `SELECT id,title,content FROM "Notice" WHERE id=$1 AND "authorUserId"=$2 AND "targetType"='CLASS'
     AND "targetClassIds"=$3 LIMIT 1`, noticeId, authorUserId, JSON.stringify([classId]),
  );
  return rows[0] ?? null;
}

async function readNoticeDeliveryStatus(noticeId: string) {
  try {
    const rows = await prisma.$queryRawUnsafe<DeliveryStatusRow[]>(
      `SELECT "recipientUserId", "studentId", channel, status, "errorCode" FROM "NotificationDelivery" WHERE "noticeId"=$1 AND "eventType"='CLASS_NOTICE'`, noticeId,
    );
    return summarizeDeliveryStatus(rows);
  } catch { return null; }
}

async function noticeStatus(noticeId: string, classId: string) {
  let recipientCount: number | null = null;
  try { recipientCount = (await getClassParentRecipients(classId)).length; } catch { /* 기록 조회와 연결 대상 조회를 구분한다. */ }
  return { ok: true as const, noticeId, notificationStatus: await readNoticeDeliveryStatus(noticeId), recipientCount, deliveryLookupFailed: recipientCount === null };
}

/** 응답 유실 후 확인 전용. 조회는 새 공지나 알림을 만들지 않는다. */
export async function getStaffClassNoticeStatus(input: { classId: string; operationId: string }) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.operationId ?? "")) return { ok: false as const, message: "공지 작업 정보를 확인해 주세요." };
  const access = await requireStaffClassAccess(input.classId);
  const noticeId = createHash("sha256").update(JSON.stringify([access.staff.appUserId, input.classId, input.operationId])).digest("hex");
  const saved = await findOwnedNotice(noticeId, input.classId, access.staff.appUserId);
  if (!saved) return { ok: false as const, code: "NOT_FOUND" as const, message: "현재 저장된 공지가 조회되지 않습니다. 같은 작업으로 다시 제출할 수 있습니다." };
  return { ...await noticeStatus(saved.id, input.classId), savedTitle: saved.title, savedContent: saved.content };
}
