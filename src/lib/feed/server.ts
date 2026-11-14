/**
 * 수업 피드 서버 공용(2026-11-14 원장 결정) — 학부모 «볼 수 있는가» 판정과 피드 데이터 조회.
 *
 * 사진 보기 라우트·영상 라우트·소식 목록·소식 상세·홈 카드가 **이 파일 하나**를 쓴다.
 * 예전엔 리포트는 출결(Attendance) 기준, 사진은 수강(Enrollment)+동의 기준, 영상은 둘 다 기준으로
 * 갈라져 있어 «리포트는 보이는데 사진은 403» 같은 어긋남이 났다.
 * 기준 문장은 순수 모듈 rules.ts(feedVisibleSessionSql·feedParticipantSql)에 있다.
 *
 * IDOR: sessionId·photoId 는 주소에서 오지만, 학생은 로그인한 보호자(appUserId) 쪽에서만 찾는다.
 */
import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { profilePhotoUpdatedAtSql, profilePhotoVersion } from "@/lib/profilePhoto/rules";
import { isValidPrivateSessionPhotoRef } from "@/lib/sessionPhotoStorage";
import { parseStoredSessionPhotos, toSessionReportPhotoViews } from "@/lib/sessionPhotoEntries";
import {
  classCoachNameSql,
  feedParticipantSql,
  feedVisibleSessionSql,
  sessionKstDateSql,
  selectViewablePhotos,
  type FeedCandidate,
  type FeedPhotoView,
} from "@/lib/feed/rules";

export type ParentFeedSession = {
  id: string;
  classId: string;
  /** 수업일(KST "YYYY-MM-DD") */
  ymd: string;
  topic: string | null;
  content: string | null;
  photosJSON: string | null;
  className: string;
  dayOfWeek: string | null;
  startTime: string | null;
  endTime: string | null;
  programName: string | null;
  coachName: string | null;
};

/**
 * 이 보호자가 볼 수 있는 수업이면 수업 정보 + «참여한 내 아이» 목록, 아니면 null.
 * null 의 이유(없는 수업·미발행·남의 수업)는 구분하지 않는다 — 다른 수업 ID 가 있는지 떠볼 수 없게.
 */
export async function loadParentViewableSession(
  appUserId: string,
  sessionId: string,
): Promise<{ session: ParentFeedSession; children: Array<{ id: string; name: string; photoVersion?: string | null }> } | null> {
  if (!appUserId || !sessionId) return null;
  const sessions = await prisma.$queryRawUnsafe<ParentFeedSession[]>(
    `SELECT se.id, se."classId", ${sessionKstDateSql("se")}::text AS ymd, se.topic, se.content, se."photosJSON",
            c.name AS "className", c."dayOfWeek", c."startTime", c."endTime",
            p.name AS "programName", ${classCoachNameSql("se", "c")} AS "coachName"
       FROM "Session" se
       JOIN "Class" c ON c.id = se."classId"
       LEFT JOIN "Program" p ON p.id = c."programId"
      WHERE se.id = $1 AND ${feedVisibleSessionSql("se")}
      LIMIT 1`,
    sessionId,
  );
  const session = sessions[0];
  if (!session) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; photoUpdatedAt?: Date | string | null }>>(
    // 프로필 사진 바꾼 시각(사진 있을 때만) — 리포트 상세의 아이 이름 옆 사진 캐시 버전(2026-11-14)
    `SELECT st.id, st.name, ${profilePhotoUpdatedAtSql("st")} AS "photoUpdatedAt"
       FROM "User" u
       JOIN "Student" st ON ${await childAccessSql("st", 'u."id"')} AND ${notMergedStudent("st")}
       JOIN "Session" se ON se.id = $2
      WHERE u.id = $1 AND ${feedParticipantSql("st", "se")}
      ORDER BY st.name ASC`,
    appUserId,
    sessionId,
  );
  if (rows.length === 0) return null;
  const children = rows.map((row) => ({ id: row.id, name: row.name, photoVersion: profilePhotoVersion(row.photoUpdatedAt ?? null) }));
  return { session, children };
}

/** 보호자가 이 수업의 사진·영상을 볼 수 있나(사진 라우트·영상 라우트 공용) */
export async function parentCanViewSession(appUserId: string, sessionId: string): Promise<boolean> {
  return (await loadParentViewableSession(appUserId, sessionId)) !== null;
}

/** 사진 원장(SocialPostDraft)에 실제로 있는 이 수업의 비공개 사진 id — 사진 라우트가 여는 것과 같은 집합 */
async function availablePrivatePhotoIds(sessionIds: string[], classIdBySession: Map<string, string>): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (sessionIds.length === 0) return result;
  const drafts = await prisma.$queryRawUnsafe<Array<{ sessionId: string; mediaJSON: string }>>(
    `SELECT "sessionId", "mediaJSON" FROM "SocialPostDraft" WHERE "sessionId" = ANY($1::text[])`,
    sessionIds,
  );
  for (const draft of drafts) {
    const classId = classIdBySession.get(draft.sessionId);
    if (!classId) continue;
    const ids = result.get(draft.sessionId) ?? new Set<string>();
    for (const photo of parseStoredSessionPhotos(draft.mediaJSON)) {
      if (isValidPrivateSessionPhotoRef(photo as unknown as Record<string, unknown>, { classId, sessionId: draft.sessionId })) ids.add(photo.id);
    }
    result.set(draft.sessionId, ids);
  }
  return result;
}

/**
 * 여러 수업의 «학부모가 실제로 열 수 있는 사진» — 수업 기록(photosJSON) 순서대로.
 * 사진 보기 라우트(/api/staff/sessions/[id]/photos/[photoId])가 여는 것과 같은 집합이라 헛요청이 없다.
 */
export async function listViewableSessionPhotos(
  sessions: Array<{ id: string; classId: string; photosJSON: string | null }>,
): Promise<Map<string, FeedPhotoView[]>> {
  const classIdBySession = new Map(sessions.map((s) => [s.id, s.classId]));
  const available = await availablePrivatePhotoIds(sessions.map((s) => s.id), classIdBySession);
  const result = new Map<string, FeedPhotoView[]>();
  for (const s of sessions) {
    const srcs = toSessionReportPhotoViews(s.photosJSON, s.id).map((view) => view.src);
    result.set(s.id, selectViewablePhotos(srcs, s.id, available.get(s.id) ?? new Set()));
  }
  return result;
}

/** 수업별 등록된 영상 수(지운 것·등록 전 제외). 표가 아직 없거나 조회가 실패하면 0 */
export async function countSessionVideos(sessionIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (sessionIds.length === 0) return result;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ sessionId: string; count: number }>>(
      `SELECT "sessionId", COUNT(*)::int AS count
         FROM "SessionVideo"
        WHERE "sessionId" = ANY($1::text[]) AND "registeredAt" IS NOT NULL AND "deletedAt" IS NULL
        GROUP BY "sessionId"`,
      sessionIds,
    );
    for (const row of rows) result.set(row.sessionId, Number(row.count) || 0);
  } catch {
    // 영상 표가 없는 환경에서도 소식·홈은 그대로 보이게
  }
  return result;
}

/** 수업별 «사진 n · 영상 n» 개수(소식 목록 행) */
export async function countSessionFeedMedia(
  sessions: Array<{ id: string; classId: string; photosJSON: string | null }>,
): Promise<Map<string, { photoCount: number; videoCount: number }>> {
  const [photos, videos] = await Promise.all([
    listViewableSessionPhotos(sessions).catch(() => new Map<string, FeedPhotoView[]>()),
    countSessionVideos(sessions.map((s) => s.id)),
  ]);
  return new Map(sessions.map((s) => [s.id, { photoCount: photos.get(s.id)?.length ?? 0, videoCount: videos.get(s.id) ?? 0 }]));
}

/**
 * 학부모 홈 «최신 수업 피드» 후보 — 아이마다 가장 최근 공개 수업 1건.
 * 화면은 pickFeedCard(후보, 고른 아이)로 카드 하나를 고른다.
 */
export async function getLatestFeedCandidates(appUserId: string): Promise<FeedCandidate[]> {
  if (!appUserId) return [];
  const rows = await prisma.$queryRawUnsafe<Array<{
    studentId: string; sessionId: string; classId: string; ymd: string; publishedAt: Date | null;
    className: string; coachName: string | null; content: string | null; topic: string | null; photosJSON: string | null;
  }>>(
    `SELECT DISTINCT ON (st.id)
            st.id AS "studentId", se.id AS "sessionId", se."classId", ${sessionKstDateSql("se")}::text AS ymd, se."publishedAt",
            c.name AS "className", ${classCoachNameSql("se", "c")} AS "coachName", se.content, se.topic, se."photosJSON"
       FROM "User" u
       JOIN "Student" st ON ${await childAccessSql("st", 'u."id"')} AND ${notMergedStudent("st")}
       JOIN "Session" se ON ${feedVisibleSessionSql("se")} AND ${feedParticipantSql("st", "se")}
       JOIN "Class" c ON c.id = se."classId"
      WHERE u.id = $1
      ORDER BY st.id, se.date DESC, se."publishedAt" DESC NULLS LAST`,
    appUserId,
  );
  if (rows.length === 0) return [];
  const sessions = rows.map((r) => ({ id: r.sessionId, classId: r.classId, photosJSON: r.photosJSON }));
  const [photos, videos] = await Promise.all([
    listViewableSessionPhotos(sessions).catch(() => new Map<string, FeedPhotoView[]>()),
    countSessionVideos(sessions.map((s) => s.id)),
  ]);
  return rows.map((r) => ({
    studentId: r.studentId,
    sessionId: r.sessionId,
    ymd: r.ymd,
    publishedAtMs: r.publishedAt ? new Date(r.publishedAt).getTime() : null,
    className: r.className,
    coachName: r.coachName,
    content: r.content,
    topic: r.topic,
    photos: photos.get(r.sessionId) ?? [],
    videoCount: videos.get(r.sessionId) ?? 0,
  }));
}
