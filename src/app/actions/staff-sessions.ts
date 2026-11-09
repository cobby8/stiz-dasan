"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { syncCreditForRegularSession, syncCreditForSeasonalSeat } from "@/lib/makeup/credit-service";
import { applyMakeupAttendanceInTx, findMakeupBookings, makeupOnClassDateSql } from "@/lib/makeup/makeup-attendance";
import { requireStaffClassAccess, requireStaffSeasonalSessionAccess } from "@/lib/staff-class-access";
import { deliverParentNotification, getClassParentRecipients, getStudentParentRecipients } from "@/lib/staff-notifications";
import type { ParentRecipient } from "@/lib/staff-notifications";
import { notMergedStudent } from "@/lib/studentVisibility";
import { adoptRegularSessionKey, regularSessionKey } from "@/lib/regular/regularSession";
import {
  absencePlanMessage,
  applyAttendanceAbsenceReasonInTx,
  type AbsenceReasonIntent,
  type AbsenceReportState,
} from "@/lib/regular/attendance-absence-reason";

type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

async function requireSessionAccess(sessionId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; classId: string; status: string; className: string; sessionDateId: string | null; date: Date | string }>>(
    `SELECT s.id, s."classId", s.date::date::text AS date, s.status, c.name AS "className", s."specialProgramSessionDateId" AS "sessionDateId"
     FROM "Session" s JOIN "Class" c ON c.id = s."classId" WHERE s.id = $1 LIMIT 1`,
    sessionId,
  );
  if (!rows[0]) throw new Error("수업 기록을 찾을 수 없습니다.");
  const access = rows[0].sessionDateId
    ? (await requireStaffSeasonalSessionAccess(rows[0].sessionDateId)).access
    : await requireStaffClassAccess(rows[0].classId);
  return { session: rows[0], access };
}

async function isSessionRosterStudent(classId: string, sessionDateId: string | null, studentId: string, sessionDate: Date | string) {
  if (!sessionDateId) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT e.id FROM "Enrollment" e WHERE e."classId" = $1 AND e."studentId" = $2 AND e.status = 'ACTIVE'
       AND (e."startsOn" IS NULL OR e."startsOn" <= $3::date OR EXISTS (
         SELECT 1 FROM "Attendance" historical JOIN "Session" prior ON prior.id=historical."sessionId"
         WHERE historical."studentId"=$2 AND prior."classId"=$1 AND prior.date::date=$3::date
       )) LIMIT 1`, classId, studentId, sessionDate,
    );
    return Boolean(rows[0]);
  }
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT app.id FROM "SpecialProgramApplicationItem" i
     JOIN "SpecialProgramApplication" app ON app.id = i."applicationId"
     JOIN "SpecialProgramSessionDate" anchor_sd ON anchor_sd.id = $1
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
     WHERE i."offeringId" = o.id AND app."convertedStudentId" = $2
       AND i.status = 'APPROVED'
       AND i."conversionStatus" IN ('COMPLETED', 'INVOICE_RETRY_REQUIRED')
       AND (
         COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
         OR CASE EXTRACT(ISODOW FROM sd."startsAt" AT TIME ZONE 'Asia/Seoul')::int
           WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
           WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
         END = ANY(app."selectedWeekdays")
       )
     LIMIT 1`,
    sessionDateId, studentId,
  );
  return Boolean(rows[0]);
}

type SessionRow = { id: string; classId: string; status: string; className: string; sessionDateId: string | null };

// 방학특강 출결 저장 — 좌석(SpecialProgramEnrollmentDate)이 정본이다.
// 입력 키 = enrollmentDateId(그 좌석). 미전환 신청자도 좌석이 있어 여기서 저장된다.
// 절차:
//  1) 좌석을 이 세션의 형제 반/court 스코프 안에서만 검증하며 UPDATE(다른 회차 좌석ID 위조 방지).
//  2) 전환된 학생(e.studentId 있음)이면 정규 Attendance 도 병행 기록 + 학부모 알림(정규 소비처·알림 위해).
//  3) 미전환이면 좌석만 저장(Attendance/알림 skip — 학부모 알림은 후속 과제).
// 상태값(PRESENT/LATE/ABSENT)은 좌석 attendanceStatus 문자열과 동일해 직결한다.
async function saveSeasonalSeatAttendance(input: {
  session: SessionRow;
  enrollmentDateId: string;
  status: AttendanceStatus;
  note: string | null;
  checkedByUserId: string | null;
}) {
  // 알림 전송 여부 판정용 이전 좌석 상태(변경 없으면 알림 생략).
  const prev = await prisma.$queryRawUnsafe<{ attendanceStatus: string | null }[]>(
    `SELECT "attendanceStatus" FROM "SpecialProgramEnrollmentDate" WHERE id = $1 LIMIT 1`,
    input.enrollmentDateId,
  );
  const changed = prev[0]?.attendanceStatus !== input.status;

  // 좌석을 이 세션 스코프(형제 반 포함) 안에서만 갱신한다. 스코프 밖 좌석ID면 0행 → 명단 외 처리.
  const updated = await prisma.$queryRawUnsafe<{ id: string; studentId: string | null }[]>(
    `UPDATE "SpecialProgramEnrollmentDate" e
        SET "attendanceStatus" = $3,
            "attendanceNote" = $4,
            "arrivedAt" = CASE WHEN $3 = 'LATE' THEN COALESCE(e."arrivedAt", now()) ELSE NULL END,
            "attendanceCheckedAt" = now(),
            "attendanceCheckedByUserId" = $5,
            "updatedAt" = now()
       FROM "Session" s
       JOIN "SpecialProgramSessionDate" anchor_sd ON anchor_sd.id = s."specialProgramSessionDateId"
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
       JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = o.id AND i.status = 'APPROVED'
      WHERE s.id = $1
        AND e.id = $2
        AND e."applicationItemId" = i.id
        AND e."sessionDateId" = sd.id
        AND e.status = 'SCHEDULED'
      RETURNING e.id, e."studentId"`,
    input.session.id, input.enrollmentDateId, input.status, input.note, input.checkedByUserId,
  );
  if (updated.length === 0) {
    return { ok: false as const, message: "이 수업의 확정 명단에 없는 좌석입니다." };
  }

  const studentId = updated[0].studentId;

  // 보강권 — 결석이면 발급, 출석·지각으로 정정되면 회수(2026-08-09 개정 약관).
  // ★ 출결 저장은 이미 끝났다. 보강권이 실패해도 출결을 되돌리지 않는다.
  //   선생님이 수업 중에 쓰는 화면이라, 부수 기능 때문에 출결이 안 찍히면 더 큰 문제다.
  if (studentId) {
    try {
      await syncCreditForSeasonalSeat({
        enrollmentDateId: input.enrollmentDateId,
        studentId,
        status: input.status,
      });
    } catch (error) {
      console.error("[saveStaffAttendance] 보강권 처리 실패(출결은 저장됨)", {
        enrollmentDateId: input.enrollmentDateId, studentId, error,
      });
    }
  }

  // 미전환(Student 없음) 좌석은 여기서 끝. 정규 Attendance/학부모 알림은 없다.
  if (!studentId) {
    return { ok: true as const, attendanceId: updated[0].id, changed };
  }

  // 전환된 학생: 정규 Attendance 에도 기록(정규 출결 소비처·통계용). 좌석 저장은 이미 성공했으므로
  // Attendance/알림 실패가 좌석 저장을 되돌리지 않게 격리한다(좌석이 정본).
  let attendanceId = updated[0].id;
  try {
    const saved = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "Attendance" (id, "sessionId", "studentId", status, note, "checkedAt", "arrivedAt", "checkedByUserId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), CASE WHEN $3 = 'LATE' THEN NOW() ELSE NULL END, $5, NOW(), NOW())
       ON CONFLICT ("sessionId", "studentId") DO UPDATE SET
         status = EXCLUDED.status, note = EXCLUDED.note,
         "checkedAt" = COALESCE("Attendance"."checkedAt", NOW()),
         "arrivedAt" = CASE WHEN EXCLUDED.status = 'LATE' THEN COALESCE("Attendance"."arrivedAt", NOW()) ELSE NULL END,
         "checkedByUserId" = EXCLUDED."checkedByUserId", "updatedAt" = NOW()
       RETURNING id`,
      input.session.id, studentId, input.status, input.note, input.checkedByUserId,
    );
    if (saved[0]) attendanceId = saved[0].id;

    if (changed && (input.status === "PRESENT" || input.status === "LATE")) {
      const [recipient] = await getSessionParentRecipients(input.session, [studentId]);
      if (recipient) {
        const delivery = await deliverParentNotification({
          eventType: input.status === "LATE" ? "ATTENDANCE_LATE" : "ATTENDANCE_PRESENT",
          dedupeKey: `attendance:${attendanceId}:status:${input.status}:user:${recipient.userId}`,
          recipient,
          title: `${input.session.className} 출석 안내`,
          message: `${recipient.studentName} 학생이 ${input.status === "LATE" ? "지각 출석" : "출석"}했습니다.`,
          linkUrl: "/parent/attendance",
          sessionId: input.session.id,
          attendanceId,
        });
        if (!delivery.duplicate && delivery.push?.status === "FAILED") {
          return { ok: true as const, attendanceId, changed, notificationWarning: true as const };
        }
      }
    }
  } catch (error) {
    console.error("[saveSeasonalSeatAttendance] 정규 Attendance/알림 실패(좌석 저장은 유지)", {
      sessionId: input.session.id,
      enrollmentDateId: input.enrollmentDateId,
      studentId,
      error,
    });
    return { ok: true as const, attendanceId, changed, notificationWarning: true as const };
  }
  return { ok: true as const, attendanceId, changed };
}

async function getSessionParentRecipients(session: { classId: string; sessionDateId: string | null; date?: Date | string }, studentIds?: string[]) {
  if (!session.sessionDateId) return getClassParentRecipients(session.classId, studentIds, session.date);
  return prisma.$queryRawUnsafe<ParentRecipient[]>(
    `SELECT DISTINCT st.id AS "studentId", st.name AS "studentName", st."parentId" AS "userId"
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
     JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = sd."offeringId"
       AND i.status = 'APPROVED'
       AND i."conversionStatus" IN ('COMPLETED', 'INVOICE_RETRY_REQUIRED')
     JOIN "SpecialProgramApplication" app ON app.id = i."applicationId"
       AND (
         COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
         OR CASE EXTRACT(ISODOW FROM sd."startsAt" AT TIME ZONE 'Asia/Seoul')::int
           WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
           WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
         END = ANY(app."selectedWeekdays")
       )
     JOIN "Student" st ON st.id = app."convertedStudentId" AND ${notMergedStudent("st")}
     WHERE anchor_sd.id = $1 AND ($2::text[] IS NULL OR st.id = ANY($2::text[])) AND st."parentId" IS NOT NULL`,
    session.sessionDateId, studentIds?.length ? studentIds : null,
  );
}

export async function savePlannedClassContent(input: {
  classId: string;
  date: string;
  plannedContent: string;
  sessionDateId?: string;
}) {
  const sessionDateId = input.sessionDateId?.trim() || null;
  const seasonal = sessionDateId ? await requireStaffSeasonalSessionAccess(sessionDateId) : null;
  const access = seasonal?.access ?? await requireStaffClassAccess(input.classId);
  if (seasonal && seasonal.seasonal.linkedClassId !== input.classId) {
    return { ok: false as const, message: "특강과 연결된 수업 정보가 일치하지 않습니다." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false as const, message: "수업 날짜를 다시 확인해 주세요." };
  }

  // 정규 수업 키는 관리자 출결·랠리즈와 같은 함수(regularSessionKey)로 만든다.
  const sessionKey = sessionDateId ? `seasonal:${sessionDateId}` : regularSessionKey(input.classId, input.date);
  const rows = await prisma.$transaction(async (tx) => {
    // 관리자가 먼저 출결을 저장해 «키 없는» 기록이 있으면 그 기록에 키를 붙여 같은 기록을 쓴다(기록 갈라짐 방지).
    if (!sessionDateId) await adoptRegularSessionKey(tx, input.classId, input.date);
    return tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Session" (
       id, "classId", date, "sessionKey", status, "plannedContent", "coachId", "specialProgramSessionDateId", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2::date, $3, 'PLANNED', $4, $5, $6, NOW(), NOW()
     )
     ON CONFLICT ("sessionKey") DO UPDATE SET
       "plannedContent" = EXCLUDED."plannedContent",
       "updatedAt" = NOW()
     WHERE "Session".status = 'PLANNED'
     RETURNING id`,
    input.classId,
    input.date,
    sessionKey,
    input.plannedContent.trim() || null,
    access.coachId,
    sessionDateId,
    );
  });

  if (!rows[0]) {
    return { ok: false as const, message: "진행 중이거나 종료된 수업의 예정 내용은 여기서 바꿀 수 없습니다." };
  }

  revalidatePath("/staff");
  return { ok: true as const, sessionId: rows[0].id };
}

export async function saveSessionMemo(input: { sessionId: string; notes: string }) {
  const { session } = await requireSessionAccess(input.sessionId);
  if (session.status !== "IN_PROGRESS") {
    return { ok: false as const, message: "진행 중인 수업에서만 메모할 수 있습니다." };
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "Session" SET notes = $2, "updatedAt" = NOW() WHERE id = $1`,
    input.sessionId,
    input.notes.trim() || null,
  );
  revalidatePath(`/staff/sessions/${input.sessionId}`);
  return { ok: true as const };
}

export async function saveStaffAttendance(input: {
  sessionId: string;
  attendanceKey: string;
  status: AttendanceStatus;
  note?: string;
  /** 결석 사유 — "ILLNESS_INJURY"=질병·부상 표시, null=표시 끄기, 생략=그대로(출석·지각이면 출석부 사유는 지워짐). 정규 수강생만. */
  absenceReason?: AbsenceReasonIntent;
}) {
  const { session, access } = await requireSessionAccess(input.sessionId);
  if (session.status !== "IN_PROGRESS") return { ok: false as const, message: "진행 중인 수업에서만 출결을 기록할 수 있습니다." };
  if (!["PRESENT", "LATE", "ABSENT"].includes(input.status)) return { ok: false as const, message: "올바른 출결 상태가 아닙니다." };
  if (input.absenceReason !== undefined && input.absenceReason !== null && input.absenceReason !== "ILLNESS_INJURY") {
    return { ok: false as const, message: "올바른 결석 사유가 아닙니다." };
  }

  // 방학특강(seasonal) 세션은 좌석(SpecialProgramEnrollmentDate)이 출결 정본이다.
  //  - attendanceKey = enrollmentDateId(좌석). 미전환 신청자도 좌석이 있어 여기서 처리된다.
  //  - 좌석을 먼저 저장하고, 전환된 학생(studentId 있음)만 정규 Attendance + 학부모 알림을 병행한다.
  if (session.sessionDateId) {
    return saveSeasonalSeatAttendance({
      session,
      enrollmentDateId: input.attendanceKey,
      status: input.status,
      note: input.note?.trim() || null,
      checkedByUserId: access.staff.appUserId,
    });
  }

  // 정규(비seasonal): attendanceKey = studentId. 기존 동작 그대로.
  const studentId = input.attendanceKey;
  const enrolled = await isSessionRosterStudent(session.classId, session.sessionDateId, studentId, session.date);
  // 정규 명단에 없으면 «이 반·이 날 보강 예약된 아이»인지 본다(명단 조회와 같은 조건 — makeupOnClassDateSql).
  const sessionYmd = String(session.date).slice(0, 10);
  const isMakeup = !enrolled && (await findMakeupBookings(prisma, { studentId, classId: session.classId, dateYmd: sessionYmd })).length > 0;
  if (!enrolled && !isMakeup) return { ok: false as const, message: "이 수업의 확정 명단에 없는 학생입니다." };

  const previous = await prisma.$queryRawUnsafe<{ status: string }[]>(
    `SELECT status FROM "Attendance" WHERE "sessionId" = $1 AND "studentId" = $2 LIMIT 1`, input.sessionId, studentId,
  );
  const changed = previous[0]?.status !== input.status;
  const saved = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Attendance" (id, "sessionId", "studentId", status, note, "checkedAt", "arrivedAt", "checkedByUserId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), CASE WHEN $3 = 'LATE' THEN NOW() ELSE NULL END, $5, NOW(), NOW())
     ON CONFLICT ("sessionId", "studentId") DO UPDATE SET
       status = EXCLUDED.status, note = EXCLUDED.note,
       "checkedAt" = COALESCE("Attendance"."checkedAt", NOW()),
       "arrivedAt" = CASE WHEN EXCLUDED.status = 'LATE' THEN COALESCE("Attendance"."arrivedAt", NOW()) ELSE NULL END,
       "checkedByUserId" = EXCLUDED."checkedByUserId", "updatedAt" = NOW()
     RETURNING id`,
    input.sessionId, studentId, input.status, input.note?.trim() || null, access.staff.appUserId,
  );

  if (isMakeup) {
    // 보강 온 아이 — 이 반 결석으로 보강권을 새로 주면 안 된다(syncCreditForRegularSession 을 타지 않는다).
    // 출석·지각이면 보강 예약 «참석» → 보강권 «사용», 결석이면 보강권을 쓰지 않고 참석 표시였으면 «예약됨»으로 되돌린다.
    // 실패해도 출결은 유지한다(위와 같은 이유).
    try {
      // 예약 전이와 보강권 전이(ATTENDED→USED, BOOKED→RESERVED — 관리자 보강 상태 변경과 같은 표)를 한 트랜잭션으로.
      await prisma.$transaction((tx) => applyMakeupAttendanceInTx(tx, {
        studentId, classId: session.classId, dateYmd: sessionYmd, status: input.status,
      }));
    } catch (error) {
      console.error("[saveStaffAttendance] 보강 예약·보강권 처리 실패(출결은 저장됨)", {
        sessionId: input.sessionId, studentId, error,
      });
    }
  } else {
    // 보강권 — 결석이면 발급, 출석·지각으로 정정되면 회수. 실패해도 출결은 유지한다(위와 같은 이유).
    try {
      await syncCreditForRegularSession({ sessionId: input.sessionId, studentId, status: input.status });
    } catch (error) {
      console.error("[saveStaffAttendance] 보강권 처리 실패(출결은 저장됨)", {
        sessionId: input.sessionId, studentId, error,
      });
    }
  }

  // 결석 사유(질병·부상) — 정규 수강생만. 보강 온 아이의 결석은 자기 반 결석이 아니라 이월 대상이 아니다.
  // 청구 작업대의 이월 후보(RegularAbsence reason=ILLNESS_INJURY)와 같은 곳·같은 값으로 저장한다.
  // 실패해도 출결은 유지한다(위와 같은 이유) — 대신 화면에 다시 눌러 달라고 알린다.
  let absenceReport: AbsenceReportState | undefined;
  let absenceMessage: string | null = null;
  if (!isMakeup) {
    try {
      const applied = await prisma.$transaction((tx) => applyAttendanceAbsenceReasonInTx(tx, {
        studentId, classId: session.classId, dateYmd: sessionYmd, attendanceStatus: input.status,
        intent: input.absenceReason, confirmedByUserId: null, actorUserId: access.staff.appUserId,
      }));
      absenceReport = applied.report;
      absenceMessage = absencePlanMessage(applied.plan);
    } catch (error) {
      console.error("[saveStaffAttendance] 결석 사유 저장 실패(출결은 저장됨)", { sessionId: input.sessionId, studentId, error });
      if (input.absenceReason !== undefined) absenceMessage = "출결은 저장됐지만 질병·부상 표시는 저장하지 못했습니다. 다시 눌러 주세요.";
    }
  }
  const extra = { absenceReport, ...(absenceMessage ? { absenceMessage } : {}) };

  if (changed && (input.status === "PRESENT" || input.status === "LATE")) {
    try {
      // 보강 온 아이는 이 반 수강생이 아니라 반 기준 조회로는 학부모가 안 잡힌다 → 학생으로 바로 찾는다.
      const [recipient] = isMakeup
        ? await getStudentParentRecipients([studentId])
        : await getSessionParentRecipients(session, [studentId]);
      if (recipient) {
        const delivery = await deliverParentNotification({
          eventType: input.status === "LATE" ? "ATTENDANCE_LATE" : "ATTENDANCE_PRESENT",
          dedupeKey: `attendance:${saved[0].id}:status:${input.status}:user:${recipient.userId}`,
          recipient,
          title: `${session.className} 출석 안내`,
          message: `${recipient.studentName} 학생이 ${input.status === "LATE" ? "지각 출석" : "출석"}했습니다.`,
          linkUrl: "/parent/attendance",
          sessionId: input.sessionId,
          attendanceId: saved[0].id,
        });
        if (!delivery.duplicate && delivery.push?.status === "FAILED") {
          return { ok: true as const, attendanceId: saved[0].id, changed, notificationWarning: true as const, ...extra };
        }
      }
    } catch (error) {
      console.error("[saveStaffAttendance] Parent notification failed", {
        sessionId: input.sessionId,
        studentId,
        error,
      });
      return { ok: true as const, attendanceId: saved[0].id, changed, notificationWarning: true as const, ...extra };
    }
  }
  return { ok: true as const, attendanceId: saved[0].id, changed, ...extra };
}

/**
 * 수업 종료 안내를 받을 «보강 온 아이» 학부모.
 * - 그날 그 반 보강 예약(예약됨·참석 — 명단과 같은 makeupOnClassDateSql) 중 이 회차 출결이 출석·지각인 아이만.
 * - 결석한 보강 아이는 그 반 수업을 듣지 않았으므로 보내지 않는다(리포트 화면도 출석한 수업 기준).
 * - 특강 회차(sessionDateId)는 보강 대상이 아니라 빈 목록.
 * 학부모는 학생으로 바로 찾는다(getStudentParentRecipients — 출석 알림과 같은 경로).
 */
async function getMakeupCompletedParentRecipients(
  session: { classId: string; sessionDateId: string | null; date?: Date | string },
  sessionId: string,
): Promise<ParentRecipient[]> {
  if (session.sessionDateId) return [];
  const rows = await prisma.$queryRawUnsafe<{ studentId: string }[]>(
    `SELECT DISTINCT ms."studentId"
       FROM "MakeupSession" ms
       JOIN "Student" st ON st.id = ms."studentId" AND ${notMergedStudent("st")}
      WHERE ${makeupOnClassDateSql("ms", "$1", "$3")}
        AND EXISTS (SELECT 1 FROM "Attendance" a
                     WHERE a."sessionId" = $2 AND a."studentId" = ms."studentId" AND a.status IN ('PRESENT','LATE'))`,
    session.classId, sessionId, session.date,
  );
  return getStudentParentRecipients(rows.map((r) => r.studentId));
}

export async function completeClassSession(input: {
  sessionId: string;
  /** 오늘 수업 한 줄(선택). 비워도 출결·사진만으로 리포트가 된다. */
  report?: string;
  /** 학부모에게 바로 보낼지. 화면에서 기본 켬. */
  publishReport?: boolean;
}) {
  const { session, access } = await requireSessionAccess(input.sessionId);
  if (session.status === "COMPLETED") return { ok: true as const, completed: true, resumed: true };
  if (session.status !== "IN_PROGRESS") return { ok: false as const, message: "시작한 수업만 종료할 수 있습니다." };

  const missing = session.sessionDateId
      ? await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        // 좌석 기준 미확인 카운트: 형제 반/court 합산, 승인항목의 이 회차 좌석(SCHEDULED) 중
        // 아직 출결이 안 찍힌(attendanceStatus IS NULL) 좌석 수. 전환 여부와 무관하게 전원 확인해야 종료 가능.
        `SELECT COUNT(*)::bigint AS count
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
         JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = o.id AND i.status = 'APPROVED'
         JOIN "SpecialProgramEnrollmentDate" e
           ON e."applicationItemId" = i.id AND e."sessionDateId" = sd.id AND e.status = 'SCHEDULED'
         WHERE anchor_sd.id = $1 AND e."attendanceStatus" IS NULL`,
        session.sessionDateId,
      )
    : await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM "Enrollment" e
         WHERE e."classId" = $1 AND e.status = 'ACTIVE'
           AND (e."startsOn" IS NULL OR e."startsOn" <= $3::date)
           AND NOT EXISTS (SELECT 1 FROM "Attendance" a WHERE a."sessionId" = $2 AND a."studentId" = e."studentId")`,
        session.classId, input.sessionId, session.date,
      );
  // 보강 온 아이도 출결을 찍어야 종료할 수 있다(2026-11-09 원장 승인) — 명단 조회와 같은 makeupOnClassDateSql 조건.
  // 보강을 안 찍고 끝내면 예약이 «예약됨»에 남아 보강권이 줄지 않는다(관리자가 따로 눌러야 했던 그 문제).
  const missingMakeup = session.sessionDateId
    ? [{ count: BigInt(0) }]
    : await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(DISTINCT ms."studentId")::bigint AS count
           FROM "MakeupSession" ms
           JOIN "Student" st ON st.id = ms."studentId" AND ${notMergedStudent("st")}
          WHERE ${makeupOnClassDateSql("ms", "$1", "$3")}
            AND NOT EXISTS (SELECT 1 FROM "Attendance" a WHERE a."sessionId" = $2 AND a."studentId" = ms."studentId")`,
        session.classId, input.sessionId, session.date,
      );
  if (Number(missing[0]?.count ?? 0) + Number(missingMakeup[0]?.count ?? 0) > 0) {
    return { ok: false as const, message: "출결을 확인하지 않은 학생이 있습니다(보강 온 아이 포함)." };
  }

  // 리포트를 종료와 같은 UPDATE 로 처리한다. 지금까지는 리포트 작성·발행이 관리자
  // 전용이라(requireAdmin) 선생님이 수업을 마쳐도 원장이 PC 에서 다시 써야 나갔고,
  // 그래서 운영 100회차 동안 발행이 0건이었다. 선생님이 끝내면서 같이 끝내게 한다.
  const report = (input.report ?? "").trim().slice(0, 2000) || null;
  const publish = input.publishReport !== false;
  const ended = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "Session"
        SET status = 'COMPLETED', "endedAt" = NOW(), "endedByUserId" = $2, "updatedAt" = NOW(),
            content = COALESCE($3, content),
            published = CASE WHEN $4 THEN true ELSE published END,
            "publishedAt" = CASE WHEN $4 AND NOT published THEN NOW() ELSE "publishedAt" END
      WHERE id = $1 AND status = 'IN_PROGRESS' AND "startedAt" IS NOT NULL RETURNING id`,
    input.sessionId, access.staff.appUserId, report, publish,
  );
  if (!ended[0]) return { ok: false as const, message: "수업 종료 상태를 다시 확인해 주세요." };

  // 종료 즉시 캐시 무효화 — 알림 발송보다 먼저 해야 직원 화면이 날짜 이동 없이도 완료 상태로 바뀐다.
  revalidatePath("/staff");
  revalidatePath("/staff/seasonal");
  revalidatePath(`/staff/sessions/${input.sessionId}`);

  // 종료 안내는 결석 여부와 관계없이 이 수업의 전체 재원생 학부모에게 보냅니다.
  // 보강 온 아이는 출석·지각한 경우에만 그 학부모에게도 보냅니다(getMakeupCompletedParentRecipients).
  // 수업 종료 저장은 학부모 알림보다 우선입니다. 알림 장애가 이미 끝난 수업을 실패로 되돌리지 않게 격리합니다.
  // ★ 알림 발송은 NotificationDelivery 큐에 먼저 기록되고 push-outbox 크론(매분)이 재발송을 보장하므로,
  //   여기서 발송 완료를 끝까지 기다리지 않는다. 발송이 느리면(푸시·SMS 지연) 응답이 막혀 화면이 "종료 처리 중"에서
  //   멈추던 문제가 있었다 → 짧은 예산(budget) 안에서만 즉시 시도하고, 초과분은 크론이 처리한다.
  let notificationWarning:
    | { code: "PARENT_NOTIFICATION_FAILED"; failedCount: number }
    | undefined;
  const NOTIFY_BUDGET_MS = 3500;
  try {
    const notifyWork = (async () => {
      const regularRecipients = await getSessionParentRecipients(session);
      // 보강 온 아이 학부모에게도 같은 안내(2026-11-09 원장 승인) — 반 수강생이 아니라 위 조회로는 안 잡힌다.
      // 같은 키 규칙(session:…:student:…:user:…)이라 정규·보강에 겹친 아이가 있어도 두 번 나가지 않는다.
      const makeupRecipients = await getMakeupCompletedParentRecipients(session, input.sessionId);
      const seen = new Set(regularRecipients.map((r) => `${r.studentId}:${r.userId}`));
      const recipients = [...regularRecipients, ...makeupRecipients.filter((r) => !seen.has(`${r.studentId}:${r.userId}`))];
      const results = await Promise.allSettled(recipients.map((recipient) => deliverParentNotification({
        eventType: "CLASS_COMPLETED",
        dedupeKey: `session:${input.sessionId}:completed:student:${recipient.studentId}:user:${recipient.userId}`,
        recipient,
        title: `${session.className} 수업 종료`,
        message: `${recipient.studentName} 학생의 수업이 종료되었습니다.`,
        // 예전 값 "/parent/sessions" 는 **없는 주소**였다(알림을 눌러도 404).
        // 학부모 리포트 화면은 /mypage/reports/[sessionId] 다.
        linkUrl: `/mypage/reports/${input.sessionId}`,
        sessionId: input.sessionId,
      })));
      const failedCount = results.reduce((count, result) => {
        if (result.status === "rejected") return count + 1;
        if (result.value.duplicate || !result.value.push) return count;
        return count + (result.value.push.failedCount || (result.value.push.status === "FAILED" ? 1 : 0));
      }, 0);
      if (failedCount > 0) {
        notificationWarning = { code: "PARENT_NOTIFICATION_FAILED", failedCount };
        console.error("[completeClassSession] Parent notification delivery failed", {
          sessionId: input.sessionId, classId: session.classId, failedCount, recipientCount: recipients.length,
        });
      }
    })();
    // 예산 시간 안에 끝나면 결과(경고)를 반영하고, 초과하면 응답을 먼저 돌려준다(큐+크론이 마저 발송).
    await Promise.race([
      notifyWork.catch((error) => {
        notificationWarning = { code: "PARENT_NOTIFICATION_FAILED", failedCount: 1 };
        console.error("[completeClassSession] Parent notification lookup failed", { sessionId: input.sessionId, classId: session.classId, error });
      }),
      new Promise<void>((resolve) => setTimeout(resolve, NOTIFY_BUDGET_MS)),
    ]);
  } catch (error) {
    console.error("[completeClassSession] Parent notification dispatch error", { sessionId: input.sessionId, error });
  }
  return {
    ok: true as const,
    completed: true,
    resumed: false,
    ...(notificationWarning ? { notificationWarning } : {}),
  };
}

/**
 * 진행 화면의 '수업 시작 취소' 버튼이 호출하는 서버 기능입니다.
 * 실수/테스트로 시작한 수업을 '시작 전(PLANNED)' 상태로 되돌립니다.
 * ★ 세션 상태(status/startedAt/startedByUserId)만 되돌리고, 출결(Attendance /
 *   SpecialProgramEnrollmentDate.attendanceStatus)·사진·메모는 절대 건드리지 않습니다.
 *   (관리자 사전 결석·셔틀 제외 마크 등 기록을 보존하기 위함)
 */
export async function cancelClassSession(input: { sessionId: string }) {
  // 종료/출결과 동일한 권한 게이트로 담당 수업(또는 특강)인지 다시 검사합니다.
  const { session } = await requireSessionAccess(input.sessionId);

  // 진행 중(IN_PROGRESS)인 수업만 시작을 취소할 수 있습니다. 그 외 상태는 되돌릴 대상이 아닙니다.
  if (session.status !== "IN_PROGRESS") {
    return { ok: false as const, message: "진행 중인 수업만 시작을 취소할 수 있습니다." };
  }

  // status='IN_PROGRESS' 조건을 WHERE에 함께 걸어, 그 사이 다른 기기에서 상태가 바뀌었으면
  // 0행이 되어 안전하게 통과시킵니다(이미 바뀐 것이므로 목표 상태와 일치 → 성공 처리).
  //  - startedAt/startedByUserId를 NULL로 비워 다음 시작 때 새 스톱워치가 잡히게 합니다.
  //  - 정규/특강 공통(sessionDateId 유무와 무관하게 세션 상태만 되돌립니다).
  await prisma.$executeRawUnsafe(
    `UPDATE "Session"
        SET status = 'PLANNED', "startedAt" = NULL, "startedByUserId" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND status = 'IN_PROGRESS'`,
    input.sessionId,
  );

  // 진행 화면(page.tsx)은 status !== 'IN_PROGRESS'면 /staff로 리다이렉트하므로 캐시를 무효화합니다.
  revalidatePath("/staff");
  revalidatePath(`/staff/sessions/${input.sessionId}`);
  return { ok: true as const };
}

type SessionStartRow = {
  id: string;
  classId: string;
  status: string;
  startedAt: Date | string | null;
};

export type StartClassSessionResult =
  | {
      ok: true;
      sessionId: string;
      classId: string;
      status: "IN_PROGRESS";
      startedAt: string;
      resumed: boolean;
    }
  | {
      ok: false;
      code: "INVALID_INPUT" | "FORBIDDEN" | "COMPLETED" | "ACTIVE_SESSION" | "DB_NOT_READY" | "UNKNOWN";
      message: string;
      activeSessionId?: string;
    };

function isValidDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function toIsoString(value: Date | string | null) {
  if (!value) throw new Error("수업 시작 시각이 기록되지 않았습니다.");
  return new Date(value).toISOString();
}

function isLifecycleSchemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("sessionKey") ||
    message.includes("specialProgramSessionDateId") ||
    message.includes("startedAt") ||
    message.includes("startedByUserId") ||
    message.includes('column "status"')
  );
}

/**
 * 확인 모달의 '수업 시작' 버튼이 호출하는 서버 기능입니다.
 * 휴대폰 시간이 아니라 DB의 NOW()를 기록해 모든 기기에서 같은 스톱워치 기준을 사용합니다.
 */
export async function startClassSession(input: {
  classId: string;
  date: string;
  sessionDateId?: string;
}): Promise<StartClassSessionResult> {
  const classId = input.classId?.trim();
  const date = input.date?.trim();

  if (!classId || !isValidDateKey(date)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "수업과 날짜 정보를 다시 확인해 주세요.",
    };
  }

  try {
    // 화면에서 다른 수업 ID를 보내더라도 서버에서 담당 수업인지 다시 검사합니다.
    const sessionDateId = input.sessionDateId?.trim() || null;
    const seasonal = sessionDateId ? await requireStaffSeasonalSessionAccess(sessionDateId) : null;
    const access = seasonal?.access ?? await requireStaffClassAccess(classId);
    if (seasonal) {
      if (seasonal.seasonal.linkedClassId !== classId) {
        return { ok: false, code: "INVALID_INPUT", message: "특강과 연결된 수업 정보가 일치하지 않습니다." };
      }
      const validDate = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "SpecialProgramSessionDate"
         WHERE id = $1 AND ("startsAt" AT TIME ZONE 'Asia/Seoul')::date = $2::date LIMIT 1`,
        sessionDateId, date,
      );
      if (!validDate[0]) return { ok: false, code: "INVALID_INPUT", message: "오늘 예정된 특강 회차가 아닙니다." };
    }
    // 정규 수업 키는 관리자 출결·랠리즈와 같은 함수(regularSessionKey)로 만든다.
    const sessionKey = sessionDateId ? `seasonal:${sessionDateId}` : regularSessionKey(classId, date);
    const result = await prisma.$transaction(async (tx) => {
      // 교사별 잠금은 두 휴대폰에서 동시에 눌러도 한 수업만 열리게 하는 안전장치입니다.
      // pg_advisory_xact_lock는 void를 반환한다. $queryRawUnsafe로 부르면 Prisma가 void 컬럼 역직렬화에 실패(P2010)하므로,
      // 결과를 읽지 않는 $executeRawUnsafe로 호출한다(락은 fire-and-forget).
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, access.staff.appUserId);

      // 관리자가 먼저 출결을 저장해 «키 없는» 같은 반·같은 날 기록이 있으면, 새로 만들지 않고 그 기록에 키를 붙여 이어 쓴다.
      // (예전엔 여기서 키로만 찾아 기록이 둘로 갈라질 수 있었다)
      if (!sessionDateId) await adoptRegularSessionKey(tx, classId, date);

      // 같은 수업의 빠른 중복 클릭은 새 장부를 만들지 않고 기존 장부로 복귀합니다.
      const existing = await tx.$queryRawUnsafe<SessionStartRow[]>(
        `SELECT id, "classId", status, "startedAt"
         FROM "Session"
         WHERE "sessionKey" = $1
         LIMIT 1`,
        sessionKey,
      );

      if (existing[0]?.status === "IN_PROGRESS") {
        return {
          ok: true as const,
          sessionId: existing[0].id,
          classId: existing[0].classId,
          status: "IN_PROGRESS" as const,
          startedAt: toIsoString(existing[0].startedAt),
          resumed: true,
        };
      }

      if (existing[0]?.status === "COMPLETED") {
        return { ok: false as const, code: "COMPLETED" as const, message: "이미 종료된 수업입니다." };
      }

      const active = await tx.$queryRawUnsafe<SessionStartRow[]>(
        `SELECT id, "classId", status, "startedAt"
         FROM "Session"
         WHERE status = 'IN_PROGRESS'
           AND "startedByUserId" = $1
         ORDER BY "startedAt" DESC
         LIMIT 1`,
        access.staff.appUserId,
      );

      if (active[0]) {
        return {
          ok: false as const,
          code: "ACTIVE_SESSION" as const,
          message: "진행 중인 수업을 먼저 종료해 주세요.",
          activeSessionId: active[0].id,
        };
      }

      // 사전에 작성된 PLANNED Session이 있으면 시작 상태로 한 번만 변경합니다.
      const started = await tx.$queryRawUnsafe<SessionStartRow[]>(
        `UPDATE "Session"
         SET status = 'IN_PROGRESS',
             "startedAt" = COALESCE("startedAt", NOW()),
             "startedByUserId" = COALESCE("startedByUserId", $2),
             "coachId" = COALESCE("coachId", $3),
             "updatedAt" = NOW()
         WHERE "sessionKey" = $1
           AND status = 'PLANNED'
         RETURNING id, "classId", status, "startedAt"`,
        sessionKey,
        access.staff.appUserId,
        access.coachId,
      );

      if (started[0]) {
        return {
          ok: true as const,
          sessionId: started[0].id,
          classId: started[0].classId,
          status: "IN_PROGRESS" as const,
          startedAt: toIsoString(started[0].startedAt),
          resumed: false,
        };
      }

      // 첫 요청만 새 Session을 만듭니다. 같은 키의 재요청은 아무것도 생성하지 않습니다.
      const inserted = await tx.$queryRawUnsafe<SessionStartRow[]>(
      `INSERT INTO "Session" (
         id, "classId", date, "sessionKey", status, "coachId",
         "startedAt", "startedByUserId", "specialProgramSessionDateId", "createdAt", "updatedAt"
       )
       VALUES (
         gen_random_uuid()::text, $1, $2::date, $3, 'IN_PROGRESS', $4,
         NOW(), $5, $6, NOW(), NOW()
       )
       ON CONFLICT ("sessionKey") DO NOTHING
       RETURNING id, "classId", status, "startedAt"`,
      classId,
      date,
      sessionKey,
      access.coachId,
      access.staff.appUserId,
      sessionDateId,
      );

      if (inserted[0]) {
        return {
          ok: true as const,
          sessionId: inserted[0].id,
          classId: inserted[0].classId,
          status: "IN_PROGRESS" as const,
          startedAt: toIsoString(inserted[0].startedAt),
          resumed: false,
        };
      }

      return { ok: false as const, code: "UNKNOWN" as const, message: "수업을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    });

    if (result.ok) revalidatePath("/staff");
    return result;
  } catch (error) {
    if (isLifecycleSchemaMissing(error)) {
      return {
        ok: false,
        code: "DB_NOT_READY",
        message: "수업 시작 기능을 준비 중입니다. 관리자에게 문의해 주세요.",
      };
    }

    const message = error instanceof Error ? error.message : "수업 시작 권한을 확인하지 못했습니다.";
    const isPermissionError =
      message.includes("담당 특강") ||
      message.includes("담당 수업") ||
      message.includes("코치 정보") ||
      message.includes("권한") ||
      message.includes("permission");

    if (isPermissionError) {
      return { ok: false, code: "FORBIDDEN", message };
    }

    console.error("[startClassSession] failed:", error);
    return {
      ok: false,
      code: "UNKNOWN",
      message: "수업을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
  }
}
