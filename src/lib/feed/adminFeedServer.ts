/**
 * 관리자 «수업 피드» 조회(2026-11-14 원장 승인 · 같은 날 인스타식 스크롤로 개편).
 * - 페이지 단위(20개 + 다음 커서)로 읽고, 필터(기간·선생님·요일·반·발행·내용 없음)는 전부 SQL 에서 건다.
 * - 사진·영상 개수는 학부모 피드와 같은 함수(listViewableSessionPhotos·countSessionVideos)로 세서,
 *   관리자가 보는 숫자 = 학부모가 실제로 열 수 있는 숫자다.
 *
 * 🔒 호출하는 쪽(화면·API)에서 반드시 관리자 확인(requireAdmin)을 먼저 한다.
 * 🔒 사용자 입력은 normalizeAdminFeedFilter·decodeAdminFeedCursor 로 모양을 거른 뒤 «바인딩 값($n)»으로만 넣는다.
 *    SQL 문장에 붙는 것은 이 파일에 적힌 고정 조각뿐이다.
 */
import { prisma } from "@/lib/prisma";
import { listViewableSessionPhotos, countSessionVideos } from "@/lib/feed/server";
import { classCoachNameSql, sessionKstDateSql, TODAY_KST_SQL, type FeedPhotoView } from "@/lib/feed/rules";
import {
  ADMIN_FEED_PAGE_SIZE,
  NO_TEACHER_LABEL,
  PHOTO_PREVIEW_LIMIT,
  splitAdminFeedPage,
  type AdminFeedCursor,
  type AdminFeedFacets,
  type AdminFeedFilter,
  type AdminFeedItem,
} from "@/lib/feed/adminFeedRules";

type FeedRow = {
  id: string; classId: string; ymd: string; className: string; startTime: string | null; endTime: string | null;
  teacherName: string | null; endedByName: string | null; content: string | null; topic: string | null;
  status: string; published: boolean | null; photosJSON: string | null;
};

const SESSION_DATE = sessionKstDateSql("se");

// 공통 FROM — 담당 선생님 이름은 LATERAL 로 한 번만 계산해 SELECT·WHERE 가 같이 쓴다
const FEED_FROM = `
       FROM "Session" se
       JOIN "Class" c ON c.id = se."classId"
       CROSS JOIN LATERAL (SELECT NULLIF(BTRIM(${classCoachNameSql("se", "c")}), '') AS name) t
       LEFT JOIN "User" eu ON eu.id = se."endedByUserId"`;

const FEED_SELECT = `SELECT se.id, se."classId", ${SESSION_DATE}::text AS ymd,
            c.name AS "className", c."startTime", c."endTime",
            t.name AS "teacherName",
            eu.name AS "endedByName",
            se.content, se.topic, se.status, se.published, se."photosJSON"`;

// 피드에 오르는 수업 = 진행 중이거나 끝난 수업
const FEED_STATUS = `se.status IN ('IN_PROGRESS', 'COMPLETED')`;

// «내용 있음» = 한 줄이 비어 있지 않음 OR 사진 목록이 비어 있지 않음 OR 등록된 영상 있음(hasFeedContent 와 같은 문장)
const HAS_CONTENT_SQL = `(
         NULLIF(BTRIM(COALESCE(se.content, '')), '') IS NOT NULL
         OR BTRIM(COALESCE(se."photosJSON", '')) NOT IN ('', '[]', 'null')
         OR EXISTS (SELECT 1 FROM "SessionVideo" v
                     WHERE v."sessionId" = se.id AND v."registeredAt" IS NOT NULL AND v."deletedAt" IS NULL)
       )`;

// 정렬 키 — adminFeedRules 의 커서(수업일·시작 시각·id 모두 내림차순)와 같은 세 값
const ORDER_KEY = `${SESSION_DATE}, COALESCE(c."startTime", ''), se.id`;

/** 필터·커서 → WHERE 조각과 바인딩 값. 값은 전부 params 로만 들어간다 */
function buildFeedWhere(filter: AdminFeedFilter, cursor: AdminFeedCursor | null): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where: string[] = [
    FEED_STATUS,
    `${SESSION_DATE} BETWEEN ${TODAY_KST_SQL} - ${bind(filter.days)}::int AND ${TODAY_KST_SQL}`,
  ];
  if (filter.publish === "PUBLISHED") where.push(`se.published = true`);
  if (filter.publish === "DRAFT") where.push(`COALESCE(se.published, false) = false`);
  // 요일 — PostgreSQL DOW 도 0=일 … 6=토(feedWeekday 와 같은 번호). KST 달력 날짜에서 바로 뽑는다
  if (filter.weekday >= 0) where.push(`EXTRACT(DOW FROM ${SESSION_DATE})::int = ${bind(filter.weekday)}::int`);
  if (filter.classId) where.push(`se."classId" = ${bind(filter.classId)}`);
  if (filter.teacher === NO_TEACHER_LABEL) where.push(`t.name IS NULL`);
  else if (filter.teacher) where.push(`t.name = ${bind(filter.teacher)}`);
  if (!filter.includeEmpty) where.push(HAS_CONTENT_SQL);
  if (cursor) {
    where.push(`(${ORDER_KEY}) < (${bind(cursor.ymd)}::date, ${bind(cursor.startTime)}::text, ${bind(cursor.id)}::text)`);
  }
  return { where: where.join("\n        AND "), params };
}

/** DB 행 → 화면 게시물(학부모가 열 수 있는 사진·영상 개수 포함) */
async function toFeedItems(rows: FeedRow[]): Promise<AdminFeedItem[]> {
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
      classId: r.classId,
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

/** 피드 한 장(20개) + 다음 커서. 다음이 없으면 nextCursor = null */
export async function getAdminFeedPage(
  filter: AdminFeedFilter,
  cursor: AdminFeedCursor | null,
): Promise<{ items: AdminFeedItem[]; nextCursor: string | null }> {
  const { where, params } = buildFeedWhere(filter, cursor);
  // 한 개 더 읽어 «다음이 있나»를 안다
  const rows = await prisma.$queryRawUnsafe<FeedRow[]>(
    `${FEED_SELECT}
${FEED_FROM}
      WHERE ${where}
      ORDER BY ${SESSION_DATE} DESC, COALESCE(c."startTime", '') DESC, se.id DESC
      LIMIT ${ADMIN_FEED_PAGE_SIZE + 1}`,
    ...params,
  );
  const page = splitAdminFeedPage(rows.map((r) => ({ ...r, sessionId: r.id })));
  return { items: await toFeedItems(page.items), nextCursor: page.nextCursor };
}

/** 게시물 하나 다시 읽기(편집 패널에서 저장·발행한 뒤 카드 갱신용). 없으면 null */
export async function getAdminFeedItem(sessionId: string): Promise<AdminFeedItem | null> {
  if (!sessionId) return null;
  const rows = await prisma.$queryRawUnsafe<FeedRow[]>(
    `${FEED_SELECT}
${FEED_FROM}
      WHERE se.id = $1
      LIMIT 1`,
    sessionId,
  );
  return (await toFeedItems(rows))[0] ?? null;
}

/** 필터 모달의 선생님·반 목록 — 그 기간에 피드에 오른 수업 기준(다른 필터와 무관) */
export async function getAdminFeedFacets(days: number): Promise<AdminFeedFacets> {
  const period = `${FEED_STATUS} AND ${SESSION_DATE} BETWEEN ${TODAY_KST_SQL} - $1::int AND ${TODAY_KST_SQL}`;
  const [teacherRows, classRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ name: string | null }>>(
      `SELECT DISTINCT t.name ${FEED_FROM} WHERE ${period}`,
      days,
    ),
    prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT DISTINCT c.id, c.name FROM "Session" se JOIN "Class" c ON c.id = se."classId" WHERE ${period} ORDER BY c.name ASC`,
      days,
    ),
  ]);
  const names = teacherRows.map((r) => r.name?.trim() || "").filter(Boolean).sort((a, b) => a.localeCompare(b, "ko"));
  if (teacherRows.some((r) => !r.name?.trim())) names.push(NO_TEACHER_LABEL);
  return { teachers: [...new Set(names)], classes: classRows };
}
