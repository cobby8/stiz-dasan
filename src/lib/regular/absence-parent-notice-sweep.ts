import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";
import { deliverParentNotification } from "@/lib/staff-notifications";
import {
  ABSENCE_NOTICE_DELAY_MINUTES,
  ABSENCE_NOTICE_EVENT,
  absenceNoticeDedupeKey,
  absenceNoticeKeyPrefixSql,
  absenceNoticeMessage,
  absenceNoticeTitle,
} from "@/lib/regular/absence-parent-notice";

type Candidate = {
  attendanceId: string;
  sessionId: string;
  classId: string;
  className: string;
  studentId: string;
  studentName: string;
  userId: string;
};

export type AbsenceNoticeSweepResult = { candidates: number; delivered: number; duplicate: number; failed: number };

/**
 * 선생님 출석부의 «결석»을 학부모에게 알린다(f2) — push-outbox 크론(매분)이 부른다.
 * 규칙·문구는 absence-parent-notice.ts 에 있다. 여기는 «누구에게» 를 DB 에서 고르고 보내기만 한다.
 *
 * 개별 줄 저장·«전체 출석»·관리자 화면 어디서 찍혔든 출결 표(Attendance)를 기준으로 고르므로 경로마다 따로 붙일 필요가 없다.
 */
export async function sweepAbsenceParentNotices(limit = 50, nowMs: number = Date.now()): Promise<AbsenceNoticeSweepResult> {
  const today = todayKst(nowMs);
  const result: AbsenceNoticeSweepResult = { candidates: 0, delivered: 0, duplicate: 0, failed: 0 };
  const rows = await prisma.$queryRawUnsafe<Candidate[]>(
    `SELECT a.id AS "attendanceId", s.id AS "sessionId", s."classId", c.name AS "className",
            st.id AS "studentId", st.name AS "studentName", st."parentId" AS "userId"
       FROM "Attendance" a
       JOIN "Session" s ON s.id = a."sessionId" AND s."specialProgramSessionDateId" IS NULL
       JOIN "Class" c ON c.id = s."classId"
       JOIN "Student" st ON st.id = a."studentId" AND ${notMergedStudent("st")} AND st."parentId" IS NOT NULL
      WHERE a.status = 'ABSENT'
        AND s.date::date = $1::date
        -- Attendance.updatedAt 은 시간대 없는 칸(UTC 로 저장) → UTC 로 한 번 붙여 비교한다.
        AND (a."updatedAt" AT TIME ZONE 'UTC') <= NOW() - make_interval(mins => $2::int)
        -- 정규 반 수강생만(보강 온 아이 제외).
        AND EXISTS (SELECT 1 FROM "Enrollment" e
                     WHERE e."classId" = s."classId" AND e."studentId" = st.id AND e.status = 'ACTIVE')
        -- 결석 신고가 이미 있는 날(학부모 신고·원장 기간 결석·출석부 질병·부상 표시)은 보내지 않는다.
        AND NOT EXISTS (SELECT 1 FROM "RegularAbsence" ra
                         WHERE ra."studentId" = st.id AND ra."classId" = s."classId"
                           AND ra.date = $1::date AND ra.status IN ('REPORTED','CONFIRMED'))
        -- 이미 보낸 아이는 다시 고르지 않는다 — 중복 방지 키와 같은 기준(반+날짜+아이, absenceNoticeKeyPrefixSql).
        -- «웹푸시 행»을 기준으로 본다: 앱 알림만 남고 웹푸시 기록이 실패했으면 다음 분에 다시 골라 웹푸시만 채운다
        -- (앱 알림은 같은 키라 ON CONFLICT 로 두 번 생기지 않는다).
        AND NOT EXISTS (SELECT 1 FROM "NotificationDelivery" nd
                         WHERE nd."eventType" = $3 AND nd."studentId" = st.id AND nd.channel = 'PUSH'
                           AND starts_with(nd."dedupeKey", ${absenceNoticeKeyPrefixSql('s."classId"', "$1::text", "st.id")}))
      ORDER BY a."updatedAt"
      LIMIT $4`,
    today, ABSENCE_NOTICE_DELAY_MINUTES, ABSENCE_NOTICE_EVENT, limit,
  );
  result.candidates = rows.length;
  for (const row of rows) {
    try {
      const delivered = await deliverParentNotification({
        eventType: ABSENCE_NOTICE_EVENT,
        dedupeKey: absenceNoticeDedupeKey({ classId: row.classId, dateYmd: today, studentId: row.studentId, userId: row.userId }),
        recipient: { studentId: row.studentId, studentName: row.studentName, userId: row.userId },
        title: absenceNoticeTitle(row.className),
        message: absenceNoticeMessage(row.className, row.studentName),
        linkUrl: "/parent/attendance",
        sessionId: row.sessionId,
        attendanceId: row.attendanceId,
      });
      if (delivered.duplicate) result.duplicate += 1;
      else result.delivered += 1;
    } catch (error) {
      // 한 명 실패가 나머지를 막지 않게 — 다음 분에 다시 고른다(장부에 없으면 NOT EXISTS 를 통과).
      result.failed += 1;
      console.error("[absence-parent-notice] 결석 알림 실패", { attendanceId: row.attendanceId, error });
    }
  }
  return result;
}
