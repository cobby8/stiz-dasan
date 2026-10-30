import "server-only";
import { prisma } from "@/lib/prisma";
import type { NativeFlow, NativeFlowStore } from "./service";

/** 서버 전용 연결만 사용하며 이 표는 공개 Data API에서 읽을 수 없다. */
export const postgresNativeFlowStore: NativeFlowStore = {
  async purgeExpired(now) {
    // 시작할 때 만료된 개발 원장을 최대 100행만 정리한다. 정시 삭제 예약을 대신하지는 않는다.
    await prisma.$executeRawUnsafe(`DELETE FROM "NativeAuthFlow" WHERE id IN (
      SELECT id FROM "NativeAuthFlow" WHERE "expiresAt"<=$1 OR (status='READY' AND "codeExpiresAt"<=$1)
      ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED)`,now);
  },
  async create(row) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "NativeAuthFlow" (id,platform,provider,challenge,state,"expiresAt",status)
       VALUES ($1,$2,$3,$4,$5,$6,'CREATED')`, row.id,row.platform,row.provider,row.challenge,row.state,row.expiresAt);
  },
  async read(id) {
    return (await prisma.$queryRawUnsafe<NativeFlow[]>(`SELECT * FROM "NativeAuthFlow" WHERE id=$1`,id))[0] ?? null;
  },
  async bindBrowser(id,browserHash,now) {
    return await prisma.$executeRawUnsafe(`UPDATE "NativeAuthFlow" SET status='BROWSER',"browserHash"=$2 WHERE id=$1 AND status='CREATED' AND "expiresAt">$3`,id,browserHash,now) === 1;
  },
  async ready(id,browserHash,codeHash,codeExpiresAt,sealedSession,now) {
    return await prisma.$executeRawUnsafe(`UPDATE "NativeAuthFlow" SET status='READY',"codeHash"=$3,"codeExpiresAt"=$4,"sealedSession"=$5
      WHERE id=$1 AND status='BROWSER' AND "browserHash"=$2 AND "expiresAt">$6`,id,browserHash,codeHash,codeExpiresAt,sealedSession,now) === 1;
  },
  async consume(id,challenge,state,codeHash,now) {
    const rows = await prisma.$queryRawUnsafe<NativeFlow[]>(
      `WITH claimed AS (
        SELECT * FROM "NativeAuthFlow" WHERE id=$1 AND status='READY' AND challenge=$2 AND state=$3
          AND "codeHash"=$4 AND "expiresAt">$5 AND "codeExpiresAt">$5 FOR UPDATE
       ) UPDATE "NativeAuthFlow" f SET status='CONSUMED',"sealedSession"=NULL,"codeHash"=NULL,"consumedAt"=$5
         FROM claimed WHERE f.id=claimed.id AND f.status='READY' RETURNING claimed.*`,id,challenge,state,codeHash,now);
    return rows[0] ?? null;
  },
  async cancel(id,challenge,state,now) {
    return await prisma.$executeRawUnsafe(`UPDATE "NativeAuthFlow" SET status='CANCELLED',"sealedSession"=NULL,"codeHash"=NULL
      WHERE id=$1 AND challenge=$2 AND state=$3 AND status IN ('CREATED','BROWSER','READY') AND "expiresAt">$4`,id,challenge,state,now) === 1;
  },
};

/** 전화·이메일·사용자 메타데이터로 학원 계정을 추측하지 않는다. */
export async function requireNativeAccount(authUserId: string) {
  const rows = await prisma.$queryRawUnsafe<{id:string;role:string;username:string|null;phoneVerifiedAt:Date|null}[]>(
    `SELECT id,role::text AS role,username,"phoneVerifiedAt" FROM "User"
      WHERE ("authUserId"=$1 OR ("authUserId" IS NULL AND id=$1))
        AND "withdrawnAt" IS NULL AND "withdrawRequestedAt" IS NULL LIMIT 2`,authUserId);
  if (rows.length !== 1 || !["ADMIN","VICE_ADMIN","INSTRUCTOR","DRIVER","PARENT"].includes(rows[0].role)) return false;
  return rows[0].role !== "PARENT" || rows[0].username === null || Boolean(rows[0].phoneVerifiedAt);
}
