import { prisma } from "@/lib/prisma";

/** 새 표가 없는 운영 환경에서는 기존 보호자 권한을 그대로 유지한다. */
export async function childConnectionsAvailable(): Promise<boolean> {
  if (process.env.CHILD_CONNECTIONS_ENABLED !== "true") return false;
  try {
    const rows = await prisma.$queryRawUnsafe<{ ready: boolean }[]>(
      `WITH required(name,cols) AS (VALUES
        ('ParentStudentAccess',ARRAY['id','studentId','userId','status','source','approvedBy','createdAt','updatedAt']),
        ('ChildLinkRequest',ARRAY['id','studentId','requesterId','approverId','challengeId','requesterName','requesterPhoneLast4','relation','status','createdAt','expiresAt','decidedAt','decidedBy']),
        ('ChildIdentityChallenge',ARRAY['id','userId','sessionHash','createdAt','expiresAt','usedAt','verifiedName','phoneHash','phoneLast4','birthHash','proofExpiresAt','proofUsedAt','verifyAttempts','requestAttempts']))
       SELECT COALESCE(bool_and(c.oid IS NOT NULL AND c.relrowsecurity AND c.relforcerowsecurity
         AND r.cols <@ ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)),false)
         AND to_regclass('public."ParentStudentAccess_user_status_idx"') IS NOT NULL
         AND to_regclass('public."ChildLinkRequest_pending_unique"') IS NOT NULL AS ready
       FROM required r LEFT JOIN pg_class c ON c.oid=to_regclass('public."' || r.name || '"')`,
    );
    return rows[0]?.ready === true;
  } catch { return false; }
}

/** SQL 식별자는 코드에 적힌 값만 받는다. 사용자 입력은 반드시 $n 매개변수로 전달한다. */
export async function childAccessSql(alias: string, parentExpression: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias) || !/^(\$[1-9]\d*|[a-z][a-z0-9_]*\."(?:id|parentId)")$/i.test(parentExpression)) {
    throw new Error("INVALID_CHILD_ACCESS_EXPRESSION");
  }
  const legacy = `${alias}."parentId" = ${parentExpression}`;
  if (!await childConnectionsAvailable()) return legacy;
  return `(${legacy} OR EXISTS (SELECT 1 FROM "ParentStudentAccess" child_access
    JOIN "User" child_actor ON child_actor.id = child_access."userId" AND child_actor."withdrawnAt" IS NULL
    WHERE child_access."studentId" = ${alias}.id AND child_access."userId" = ${parentExpression}
      AND child_access.status = 'ACTIVE'))`;
}

/** Prisma 조회도 SQL 조회와 같은 학생 범위로 제한한다. */
export async function childAccessWhere(userId: string) {
  if (!await childConnectionsAvailable()) return { parentId: userId };
  const grants = await prisma.$queryRawUnsafe<{ studentId: string }[]>(
    `SELECT a."studentId" FROM "ParentStudentAccess" a JOIN "User" u ON u.id=a."userId"
       WHERE a."userId"=$1 AND a.status='ACTIVE' AND u."withdrawnAt" IS NULL`, userId,
  );
  return { OR: [{ parentId: userId }, { id: { in: grants.map(row => row.studentId) } }] };
}

/** 새 연결 권한은 본인인증 또는 인증된 기존 가족의 승인을 거친 기록에 한한다. */
export async function hasGrantedChildren(userId: string): Promise<boolean> {
  if (!await childConnectionsAvailable()) return false;
  const rows=await prisma.$queryRawUnsafe<{found:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "ParentStudentAccess" a
    JOIN "Student" s ON s.id=a."studentId" AND s."mergedIntoStudentId" IS NULL
    JOIN "User" u ON u.id=a."userId" AND u."withdrawnAt" IS NULL
    WHERE a."userId"=$1 AND a.status='ACTIVE') AS found`,userId);
  return rows[0]?.found === true;
}
