-- 외부 시스템 반영은 DB 트랜잭션보다 오래 걸릴 수 있으므로, 시도 행에 임대 토큰을 둬 중복 실행을 막는다.
ALTER TABLE "OperationsSyncAttempt"
  ADD COLUMN IF NOT EXISTS "processingToken" TEXT;

ALTER TABLE "OperationsSyncAttempt"
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMPTZ;

