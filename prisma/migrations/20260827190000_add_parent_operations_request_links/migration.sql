-- 학부모 요청 링크는 접수만 허용하며, 승인 전 외부 시스템을 변경하지 않는다.
-- 이 마이그레이션만 적용되는 새 DB에서도 동작하도록 기존 운영 동기화 원장을 먼저 준비한다.
CREATE TABLE IF NOT EXISTS "OperationsRequest" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceText" TEXT NOT NULL,
  "targetMonth" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','PENDING','PARTIAL','SYNCED','HELD')),
  "requestedByUserId" TEXT NOT NULL REFERENCES "User"(id),
  "approvedByUserId" TEXT REFERENCES "User"(id),
  "approvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "OperationsCommand" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "requestId" TEXT NOT NULL REFERENCES "OperationsRequest"(id) ON DELETE CASCADE,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "sourceText" TEXT NOT NULL,
  "studentId" TEXT REFERENCES "Student"(id),
  "studentName" TEXT,
  kind TEXT NOT NULL,
  "effectiveMonth" TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','HELD','PARTIAL','SYNCED')),
  "holdReason" TEXT,
  "beforeJson" JSONB,
  "afterJson" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "OperationsSyncAttempt" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "commandId" TEXT NOT NULL REFERENCES "OperationsCommand"(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('SHEET','RALLYZ','WEBSITE')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCEEDED','FAILED','SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  "externalReference" TEXT,
  error TEXT,
  "verifiedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("commandId", target)
);

CREATE INDEX IF NOT EXISTS "OperationsRequest_status_createdAt_idx" ON "OperationsRequest" (status, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "OperationsCommand_requestId_idx" ON "OperationsCommand" ("requestId");
CREATE INDEX IF NOT EXISTS "OperationsCommand_studentId_idx" ON "OperationsCommand" ("studentId");
CREATE UNIQUE INDEX IF NOT EXISTS "OperationsCommand_idempotencyKey_key" ON "OperationsCommand" ("idempotencyKey");
CREATE INDEX IF NOT EXISTS "OperationsSyncAttempt_commandId_idx" ON "OperationsSyncAttempt" ("commandId");

CREATE TABLE IF NOT EXISTS "ParentOperationsRequestLink" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "studentId" TEXT NOT NULL REFERENCES "Student"(id) ON DELETE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "lastUsedAt" TIMESTAMPTZ,
  "createdByUserId" TEXT NOT NULL REFERENCES "User"(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "OperationsRequest" ADD COLUMN IF NOT EXISTS "parentRequestLinkId" TEXT;
ALTER TABLE "OperationsRequest" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMPTZ;
ALTER TABLE "OperationsRequest" DROP CONSTRAINT IF EXISTS "OperationsRequest_parentRequestLinkId_fkey";
ALTER TABLE "OperationsRequest" ADD CONSTRAINT "OperationsRequest_parentRequestLinkId_fkey"
  FOREIGN KEY ("parentRequestLinkId") REFERENCES "ParentOperationsRequestLink"(id) ON DELETE SET NULL;

ALTER TABLE "OperationsCommand" ADD COLUMN IF NOT EXISTS "billingStatus" TEXT NOT NULL DEFAULT 'HELD';
ALTER TABLE "OperationsCommand" ADD COLUMN IF NOT EXISTS "notificationStatus" TEXT NOT NULL DEFAULT 'HELD';

CREATE TABLE IF NOT EXISTS "OperationsAuditLog" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "requestId" TEXT REFERENCES "OperationsRequest"(id) ON DELETE CASCADE,
  "linkId" TEXT REFERENCES "ParentOperationsRequestLink"(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorUserId" TEXT REFERENCES "User"(id),
  "detailsJson" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ParentOperationsRequestLink_studentId_expiresAt_idx"
  ON "ParentOperationsRequestLink" ("studentId", "expiresAt");
CREATE INDEX IF NOT EXISTS "OperationsAuditLog_requestId_createdAt_idx"
  ON "OperationsAuditLog" ("requestId", "createdAt" DESC);

ALTER TABLE "ParentOperationsRequestLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsCommand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationsSyncAttempt" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "OperationsRequest", "OperationsCommand", "OperationsSyncAttempt", "ParentOperationsRequestLink", "OperationsAuditLog" FROM anon, authenticated;
