import { unstable_noStore as noStore } from "next/cache";

import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import {
  requireStaffClassAccess,
  requireStaffSeasonalSessionAccess,
} from "@/lib/staff-class-access";
import { normalizePhoneNumber } from "@/lib/staff-contacts";
import { notMergedStudent } from "@/lib/studentVisibility";

export type StaffClassGuardian = {
  id: string | null;
  name: string;
  relation: string;
  phone: string | null;
  isPrimary: boolean;
};

export type StaffClassAttendanceSummary = {
  present: number;
  late: number;
  absent: number;
  total: number;
};

export type StaffClassBillingSummary = {
  unpaidCount: number;
  pendingConfirmationCount: number;
  // 학생별 미납 «합계» — 부원장에게는 null(2026-11-14, 건수만 보인다). 원장만 숫자
  unpaidAmount: number | null;
};

export type StaffClassPerson = {
  id: string;
  name: string;
  school: string | null;
  grade: string | null;
  memo: string | null;
  studentPhone: string | null;
  guardians: StaffClassGuardian[];
  recentAttendance: StaffClassAttendanceSummary;
  todayStatus: "PRESENT" | "LATE" | "ABSENT" | null;
  // null = 이 직원은 수강료·미납을 볼 수 없음(선생님 — loadStaffClassPeople 이 비운다).
  billing: StaffClassBillingSummary | null;
};

type StaffClassPersonRow = Omit<
  StaffClassPerson,
  "guardians" | "recentAttendance" | "billing"
> & {
  guardians: StaffClassGuardian[] | null;
  recentAttendance: StaffClassAttendanceSummary | null;
  billing: StaffClassBillingSummary | null;
};

/** 정규 수업 기록의 날짜("YYYY-MM-DD"). 기록이 없거나 다른 반 기록이면 오늘(KST) — 대타 판정 기준 날짜(f4). */
async function regularSessionDateOrToday(classId: string, sessionId?: string | null): Promise<string> {
  if (!sessionId) return todayKst();
  const rows = await prisma.$queryRawUnsafe<Array<{ date: string }>>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date FROM "Session" WHERE id = $1 AND "classId" = $2 LIMIT 1`,
    sessionId,
    classId,
  );
  return rows[0]?.date ?? todayKst();
}

async function resolveSessionDateId(sessionId?: string | null) {
  if (!sessionId) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ sessionDateId: string | null; classId: string | null; date: string | null }>>(
    `SELECT "specialProgramSessionDateId" AS "sessionDateId", "classId", to_char(date,'YYYY-MM-DD') AS date
       FROM "Session"
      WHERE id = $1
      LIMIT 1`,
    sessionId,
  );
  if (rows[0]?.sessionDateId) return rows[0].sessionDateId;
  // 폴백: 세션에 특강 회차가 안 붙어 있어도, 이 반이 '그날 방학특강 회차가 있는 연결반'이면 그 회차를 앵커로 삼는다.
  // (같은 반에 정규식 세션이 섞여 있어 특강 명단이 정규(1명)로 폴백되던 문제 해결)
  if (rows[0]?.classId && rows[0]?.date) {
    const anchor = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT sd.id
         FROM "SpecialProgramOffering" o
         JOIN "SpecialProgramSessionDate" sd ON sd."offeringId" = o.id
        WHERE o."linkedClassId" = $1
          AND (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $2::date
        LIMIT 1`,
      rows[0].classId, rows[0].date,
    );
    if (anchor[0]?.id) return anchor[0].id;
  }
  return null;
}

/**
 * 담당 수업의 활성 학생 정보를 한 번의 묶음 조회로 반환합니다.
 * 연락처가 포함되므로 결과를 Next.js 데이터 캐시에 저장하지 않습니다.
 */
export async function getStaffClassPeople(
  classId: string,
  sessionId?: string | null,
  sessionDateId?: string | null,
): Promise<StaffClassPerson[]> {
  noStore();
  const effectiveSessionDateId = sessionDateId ?? await resolveSessionDateId(sessionId);

  if (effectiveSessionDateId) {
    await requireStaffSeasonalSessionAccess(effectiveSessionDateId);
  } else {
    // f4 대타: 그 수업 기록의 날짜(기록 전이면 오늘 KST)에 대타 지정이 있으면 명단을 연다.
    //   기록 날짜는 classId 까지 함께 맞춰 찾는다 — 다른 반 기록 ID 를 섞어 날짜를 바꿔 끼우지 못하게.
    await requireStaffClassAccess(classId, undefined, { substituteDate: await regularSessionDateOrToday(classId, sessionId) });
  }

  const rows = effectiveSessionDateId
    ? await prisma.$queryRawUnsafe<StaffClassPersonRow[]>(
      `WITH active_students AS (
         SELECT DISTINCT
                COALESCE(st.id, 'item:' || item.id) AS id,
                st.id AS "studentId",
                COALESCE(st.name, app."childName") AS name,
                st.school, st.grade, st.memo,
                COALESCE(st.phone, app."childPhone") AS phone,
                st."parentId"
           FROM "SpecialProgramSessionDate" anchor_sd
           JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = anchor_sd."offeringId"
           JOIN "SpecialProgramSessionDate" sd
             ON sd."startsAt" = anchor_sd."startsAt" AND sd."endsAt" = anchor_sd."endsAt"
           JOIN "SpecialProgramOffering" o
             ON o.id = sd."offeringId"
            AND (
              o.id = anchor_o.id
              OR (
                anchor_o."linkedClassId" IS NOT NULL
                AND o."linkedClassId" = anchor_o."linkedClassId"
                AND o."seasonId" = anchor_o."seasonId"
              )
            )
           -- 좌석(SCHEDULED) 기준 명단. 미전환 신청자도 childName으로 포함하고, 취소 좌석은 제외 → 출석부와 동일.
           JOIN "SpecialProgramApplicationItem" item ON item."offeringId" = o.id AND item.status = 'APPROVED'
           JOIN "SpecialProgramEnrollmentDate" seat
             ON seat."applicationItemId" = item.id AND seat."sessionDateId" = sd.id AND seat.status = 'SCHEDULED'
           JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
           LEFT JOIN "Student" st ON st.id = app."convertedStudentId" AND ${notMergedStudent("st")}
          WHERE anchor_sd.id = $1
            AND anchor_o."linkedClassId" = $2
       ), recent_attendance AS (
         SELECT ranked."studentId",
                COUNT(*) FILTER (WHERE ranked.status = 'PRESENT')::int AS present,
                COUNT(*) FILTER (WHERE ranked.status = 'LATE')::int AS late,
                COUNT(*) FILTER (WHERE ranked.status = 'ABSENT')::int AS absent,
                COUNT(*)::int AS total
           FROM (
             SELECT a."studentId", a.status,
                    ROW_NUMBER() OVER (PARTITION BY a."studentId" ORDER BY se.date DESC, a."updatedAt" DESC) AS rank
               FROM "Attendance" a
               JOIN "Session" se ON se.id = a."sessionId"
              WHERE se."classId" = $2
           ) ranked
          WHERE ranked.rank <= 12
          GROUP BY ranked."studentId"
       ), billing_summary AS (
         SELECT p."studentId",
                COUNT(*) FILTER (WHERE p.status IN ('PENDING', 'OVERDUE'))::int AS "unpaidCount",
                COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('PENDING', 'OVERDUE')), 0)::int AS "unpaidAmount",
                COUNT(*) FILTER (WHERE latest.status = 'PENDING')::int AS "pendingConfirmationCount"
           FROM "Payment" p
           LEFT JOIN LATERAL (
             SELECT r.status
               FROM "StaffPaymentConfirmationRequest" r
              WHERE r."paymentId" = p.id
              ORDER BY r."createdAt" DESC
              LIMIT 1
           ) latest ON true
          WHERE p."classId" = $2
          GROUP BY p."studentId"
       )
       SELECT s.id, s.name, s.school, s.grade, s.memo, s.phone AS "studentPhone",
              COALESCE(guardian_data.guardians, '[]'::jsonb) AS guardians,
              jsonb_build_object(
                'present', COALESCE(ra.present, 0),
                'late', COALESCE(ra.late, 0),
                'absent', COALESCE(ra.absent, 0),
                'total', COALESCE(ra.total, 0)
              ) AS "recentAttendance",
              today_attendance.status AS "todayStatus",
              jsonb_build_object(
                'unpaidCount', COALESCE(bs."unpaidCount", 0),
                'pendingConfirmationCount', COALESCE(bs."pendingConfirmationCount", 0),
                'unpaidAmount', COALESCE(bs."unpaidAmount", 0)
              ) AS billing
         FROM active_students s
         LEFT JOIN "User" parent ON parent.id = s."parentId"
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', contacts.id,
                      'name', contacts.name,
                      'relation', contacts.relation,
                      'phone', contacts.phone,
                      'isPrimary', contacts."isPrimary"
                    )
                    ORDER BY contacts."isPrimary" DESC, contacts.name
                  ) AS guardians
             FROM (
               SELECT g.id, g.name, g.relation, g.phone, g."isPrimary"
                 FROM "Guardian" g
                WHERE g."studentId" = s."studentId"
               UNION ALL
               SELECT NULL::text, parent.name, '보호자', parent.phone, true
                WHERE parent.id IS NOT NULL AND NOT EXISTS (
                  SELECT 1
                    FROM "Guardian" g
                   WHERE g."studentId" = s."studentId"
                     AND NULLIF(regexp_replace(g.phone, '[^0-9]', '', 'g'), '')
                         = NULLIF(regexp_replace(parent.phone, '[^0-9]', '', 'g'), '')
                )
             ) contacts
         ) guardian_data ON true
         LEFT JOIN recent_attendance ra ON ra."studentId" = s."studentId"
         LEFT JOIN billing_summary bs ON bs."studentId" = s."studentId"
         LEFT JOIN LATERAL (
           SELECT a.status
             FROM "Attendance" a
             JOIN "Session" se ON se.id = a."sessionId"
            WHERE a."studentId" = s."studentId"
              AND se."classId" = $2
              AND (($3::text IS NOT NULL AND se.id = $3) OR ($3::text IS NULL AND se."specialProgramSessionDateId" = $1))
            ORDER BY se."startedAt" DESC NULLS LAST, se."createdAt" DESC
            LIMIT 1
         ) today_attendance ON true
        ORDER BY s.name`,
      effectiveSessionDateId,
      classId,
      sessionId ?? null,
    )
    : await prisma.$queryRawUnsafe<StaffClassPersonRow[]>(
    `WITH active_students AS (
       SELECT DISTINCT s.id, s.name, s.school, s.grade, s.memo, s.phone, s."parentId"
         FROM "Enrollment" e
         JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
        WHERE e."classId" = $1
          AND e.status = 'ACTIVE'
          AND (e."startsOn" IS NULL OR e."startsOn" <= COALESCE((SELECT se.date::date FROM "Session" se WHERE se.id=$2), (NOW() AT TIME ZONE 'Asia/Seoul')::date) OR EXISTS (
            SELECT 1 FROM "Attendance" historical JOIN "Session" prior ON prior.id=historical."sessionId"
            WHERE historical."studentId"=e."studentId" AND prior."classId"=$1
              AND (($2::text IS NOT NULL AND prior.id=$2) OR ($2::text IS NULL AND prior.date::date=(NOW() AT TIME ZONE 'Asia/Seoul')::date))
          ))
     ), recent_attendance AS (
       SELECT ranked."studentId",
              COUNT(*) FILTER (WHERE ranked.status = 'PRESENT')::int AS present,
              COUNT(*) FILTER (WHERE ranked.status = 'LATE')::int AS late,
              COUNT(*) FILTER (WHERE ranked.status = 'ABSENT')::int AS absent,
              COUNT(*)::int AS total
         FROM (
           SELECT a."studentId", a.status,
                  ROW_NUMBER() OVER (PARTITION BY a."studentId" ORDER BY se.date DESC, a."updatedAt" DESC) AS rank
             FROM "Attendance" a
             JOIN "Session" se ON se.id = a."sessionId"
            WHERE se."classId" = $1
         ) ranked
        WHERE ranked.rank <= 12
        GROUP BY ranked."studentId"
     ), billing_summary AS (
       SELECT p."studentId",
              COUNT(*) FILTER (WHERE p.status IN ('PENDING', 'OVERDUE'))::int AS "unpaidCount",
              COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('PENDING', 'OVERDUE')), 0)::int AS "unpaidAmount",
              COUNT(*) FILTER (WHERE latest.status = 'PENDING')::int AS "pendingConfirmationCount"
         FROM "Payment" p
         LEFT JOIN LATERAL (
           SELECT r.status
             FROM "StaffPaymentConfirmationRequest" r
            WHERE r."paymentId" = p.id
            ORDER BY r."createdAt" DESC
            LIMIT 1
         ) latest ON true
        WHERE p."classId" = $1
        GROUP BY p."studentId"
     )
     SELECT s.id, s.name, s.school, s.grade, s.memo, s.phone AS "studentPhone",
            COALESCE(guardian_data.guardians, '[]'::jsonb) AS guardians,
            jsonb_build_object(
              'present', COALESCE(ra.present, 0),
              'late', COALESCE(ra.late, 0),
              'absent', COALESCE(ra.absent, 0),
              'total', COALESCE(ra.total, 0)
            ) AS "recentAttendance",
            today_attendance.status AS "todayStatus",
            jsonb_build_object(
              'unpaidCount', COALESCE(bs."unpaidCount", 0),
              'pendingConfirmationCount', COALESCE(bs."pendingConfirmationCount", 0),
              'unpaidAmount', COALESCE(bs."unpaidAmount", 0)
            ) AS billing
       FROM active_students s
       JOIN "User" parent ON parent.id = s."parentId"
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', contacts.id,
                    'name', contacts.name,
                    'relation', contacts.relation,
                    'phone', contacts.phone,
                    'isPrimary', contacts."isPrimary"
                  )
                  ORDER BY contacts."isPrimary" DESC, contacts.name
                ) AS guardians
           FROM (
             SELECT g.id, g.name, g.relation, g.phone, g."isPrimary"
               FROM "Guardian" g
              WHERE g."studentId" = s.id
             UNION ALL
             SELECT NULL::text, parent.name, '보호자', parent.phone, true
              WHERE NOT EXISTS (
                SELECT 1
                  FROM "Guardian" g
                 WHERE g."studentId" = s.id
                   AND NULLIF(regexp_replace(g.phone, '[^0-9]', '', 'g'), '')
                       = NULLIF(regexp_replace(parent.phone, '[^0-9]', '', 'g'), '')
              )
           ) contacts
       ) guardian_data ON true
       LEFT JOIN recent_attendance ra ON ra."studentId" = s.id
       LEFT JOIN billing_summary bs ON bs."studentId" = s.id
       LEFT JOIN LATERAL (
         SELECT a.status
           FROM "Attendance" a
           JOIN "Session" se ON se.id = a."sessionId"
          WHERE a."studentId" = s.id
            AND se."classId" = $1
            AND (($2::text IS NOT NULL AND se.id = $2) OR ($2::text IS NULL AND se.date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date))
          ORDER BY se."startedAt" DESC NULLS LAST, se."createdAt" DESC
          LIMIT 1
       ) today_attendance ON true
      ORDER BY s.name`,
    classId,
    sessionId ?? null,
  );

  return rows.map((row) => ({
    ...row,
    studentPhone: normalizePhoneNumber(row.studentPhone),
    guardians: (row.guardians ?? []).map((guardian) => ({
      ...guardian,
      phone: normalizePhoneNumber(guardian.phone),
    })),
    recentAttendance: row.recentAttendance ?? { present: 0, late: 0, absent: 0, total: 0 },
    billing: row.billing ?? {
      unpaidCount: 0,
      pendingConfirmationCount: 0,
      unpaidAmount: 0,
    },
  }));
}
