import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { notifyAdminsOfAbsenceChange } from "@/lib/regular/parent-regular-absence";
import { notifyAdminsOfShuttleException } from "@/lib/shuttle/parent-shuttle-exception";

type MissingAbsence = { id: string; studentId: string; studentName: string; classId: string; className: string; date: string; reason: string; status: string; eventVersion: string };
type MissingShuttle = { id: string; studentId: string; studentName: string; serviceDate: string; direction: string; kind: string; location: string | null; note: string | null; canceled: boolean };

/** 최근 사이트 내부 요청 중 전달 장부가 전혀 없는 건만 복구한다. 시트·Rallyz 쓰기는 하지 않는다. */
export async function reconcileOperationalNotifications(limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const absences = await prisma.$queryRawUnsafe<MissingAbsence[]>(
    `SELECT ra.id, ra."studentId" AS "studentId", s.name AS "studentName", ra."classId" AS "classId", c.name AS "className",
            to_char(ra.date,'YYYY-MM-DD') AS date, ra.reason, ra.status, to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"
       FROM "RegularAbsence" ra JOIN "Student" s ON s.id=ra."studentId" JOIN "Class" c ON c.id=ra."classId"
      WHERE ra."updatedAt" >= NOW()-INTERVAL '14 days' AND ra.status IN ('REPORTED','CANCELLED') AND ${notMergedStudent("s")}
        AND NOT EXISTS (SELECT 1 FROM "NotificationDelivery" nd WHERE nd."stableEventKey" =
          ('regular-absence:'||ra.id||':'||CASE WHEN ra.status='CANCELLED' THEN 'CANCELED' ELSE 'REPORTED' END||':'||
           to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS')||CASE WHEN ra.status='CANCELLED' THEN ''
             ELSE '-'||encode(digest(ra.reason,'sha256'),'hex') END))
      ORDER BY ra."updatedAt" LIMIT $1`, safeLimit,
  );
  let processed = 0;
  let failed = 0;
  for (const row of absences) {
    const canceled = row.status === "CANCELLED";
    const notification = await notifyAdminsOfAbsenceChange({ kind: canceled ? "CANCELED" : "REPORTED", studentName: row.studentName,
      className: row.className, classId: row.classId, studentId: row.studentId, date: row.date,
      reason: canceled ? undefined : row.reason, recordId: row.id,
      eventVersion: canceled ? row.eventVersion : `${row.eventVersion}-${createHash("sha256").update(row.reason).digest("hex")}` });
    if (notification && notification.deliveredCount > 0 && notification.failedCount === 0) processed += 1;
    else failed += 1;
  }
  const remaining = safeLimit - processed;
  if (remaining <= 0) return { processed, failed, absence: processed, shuttle: 0 };
  const shuttleCandidates = await prisma.$queryRawUnsafe<MissingShuttle[]>(
    `SELECT x.id, x."studentId" AS "studentId", s.name AS "studentName", to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
            x.direction, x.kind, x.location, x.note, (x."canceledAt" IS NOT NULL) AS canceled
       FROM "ShuttleDayException" x JOIN "Student" s ON s.id=x."studentId"
      WHERE x."updatedAt" >= NOW()-INTERVAL '14 days' AND ${notMergedStudent("s")}
        AND (x."canceledAt" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "ShuttleDayException" active
           WHERE active."studentId"=x."studentId" AND active."serviceDate"=x."serviceDate"
             AND active.direction=x.direction AND active."canceledAt" IS NULL
        ))
      ORDER BY x."updatedAt" LIMIT $1`, Math.min(200, remaining * 10),
  );
  const keyedShuttles = shuttleCandidates.map((row) => ({ row, stableEventKey: `shuttle-day-exception:${row.id}:${row.canceled ? "CANCELED" : "SUBMITTED"}:${row.canceled ? "canceled" : createHash("sha256")
    .update(JSON.stringify({ direction: row.direction, kind: row.kind, location: row.location, note: row.note })).digest("hex")}` }));
  const existingKeys = keyedShuttles.length ? await prisma.$queryRawUnsafe<{ stableEventKey: string }[]>(
    `SELECT DISTINCT "stableEventKey" FROM "NotificationDelivery" WHERE "stableEventKey" = ANY($1::text[])`,
    keyedShuttles.map((entry) => entry.stableEventKey),
  ) : [];
  const existing = new Set(existingKeys.map((entry) => entry.stableEventKey));
  const shuttles = keyedShuttles.filter((entry) => !existing.has(entry.stableEventKey)).slice(0, remaining);
  for (const { row, stableEventKey } of shuttles) {
    const notification = await notifyAdminsOfShuttleException({ action: row.canceled ? "CANCELED" : "SUBMITTED", studentName: row.studentName,
      studentId: row.studentId, serviceDate: row.serviceDate, direction: row.direction, kind: row.kind,
      location: row.location, recordId: row.id, eventVersion: stableEventKey.slice(stableEventKey.lastIndexOf(":") + 1) });
    if (notification && notification.deliveredCount > 0 && notification.failedCount === 0) processed += 1;
    else failed += 1;
  }
  return { processed, failed, absence: absences.length, shuttle: shuttles.length };
}
