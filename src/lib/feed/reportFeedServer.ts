/**
 * 학부모 «수업 리포트 피드» 서버 조회(2026-11-14 원장 요청) — 화면(/mypage/reports/feed)과
 * 다음 장 라우트(/api/mypage/report-feed)가 **이 파일 하나**를 쓴다.
 *
 * 공개 기준은 새로 만들지 않는다 — 소식 목록·상세·사진·영상과 같은 문장(@/lib/feed/rules):
 *   feedVisibleSessionSql(끝났고 발행된 수업) + feedParticipantSql(내 아이가 참여한 수업).
 * IDOR: 아이는 로그인한 보호자(appUserId) 쪽에서만 찾는다(childAccessSql). 주소에서 온 수업 id·커서는
 *       «어디서부터 볼지»만 정할 뿐, 볼 수 있는 범위를 넓히지 못한다.
 *
 * 오류 방지(원장 «오류가 안 나도록»): 목록 본체가 실패하면 그대로 던진다(호출부가 «다시 불러오기»).
 * 사진·출결 같은 부가 조회는 실패해도 그 칸만 null(화면이 그 칸에 «다시 불러오기»)이고 피드는 보인다.
 */
import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { classCoachNameSql, feedParticipantSql, feedVisibleSessionSql, sessionKstDateSql, type FeedPhotoView } from "@/lib/feed/rules";
import { countSessionVideos, listViewableSessionPhotos } from "@/lib/feed/server";
import {
  REPORT_FEED_START_MAX,
  clampReportFeedLimit,
  nextReportFeedCursor,
  type ReportFeedCursor,
} from "@/lib/feed/reportFeedRules";

/** 화면으로 넘기는 게시물 하나(수업 1회) — 직렬화 가능한 값만 */
export type ReportFeedPost = {
  id: string;
  /** 수업일(KST "YYYY-MM-DD") */
  ymd: string;
  className: string;
  startTime: string | null;
  coachName: string | null;
  topic: string | null;
  content: string | null;
  /** 볼 수 있는 사진. null = 사진 조회 실패(그 칸만 «다시 불러오기») */
  photos: FeedPhotoView[] | null;
  videoCount: number;
  /** 이 수업에 참여한 내 아이와 출결. null = 출결 조회 실패(그 칸은 비워 둠) */
  children: Array<{ id: string; name: string; status: string | null }> | null;
};

export type ReportFeedPage = { posts: ReportFeedPost[]; nextCursor: string | null };

type BaseRow = {
  id: string; classId: string; ymd: string; className: string; startTime: string | null;
  coachName: string | null; topic: string | null; content: string | null; photosJSON: string | null;
};

type Range =
  | { kind: "before"; cursor: ReportFeedCursor | null } // 커서보다 오래된 것(없으면 맨 위부터)
  | { kind: "atOrAfter"; cursor: ReportFeedCursor } // 이 수업과 그보다 최신 것(?start= 처음 장)
  | { kind: "one"; sessionId: string }; // 수업 하나(그 게시물만 다시 불러오기)

/**
 * 공개 + 내 아이 참여 수업을 (수업일 내림차순, id 내림차순)으로.
 * 값은 전부 $n 바인딩 — SQL 문장에는 별칭·고정 문장만 들어간다.
 */
async function queryVisibleSessions(appUserId: string, range: Range, limit: number): Promise<BaseRow[]> {
  const day = sessionKstDateSql("se");
  const params: unknown[] = [appUserId];
  let rangeSql = "";
  if (range.kind === "before" && range.cursor) {
    params.push(range.cursor.ymd, range.cursor.id);
    rangeSql = `AND (${day}, se.id) < ($2::date, $3::text)`;
  } else if (range.kind === "atOrAfter") {
    params.push(range.cursor.ymd, range.cursor.id);
    rangeSql = `AND (${day}, se.id) >= ($2::date, $3::text)`;
  } else if (range.kind === "one") {
    params.push(range.sessionId);
    rangeSql = `AND se.id = $2`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;
  return prisma.$queryRawUnsafe<BaseRow[]>(
    `SELECT se.id, se."classId", ${day}::text AS ymd, c.name AS "className", c."startTime",
            ${classCoachNameSql("se", "c")} AS "coachName", se.topic, se.content, se."photosJSON"
       FROM "Session" se
       JOIN "Class" c ON c.id = se."classId"
      WHERE ${feedVisibleSessionSql("se")}
        AND EXISTS (
          SELECT 1 FROM "Student" st
           WHERE ${await childAccessSql("st", "$1")} AND ${notMergedStudent("st")} AND ${feedParticipantSql("st", "se")}
        )
        ${rangeSql}
      ORDER BY ${day} DESC, se.id DESC
      LIMIT ${limitParam}::int`,
    ...params,
  );
}

/** 이 수업들에 참여한 내 아이와 출결(아이는 보호자 쪽에서만 찾는다) */
async function queryChildrenAttendance(appUserId: string, sessionIds: string[]) {
  if (sessionIds.length === 0) return [];
  return prisma.$queryRawUnsafe<Array<{ sessionId: string; studentId: string; name: string; status: string | null }>>(
    `SELECT se.id AS "sessionId", st.id AS "studentId", st.name,
            (SELECT a.status::text FROM "Attendance" a WHERE a."sessionId" = se.id AND a."studentId" = st.id LIMIT 1) AS status
       FROM "Student" st
       JOIN "Session" se ON se.id = ANY($2::text[]) AND ${feedParticipantSql("st", "se")}
      WHERE ${await childAccessSql("st", "$1")} AND ${notMergedStudent("st")}
      ORDER BY st.name ASC`,
    appUserId,
    sessionIds,
  );
}

/** 목록 행에 사진·영상 수·출결을 붙인다. 부가 조회는 하나가 실패해도 나머지는 그대로 */
async function decorate(appUserId: string, rows: BaseRow[]): Promise<ReportFeedPost[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [photos, videos, attendance] = await Promise.all([
    listViewableSessionPhotos(rows.map((r) => ({ id: r.id, classId: r.classId, photosJSON: r.photosJSON })))
      .catch((error) => { console.error("[report-feed] 사진 조회 실패:", error); return null; }),
    // countSessionVideos 는 스스로 실패를 0 으로 바꾼다 — 그래도 한 번 더 감싼다(영상 칸만 빠지게)
    countSessionVideos(ids).catch((error) => { console.error("[report-feed] 영상 수 조회 실패:", error); return new Map<string, number>(); }),
    queryChildrenAttendance(appUserId, ids)
      .catch((error) => { console.error("[report-feed] 출결 조회 실패:", error); return null; }),
  ]);
  return rows.map((r) => ({
    id: r.id,
    ymd: r.ymd,
    className: r.className,
    startTime: r.startTime ?? null,
    coachName: r.coachName ?? null,
    topic: r.topic?.trim() || null,
    content: r.content?.trim() || null,
    photos: photos ? photos.get(r.id) ?? [] : null,
    videoCount: videos.get(r.id) ?? 0,
    children: attendance
      ? attendance.filter((a) => a.sessionId === r.id).map((a) => ({ id: a.studentId, name: a.name, status: a.status }))
      : null,
  }));
}

/**
 * 피드 한 장 — 커서(없으면 맨 위)보다 오래된 게시물 limit 개.
 * appUserId 는 호출부가 requireVerifiedParent() 로 확인한 값만 넘긴다.
 */
export async function loadReportFeedPage(appUserId: string, cursor: ReportFeedCursor | null, rawLimit?: unknown): Promise<ReportFeedPage> {
  if (!appUserId) return { posts: [], nextCursor: null };
  const limit = clampReportFeedLimit(rawLimit);
  const rows = await queryVisibleSessions(appUserId, { kind: "before", cursor }, limit);
  const posts = await decorate(appUserId, rows);
  return { posts, nextCursor: nextReportFeedCursor(posts, limit) };
}

/**
 * ?start=<수업 id> 로 들어온 처음 장 — 맨 위(최신)부터 그 수업까지 + 그 뒤로 한 장이 차도록.
 * 볼 수 없는 수업(남의 수업·미발행·없는 id)이거나 너무 멀면(200개 넘게 위) null → 호출부가 그냥 맨 위부터.
 */
export async function loadReportFeedFromStart(appUserId: string, startSessionId: string, rawLimit?: unknown): Promise<ReportFeedPage | null> {
  if (!appUserId || !startSessionId) return null;
  const limit = clampReportFeedLimit(rawLimit);
  // 1) 그 수업이 «이 보호자가 볼 수 있는 수업»인지 — 같은 공개 기준으로 한 줄만
  const [start] = await queryVisibleSessions(appUserId, { kind: "one", sessionId: startSessionId }, 1);
  if (!start) return null;
  // 2) 맨 위부터 그 수업까지(그 수업 포함)
  const upTo = await queryVisibleSessions(appUserId, { kind: "atOrAfter", cursor: { ymd: start.ymd, id: start.id } }, REPORT_FEED_START_MAX + 1);
  if (upTo.length > REPORT_FEED_START_MAX) return null;
  // 3) 그 수업 아래로 한 장(아래로 이어 볼 수 있게)
  const below = await queryVisibleSessions(appUserId, { kind: "before", cursor: { ymd: start.ymd, id: start.id } }, limit);
  const posts = await decorate(appUserId, [...upTo, ...below]);
  return { posts, nextCursor: below.length < limit ? null : nextReportFeedCursor(posts, posts.length) };
}

/** 게시물 하나만 다시(사진 칸 «다시 불러오기») — 볼 수 없는 수업이면 null */
export async function loadReportFeedPost(appUserId: string, sessionId: string): Promise<ReportFeedPost | null> {
  if (!appUserId || !sessionId) return null;
  const rows = await queryVisibleSessions(appUserId, { kind: "one", sessionId }, 1);
  const [post] = await decorate(appUserId, rows);
  return post ?? null;
}
