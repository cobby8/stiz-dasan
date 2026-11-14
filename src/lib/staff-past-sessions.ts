import { prisma } from "@/lib/prisma";
import { getAccessibleClassIds, getStaffClassAccessContext, getSubstituteClassIds } from "@/lib/staff-class-access";
import { todayKst } from "@/lib/datetime/kst";
import { sessionKstDateSql, TODAY_KST_SQL } from "@/lib/feed/rules";
import { STAFF_PAST_SESSION_LIST_DAYS, type PastSessionRow } from "@/lib/staff/sessionEditWindow";

/**
 * «지난 수업 목록에 보일 날짜»(SQL) — 오늘 포함 최근 14일(순수판 inPastSessionListRange 와 같은 뜻).
 * 날짜 − 정수 = 날짜(Postgres). @param se Session 별칭
 */
export function pastSessionListRangeSql(se: string): string {
  const day = sessionKstDateSql(se);
  return `(${day} <= ${TODAY_KST_SQL} AND ${day} > ${TODAY_KST_SQL} - ${STAFF_PAST_SESSION_LIST_DAYS})`;
}

/**
 * 특강 회차의 좌석 수(SQL 식) — 출석부·종료 검사와 같은 범위(같은 시간의 형제 반/코트 좌석까지, 승인 항목의 SCHEDULED 좌석).
 * 특강은 좌석이 출결 정본이라 Attendance 로 세면 전환 전 신청자가 빠진다.
 * @param statuses 세려는 좌석 출결 상태
 */
function seasonalSeatCountSql(statuses: readonly string[]): string {
  const list = statuses.map((status) => `'${status}'`).join(", ");
  return `(SELECT COUNT(DISTINCT e.id)
             FROM "SpecialProgramSessionDate" anchor_sd
             JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = anchor_sd."offeringId"
             JOIN "SpecialProgramSessionDate" sib_sd
               ON sib_sd."startsAt" = anchor_sd."startsAt" AND sib_sd."endsAt" = anchor_sd."endsAt"
             JOIN "SpecialProgramOffering" o
               ON o.id = sib_sd."offeringId"
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
               ON e."applicationItemId" = i.id AND e."sessionDateId" = sib_sd.id AND e.status = 'SCHEDULED'
            WHERE anchor_sd.id = s."specialProgramSessionDateId" AND e."attendanceStatus" IN (${list}))`;
}

/**
 * 선생님 «지난 수업» 목록 — 오늘 포함 최근 14일의 완료한 수업(2026-11-14 원장 지시).
 *
 * 범위 = «열 수 있는 수업»만(수업 화면의 권한 판정 requireStaffSessionAccess 와 같은 기준 — 눌렀는데 권한 없음이 뜨지 않게):
 *   - 원장·부원장: 전체
 *   - 정규 수업: 내 담당 반(getAccessibleClassIds) + 오늘 대타로 맡은 반의 «오늘» 수업
 *     (대타 권한은 KST 자정에 닫힌다 — 지난 날 대타 수업은 권한이 없어 목록에도 넣지 않는다)
 *   - 특강 회차: 수업 기록의 코치가 나인 것
 * 날짜는 무tz 칼럼 Session.date 를 «두 번» 변환(sessionKstDateSql), 오늘은 DB 시계(TODAY_KST_SQL).
 */
export async function getStaffPastSessions(): Promise<PastSessionRow[]> {
  const access = await getStaffClassAccessContext();
  const [classIds, substituteIds] = access.canAccessAllClasses
    ? [[] as string[], [] as string[]]
    : await Promise.all([getAccessibleClassIds(access), getSubstituteClassIds(access, todayKst())]);
  // 담당 반도 코치 연결도 없으면 볼 수업이 없다
  if (!access.canAccessAllClasses && classIds.length === 0 && substituteIds.length === 0 && !access.coachId) return [];

  const day = sessionKstDateSql("s");
  const rows = await prisma.$queryRawUnsafe<PastSessionRow[]>(
    `SELECT s.id AS "sessionId",
            ${day}::text AS ymd,
            c.name AS "className",
            COALESCE(to_char(sd."startsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI'), c."startTime") AS "startTime",
            COALESCE(to_char(sd."endsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI'), c."endTime") AS "endTime",
            (s."specialProgramSessionDateId" IS NOT NULL) AS seasonal,
            (CASE WHEN s."specialProgramSessionDateId" IS NOT NULL THEN ${seasonalSeatCountSql(["PRESENT", "LATE"])}
                  ELSE (SELECT COUNT(*) FROM "Attendance" a WHERE a."sessionId" = s.id AND a.status IN ('PRESENT', 'LATE')) END)::int AS "presentCount",
            (CASE WHEN s."specialProgramSessionDateId" IS NOT NULL THEN ${seasonalSeatCountSql(["ABSENT"])}
                  ELSE (SELECT COUNT(*) FROM "Attendance" a WHERE a."sessionId" = s.id AND a.status = 'ABSENT') END)::int AS "absentCount",
            (COALESCE(btrim(s.content), '') <> ''
              OR COALESCE(btrim(s."photosJSON"), '') NOT IN ('', '[]')
              OR EXISTS (SELECT 1 FROM "SessionVideo" v
                          WHERE v."sessionId" = s.id AND v."registeredAt" IS NOT NULL AND v."deletedAt" IS NULL)) AS "hasFeed",
            COALESCE(s.published, false) AS published
       FROM "Session" s
       JOIN "Class" c ON c.id = s."classId"
       LEFT JOIN "SpecialProgramSessionDate" sd ON sd.id = s."specialProgramSessionDateId"
      WHERE s.status = 'COMPLETED'
        -- 색인(status, date)을 탈 수 있게 넉넉한 하한을 먼저 건다(KST 날짜 판정은 아래 줄이 그대로 한다)
        AND s.date >= NOW() - interval '${STAFF_PAST_SESSION_LIST_DAYS + 2} days'
        AND ${pastSessionListRangeSql("s")}
        AND (
          $1::boolean = true
          OR (s."specialProgramSessionDateId" IS NULL AND s."classId" = ANY($2::text[]))
          OR (s."specialProgramSessionDateId" IS NULL AND s."classId" = ANY($3::text[]) AND ${day} = ${TODAY_KST_SQL})
          OR (s."specialProgramSessionDateId" IS NOT NULL AND $4::text IS NOT NULL AND s."coachId" = $4::text)
        )
      ORDER BY ${day} DESC, "startTime", c.name
      LIMIT 300`,
    access.canAccessAllClasses,
    classIds,
    substituteIds,
    access.coachId,
  );
  return rows.map((row) => ({
    ...row,
    presentCount: Number(row.presentCount) || 0,
    absentCount: Number(row.absentCount) || 0,
    seasonal: row.seasonal === true,
    hasFeed: row.hasFeed === true,
    published: row.published === true,
  }));
}
