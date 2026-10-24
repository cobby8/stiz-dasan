import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import { summarizeDeliveryStatus, type DeliveryStatusRow, type DeliveryStatusSummary } from "@/lib/parent-staff-status";
import {
  SHUTTLE_EXCEPTION_MESSAGE,
  validateShuttleException,
  type ShuttleDirection,
  type ShuttleExceptionKind,
} from "@/lib/shuttle/dayExceptionRules";

// ── 학부모의 "오늘만" 셔틀 변경 ──────────────────────────────────────────────
//
// 결석 신고와 같은 성격이다: 승인 없이 바로 반영하고 원장에게는 알림만 보낸다.
// 기사님 화면이 그날 명단을 만들 때 이 표를 함께 읽는다.
//
// ★ 보안 가드:
//   1) IDOR — studentId 가 그 부모의 자녀인지 SQL 로 재검증.
//   2) 날짜는 서버 기준(KST)으로 판정 — 클라이언트 시계를 믿으면 지난 날도 바꿀 수 있다.
//   3) 같은 학생·날짜·방향에 살아있는 예외는 한 건(DB 부분 유니크가 최종 방어선).

function kstTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type ShuttleExceptionRow = {
  id: string;
  studentId: string;
  studentName: string;
  serviceDate: string;
  direction: string;
  kind: string;
  location: string | null;
  note: string | null;
  notificationStatus?: DeliveryStatusSummary | null;
};

export type ShuttleExceptionOptions = {
  today: string;
  maxDate: string;
  children: { studentId: string; studentName: string }[];
  upcoming: ShuttleExceptionRow[];
};

export async function getShuttleExceptionOptions(parentUserId: string): Promise<ShuttleExceptionOptions> {
  const today = kstTodayYmd();
  const { addDays, MAX_DAYS_AHEAD } = await import("@/lib/shuttle/dayExceptionRules");

  const children = await prisma.$queryRawUnsafe<{ studentId: string; studentName: string }[]>(
    // 셔틀은 정규 수강생만 탄다. 지금 다니는 자녀만 보여준다.
    `SELECT DISTINCT s.id AS "studentId", s.name AS "studentName"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
      ORDER BY s.name`,
    parentUserId,
  );

  const upcoming = await prisma.$queryRawUnsafe<ShuttleExceptionRow[]>(
    `SELECT x.id, x."studentId", s.name AS "studentName",
            to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
            x.direction, x.kind, x.location, x.note
       FROM "ShuttleDayException" x
       JOIN "Student" s ON s.id = x."studentId"
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")} AND x."canceledAt" IS NULL
        AND x."serviceDate" >= $2::date
      ORDER BY x."serviceDate", s.name`,
    parentUserId, today,
  );

  return {
    today,
    maxDate: addDays(today, MAX_DAYS_AHEAD),
    children: children.map((row) => ({ studentId: row.studentId, studentName: row.studentName })),
    upcoming: await Promise.all(upcoming.map(async (row) => ({
      id: row.id,
      studentId: row.studentId,
      studentName: row.studentName,
      serviceDate: row.serviceDate,
      direction: row.direction,
      kind: row.kind,
      location: row.location ?? null,
      note: row.note ?? null,
      notificationStatus: await readShuttleNotificationStatus(row.id, "SUBMITTED", shuttleEventVersion(row)),
    }))),
  };
}

export type SubmitShuttleExceptionInput = {
  studentId?: string;
  serviceDate?: unknown;
  direction?: unknown;
  kind?: unknown;
  location?: unknown;
  note?: unknown;
};

export async function submitShuttleException(parentUserId: string, input: SubmitShuttleExceptionInput) {
  const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
  if (!studentId) return { ok: false as const, message: "자녀를 선택해 주세요." };

  // 가드1: 그 부모의 자녀이고 지금 다니는 학생인지 재검증.
  const owned = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
    `SELECT s.id, s.name
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
      WHERE s.id = $1 AND s."parentId" = $2 AND ${notMergedStudent("s")}
      LIMIT 1`,
    studentId, parentUserId,
  );
  if (!owned[0]) return { ok: false as const, message: "본인 자녀만 신청할 수 있습니다." };

  // 가드2: 날짜 판정은 서버 시계(KST)로 한다.
  const checked = validateShuttleException(input, { today: kstTodayYmd() });
  if (!checked.ok) return { ok: false as const, message: SHUTTLE_EXCEPTION_MESSAGE[checked.error] };
  const direction: ShuttleDirection = checked.direction;
  const kind: ShuttleExceptionKind = checked.kind;

  const serviceDate = String(input.serviceDate);
  const location = kind === "LOCATION" ? String(input.location).trim().slice(0, 200) : null;
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) || null : null;

  // 가드3: 같은 날·같은 방향에 이미 있으면 덮어쓴다(학부모가 마음을 바꾼 것).
  // 두 건이 살아 있으면 기사님이 무엇을 따를지 모른다.
  const saved = await prisma.$queryRawUnsafe<{ id: string; changed: boolean }[]>(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1||'|'||$2||'|'||$3, 0))
     ), existing AS (
       SELECT x.id FROM "ShuttleDayException" x CROSS JOIN guard
        WHERE x."studentId"=$1 AND x."serviceDate"=$2::date AND x.direction=$3
          AND x.kind=$4 AND x.location IS NOT DISTINCT FROM $5 AND x.note IS NOT DISTINCT FROM $6
          AND x."canceledAt" IS NULL
        LIMIT 1
     ), canceled AS (
       UPDATE "ShuttleDayException"
          SET "canceledAt" = now(), "updatedAt" = now()
        WHERE "studentId" = $1 AND "serviceDate" = $2::date AND direction = $3
          AND "canceledAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM existing)
     ), inserted AS (
       INSERT INTO "ShuttleDayException"
        ("studentId","serviceDate","direction","kind","location","note","requestedByUserId")
       SELECT $1,$2::date,$3,$4,$5,$6,$7 WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     ) SELECT id, true AS changed FROM inserted
       UNION ALL SELECT id, false AS changed FROM existing`,
    studentId, serviceDate, direction, kind, location, note, parentUserId,
  );
  if (!saved[0]) return { ok: false as const, message: "셔틀 변경을 저장하지 못했습니다." };
  if (!saved[0].changed) return { ok: true as const, id: saved[0].id, notification: null, noOp: true as const,
    notificationStatus: await readShuttleNotificationStatus(saved[0].id, "SUBMITTED", shuttleEventVersion({ direction, kind, location, note })) };

  const notification = await notifyAdminsOfShuttleException({
    studentName: owned[0].name,
    studentId,
    serviceDate,
    direction,
    kind,
    location,
    recordId: saved[0].id,
    eventVersion: shuttleEventVersion({ direction, kind, location, note }),
  });

  return { ok: true as const, id: saved[0].id, notification,
    notificationStatus: await readShuttleNotificationStatus(saved[0].id, "SUBMITTED", shuttleEventVersion({ direction, kind, location, note })) };
}

export async function cancelShuttleException(parentUserId: string, exceptionId: string) {
  const id = exceptionId?.trim();
  if (!id) return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };

  type CanceledException = {
    id: string;
    studentId: string; studentName: string; serviceDate: string;
    direction: string; kind: string; location: string | null;
  };
  // 취소 UPDATE와 알림에 필요한 원본 확보를 한 문장으로 처리해 IDOR·경합 틈을 만들지 않는다.
  const canceled = await prisma.$queryRawUnsafe<CanceledException[]>(
      `UPDATE "ShuttleDayException" x
          SET "canceledAt" = now(), "updatedAt" = now()
         FROM "Student" s
        WHERE x."studentId" = s.id AND s."parentId" = $1
          AND x.id = $2 AND x."canceledAt" IS NULL
        RETURNING x.id, x."studentId" AS "studentId", s.name AS "studentName",
                  to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
                  x.direction, x.kind, x.location`,
      parentUserId, id,
  );
  if (canceled.length === 0) {
    // 동일 취소 재요청은 실패가 아니다. 다른 부모의 기록 여부는 공개하지 않는다.
    const existing = await getParentShuttleExceptionStatus(parentUserId, id);
    if (existing?.canceled) return { ok: true as const, id, noOp: true as const, notification: null, notificationStatus: existing.notificationStatus };
    return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };
  }
  const row = canceled[0];
  const notification = await notifyAdminsOfShuttleException({
    action: "CANCELED",
    studentName: row.studentName,
    studentId: row.studentId,
    serviceDate: row.serviceDate,
    direction: row.direction,
    kind: row.kind,
    location: row.location,
    recordId: row.id,
    eventVersion: "canceled",
  });
  return { ok: true as const, id, notification, notificationStatus: await readShuttleNotificationStatus(id, "CANCELED", "canceled") };
}

function shuttleEventVersion(input: { direction: string; kind: string; location: string | null; note: string | null }) {
  return createHash("sha256").update(JSON.stringify({ direction: input.direction, kind: input.kind, location: input.location, note: input.note })).digest("hex");
}

async function readShuttleNotificationStatus(id: string, action: "SUBMITTED" | "CANCELED", version: string) {
  try {
    const rows = await prisma.$queryRawUnsafe<DeliveryStatusRow[]>(
      `SELECT d."recipientUserId", d."studentId", d.channel, d.status, d."errorCode", u.role::text AS role
       FROM "NotificationDelivery" d LEFT JOIN "User" u ON u.id=d."recipientUserId"
       WHERE d."stableEventKey"=$1 AND d."audienceScope"='INTERNAL'`,
      `shuttle-day-exception:${id}:${action}:${version}`,
    );
    return summarizeDeliveryStatus(rows);
  } catch {
    // 장부 조회 실패를 '기록 없음'으로 바꾸지 않는다. 저장된 신청은 그대로 유지한다.
    return null;
  }
}

/** GET 재확인도 반드시 부모 소유권을 SQL에서 검증한다. 수신자 ID는 응답에 포함하지 않는다. */
export async function getParentShuttleExceptionStatus(parentUserId: string, id: string) {
  const rows = await prisma.$queryRawUnsafe<(ShuttleExceptionRow & { canceled: boolean })[]>(
    `SELECT x.id, x."studentId", s.name AS "studentName", to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
       x.direction, x.kind, x.location, x.note, (x."canceledAt" IS NOT NULL) AS canceled
     FROM "ShuttleDayException" x JOIN "Student" s ON s.id=x."studentId"
     WHERE x.id=$1 AND s."parentId"=$2 AND ${notMergedStudent("s")} LIMIT 1`, id, parentUserId,
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, notificationStatus: await readShuttleNotificationStatus(id, row.canceled ? "CANCELED" : "SUBMITTED", row.canceled ? "canceled" : shuttleEventVersion(row)) };
}

/**
 * 기사님 명단이 읽는 그날 예외 목록.
 *
 * 정규 셔틀 명단(RegularShuttleStop) 행엔 학생 id 가 없을 수 있다(시트 이관 시절 행은 **글자**만 있다).
 * 그래서 결석 매칭과 같은 방식으로 이름·전화로 이어 붙인다.
 */
export async function getShuttleExceptionsForDate(date: string): Promise<
  { name: string; phone: string | null; direction: string; kind: string; location: string | null }[]
> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string; phone: string | null; direction: string; kind: string; location: string | null }[]>(
      `SELECT s.name AS name, u.phone AS phone, x.direction, x.kind, x.location
         FROM "ShuttleDayException" x
         JOIN "Student" s ON s.id = x."studentId"
         LEFT JOIN "User" u ON u.id = s."parentId"
        WHERE x."serviceDate" = $1::date AND x."canceledAt" IS NULL AND ${notMergedStudent("s")}`,
      date,
    );
    return rows
      .map((row) => ({
        name: String(row.name ?? "").trim(),
        phone: (row.phone as string | null) ?? null,
        direction: row.direction,
        kind: row.kind,
        location: row.location ?? null,
      }))
      .filter((row) => row.name.length > 0);
  } catch (error) {
    // 예외 표를 못 읽어도 운행 명단 자체는 떠야 한다.
    console.error("[shuttle day exception] 조회 실패:", error);
    return [];
  }
}

export async function notifyAdminsOfShuttleException(input: {
  action?: "SUBMITTED" | "CANCELED";
  studentName: string;
  studentId: string;
  serviceDate: string;
  direction: string;
  kind: string;
  location: string | null;
  recordId: string;
  eventVersion: string;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const { SHUTTLE_DIRECTION_LABEL, SHUTTLE_EXCEPTION_KIND_LABEL } = await import(
      "@/lib/shuttle/dayExceptionRules"
    );
    const what = input.kind === "SKIP"
      ? SHUTTLE_EXCEPTION_KIND_LABEL.SKIP
      : `${SHUTTLE_EXCEPTION_KIND_LABEL.LOCATION} (${input.location ?? "-"})`;
    return await notifyOperationalStaff({
      stableEventKey: `shuttle-day-exception:${input.recordId}:${input.action ?? "SUBMITTED"}:${input.eventVersion}`,
      eventType: `SHUTTLE_DAY_EXCEPTION_${input.action ?? "SUBMITTED"}`,
      studentId: input.studentId,
      type: "SHUTTLE_EXCEPTION",
      title: input.action === "CANCELED" ? "셔틀 당일 변경 취소" : "셔틀 당일 변경",
      message: `${input.studentName} · ${input.serviceDate} · ${SHUTTLE_DIRECTION_LABEL[input.direction as ShuttleDirection] ?? input.direction} · ${what}${input.action === "CANCELED" ? " · 취소" : ""}`,
      linkUrl: "/admin/shuttle",
      staffLinkUrl: "/staff/shuttle",
      includeDriver: true,
      driverContext: {
        studentId: input.studentId,
        serviceDate: input.serviceDate,
        direction: input.direction as ShuttleDirection,
      },
    });
  } catch (error) {
    console.error("[parent-shuttle-exception] 원장 알림 실패:", error);
  }
}
