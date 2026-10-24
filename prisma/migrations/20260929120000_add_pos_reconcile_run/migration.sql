-- 토스POS ↔ 사이트 결제 대사 실행 기록.
--
-- 왜 DB 에 남기는가: Vercel 은 실행될 때마다 파일이 사라져서, 매일 자동으로 돌린
-- 대조 결과를 파일로 보관할 수 없다. 관리자 화면에서 보려면 여기에 둬야 한다.
-- 이 표는 "기록"만 담는다. 청구서·결제를 바꾸는 값은 들어가지 않는다.

BEGIN;

CREATE TABLE IF NOT EXISTS "PosReconcileRun" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "targetMonth"     TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'OK',
  "error"           TEXT,
  "source"          TEXT NOT NULL DEFAULT 'CRON',

  -- 사람이 바로 읽는 숫자들. 화면에서 다시 계산하지 않도록 그대로 저장한다.
  "siteCount"       INTEGER NOT NULL DEFAULT 0,
  "siteAmount"      BIGINT  NOT NULL DEFAULT 0,
  "posCount"        INTEGER NOT NULL DEFAULT 0,
  "posAmount"       BIGINT  NOT NULL DEFAULT 0,
  "matchedCount"    INTEGER NOT NULL DEFAULT 0,
  "heldCount"       INTEGER NOT NULL DEFAULT 0,
  "siteOnlyCount"   INTEGER NOT NULL DEFAULT 0,
  "posOnlyCount"    INTEGER NOT NULL DEFAULT 0,
  "diffAmount"      BIGINT  NOT NULL DEFAULT 0,

  "reportMarkdown"  TEXT,
  "startedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt"      TIMESTAMPTZ,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 대상 월은 'YYYY-MM' 형식만 허용한다. 형식이 섞이면 월별 조회가 조용히 빈다.
  CONSTRAINT "PosReconcileRun_targetMonth_check"
    CHECK ("targetMonth" ~ '^(20[2-9][0-9]|2100)-(0[1-9]|1[0-2])$'),
  CONSTRAINT "PosReconcileRun_status_check"
    CHECK ("status" IN ('OK', 'FAILED')),
  CONSTRAINT "PosReconcileRun_source_check"
    CHECK ("source" IN ('CRON', 'MANUAL'))
);

-- 화면은 "그 달의 최신 실행"을 찾는다.
CREATE INDEX IF NOT EXISTS "PosReconcileRun_targetMonth_startedAt_idx"
  ON "PosReconcileRun"("targetMonth", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "PosReconcileRun_startedAt_idx"
  ON "PosReconcileRun"("startedAt" DESC);

-- 관리자 인증 서버에서만 접근한다. 브라우저의 공개 키 요청에는 열지 않는다.
ALTER TABLE "PosReconcileRun" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PosReconcileRun" FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE "PosReconcileRun" TO service_role;
-- 기록은 지우지 않는다. 대사 이력이 사라지면 "언제부터 어긋났는지"를 되짚을 수 없다.
REVOKE DELETE, TRUNCATE ON TABLE "PosReconcileRun" FROM service_role;

COMMIT;
