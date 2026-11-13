// 아이 한 명의 정규 반(수강 중·휴원 중) — «아이 기록» 아이 정보 칸과 셔틀 칸이 같이 쓴다.
//
// ★ 권한: 이 함수는 인증하지 않는다. 호출부가 «로그인 보호자의 아이»로 확인한 studentId 만 넘긴다
//   (getChildRecord 의 첫 SQL · getParentShuttleOverview 의 childAccessWhere).
// 기준은 학부모 «수업» 탭(classes-overview)과 같다 — 방학특강 반 제외, ACTIVE·PAUSED, 상태 칩은 classStatusChip.
// ⚠️ PgBouncer → $queryRawUnsafe 만. 날짜 칸(@db.Date)은 변환 없이 to_char.
import { commencementYmd } from "@/lib/enrollment/commencement";
import { resumeFromSql } from "@/lib/enrollment/resumeWindow";
import { classStatusChip, type ClassChip } from "@/lib/parent/classCards";
import type { ShuttleClassRef } from "@/lib/shuttle/childShuttleRules";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

export type ChildClassRow = ShuttleClassRef & {
  enrollmentId: string;
  endTime: string;
  programName: string | null;
  coachName: string | null;
  /** 수업 탭과 같은 상태 칩(수강 중·휴원 예정·휴원 중·퇴원 예정·검토 중 …) */
  chip: ClassChip;
};

export async function loadChildClasses(db: Reader, studentId: string, today: string): Promise<ChildClassRow[]> {
  if (!studentId) return [];
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT e.id AS "enrollmentId", e.status AS "enrollmentStatus", e."startsOn",
            c.id AS "classId", c.name AS "className", c."dayOfWeek", c."startTime", c."endTime",
            p.name AS "programName", u.name AS "coachName",
            sc.kind AS "scheduledKind", to_char(sc."effectiveFrom",'YYYY-MM-DD') AS "scheduledFrom",
            to_char(sc."resumeOn",'YYYY-MM-DD') AS "scheduledResumeOn",
            pr.kind AS "pendingKind", to_char(pr."effectiveFrom",'YYYY-MM-DD') AS "pendingFrom",
            to_char(pz."resumeOn",'YYYY-MM-DD') AS "pausedResumeOn",
            -- 승인된 복귀일(공용 규칙 resumeWindow) — 셔틀 «휴원» 판정이 이 날짜부터 정상 운행으로 본다
            ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Enrollment" e
       JOIN "Class" c ON c.id = e."classId" AND c."dayOfWeek" <> 'Seasonal'
       LEFT JOIN "Program" p ON p.id = c."programId"
       LEFT JOIN "User" u ON u.id = c."instructorId"
       -- 승인됐지만 아직 반영 전인 신청 중 가장 이른 1건(수업 탭·홈 반 상태 한 줄과 같은 기준)
       LEFT JOIN LATERAL (
         SELECT x.kind, x."effectiveFrom", x."resumeOn" FROM "EnrollmentChangeRequest" x
          WHERE x."enrollmentId" = e.id AND x.status = 'APPROVED' AND x."appliedAt" IS NULL
          ORDER BY x."effectiveFrom" LIMIT 1
       ) sc ON true
       -- 검토 중 신청
       LEFT JOIN LATERAL (
         SELECT x.kind, x."effectiveFrom" FROM "EnrollmentChangeRequest" x
          WHERE x."enrollmentId" = e.id AND x.status = 'PENDING'
          ORDER BY x."createdAt" DESC LIMIT 1
       ) pr ON true
       -- 휴원 중이면 마지막으로 반영된 휴원 신청의 복귀 예정일
       LEFT JOIN LATERAL (
         SELECT x."resumeOn" FROM "EnrollmentChangeRequest" x
          WHERE e.status = 'PAUSED' AND x."enrollmentId" = e.id AND x.kind = 'PAUSE' AND x.status = 'APPLIED'
          ORDER BY x."appliedAt" DESC NULLS LAST LIMIT 1
       ) pz ON true
      WHERE e."studentId" = $1 AND e.status IN ('ACTIVE','PAUSED')
      ORDER BY CASE c."dayOfWeek" WHEN 'Mon' THEN 1 WHEN 'Tue' THEN 2 WHEN 'Wed' THEN 3 WHEN 'Thu' THEN 4
                                  WHEN 'Fri' THEN 5 WHEN 'Sat' THEN 6 ELSE 7 END, c."startTime"`,
    studentId,
  );
  return rows.map((row): ChildClassRow => {
    const scheduled = row.scheduledKind
      ? { kind: String(row.scheduledKind), effectiveFrom: String(row.scheduledFrom ?? ""), resumeOn: (row.scheduledResumeOn ?? null) as string | null }
      : null;
    return {
      enrollmentId: String(row.enrollmentId),
      classId: String(row.classId),
      className: String(row.className ?? "수강 반"),
      dayOfWeek: String(row.dayOfWeek ?? ""),
      startTime: String(row.startTime ?? ""),
      endTime: String(row.endTime ?? ""),
      status: String(row.enrollmentStatus),
      // 첫 수업일 — 수업 탭과 같은 정리 함수(날짜 칸이 아니면 null)
      startsOn: commencementYmd(row.startsOn),
      scheduled,
      pausedResumeOn: row.pausedResumeOn ?? null,
      resumeFrom: row.resumeFrom ?? null,
      programName: row.programName ?? null,
      coachName: row.coachName ?? null,
      chip: classStatusChip({
        enrollmentStatus: row.enrollmentStatus,
        scheduled,
        pending: row.pendingKind ? { kind: row.pendingKind, effectiveFrom: row.pendingFrom } : null,
        pausedResumeOn: row.pausedResumeOn ?? null,
        today,
      }),
    };
  });
}
