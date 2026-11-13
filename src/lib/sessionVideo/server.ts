/**
 * 수업 영상 서버 공용(2026-11-14) — 버킷·업로드 시간·보호자 권한·재생 정보.
 * 라우트(선생님·학부모)와 cron 이 이 파일 하나를 함께 쓴다(같은 규칙의 경로가 갈라지지 않게).
 */
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  canManageSessionVideo,
  isYoutubeVideoId,
  playbackKind,
  PLAYBACK_URL_TTL_SECONDS,
  SESSION_VIDEO_BUCKET,
  SESSION_VIDEO_DEFAULT_MAX_BYTES,
  SESSION_VIDEO_MIME_TYPES,
  uploadWindowMessage,
  type SessionVideoPlayback,
} from "@/lib/sessionVideo/rules";

export type { SessionVideoPlayback };

export type SessionVideoSessionRow = {
  id: string;
  classId: string;
  className: string;
  status: string;
  /** 수업 날짜(KST 달력) — Session.date 는 KST 날짜를 자정으로 저장한다(staff-sessions.ts `$2::date`) */
  sessionYmd: string;
  /** 오늘(KST) — DB 시계 기준(NOW() 는 timestamptz 라 AT TIME ZONE 한 번) */
  todayYmd: string;
};

export async function loadSessionForVideo(sessionId: string): Promise<SessionVideoSessionRow | null> {
  const rows = await prisma.$queryRawUnsafe<SessionVideoSessionRow[]>(
    `SELECT s.id, s."classId", c.name AS "className", s.status,
            s.date::date::text AS "sessionYmd",
            (NOW() AT TIME ZONE 'Asia/Seoul')::date::text AS "todayYmd"
       FROM "Session" s JOIN "Class" c ON c.id = s."classId"
      WHERE s.id = $1 LIMIT 1`,
    sessionId,
  );
  return rows[0] ?? null;
}

/** 업로드·삭제 가능 시간이 아니면 409 로 보낼 문장, 맞으면 null */
export function uploadWindowError(session: SessionVideoSessionRow): string | null {
  const result = canManageSessionVideo({ status: session.status, sessionYmd: session.sessionYmd, todayYmd: session.todayYmd });
  return result.ok ? null : uploadWindowMessage(result.reason);
}

/**
 * 영상 버킷이 없으면 만든다(마이그레이션이 먼저 만들어 두지만, 빠져도 동작하게).
 * 이미 있으면 건드리지 않는다 — 원장이 대시보드에서 올린 크기 상한을 덮어쓰지 않게.
 */
export async function ensureSessionVideoBucket(): Promise<void> {
  const supabase = createAdminClient();
  const { data } = await supabase.storage.getBucket(SESSION_VIDEO_BUCKET);
  if (data) return;
  const { error } = await supabase.storage.createBucket(SESSION_VIDEO_BUCKET, {
    public: false,
    fileSizeLimit: SESSION_VIDEO_DEFAULT_MAX_BYTES,
    allowedMimeTypes: [...SESSION_VIDEO_MIME_TYPES],
  });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
}

/** 버킷 크기 상한(바이트) — 읽지 못하면 기본 50MB */
export async function sessionVideoMaxBytes(): Promise<number> {
  try {
    const { data } = await createAdminClient().storage.getBucket(SESSION_VIDEO_BUCKET);
    const limit = Number(data?.file_size_limit);
    return Number.isFinite(limit) && limit > 0 ? limit : SESSION_VIDEO_DEFAULT_MAX_BYTES;
  } catch {
    return SESSION_VIDEO_DEFAULT_MAX_BYTES;
  }
}

/**
 * 학부모가 이 수업 영상을 볼 수 있나 — 그 수업에 «참여한» 학생의 보호자만.
 * 참여 = 이 수업 출결 기록이 있음 또는 그 반 ACTIVE 수강. 보호자 판정은 childAccessSql(연결 표 포함).
 * IDOR: sessionId 는 주소에서 오지만, 학생은 로그인한 보호자(appUserId) 쪽에서만 찾는다.
 */
export async function parentCanViewSessionVideos(appUserId: string, sessionId: string, classId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ ok: number }>>(
    `SELECT 1 AS ok
       FROM "User" u
       JOIN "Student" st ON ${await childAccessSql("st", 'u."id"')} AND ${notMergedStudent("st")}
      WHERE u.id = $1
        AND (
          EXISTS (SELECT 1 FROM "Attendance" a WHERE a."sessionId" = $2 AND a."studentId" = st.id)
          OR EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."studentId" = st.id AND e."classId" = $3 AND e.status = 'ACTIVE')
        )
      LIMIT 1`,
    appUserId, sessionId, classId,
  );
  return rows.length > 0;
}

export type SessionVideoRow = {
  id: string;
  sessionId: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: bigint | number;
  durationSec: number | null;
  createdAt: Date;
  youtubeVideoId: string | null;
  youtubeStatus: string;
  youtubePrivacy: string | null;
  storageDeletedAt: Date | null;
};

/** 등록이 끝났고 지워지지 않은 영상(오래된 순) */
export async function listSessionVideos(sessionId: string): Promise<SessionVideoRow[]> {
  return prisma.$queryRawUnsafe<SessionVideoRow[]>(
    `SELECT id, "sessionId", "storageBucket", "storagePath", "mimeType", "sizeBytes", "durationSec", "createdAt",
            "youtubeVideoId", "youtubeStatus", "youtubePrivacy", "storageDeletedAt"
       FROM "SessionVideo"
      WHERE "sessionId" = $1 AND "registeredAt" IS NOT NULL AND "deletedAt" IS NULL
      ORDER BY "createdAt" ASC`,
    sessionId,
  );
}


/**
 * 재생 정보로 바꾼다. 저장소 사본은 «짧은 수명 서명 주소»(10분)만 준다 — 주소가 새도 금방 못 쓴다.
 * 유튜브 일부공개가 끝난 영상은 유튜브 ID 만 준다(임베드는 youtube-nocookie).
 */
export async function toPlayback(rows: SessionVideoRow[]): Promise<SessionVideoPlayback[]> {
  const supabase = createAdminClient();
  return Promise.all(rows.map(async (row): Promise<SessionVideoPlayback> => {
    const base = { id: row.id, createdAt: new Date(row.createdAt).toISOString(), durationSec: row.durationSec };
    const kind = playbackKind(row);
    if (kind === "youtube" && isYoutubeVideoId(row.youtubeVideoId)) return { ...base, kind: "youtube", youtubeId: row.youtubeVideoId };
    if (kind === "file" && row.storageBucket === SESSION_VIDEO_BUCKET) {
      const { data } = await supabase.storage.from(row.storageBucket).createSignedUrl(row.storagePath, PLAYBACK_URL_TTL_SECONDS);
      if (data?.signedUrl) return { ...base, kind: "file", url: data.signedUrl, mimeType: row.mimeType };
    }
    return { ...base, kind: "none" };
  }));
}
