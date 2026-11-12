import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * 관리자 쪽 «앱 가족 연결»(ParentStudentAccess) 관리 — 2026-11-13.
 *
 * 왜: 가족 연결은 보호자 본인이 탈퇴할 때만 풀렸다. 관리자가 보호자 행을 지워도
 * 그 보호자는 계속 출결·결제·사진을 보고 결석 신청까지 할 수 있었다.
 * - 관리자가 학생 상세에서 연결을 직접 해제한다.
 * - 보호자 행을 지우거나 번호를 바꾸면, 그 번호로 자동 연결(REGISTERED_CONTACT)된 계정을 함께 해제한다.
 * 대표 보호자(Student.parentId, 청구 수신자)는 이 표와 별개라 여기서 풀 수 없다.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type FamilyAccessRow = {
  id: string;
  name: string;
  phoneLast4: string;
  source: "REGISTERED_CONTACT" | "ADULT_SELF" | "FAMILY_APPROVAL";
  createdAt: string;
};

export async function familyAccessTablesPresent(db: Db = prisma): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT to_regclass('public."ParentStudentAccess"') IS NOT NULL
        AND to_regclass('public."ChildLinkRequest"') IS NOT NULL AS ok`,
  );
  return rows[0]?.ok === true;
}

/** 이 학생의 살아 있는 가족 연결(대표 보호자 제외). 전화는 끝 4자리만. */
export async function loadFamilyAccess(db: Db, studentId: string): Promise<FamilyAccessRow[]> {
  if (!await familyAccessTablesPresent(db)) return [];
  const rows = await db.$queryRawUnsafe<Array<{ id: string; name: string | null; last4: string | null; source: string; createdAt: Date }>>(
    `SELECT a.id, u.name, RIGHT(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g'), 4) AS last4,
            a.source, a."createdAt"
       FROM "ParentStudentAccess" a
       JOIN "User" u ON u.id = a."userId" AND u."withdrawnAt" IS NULL
       JOIN "Student" s ON s.id = a."studentId"
      WHERE a."studentId" = $1 AND a.status = 'ACTIVE'
        AND u.id IS DISTINCT FROM s."parentId"
      ORDER BY a."createdAt" ASC`,
    studentId,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name || "이름 없음",
    phoneLast4: row.last4 || "",
    source: row.source as FamilyAccessRow["source"],
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

/** 연결을 끊은 사람이 이 학생에 대해 걸어 둔·받아 둔 대기 요청도 닫는다(끊긴 사람이 다른 사람을 승인하지 못하게). */
async function cancelPendingRequestsFor(tx: Prisma.TransactionClient, studentId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  await tx.$executeRawUnsafe(
    `UPDATE "ChildLinkRequest" SET status = 'CANCELED', "decidedAt" = NOW()
      WHERE "studentId" = $1 AND status = 'PENDING'
        AND ("approverId" = ANY($2::text[]) OR "requesterId" = ANY($2::text[]))`,
    studentId,
    userIds,
  );
}

/** 관리자가 연결 하나를 해제한다. 성공하면 true, 이미 없거나 다른 학생의 연결이면 false. */
export async function revokeFamilyAccess(tx: Prisma.TransactionClient, studentId: string, accessId: string): Promise<boolean> {
  if (!await familyAccessTablesPresent(tx)) return false;
  const rows = await tx.$queryRawUnsafe<Array<{ userId: string }>>(
    `UPDATE "ParentStudentAccess" SET status = 'REVOKED', "updatedAt" = NOW()
      WHERE id = $1 AND "studentId" = $2 AND status = 'ACTIVE'
      RETURNING "userId"`,
    accessId,
    studentId,
  );
  if (rows.length !== 1) return false;
  await cancelPendingRequestsFor(tx, studentId, [rows[0].userId]);
  return true;
}

/**
 * 보호자 행이 지워졌거나 번호가 바뀐 뒤 호출한다.
 * 그 번호로 «등록 연락처 일치» 자동 연결된 계정 중, 이제 이 학생의 어느 보호자 번호와도 맞지 않고
 * 대표 보호자도 아닌 계정의 연결을 해제한다. 해제한 수를 돌려준다.
 * (본인 인증 ADULT_SELF·가족 승인 FAMILY_APPROVAL 은 보호자 행과 무관하므로 건드리지 않는다 — 필요하면 관리자가 직접 해제)
 */
export async function revokeContactAccessForRemovedPhone(tx: Prisma.TransactionClient, studentId: string, phoneDigits: string): Promise<number> {
  const phone = (phoneDigits || "").replace(/[^0-9]/g, "");
  if (!phone || !await familyAccessTablesPresent(tx)) return 0;
  const rows = await tx.$queryRawUnsafe<Array<{ userId: string }>>(
    `UPDATE "ParentStudentAccess" a SET status = 'REVOKED', "updatedAt" = NOW()
       FROM "User" u, "Student" s
      WHERE a."studentId" = $1 AND a.status = 'ACTIVE' AND a.source = 'REGISTERED_CONTACT'
        AND u.id = a."userId" AND s.id = a."studentId"
        AND u.id IS DISTINCT FROM s."parentId"
        AND regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = $2
        AND NOT EXISTS (
          SELECT 1 FROM "Guardian" g
           WHERE g."studentId" = $1 AND regexp_replace(COALESCE(g.phone, ''), '[^0-9]', '', 'g') = $2
        )
      RETURNING a."userId"`,
    studentId,
    phone,
  );
  await cancelPendingRequestsFor(tx, studentId, rows.map((row) => row.userId));
  return rows.length;
}
