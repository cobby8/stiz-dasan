-- 랠리즈 2026 수업 피드(다산2호점) → 사이트 수업 피드 이관 표시·장부 (2026-11-16 원장 결정표 v1~v5 승인).
--
-- 왜 필요한가
--   1) Session."importSource" : 이관한 글·사진·영상이 들어간 수업 표시. 값이 있으면
--      관리자·선생님 «발행» 버튼을 눌러도 학부모 알림을 보내지 않는다(원장 «학부모 알림 금지»).
--      코드: src/lib/feed/importedSession.ts (칸이 없으면 «이관 아님»으로 본다 → 이 마이그레이션 전에도 사이트는 그대로 동작)
--   2) RallyzFeedImport : 이관 장부. 한 행 = 랠리즈 글 1개(POST) 또는 수업 영상 1개(VIDEO).
--      - 같은 글을 두 번 넣지 않게(UNIQUE kind+sourceKey) — 스크립트를 몇 번 다시 돌려도 안전
--      - 되돌릴 때 «무엇을 덧붙였는지»를 정확히 안다(appendedContent·photosJSON 항목·만든 수업 여부·이전 상태)
--   스크립트: scripts/rallyz-feed-import/ (원장 PC 에서 실행, 랠리즈는 읽기만)
--
-- 기존 표·행을 바꾸는 문장은 없다(칸 추가 1 + 새 표 1). 기존 행의 importSource 는 모두 NULL.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- ⚠️ 이관 데이터를 먼저 되돌린 뒤(docs/rallyz-feed-import.md «되돌리기») 실행한다.
-- DROP TABLE IF EXISTS public."RallyzFeedImport";
-- ALTER TABLE public."Session" DROP CONSTRAINT IF EXISTS "Session_importSource_check";
-- ALTER TABLE public."Session" DROP COLUMN IF EXISTS "importSource";

ALTER TABLE public."Session" ADD COLUMN IF NOT EXISTS "importSource" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Session_importSource_check') THEN
    -- 코드 상수(IMPORT_SOURCE_RALLYZ_FEED)와 같은 집합 — 테스트가 비교한다
    ALTER TABLE public."Session"
      ADD CONSTRAINT "Session_importSource_check" CHECK ("importSource" IS NULL OR "importSource" IN ('RALLYZ_FEED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public."RallyzFeedImport" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  -- POST = 랠리즈 글 1개(글·사진), VIDEO = 수업(반·날짜)별로 묶은 영상 1개
  kind TEXT NOT NULL,
  -- POST: 랠리즈 글 id · VIDEO: "<classId>:<YYYY-MM-DD>"
  "sourceKey" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  -- 이 이관이 수업 기록을 새로 만들었나(되돌릴 때 수업째 지울지 판단)
  "createdSession" BOOLEAN NOT NULL DEFAULT false,
  -- 이관 전 수업 상태(PLANNED 였던 지난 수업을 COMPLETED 로 바꿨으면 되돌릴 때 복원)
  "previousStatus" TEXT,
  -- 이관 전 학부모 발행 여부(되돌릴 때 미발행이던 수업은 미발행으로 복원)
  "previousPublished" BOOLEAN,
  -- 수업 내용(content) 뒤에 덧붙인 글 그대로(되돌릴 때 이 글만 빼낸다)
  "appendedContent" TEXT,
  -- photosJSON 에 덧붙인 항목(JSON 배열 문자열)과 저장소 경로 — 되돌릴 때 사진 파일도 지운다
  "photoEntriesJSON" TEXT NOT NULL DEFAULT '[]',
  "sessionVideoId" TEXT,
  "youtubeVideoId" TEXT,
  -- 랠리즈 원본 정보(작성일·반 이름) — 대조용
  "rallyzCreatedAt" TEXT,
  "rallyzClassName" TEXT,
  -- 한 번 실행 묶음 id(되돌림 단위)
  batch TEXT NOT NULL,
  "importedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "RallyzFeedImport_kind_check" CHECK (kind IN ('POST', 'VIDEO')),
  CONSTRAINT "RallyzFeedImport_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES public."Session" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 같은 랠리즈 글·같은 수업 영상은 한 번만
CREATE UNIQUE INDEX IF NOT EXISTS "RallyzFeedImport_kind_sourceKey_key"
  ON public."RallyzFeedImport" (kind, "sourceKey");
-- 발행 알림 판정·되돌림(수업별)
CREATE INDEX IF NOT EXISTS "RallyzFeedImport_sessionId_idx"
  ON public."RallyzFeedImport" ("sessionId");
-- 실행 묶음 단위 되돌림
CREATE INDEX IF NOT EXISTS "RallyzFeedImport_batch_idx"
  ON public."RallyzFeedImport" (batch);

-- 서버·이관 스크립트만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가
ALTER TABLE public."RallyzFeedImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RallyzFeedImport" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."RallyzFeedImport" FROM anon, authenticated;
