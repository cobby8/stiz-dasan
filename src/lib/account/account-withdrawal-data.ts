import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Reader = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
export type WithdrawalRecord = {
  id: string;
  name: string;
  role: string;
  authUserId: string | null;
  withdrawRequestedAt: Date | null;
  withdrawnAt: Date | null;
  activeEnrollments: number;
  activeStaffGrantCount: number;
  activeWorkCount: number;
};

/** 주 역할·추가 역할·자녀·담당 업무를 같은 기준으로 읽어 UI와 실제 실행의 판정 차이를 막는다. */
export async function readWithdrawalRecord(
  userId: string,
  db: Reader = prisma,
): Promise<WithdrawalRecord | null> {
  const schema = await db.$queryRawUnsafe<{ additional: boolean }[]>(
    `SELECT to_regclass('public."ParentStudentAccess"') IS NOT NULL AS additional`,
  );
  const family = schema[0]?.additional
    ? ` OR EXISTS(SELECT 1 FROM "ParentStudentAccess" access
    WHERE access."studentId"=s.id AND access."userId"=u.id AND access.status='ACTIVE')`
    : "";
  const rows = await db.$queryRawUnsafe<WithdrawalRecord[]>(
    `SELECT u.id,u.name,u.role::text AS role,u."authUserId",u."withdrawRequestedAt",u."withdrawnAt",
    (SELECT COUNT(*)::int FROM "Enrollment" e JOIN "Student" s ON s.id=e."studentId"
      WHERE (s."parentId"=u.id${family}) AND s."mergedIntoStudentId" IS NULL AND e.status='ACTIVE') AS "activeEnrollments",
    (SELECT COUNT(*)::int FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.status='ACTIVE') AS "activeStaffGrantCount",
    ((SELECT COUNT(*)::int FROM "Coach" co WHERE co."userId"=u.id)
      +(SELECT COUNT(*)::int FROM "Class" c JOIN "Program" p ON p.id=c."programId" WHERE c."instructorId"=u.id AND p."deletedAt" IS NULL)
      +(SELECT COUNT(*)::int FROM "Session" se WHERE se."startedByUserId"=u.id AND se.status='IN_PROGRESS')
      +(SELECT COUNT(*)::int FROM "ShuttleRoutePlan" r WHERE r."driverUserId"=u.id AND r.status IN ('DRAFT','CONFIRMED')
        AND (r."serviceDate" IS NULL OR r."serviceDate">=(NOW() AT TIME ZONE 'Asia/Seoul')::date)))::int AS "activeWorkCount"
    FROM "User" u WHERE u.id=$1 LIMIT 1`,
    userId,
  );
  return rows[0] ?? null;
}
