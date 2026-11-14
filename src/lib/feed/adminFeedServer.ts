/**
 * 관리자 «수업 피드» 조회(2026-11-14 원장 승인) — 최근 N일 수업과 그 수업의 한 줄·사진·영상 개수.
 * 사진·영상 개수는 학부모 피드와 같은 함수(listViewableSessionPhotos·countSessionVideos)로 세서,
 * 관리자가 보는 숫자 = 학부모가 실제로 열 수 있는 숫자다.
 *
 * 호출하는 쪽(화면)에서 반드시 관리자 확인(requireAdmin)을 먼저 한다.
 */
import { prisma } from "@/lib/prisma";
import { listViewableSessionPhotos, countSessionVideos } from "@/lib/feed/server";
import { classCoachNameSql, sessionKstDateSql, TODAY_KST_SQL, type FeedPhotoView } from "@/lib/feed/rules";
import { normalizeFeedDays, PHOTO_PREVIEW_LIMIT, type AdminFeedItem } from "@/lib/feed/adminFeedRules";

const MAX_ROWS = 600;

export async function getAdminFeedItems(daysInput: unknown): Promise<AdminFeedItem[]> {
  const days = normalizeFeedDays(daysInput);
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; classId: string; ymd: string; className: string; startTime: string | null; endTime: string | null;
    teacherName: string | null; endedByName: string | null; content: string | null; topic: string | null;
    status: string; published: boolean | null; photosJSON: string | null;
  }>>(
    `SELECT se.id, se."classId", ${sessionKstDateSql("se")}::text AS ymd,
            c.name AS "className", c."startTime", c."endTime",
            ${classCoachNameSql("se", "c")} AS "teacherName",
            eu.name AS "endedByName",
            se.content, se.topic, se.status, se.published, se."photosJSON"
       FROM "Session" se
       JOIN "Class" c ON c.id = se."classId"
       LEFT JOIN "User" eu ON eu.id = se."endedByUserId"
      WHERE se.status IN ('IN_PROGRESS', 'COMPLETED')
        AND ${sessionKstDateSql("se")} BETWEEN ${TODAY_KST_SQL} - $1::int AND ${TODAY_KST_SQL}
      ORDER BY ${sessionKstDateSql("se")} DESC, c."startTime" DESC NULLS LAST, c.name ASC
      LIMIT ${MAX_ROWS}`,
    days,
  );
  if (rows.length === 0) return [];
  const sessions = rows.map((r) => ({ id: r.id, classId: r.classId, photosJSON: r.photosJSON }));
  const [photos, videos] = await Promise.all([
    listViewableSessionPhotos(sessions).catch(() => new Map<string, FeedPhotoView[]>()),
    countSessionVideos(sessions.map((s) => s.id)),
  ]);
  return rows.map((r) => {
    const sessionPhotos = photos.get(r.id) ?? [];
    return {
      sessionId: r.id,
      ymd: r.ymd,
      className: r.className,
      startTime: r.startTime,
      endTime: r.endTime,
      teacherName: r.teacherName?.trim() || null,
      endedByName: r.endedByName?.trim() || null,
      content: r.content?.trim() || null,
      topic: r.topic?.trim() || null,
      status: r.status,
      published: r.published === true,
      photoCount: sessionPhotos.length,
      videoCount: videos.get(r.id) ?? 0,
      photos: sessionPhotos.slice(0, PHOTO_PREVIEW_LIMIT).map((p) => p.src),
    };
  });
}
