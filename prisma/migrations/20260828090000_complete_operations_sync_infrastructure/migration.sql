-- 운영 동기화 화면이 SSR 요청 중 DDL을 실행하지 않도록 원장 구조를 완결하는 3단계 migration이다.
-- 이 파일만 단독 적용하면 안 되며 아래 3개 디렉터리를 순서대로 모두 적용해야 한다.
-- 1. prisma/migrations/20260827190000_add_parent_operations_request_links
-- 2. prisma/migrations/20260827223000_add_operations_sync_processing_lease
-- 3. prisma/migrations/20260828090000_complete_operations_sync_infrastructure

CREATE TABLE IF NOT EXISTS "OperationsRequest" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceText" TEXT NOT NULL, "targetMonth" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  "requestedByUserId" TEXT NOT NULL REFERENCES "User"(id),
  "approvedByUserId" TEXT REFERENCES "User"(id), "approvedAt" TIMESTAMPTZ,
  "parentRequestLinkId" TEXT, "submittedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "OperationsCommand" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "requestId" TEXT NOT NULL REFERENCES "OperationsRequest"(id) ON DELETE CASCADE,
  "idempotencyKey" TEXT NOT NULL UNIQUE, "sourceText" TEXT NOT NULL,
  "studentId" TEXT REFERENCES "Student"(id), "studentName" TEXT,
  kind TEXT NOT NULL, "effectiveMonth" TEXT NOT NULL, confidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', "holdReason" TEXT,
  "beforeJson" JSONB, "afterJson" JSONB,
  "billingStatus" TEXT NOT NULL DEFAULT 'HELD', "notificationStatus" TEXT NOT NULL DEFAULT 'HELD',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "OperationsSyncAttempt" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "commandId" TEXT NOT NULL REFERENCES "OperationsCommand"(id) ON DELETE CASCADE,
  target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
  "externalReference" TEXT, error TEXT, "verifiedAt" TIMESTAMPTZ,
  "processingToken" TEXT, "processingStartedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("commandId", target)
);

CREATE TABLE IF NOT EXISTS "RallyzAttendanceSyncRun" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceDate" DATE NOT NULL, status TEXT NOT NULL DEFAULT 'PREVIEW', "sourceJson" JSONB NOT NULL,
  "requestedByUserId" TEXT NOT NULL REFERENCES "User"(id),
  "appliedByUserId" TEXT REFERENCES "User"(id), "appliedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "RallyzAttendanceSyncItem" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "runId" TEXT NOT NULL REFERENCES "RallyzAttendanceSyncRun"(id) ON DELETE CASCADE,
  "idempotencyKey" TEXT NOT NULL UNIQUE, "sourceDate" DATE NOT NULL,
  "rallyzClassId" TEXT, "sourceClassName" TEXT NOT NULL, "slotKey" TEXT,
  "studentName" TEXT NOT NULL, "managementName" TEXT, "sourceStatus" TEXT NOT NULL, "siteStatus" TEXT,
  "studentId" TEXT REFERENCES "Student"(id), "classId" TEXT REFERENCES "Class"(id),
  "sessionId" TEXT REFERENCES "Session"(id), "attendanceId" TEXT REFERENCES "Attendance"(id),
  status TEXT NOT NULL DEFAULT 'PENDING', "holdReason" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 이전 migration 일부만 적용된 DB도 현재 코드 계약까지 안전하게 보완한다.
ALTER TABLE "OperationsRequest" ADD COLUMN IF NOT EXISTS "parentRequestLinkId" TEXT;
ALTER TABLE "OperationsRequest" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMPTZ;
ALTER TABLE "OperationsCommand" ADD COLUMN IF NOT EXISTS "billingStatus" TEXT NOT NULL DEFAULT 'HELD';
ALTER TABLE "OperationsCommand" ADD COLUMN IF NOT EXISTS "notificationStatus" TEXT NOT NULL DEFAULT 'HELD';
ALTER TABLE "OperationsSyncAttempt" ADD COLUMN IF NOT EXISTS "processingToken" TEXT;
ALTER TABLE "OperationsSyncAttempt" ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "OperationsRequest_status_createdAt_idx" ON "OperationsRequest" (status, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "OperationsCommand_requestId_idx" ON "OperationsCommand" ("requestId");
CREATE INDEX IF NOT EXISTS "OperationsCommand_studentId_idx" ON "OperationsCommand" ("studentId");
CREATE UNIQUE INDEX IF NOT EXISTS "OperationsCommand_idempotencyKey_key" ON "OperationsCommand" ("idempotencyKey");
CREATE INDEX IF NOT EXISTS "OperationsSyncAttempt_commandId_idx" ON "OperationsSyncAttempt" ("commandId");
CREATE INDEX IF NOT EXISTS "RallyzAttendanceSyncRun_createdAt_idx" ON "RallyzAttendanceSyncRun" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "RallyzAttendanceSyncItem_runId_idx" ON "RallyzAttendanceSyncItem" ("runId");
CREATE UNIQUE INDEX IF NOT EXISTS "RallyzAttendanceSyncItem_runId_idempotencyKey_key"
  ON "RallyzAttendanceSyncItem" ("runId", "idempotencyKey");

ALTER TABLE "OperationsRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsCommand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsSyncAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RallyzAttendanceSyncRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RallyzAttendanceSyncItem" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "OperationsRequest", "OperationsCommand", "OperationsSyncAttempt",
  "RallyzAttendanceSyncRun", "RallyzAttendanceSyncItem" FROM anon, authenticated;
