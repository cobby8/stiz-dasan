import { prisma } from "@/lib/prisma";
import type { NativePushPlatform } from "@/lib/push/nativePushPolicy";

/**
 * 스토어 앱 푸시 토큰 표(NativePushToken) 읽기·지우기 — 발송·탈퇴·로그아웃이 함께 쓴다(e2, 2026-11-14).
 * PgBouncer 트랜잭션 모드라 raw SQL 만 쓴다.
 *
 * ⚠️ 표가 아직 없는 DB(마이그레이션 적용 전 배포)에서도 웹푸시·탈퇴가 멈추지 않게,
 *    읽기 실패는 «앱 토큰 0개»로, 탈퇴 정리는 표가 있을 때만 지운다.
 */

export type NativeTokenRow = { id: string; userId?: string; platform: NativePushPlatform; token: string };

type RawDb = {
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
};

/** 이 사람의 앱 토큰(ids 가 있으면 그 줄만 — 부분 실패 재시도용) */
export async function listNativeTokensForUser(userId: string, ids: string[] | null): Promise<NativeTokenRow[]> {
  if (ids && ids.length === 0) return [];
  try {
    return await prisma.$queryRawUnsafe<NativeTokenRow[]>(
      `SELECT id, platform, token FROM "NativePushToken"
       WHERE "userId" = $1 AND ($2::text[] IS NULL OR id = ANY($2::text[]))`,
      userId,
      ids,
    );
  } catch (error) {
    console.error("Native push token lookup failed:", error instanceof Error ? error.message : "UNKNOWN");
    return [];
  }
}

/** 학부모 전원의 앱 토큰(전체 공지) — 웹푸시의 sendPushToAllParents 와 같은 대상(role = PARENT) */
export async function listNativeTokensForParents(): Promise<NativeTokenRow[]> {
  try {
    return await prisma.$queryRawUnsafe<NativeTokenRow[]>(
      `SELECT t.id, t."userId", t.platform, t.token
       FROM "NativePushToken" t
       JOIN "User" u ON u.id = t."userId"
       WHERE u.role = 'PARENT'`,
    );
  } catch (error) {
    console.error("Parent native push token lookup failed:", error instanceof Error ? error.message : "UNKNOWN");
    return [];
  }
}

/** 죽은 토큰(FCM UNREGISTERED 등) 정리 */
export async function deleteNativeToken(id: string): Promise<boolean> {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "NativePushToken" WHERE id = $1`, id);
    return true;
  } catch (error) {
    console.error("Expired native push token cleanup failed:", error instanceof Error ? error.message : "UNKNOWN");
    return false;
  }
}

/**
 * 탈퇴: 이 사람의 앱 토큰을 모두 지운다. 탈퇴 거래(tx) 안에서 부른다.
 * 표가 없으면(마이그레이션 전) 아무것도 하지 않는다 — 실패한 문장이 거래 전체를 무르지 않게 먼저 확인한다.
 */
export async function deleteNativePushTokensOfUser(db: RawDb, userId: string): Promise<void> {
  const exists = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT to_regclass('public."NativePushToken"') IS NOT NULL AS ok`,
  );
  if (!exists[0]?.ok) return;
  await db.$executeRawUnsafe(`DELETE FROM "NativePushToken" WHERE "userId" = $1`, userId);
}
