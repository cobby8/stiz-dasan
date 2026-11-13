/**
 * 유튜브 연결 행(YouTubeConnection, id='default') 읽기·쓰기 — 서버 전용(raw SQL).
 * refresh token 은 암호문으로만 저장하고, 쓸 때만 잠깐 풀어 access token 을 받는다.
 */
import { prisma } from "@/lib/prisma";
import { readYoutubeConfig } from "@/lib/youtube/config";
import { openYoutubeToken, sealYoutubeToken } from "@/lib/youtube/tokenCrypto";
import { refreshYoutubeAccessToken, YoutubeApiError } from "@/lib/youtube/api";
import { todayKst } from "@/lib/datetime/kst";
import { YOUTUBE_DAILY_UPLOAD_LIMIT } from "@/lib/sessionVideo/rules";

export type YoutubeConnectionRow = {
  channelId: string;
  channelTitle: string | null;
  refreshTokenEncrypted: string;
  scope: string | null;
  connectedByUserId: string | null;
  connectedAt: Date;
  lastError: string | null;
  lastErrorAt: Date | null;
  quotaDay: string | null;
  quotaUsed: number;
  quotaBlockedUntil: Date | null;
};

/** 표가 아직 없으면(마이그레이션 전) null — 화면이 «준비 중»으로 보인다 */
export async function getYoutubeConnection(): Promise<YoutubeConnectionRow | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<YoutubeConnectionRow[]>(
      `SELECT "channelId", "channelTitle", "refreshTokenEncrypted", scope, "connectedByUserId", "connectedAt",
              "lastError", "lastErrorAt", "quotaDay", "quotaUsed", "quotaBlockedUntil"
         FROM "YouTubeConnection" WHERE id = 'default' LIMIT 1`,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function saveYoutubeConnection(input: {
  channelId: string; channelTitle: string; refreshToken: string; scope: string | null; connectedByUserId: string; encryptionKey: Buffer;
}) {
  const sealed = sealYoutubeToken(input.refreshToken, input.encryptionKey);
  // 다시 연결하면 같은 행을 덮어쓴다(채널을 바꿔 연결해도 한 행). 할당량 기록은 그대로 둔다.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "YouTubeConnection" (id, "channelId", "channelTitle", "refreshTokenEncrypted", scope, "connectedByUserId", "connectedAt", "updatedAt")
     VALUES ('default', $1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       "channelId" = EXCLUDED."channelId", "channelTitle" = EXCLUDED."channelTitle",
       "refreshTokenEncrypted" = EXCLUDED."refreshTokenEncrypted", scope = EXCLUDED.scope,
       "connectedByUserId" = EXCLUDED."connectedByUserId", "connectedAt" = NOW(),
       "lastError" = NULL, "lastErrorAt" = NULL, "updatedAt" = NOW()`,
    input.channelId, input.channelTitle, sealed, input.scope, input.connectedByUserId,
  );
}

export async function deleteYoutubeConnection() {
  await prisma.$executeRawUnsafe(`DELETE FROM "YouTubeConnection" WHERE id = 'default'`);
}

export async function recordYoutubeConnectionError(message: string | null) {
  await prisma.$executeRawUnsafe(
    `UPDATE "YouTubeConnection" SET "lastError" = $1, "lastErrorAt" = CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END, "updatedAt" = NOW()
      WHERE id = 'default'`,
    message ? message.slice(0, 500) : null,
  );
}

/**
 * 오늘(KST) 업로드 한 칸을 «먼저» 차지한다 — 유튜브를 부르기 전에. 못 차지하면 false(오늘 할당량 끝).
 * 한 문장 UPDATE 라 cron 이 겹쳐 돌아도 한도를 넘지 않는다.
 */
export async function reserveYoutubeQuotaSlot(nowMs: number = Date.now(), limit: number = YOUTUBE_DAILY_UPLOAD_LIMIT): Promise<boolean> {
  const today = todayKst(nowMs);
  const rows = await prisma.$queryRawUnsafe<Array<{ quotaUsed: number }>>(
    `UPDATE "YouTubeConnection"
        SET "quotaUsed" = CASE WHEN "quotaDay" = $1 THEN "quotaUsed" + 1 ELSE 1 END,
            "quotaDay" = $1, "updatedAt" = NOW()
      WHERE id = 'default'
        AND ("quotaBlockedUntil" IS NULL OR "quotaBlockedUntil" <= NOW())
        AND ("quotaDay" IS DISTINCT FROM $1 OR "quotaUsed" < $2)
      RETURNING "quotaUsed"`,
    today, limit,
  );
  return rows.length === 1;
}

/** 할당량 초과 응답 → 다음 KST 자정까지 멈춤 */
export async function blockYoutubeQuotaUntil(untilMs: number) {
  await prisma.$executeRawUnsafe(
    `UPDATE "YouTubeConnection" SET "quotaBlockedUntil" = $1::timestamptz, "updatedAt" = NOW() WHERE id = 'default'`,
    new Date(untilMs).toISOString(),
  );
}

/** 연결된 채널의 access token(매번 새로 받는다). 연결이 없거나 설정 대기면 null */
export async function getYoutubeAccessToken(): Promise<{ accessToken: string; refreshToken: string } | null> {
  const config = readYoutubeConfig();
  if (!config.ready) return null;
  const connection = await getYoutubeConnection();
  if (!connection) return null;
  let refreshToken: string;
  try {
    refreshToken = openYoutubeToken(connection.refreshTokenEncrypted, config.encryptionKey);
  } catch {
    // 암호화 키가 바뀌었으면 저장된 토큰을 풀 수 없다 → 다시 연결해야 한다
    await recordYoutubeConnectionError("저장된 연결 정보를 풀지 못했습니다(암호화 키 변경). 유튜브를 다시 연결해 주세요.");
    return null;
  }
  try {
    const accessToken = await refreshYoutubeAccessToken({ refreshToken, clientId: config.clientId, clientSecret: config.clientSecret });
    return { accessToken, refreshToken };
  } catch (error) {
    if (error instanceof YoutubeApiError && error.reason === "invalid_grant") {
      await recordYoutubeConnectionError("구글 연결이 끊겼습니다(권한 해제·비밀번호 변경 등). 유튜브를 다시 연결해 주세요.");
      return null;
    }
    throw error;
  }
}
