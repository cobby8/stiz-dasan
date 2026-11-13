-- 수업 영상(2026-11-14, 원장 결정 — 수업 피드 결정표).
--
-- 왜 필요한가: 선생님이 수업 진행 화면에서 영상을 바로 찍어 올리면, 그 수업에 참여한 학생의
-- 보호자만 학부모 화면 안에서 본다. 영상은 원장 유튜브 채널에 «일부공개»로 옮겨 재생하는 게 목표지만,
-- 구글 심사 전에는 유튜브가 «비공개»로 강제하므로 우리 저장소(비공개 버킷) 사본으로 재생한다.
--
-- 흐름:
--   1) 선생님 화면이 «업로드 주소»를 받는 순간 행을 «예약»으로 만든다(registeredAt NULL).
--      → 브라우저가 저장소에 직접 올리고 «등록»하면 registeredAt 이 찍힌다.
--      → 예약만 남은 행(업로드 중단)은 cron 이 저장소 파일까지 치운다.
--   2) cron 이 PENDING 영상을 유튜브로 옮긴다(UPLOADING → UPLOADED | PRIVATE_LOCKED | FAILED).
--   3) UPLOADED 7일 뒤 저장소 사본을 지운다(storageDeletedAt).
--   4) 선생님이 지우면 deletedAt 이 찍히고, cron 이 저장소·유튜브 사본을 지운다.
--
-- 시간 칼럼은 모두 timestamptz(시간대 변환을 한 번만 건다).

CREATE TABLE IF NOT EXISTS public."SessionVideo" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "sessionId" TEXT NOT NULL,
  "storageBucket" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "durationSec" INTEGER,
  "uploadedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- 브라우저 업로드가 끝나 «등록»된 시각. NULL = 업로드 주소만 받은 예약(목록·재생에서 제외)
  "registeredAt" TIMESTAMPTZ(6),
  "youtubeVideoId" TEXT,
  "youtubeStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "youtubePrivacy" TEXT,
  "youtubeAttempts" INTEGER NOT NULL DEFAULT 0,
  "youtubeLastError" TEXT,
  "youtubeLockedAt" TIMESTAMPTZ(6),
  "youtubeUploadedAt" TIMESTAMPTZ(6),
  "youtubeDeletedAt" TIMESTAMPTZ(6),
  "storageDeletedAt" TIMESTAMPTZ(6),
  "deletedAt" TIMESTAMPTZ(6),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- 코드의 상수(SESSION_VIDEO_YOUTUBE_STATUSES)와 같은 집합 — 테스트가 비교한다
  CONSTRAINT "SessionVideo_youtubeStatus_check"
    CHECK ("youtubeStatus" IN ('PENDING', 'UPLOADING', 'UPLOADED', 'PRIVATE_LOCKED', 'FAILED', 'SKIPPED')),
  CONSTRAINT "SessionVideo_mimeType_check"
    CHECK ("mimeType" IN ('video/mp4', 'video/quicktime', 'video/webm')),
  CONSTRAINT "SessionVideo_sizeBytes_check" CHECK ("sizeBytes" > 0),
  CONSTRAINT "SessionVideo_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES public."Session" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 수업 하나의 영상 목록(선생님·학부모 화면)
CREATE INDEX IF NOT EXISTS "SessionVideo_sessionId_createdAt_idx"
  ON public."SessionVideo" ("sessionId", "createdAt");
-- cron: 유튜브로 옮길 영상(오래된 순)
CREATE INDEX IF NOT EXISTS "SessionVideo_youtube_queue_idx"
  ON public."SessionVideo" ("youtubeStatus", "registeredAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SessionVideo_storagePath_key"
  ON public."SessionVideo" ("storageBucket", "storagePath");

-- 유튜브 연결(한 행만 — id = 'default'). 원장 개인 gmail 계정이 주인인 채널.
--  refreshTokenEncrypted: AES-256-GCM 암호문(env YOUTUBE_TOKEN_ENCRYPTION_KEY). 평문 토큰은 어디에도 남기지 않는다.
--  quotaDay/quotaUsed : 하루(KST) 업로드 시도 수 — 유튜브 하루 할당량(약 6건) 안에서만 올린다
--  quotaBlockedUntil  : 할당량 초과 응답을 받으면 이 시각까지 업로드를 멈춘다
CREATE TABLE IF NOT EXISTS public."YouTubeConnection" (
  id TEXT PRIMARY KEY DEFAULT 'default',
  "channelId" TEXT NOT NULL,
  "channelTitle" TEXT,
  "refreshTokenEncrypted" TEXT NOT NULL,
  scope TEXT,
  "connectedByUserId" TEXT,
  "connectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "lastError" TEXT,
  "lastErrorAt" TIMESTAMPTZ(6),
  "quotaDay" TEXT,
  "quotaUsed" INTEGER NOT NULL DEFAULT 0,
  "quotaBlockedUntil" TIMESTAMPTZ(6),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "YouTubeConnection_single_row" CHECK (id = 'default')
);

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(ClassSubstitute 와 같은 방식)
ALTER TABLE public."SessionVideo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SessionVideo" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."SessionVideo" FROM anon, authenticated;
ALTER TABLE public."YouTubeConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."YouTubeConnection" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."YouTubeConnection" FROM anon, authenticated;

-- 영상 저장소(비공개 버킷). 크기 상한 50MB = Supabase 기본 전역 상한과 같다.
-- 전역 상한을 올리면(유료 요금제) 이 버킷 값만 올리면 된다 — 화면 안내는 이 값을 읽어 따라간다.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('session-videos', 'session-videos', false, 52428800, ARRAY['video/mp4', 'video/quicktime', 'video/webm'])
ON CONFLICT (id) DO NOTHING;

-- ── 되돌림 SQL(필요할 때만, 영상 파일을 먼저 백업할 것) ──────────────────────────
-- DROP TABLE IF EXISTS public."SessionVideo";
-- DROP TABLE IF EXISTS public."YouTubeConnection";
-- -- 버킷은 안의 파일을 모두 지운 뒤에만 지워진다(Supabase 대시보드 → Storage → session-videos → 비우기)
-- DELETE FROM storage.buckets WHERE id = 'session-videos';
