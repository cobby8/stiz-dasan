import "server-only";
import { prisma } from "@/lib/prisma";
import type { ParentOAuthProvider } from "@/lib/parent-oauth";
import { LINK_HANDOFF_TTL_SECONDS, type LinkHandoffAccountRow } from "./rules";
import { linkHandoffTokenId, newLinkHandoffToken } from "./token";

/**
 * 앱 «연결하기» 1회용 표(AccountLinkHandoff) DB 연결부 — 서버 전용, raw SQL 만(PgBouncer).
 * 시간 판정은 전부 DB now() 로 한다(서버 시계·날짜 문자열을 믿지 않는다).
 */

export type LinkHandoffClaim = { authUserId: string; provider: ParentOAuthProvider };

/**
 * 제공자마다 1회용 표를 만들고 원문 토큰을 돌려준다(DB 에는 hash 만).
 * 같은 계정·제공자의 아직 안 쓴 표는 먼저 «쓴 것»으로 막는다 — 동시에 유효한 표는 제공자당 1개(검수 반영).
 * 발급할 때마다 만료된 행을 50개까지 정리한다(매일 정리는 data-retention 크론이 한다).
 */
export async function issueLinkHandoffs(
  authUserId: string,
  providers: readonly ParentOAuthProvider[],
): Promise<Partial<Record<ParentOAuthProvider, string>>> {
  if (providers.length === 0) return {};
  await prisma.$executeRawUnsafe(
    `DELETE FROM "AccountLinkHandoff" WHERE id IN (
       SELECT id FROM "AccountLinkHandoff" WHERE "expiresAt" <= now()
        ORDER BY "expiresAt" LIMIT 50 FOR UPDATE SKIP LOCKED)`,
  );
  const tokens = providers.map(() => newLinkHandoffToken());
  // 한 문장으로 «옛 표 막기 + 새 표 넣기»(연결 수 한도가 작아 줄마다 따로 보내지 않는다).
  // CTE 의 UPDATE 는 같은 문장의 새 행을 보지 않으므로 방금 넣는 표는 막히지 않는다.
  await prisma.$executeRawUnsafe(
    `WITH revoked AS (
       UPDATE "AccountLinkHandoff" SET "consumedAt" = now()
        WHERE "authUserId" = $3 AND provider = ANY($2::text[]) AND "consumedAt" IS NULL
        RETURNING id
     )
     INSERT INTO "AccountLinkHandoff" (id, "authUserId", provider, "expiresAt")
     SELECT t.id, $3, t.provider, now() + ($4::int * interval '1 second')
       FROM unnest($1::text[], $2::text[]) AS t(id, provider)`,
    tokens.map(linkHandoffTokenId),
    [...providers],
    authUserId,
    LINK_HANDOFF_TTL_SECONDS,
  );
  return Object.fromEntries(providers.map((provider, i) => [provider, tokens[i]]));
}

/**
 * 확인 화면용 «읽기만». 소비하지 않는다 — 카카오톡 링크 미리보기 같은 자동 열람이 표를 써 버리지 않게.
 * 지났거나 이미 쓰인 표는 null.
 */
export async function peekLinkHandoff(token: string): Promise<LinkHandoffClaim | null> {
  const rows = await prisma.$queryRawUnsafe<LinkHandoffClaim[]>(
    `SELECT "authUserId", provider FROM "AccountLinkHandoff"
      WHERE id = $1 AND "consumedAt" IS NULL AND "expiresAt" > now() LIMIT 1`,
    linkHandoffTokenId(token),
  );
  return rows[0] ?? null;
}

/**
 * 시작(POST) 때 «딱 한 번» 쓰기. 같은 표로 두 번 눌러도 한쪽만 성공한다(조건부 UPDATE 한 문장).
 */
export async function consumeLinkHandoff(token: string): Promise<LinkHandoffClaim | null> {
  const rows = await prisma.$queryRawUnsafe<LinkHandoffClaim[]>(
    `UPDATE "AccountLinkHandoff" SET "consumedAt" = now()
      WHERE id = $1 AND "consumedAt" IS NULL AND "expiresAt" > now()
      RETURNING "authUserId", provider`,
    linkHandoffTokenId(token),
  );
  return rows[0] ?? null;
}

/** 확인 화면에 가려서 보일 아이디·이름(앱 계정 기준 — 탈퇴 계정은 찾지 않는다) */
export async function linkHandoffAccountLabel(authUserId: string): Promise<{ username: string | null; name: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ username: string | null; name: string | null }>>(
    `SELECT username, name FROM "User"
      WHERE ("authUserId" = $1 OR ("authUserId" IS NULL AND id = $1))
        AND "withdrawnAt" IS NULL
      ORDER BY CASE WHEN "authUserId" = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    authUserId,
  );
  return rows[0] ?? null;
}

/**
 * 앱 연결 대상 계정 판정용 줄(검수 반영 — 발급·사용 두 곳 모두). 판정은 rules.isLinkHandoffEligible.
 * 로그인 id 가 직접 연결된 계정만 본다(selectLinkTarget 도 authUserId 가 있는 계정만 연결한다).
 */
export async function linkHandoffAccountRows(authUserId: string): Promise<LinkHandoffAccountRow[]> {
  return prisma.$queryRawUnsafe<LinkHandoffAccountRow[]>(
    `SELECT u.role::text AS role,
            EXISTS(SELECT 1 FROM "UserRoleGrant" g WHERE g."userId" = u.id AND g.status = 'ACTIVE') AS "hasActiveStaffGrant",
            u."phoneVerifiedAt", u."withdrawnAt", u."withdrawRequestedAt"
       FROM "User" u
      WHERE u."authUserId" = $1
      LIMIT 2`,
    authUserId,
  );
}
