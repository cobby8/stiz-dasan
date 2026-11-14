// 학부모 쪽 «연결된 가족 보기·끊기» (2026-11-14 원장 결정 b7).
// 실행 테스트: tests/child-edit.test.mjs
//
// · 보기: 내 아이마다 대표 보호자 이름과 연결된 가족 이름·관계만. 전화번호는 고르지 않는다.
// · 끊기: «대표 보호자(Student.parentId)»만 다른 가족의 연결을 끊을 수 있다. 실제 해제는 관리자 화면과 같은 함수
//   (family-access-admin.revokeFamilyAccess — 그 사람의 대기 요청도 함께 닫는다)를 쓴다.
// · 대표 보호자 변경은 만들지 않는다.
import type { Prisma } from "@prisma/client";
import { childAccessSql, childConnectionsAvailable } from "@/lib/account/child-access";
import { revokeFamilyAccess } from "@/lib/account/family-access-admin";
import { notMergedStudent } from "@/lib/studentVisibility";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

export type FamilyMember = {
  /** 연결 id — 대표 보호자에게만 내려간다(끊기 버튼용). 그 외에는 null */
  accessId: string | null;
  name: string;
  /** «부모»·«가족» — 가족 승인 요청 때 고른 관계가 있으면 그것, 없으면 «가족» */
  relation: string;
  /** 지금 로그인한 본인인가 */
  isMe: boolean;
};

export type FamilyOfChild = {
  studentId: string;
  studentName: string;
  representativeName: string | null;
  meIsRepresentative: boolean;
  members: FamilyMember[];
};

const RELATION_LABEL: Record<string, string> = { PARENT: "부모", OTHER: "가족" };

/** 내 아이별 연결 가족(대표 보호자 제외). 가족 연결 기능이 꺼진 환경이면 members 는 빈 목록 */
export async function loadFamilyForParent(db: Reader, userId: string): Promise<FamilyOfChild[]> {
  if (!userId) return [];
  const children = await db.$queryRawUnsafe<Array<{ id: string; name: string; repName: string | null; meIsRep: boolean }>>(
    `SELECT s.id, s.name, rep.name AS "repName", (s."parentId" = $1) AS "meIsRep"
       FROM "Student" s
       LEFT JOIN "User" rep ON rep.id = s."parentId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY s."createdAt" ASC`,
    userId,
  );
  if (children.length === 0) return [];
  let rows: Array<{ id: string; studentId: string; userId: string; name: string | null; relation: string | null }> = [];
  if (await childConnectionsAvailable()) {
    try {
      // 전화번호는 고르지 않는다(이름·관계만)
      rows = await db.$queryRawUnsafe(
        `SELECT a.id, a."studentId", a."userId", u.name,
                (SELECT r.relation FROM "ChildLinkRequest" r
                  WHERE r."studentId" = a."studentId" AND r."requesterId" = a."userId" AND r.status = 'APPROVED'
                  ORDER BY r."decidedAt" DESC NULLS LAST LIMIT 1) AS relation
           FROM "ParentStudentAccess" a
           JOIN "User" u ON u.id = a."userId" AND u."withdrawnAt" IS NULL
           JOIN "Student" s ON s.id = a."studentId" AND ${notMergedStudent("s")}
          WHERE a."studentId" = ANY($1::text[]) AND a.status = 'ACTIVE'
            AND a."userId" IS DISTINCT FROM s."parentId"
          ORDER BY a."createdAt" ASC`,
        children.map((c) => String(c.id)),
      );
    } catch {
      rows = [];
    }
  }
  return children.map((child) => {
    const meIsRepresentative = child.meIsRep === true;
    return {
      studentId: String(child.id),
      studentName: String(child.name ?? ""),
      representativeName: child.repName ?? null,
      meIsRepresentative,
      members: rows
        .filter((row) => row.studentId === child.id)
        .map((row) => ({
          accessId: meIsRepresentative ? String(row.id) : null,
          name: String(row.name ?? "").trim() || "이름 없음",
          relation: RELATION_LABEL[String(row.relation ?? "")] ?? "가족",
          isMe: row.userId === userId,
        })),
    };
  });
}

/**
 * 대표 보호자가 다른 가족의 연결을 끊는다 — 반드시 트랜잭션 안에서 부른다.
 * 권한: 이 학생의 parentId 가 로그인한 본인일 때만(연결된 가족·남의 아이는 false).
 */
export async function revokeFamilyAsRepresentative(
  tx: Prisma.TransactionClient,
  userId: string,
  studentId: string,
  accessId: string,
): Promise<boolean> {
  if (!userId || !studentId || !accessId) return false;
  const owned = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s.id FROM "Student" s WHERE s.id = $1 AND s."parentId" = $2 AND ${notMergedStudent("s")} LIMIT 1 FOR UPDATE`,
    studentId,
    userId,
  );
  if (!owned[0]) return false;
  // 대표 보호자 «자기 자신»의 연결 행은 끊지 않는다(대표 권한은 parentId 라 끊어도 의미가 없고, 기록만 어긋난다)
  const target = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT a.id FROM "ParentStudentAccess" a
      WHERE a.id = $1 AND a."studentId" = $2 AND a.status = 'ACTIVE' AND a."userId" <> $3 LIMIT 1 FOR UPDATE`,
    accessId,
    studentId,
    userId,
  );
  if (!target[0]) return false;
  return revokeFamilyAccess(tx, studentId, accessId);
}
