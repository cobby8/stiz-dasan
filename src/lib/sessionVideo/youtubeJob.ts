/**
 * 수업 영상 정리·유튜브 이동 작업(cron /api/cron/youtube-upload, 15분마다) — 2026-11-14.
 *
 * 한 번 돌 때 하는 일(순서대로):
 *  1) 등록 안 된 예약(업로드 중단)을 3시간 뒤 «지움»으로 바꾼다
 *  2) 저장소 사본 지우기: 지운 영상 · 유튜브 일부공개 7일 지난 영상
 *  3) 오래 멈춘 UPLOADING(20분)을 대기로 되돌린다(실패 1회로 센다)
 *  4) 유튜브 연결이 있으면: 지운 영상의 유튜브 사본 삭제 → 대기 영상을 오래된 순으로 업로드
 *     (하루 KST 5건 한도, 할당량 초과 응답이면 다음 KST 자정까지 멈춤)
 *
 * 1~3 은 유튜브 연결이 없어도 돈다(저장소 정리는 유튜브와 무관).
 */
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  classifyYoutubeError,
  interpretYoutubePrivacy,
  isValidSessionVideoRef,
  nextStatusAfterFailure,
  quotaBlockedUntil,
  STORAGE_COPY_RETENTION_DAYS,
  YOUTUBE_MAX_ATTEMPTS,
  youtubeVideoTitle,
} from "@/lib/sessionVideo/rules";
import { readYoutubeConfig } from "@/lib/youtube/config";
import {
  blockYoutubeQuotaUntil,
  getYoutubeAccessToken,
  getYoutubeConnection,
  recordYoutubeConnectionError,
  reserveYoutubeQuotaSlot,
} from "@/lib/youtube/connection";
import { deleteYoutubeVideo, setYoutubeVideoUnlisted, uploadYoutubeVideo, YoutubeApiError } from "@/lib/youtube/api";

const RESERVATION_TTL_HOURS = 3;
const STALE_UPLOADING_MINUTES = 20;
/** 새 업로드를 시작하려면 남아 있어야 하는 시간(ms) — 50MB 전송 + 여유 */
const MIN_TIME_FOR_UPLOAD_MS = 120_000;
const DESCRIPTION = "STIZ 농구교실 수업 영상입니다. 학부모 화면에서만 공유됩니다.";

export type YoutubeJobResult = {
  expiredReservations: number;
  storageDeleted: number;
  storageFailed: number;
  staleRecovered: number;
  youtubeDeleted: number;
  uploaded: number;
  privateLocked: number;
  failed: number;
  skippedReason: string | null;
};

type JobRow = {
  id: string;
  sessionId: string;
  classId: string;
  className: string;
  sessionYmd: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: bigint | number;
  youtubeVideoId: string | null;
  youtubeAttempts: number;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** 1) 등록 안 된 예약 → 지움(파일은 2단계가 치운다) */
async function expireReservations(): Promise<number> {
  return prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo" SET "deletedAt" = NOW(), "youtubeStatus" = 'SKIPPED', "updatedAt" = NOW()
      WHERE "registeredAt" IS NULL AND "deletedAt" IS NULL
        AND "createdAt" < NOW() - ($1 * INTERVAL '1 hour')`,
    RESERVATION_TTL_HOURS,
  );
}

/** 2) 저장소 사본 지우기 */
async function deleteStorageCopies(): Promise<{ deleted: number; failed: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; classId: string; sessionId: string; storageBucket: string; storagePath: string }>>(
    `SELECT v.id, s."classId", v."sessionId", v."storageBucket", v."storagePath"
       FROM "SessionVideo" v JOIN "Session" s ON s.id = v."sessionId"
      WHERE v."storageDeletedAt" IS NULL AND v."youtubeStatus" <> 'UPLOADING'
        AND (v."deletedAt" IS NOT NULL
          OR (v."youtubeStatus" = 'UPLOADED' AND v."youtubeUploadedAt" < NOW() - ($1 * INTERVAL '1 day')))
      ORDER BY v."updatedAt" ASC
      LIMIT 50`,
    STORAGE_COPY_RETENTION_DAYS,
  );
  // 우리가 만든 경로 모양만 지운다(다른 파일을 건드리지 않게)
  const valid = rows.filter((row) => isValidSessionVideoRef({ ...row, videoId: row.id }));
  const invalid = rows.filter((row) => !valid.includes(row));
  if (invalid.length > 0) {
    // 우리 모양이 아닌 경로는 지우지 않고 «정리 끝»으로만 표시한다 — 안 그러면 매번 다시 뽑혀 줄을 막는다
    await prisma.$executeRawUnsafe(
      `UPDATE "SessionVideo" SET "storageDeletedAt" = NOW(), "youtubeLastError" = 'INVALID_STORAGE_PATH: 저장소 정리 건너뜀', "updatedAt" = NOW()
        WHERE id = ANY($1::text[])`,
      invalid.map((row) => row.id),
    );
  }
  if (valid.length === 0) return { deleted: 0, failed: invalid.length };
  const supabase = createAdminClient();
  const bucket = valid[0].storageBucket;
  const { error } = await supabase.storage.from(bucket).remove(valid.map((row) => row.storagePath));
  if (error) return { deleted: 0, failed: rows.length };
  await prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo" SET "storageDeletedAt" = NOW(), "updatedAt" = NOW() WHERE id = ANY($1::text[]) AND "storageDeletedAt" IS NULL`,
    valid.map((row) => row.id),
  );
  return { deleted: valid.length, failed: rows.length - valid.length };
}

/** 3) 멈춘 업로드 되살리기 — 함수가 시간 초과로 죽으면 UPLOADING 에 남는다 */
async function recoverStaleUploading(): Promise<number> {
  return prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo"
        SET "youtubeAttempts" = "youtubeAttempts" + 1,
            "youtubeStatus" = CASE WHEN "youtubeAttempts" + 1 >= $2 THEN 'FAILED' ELSE 'PENDING' END,
            "youtubeLastError" = '업로드가 시간 안에 끝나지 않았습니다.',
            "youtubeLockedAt" = NULL, "updatedAt" = NOW()
      WHERE "youtubeStatus" = 'UPLOADING' AND "youtubeLockedAt" < NOW() - ($1 * INTERVAL '1 minute')`,
    STALE_UPLOADING_MINUTES, YOUTUBE_MAX_ATTEMPTS,
  );
}

/** 4-1) 지운 영상의 유튜브 사본 삭제(한 번에 5건 — 건당 50 units) */
async function deleteYoutubeCopies(accessToken: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; youtubeVideoId: string }>>(
    `SELECT id, "youtubeVideoId" FROM "SessionVideo"
      WHERE "deletedAt" IS NOT NULL AND "youtubeVideoId" IS NOT NULL AND "youtubeDeletedAt" IS NULL
        AND "youtubeStatus" <> 'UPLOADING'
      ORDER BY "deletedAt" ASC LIMIT 5`,
  );
  let deleted = 0;
  for (const row of rows) {
    try {
      await deleteYoutubeVideo(accessToken, row.youtubeVideoId);
      await prisma.$executeRawUnsafe(
        `UPDATE "SessionVideo" SET "youtubeDeletedAt" = NOW(), "youtubeStatus" = 'SKIPPED', "updatedAt" = NOW() WHERE id = $1`,
        row.id,
      );
      deleted += 1;
    } catch (error) {
      await prisma.$executeRawUnsafe(
        `UPDATE "SessionVideo" SET "youtubeLastError" = $2, "updatedAt" = NOW() WHERE id = $1`,
        row.id, `유튜브 삭제 실패: ${errorText(error)}`,
      );
      if (error instanceof YoutubeApiError && classifyYoutubeError(error.httpStatus, error.reason) === "QUOTA") break;
    }
  }
  return deleted;
}

/** 대기 영상 하나를 «업로드 중»으로 잡는다(겹쳐 도는 cron 끼리 같은 영상을 잡지 않게 SKIP LOCKED) */
async function claimNext(): Promise<JobRow | null> {
  const rows = await prisma.$queryRawUnsafe<JobRow[]>(
    `WITH candidate AS (
       SELECT id FROM "SessionVideo"
        WHERE "youtubeStatus" = 'PENDING' AND "registeredAt" IS NOT NULL
          AND "deletedAt" IS NULL AND "storageDeletedAt" IS NULL
        ORDER BY "registeredAt" ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
     ), claimed AS (
       UPDATE "SessionVideo" v SET "youtubeStatus" = 'UPLOADING', "youtubeLockedAt" = NOW(), "updatedAt" = NOW()
         FROM candidate c WHERE v.id = c.id
       RETURNING v.id, v."sessionId", v."storageBucket", v."storagePath", v."mimeType", v."sizeBytes",
                 v."youtubeVideoId", v."youtubeAttempts"
     )
     SELECT claimed.*, s."classId", cl.name AS "className", s.date::date::text AS "sessionYmd"
       FROM claimed JOIN "Session" s ON s.id = claimed."sessionId" JOIN "Class" cl ON cl.id = s."classId"`,
  );
  return rows[0] ?? null;
}

/** 잡았던 영상을 대기로 되돌린다(할당량·인증 문제 — 영상 탓이 아니라 실패로 세지 않는다) */
async function releaseClaim(id: string, message: string | null) {
  await prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo" SET "youtubeStatus" = 'PENDING', "youtubeLockedAt" = NULL,
            "youtubeLastError" = COALESCE($2, "youtubeLastError"), "updatedAt" = NOW()
      WHERE id = $1 AND "youtubeStatus" = 'UPLOADING'`,
    id, message,
  );
}

async function finishSuccess(id: string, youtubeVideoId: string, privacyStatus: unknown) {
  const result = interpretYoutubePrivacy(privacyStatus);
  await prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo"
        SET "youtubeStatus" = $2, "youtubeVideoId" = $3, "youtubePrivacy" = $4,
            "youtubeUploadedAt" = CASE WHEN $2 = 'UPLOADED' THEN NOW() ELSE "youtubeUploadedAt" END,
            "youtubeLastError" = CASE WHEN $2 = 'UPLOADED' THEN NULL
              ELSE '유튜브가 «' || $4 || '»(으)로 올렸습니다(구글 심사 전에는 비공개 강제). 학부모는 사이트 사본으로 봅니다.' END,
            "youtubeLockedAt" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND "youtubeStatus" = 'UPLOADING'`,
    id, result.status, youtubeVideoId, result.privacy,
  );
  return result.status;
}

async function finishFailure(row: JobRow, error: unknown) {
  const kind = error instanceof YoutubeApiError ? classifyYoutubeError(error.httpStatus, error.reason) : "RETRYABLE";
  const next = nextStatusAfterFailure({ attempts: row.youtubeAttempts, kind });
  await prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo" SET "youtubeStatus" = $2, "youtubeAttempts" = $3, "youtubeLastError" = $4,
            "youtubeLockedAt" = NULL, "updatedAt" = NOW()
      WHERE id = $1 AND "youtubeStatus" = 'UPLOADING'`,
    row.id, next.status, next.attempts, errorText(error),
  );
  return { kind, status: next.status };
}

/** 저장소 사본을 스트림으로 읽어 유튜브로 흘려보낸다(메모리에 통째로 올리지 않는다) */
async function uploadOne(row: JobRow, accessToken: string) {
  const { data, error } = await createAdminClient().storage.from(row.storageBucket).createSignedUrl(row.storagePath, 600);
  if (error || !data?.signedUrl) throw new Error("저장소 영상을 읽을 주소를 만들지 못했습니다.");
  const source = await fetch(data.signedUrl, { cache: "no-store" });
  if (!source.ok || !source.body) throw new Error(`저장소 영상을 읽지 못했습니다(HTTP ${source.status}).`);
  const sizeBytes = Number(source.headers.get("content-length") || row.sizeBytes);
  return uploadYoutubeVideo({
    accessToken,
    title: youtubeVideoTitle(row.className, row.sessionYmd),
    description: DESCRIPTION,
    mimeType: row.mimeType,
    sizeBytes,
    body: source.body,
  });
}

export async function processYoutubeVideoQueue(options: { deadlineMs: number; nowMs?: () => number }): Promise<YoutubeJobResult> {
  const now = options.nowMs ?? (() => Date.now());
  const result: YoutubeJobResult = {
    expiredReservations: 0, storageDeleted: 0, storageFailed: 0, staleRecovered: 0,
    youtubeDeleted: 0, uploaded: 0, privateLocked: 0, failed: 0, skippedReason: null,
  };
  result.expiredReservations = await expireReservations();
  const storage = await deleteStorageCopies();
  result.storageDeleted = storage.deleted;
  result.storageFailed = storage.failed;
  result.staleRecovered = await recoverStaleUploading();

  if (!readYoutubeConfig().ready) { result.skippedReason = "CONFIG_MISSING"; return result; }
  if (!await getYoutubeConnection()) { result.skippedReason = "NOT_CONNECTED"; return result; }
  const token = await getYoutubeAccessToken();
  if (!token) { result.skippedReason = "TOKEN_UNAVAILABLE"; return result; }

  result.youtubeDeleted = await deleteYoutubeCopies(token.accessToken);

  while (options.deadlineMs - now() > MIN_TIME_FOR_UPLOAD_MS) {
    const row = await claimNext();
    if (!row) break;
    try {
      let videoId: string;
      let privacy: string | null;
      if (row.youtubeVideoId) {
        // 이미 올라간(비공개로 잠긴) 영상 — 다시 올리지 않고 공개 범위만 일부공개로 다시 요청(50 units)
        videoId = row.youtubeVideoId;
        privacy = await setYoutubeVideoUnlisted(token.accessToken, row.youtubeVideoId);
      } else {
        // 새 업로드(1,600 units) — 유튜브를 부르기 «전에» 오늘 한 칸을 차지한다
        if (!await reserveYoutubeQuotaSlot(now())) {
          await releaseClaim(row.id, null);
          result.skippedReason = "DAILY_LIMIT";
          break;
        }
        const uploaded = await uploadOne(row, token.accessToken);
        videoId = uploaded.id;
        privacy = uploaded.privacyStatus;
      }
      const status = await finishSuccess(row.id, videoId, privacy);
      if (status === "UPLOADED") result.uploaded += 1;
      else result.privateLocked += 1;
      await recordYoutubeConnectionError(null);
    } catch (error) {
      const kind = error instanceof YoutubeApiError ? classifyYoutubeError(error.httpStatus, error.reason) : "RETRYABLE";
      if (kind === "QUOTA") {
        // 할당량 초과 — 다음 KST 자정까지 멈추고, 이 영상은 실패로 세지 않는다
        await releaseClaim(row.id, "유튜브 하루 할당량 초과 — 다음 날 다시 올립니다.");
        await blockYoutubeQuotaUntil(quotaBlockedUntil(now()));
        result.skippedReason = "QUOTA_EXCEEDED";
        break;
      }
      if (kind === "AUTH") {
        await releaseClaim(row.id, null);
        await recordYoutubeConnectionError(`유튜브 인증 오류: ${errorText(error)} — 연결을 다시 해 주세요.`);
        result.skippedReason = "AUTH_ERROR";
        break;
      }
      await finishFailure(row, error);
      result.failed += 1;
    }
  }
  return result;
}

/** 관리자 «다시 시도»: 비공개로 잠긴·실패한 영상을 대기로(심사 통과 뒤) */
export async function retryLockedYoutubeVideos(): Promise<number> {
  return prisma.$executeRawUnsafe(
    `UPDATE "SessionVideo" SET "youtubeStatus" = 'PENDING', "youtubeAttempts" = 0, "youtubeLockedAt" = NULL, "updatedAt" = NOW()
      WHERE "youtubeStatus" IN ('PRIVATE_LOCKED', 'FAILED')
        AND "registeredAt" IS NOT NULL AND "deletedAt" IS NULL AND "storageDeletedAt" IS NULL`,
  );
}

/** 관리자 화면 요약(상태별 건수) */
export async function youtubeQueueSummary(): Promise<Record<string, number>> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string; count: number }>>(
      `SELECT "youtubeStatus" AS status, COUNT(*)::int AS count FROM "SessionVideo"
        WHERE "registeredAt" IS NOT NULL AND "deletedAt" IS NULL GROUP BY "youtubeStatus"`,
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  } catch {
    return {};
  }
}
