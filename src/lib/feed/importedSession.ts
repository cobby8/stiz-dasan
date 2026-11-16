/**
 * 이관 수업 판정(2026-11-16 원장 결정 — 랠리즈 2026 수업 피드 이관, «학부모 알림 금지»).
 *
 * 랠리즈에서 옮긴 글·사진·영상이 들어간 수업은 Session."importSource" = 'RALLYZ_FEED' 로 표시된다
 * (scripts/rallyz-feed-import 가 표시, 마이그레이션 20261116500000_rallyz_feed_import).
 * 이런 수업은 몇 달 전 수업이라, 관리자·선생님이 «발행»을 눌러도 «수업 리포트가 발행되었습니다» 알림을
 * 보내지 않는다. 발행 경로가 둘(관리자 publishSessionReport · 선생님 publishStaffSessionReport)이라
 * 둘 다 이 파일 하나를 쓴다 — 한쪽만 막으면 다른 쪽에서 알림이 샌다.
 *
 * 칸이 아직 없는 DB(마이그레이션 전)에서는 조회가 실패한다 → «이관 아님»으로 본다.
 * 그때는 이관 수업이 존재할 수 없으므로(스크립트가 이 칸에 쓴다) 알림을 막을 이유도 없다.
 */
import { prisma } from "@/lib/prisma";

/** DB CHECK(Session_importSource_check)와 같은 값 — tests/rallyz-feed-import.test.mjs 가 비교한다 */
export const IMPORT_SOURCE_RALLYZ_FEED = "RALLYZ_FEED";
export const SESSION_IMPORT_SOURCES = [IMPORT_SOURCE_RALLYZ_FEED] as const;

/** 순수 판정 — 이관 표시가 있으면 발행 알림을 보내지 않는다 */
export function skipsPublishNotice(importSource: string | null | undefined): boolean {
  return typeof importSource === "string" && (SESSION_IMPORT_SOURCES as readonly string[]).includes(importSource);
}

/** 이 수업이 이관 수업인가(발행 알림 건너뛰기). 조회 실패 = 이관 아님 */
export async function isImportedSessionForNotice(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ importSource: string | null }>>(
      `SELECT "importSource" FROM "Session" WHERE id = $1 LIMIT 1`,
      sessionId,
    );
    return skipsPublishNotice(rows[0]?.importSource ?? null);
  } catch {
    return false;
  }
}
