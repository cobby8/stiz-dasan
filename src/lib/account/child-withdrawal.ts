import type { Prisma } from "@prisma/client";

/** 기능이 꺼져도 이미 수집한 연결 원장의 개인정보는 실제 탈퇴 거래에서 함께 정리한다. */
export async function anonymizeChildConnections(tx: Prisma.TransactionClient, userId: string) {
  const rows=await tx.$queryRawUnsafe<{ access: boolean; challenge: boolean; request: boolean }[]>(`SELECT
    to_regclass('public."ParentStudentAccess"') IS NOT NULL AS access,
    to_regclass('public."ChildIdentityChallenge"') IS NOT NULL AS challenge,
    to_regclass('public."ChildLinkRequest"') IS NOT NULL AS request`);
  if(rows[0]?.access) await tx.$executeRawUnsafe(`UPDATE "ParentStudentAccess" SET status='REVOKED',"updatedAt"=NOW()
    WHERE "userId"=$1 AND status='ACTIVE'`,userId);
  if(rows[0]?.request) {
    // 본인이 신청한 행의 이름·끝자리만 익명화한다. 다른 사람의 이름을 임의로 지우지 않는다.
    await tx.$executeRawUnsafe(`UPDATE "ChildLinkRequest" SET "requesterName"='탈퇴한 회원',"requesterPhoneLast4"='',
      status=CASE WHEN status='PENDING' THEN 'CANCELED' ELSE status END,
      "decidedAt"=CASE WHEN status='PENDING' THEN NOW() ELSE "decidedAt" END
      WHERE "requesterId"=$1`,userId);
    await tx.$executeRawUnsafe(`UPDATE "ChildLinkRequest" SET status='CANCELED',"decidedAt"=NOW()
      WHERE "approverId"=$1 AND status='PENDING'`,userId);
  }
  if(rows[0]?.challenge) await tx.$executeRawUnsafe(`UPDATE "ChildIdentityChallenge" SET "verifiedName"=NULL,"phoneHash"=NULL,
    "phoneLast4"=NULL,"birthHash"=NULL,"proofUsedAt"=NOW(),"proofExpiresAt"=NOW(),"expiresAt"=NOW()
    WHERE "userId"=$1`,userId);
}
