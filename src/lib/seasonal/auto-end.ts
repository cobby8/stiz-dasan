import { prisma } from "@/lib/prisma";
import { addDaysKst, todayKst } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";
import { decideSeasonalClassEnd } from "./auto-end-rules";

/**
 * 끝난 방학특강 수강을 퇴원(WITHDRAWN) 처리한다(매일 KST 00:20 크론).
 *
 * 왜 필요한가: 특강 승인 때 연결 반(linkedClassId)의 Enrollment 를 ACTIVE 로 만들지만
 * 끝내는 로직이 없어, 특강이 끝나도 학생이 계속 "수강 중"으로 남았다
 * (2026-10-04 여름특강 3명을 손으로 WITHDRAWN 정리).
 *
 * 안전장치
 *  - **특강 전용 반(Class.dayOfWeek = 'Seasonal')만** 본다. 특강이 정규반에 연결된 경우
 *    그 정규반 수강은 절대 건드리지 않는다.
 *  - 그 반에 연결된 **모든** 특강의 마지막 회차가 오늘(KST) 이전일 때만 처리한다.
 *    하나라도 진행 중·미래 회차가 있으면 제외(다음 시즌이 같은 반을 재사용하는 경우 보호).
 *  - UPDATE 에 "읽었을 때의 상태" 조건을 걸어, 그 사이 관리자가 바꾼 건은 덮어쓰지 않는다.
 *  - 운영 원장(시트·랠리즈) 적재는 하지 않는다 — 특강 반은 동기화 대상이 불명확하다.
 */

/** 이력의 요청자 칸(NOT NULL·외래키 없음)에 남기는 시스템 표식. 사람이 아닌 크론이 했다는 뜻. */
export const SEASONAL_AUTO_END_ACTOR = "SYSTEM:seasonal-auto-end";
const REASON = "방학특강 종료 자동 처리";

export type SeasonalAutoEndItem = {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  previousStatus: "ACTIVE" | "PAUSED";
  /** 퇴원 적용일 = 마지막 회차 다음 날(KST). */
  effectiveFrom: string;
};

export async function endFinishedSeasonalEnrollments(): Promise<{
  ended: number;
  items: SeasonalAutoEndItem[];
}> {
  const today = todayKst();

  // 1) 아직 수강 중인 학생이 있는 특강 전용 반과, 연결된 특강마다의 마지막 날짜(KST).
  //    회차(SessionDate)·시즌 endsAt 은 timestamptz 라 AT TIME ZONE 을 한 번만 건다.
  //    회차가 없는 특강은 시즌 endsAt 으로 대신한다.
  const classes = await prisma.$queryRawUnsafe<Array<{
    classId: string;
    className: string;
    offeringLastYmds: Array<string | null>;
  }>>(
    `SELECT c.id AS "classId", c.name AS "className",
            array_agg(to_char(ol."lastAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')) AS "offeringLastYmds"
       FROM "Class" c
       JOIN (
         SELECT o.id, o."linkedClassId", COALESCE(MAX(sd."endsAt"), s."endsAt") AS "lastAt"
           FROM "SpecialProgramOffering" o
           JOIN "SpecialProgramSeason" s ON s.id = o."seasonId"
           LEFT JOIN "SpecialProgramSessionDate" sd ON sd."offeringId" = o.id
          WHERE o."linkedClassId" IS NOT NULL
          GROUP BY o.id, o."linkedClassId", s."endsAt"
       ) ol ON ol."linkedClassId" = c.id
      WHERE c."dayOfWeek" = 'Seasonal'
        AND EXISTS (SELECT 1 FROM "Enrollment" e
                     WHERE e."classId" = c.id AND e.status IN ('ACTIVE','PAUSED'))
      GROUP BY c.id, c.name`,
  );

  const items: SeasonalAutoEndItem[] = [];
  for (const cls of classes) {
    // 2) 날짜 판정은 순수 함수에 맡긴다(테스트로 못박은 규칙).
    const decision = decideSeasonalClassEnd(cls.offeringLastYmds ?? [], today);
    if (!decision.ended || !decision.lastYmd) continue;
    const effectiveFrom = addDaysKst(decision.lastYmd, 1);

    const enrollments = await prisma.$queryRawUnsafe<Array<{
      id: string; studentId: string; studentName: string; status: "ACTIVE" | "PAUSED";
    }>>(
      `SELECT e.id, e."studentId", s.name AS "studentName", e.status
         FROM "Enrollment" e
         JOIN "Student" s ON s.id = e."studentId"
        WHERE e."classId" = $1 AND e.status IN ('ACTIVE','PAUSED')
          AND ${notMergedStudent("s")}`,
      cls.classId,
    );

    for (const enr of enrollments) {
      // 3) 한 건씩 트랜잭션 — 상태 변경과 이력이 같이 남거나 같이 안 남는다.
      // 한 건이 실패해도 나머지는 계속 처리한다(실패 건은 다음 날 크론이 다시 집는다).
      let changed = false;
      try {
      changed = await prisma.$transaction(async (tx) => {
        // 읽었을 때 상태(기대 상태)일 때만 바꾼다. 그 사이 사람이 바꿨으면 0건 → 이력도 안 남긴다.
        const updated = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `UPDATE "Enrollment" SET status = 'WITHDRAWN', "updatedAt" = NOW()
            WHERE id = $1 AND status = $2
            RETURNING id`,
          enr.id, enr.status,
        );
        if (updated.length === 0) return false;
        await tx.$executeRawUnsafe(
          `INSERT INTO "EnrollmentChangeRequest" (
              id, "studentId", "enrollmentId", "fromClassId", kind, "effectiveFrom", reason,
              status, "requestedByUserId", "decidedByUserId", "decidedAt", "appliedAt", "createdAt", "updatedAt"
           ) VALUES (
              gen_random_uuid()::text, $1, $2, $3, 'WITHDRAW', $4::date, $5,
              'APPLIED', $6, NULL, NOW(), NOW(), NOW(), NOW()
           )`,
          enr.studentId, enr.id, cls.classId, effectiveFrom, REASON, SEASONAL_AUTO_END_ACTOR,
        );
        return true;
      });
      } catch (error) {
        console.error(`[seasonal-auto-end] 처리 실패 ${enr.studentName} · ${cls.className}`, error);
        continue;
      }
      if (!changed) continue;
      items.push({
        enrollmentId: enr.id,
        studentId: enr.studentId,
        studentName: enr.studentName,
        classId: cls.classId,
        className: cls.className,
        previousStatus: enr.status,
        effectiveFrom,
      });
    }
  }

  // 결과는 로그로 남긴다(운영 원장 대신 추적 수단).
  for (const it of items) {
    console.log(
      `[seasonal-auto-end] ${it.studentName} · ${it.className} ${it.previousStatus} → WITHDRAWN (적용일 ${it.effectiveFrom})`,
    );
  }
  return { ended: items.length, items };
}
