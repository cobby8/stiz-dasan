/**
 * 학부모 «지난 공지» 목록 조회 (2026-11-14 원장 결정표 c10).
 *
 * 소식 탭은 최근 3개월·10건만 보인다(getNoticesByClassIds). 이 함수는 «볼 수 있는 공지 전부»의 제목 줄만 읽는다.
 * - 본문(content)·첨부는 읽지 않는다(목록에 필요 없고 무겁다). 상세는 /mypage/news/[id] 가 따로 읽는다.
 * - «우리 아이 반» 판정은 SQL 이 아니라 코드에서 한다 — 대상 반 칸에 두 가지 모양(쉼표 글·JSON 배열)이 섞여 있어
 *   공용 파서(parseNoticeTargetClassIds) 한 곳으로 읽어야 한다. 그래서 쪽 나눔도 거른 «뒤»에 한다
 *   (SQL LIMIT 로 먼저 자르면 남의 반 공지가 끼어 쪽마다 건수가 달라진다).
 */
import { prisma } from "@/lib/prisma";
import { parseNoticeTargetClassIds } from "@/lib/noticeTargets";
import { noticeVisibleToClasses } from "@/lib/mypage/parentSchedule";

export type ParentNoticeLine = { id: string; title: string; isPinned: boolean; createdAt: string };

/** 한 번에 읽는 상한 — 공지가 이보다 많아질 일은 없지만 화면이 멈추지 않게 둔다 */
const NOTICE_INDEX_LIMIT = 2000;

/** 이 학부모가 볼 수 있는 공지 전부(최신순). classIds = 우리 아이들이 다니는 반 */
export async function listParentNoticeLines(classIds: readonly string[]): Promise<ParentNoticeLine[]> {
    const rows = await prisma.$queryRawUnsafe<{ id: string; title: string; targetType: string | null; targetClassIds: string | null; isPinned: boolean | null; createdAt: Date | string }[]>(
        `SELECT id, title, "targetType", "targetClassIds", "isPinned", "createdAt"
           FROM "Notice"
          WHERE "targetType" IN ('ALL', 'CLASS')
          ORDER BY "createdAt" DESC, id
          LIMIT $1`,
        NOTICE_INDEX_LIMIT,
    );
    const mine = new Set(classIds);
    return rows
        .filter((row) => noticeVisibleToClasses({ targetType: row.targetType ?? "ALL", targetClassIds: parseNoticeTargetClassIds(row.targetClassIds) }, mine))
        .map((row) => ({
            id: row.id,
            title: row.title,
            isPinned: row.isPinned === true,
            createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
        }));
}
