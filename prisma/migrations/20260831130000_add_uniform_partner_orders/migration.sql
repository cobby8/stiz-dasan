CREATE TABLE IF NOT EXISTS "UniformOrder" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "partnerRequestId" TEXT NOT NULL,
  "parentName" TEXT NOT NULL,
  "parentPhone" TEXT NOT NULL,
  "parentPhoneDigits" TEXT NOT NULL,
  "customerMemo" TEXT,
  "itemSignature" TEXT NOT NULL,
  "orderStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
  "stizSyncStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "stizOrderNumber" TEXT,
  "stizDuplicate" BOOLEAN NOT NULL DEFAULT false,
  "stizMessage" TEXT,
  "sendAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "lastSentAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "UniformOrderItem" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "uniformOrderId" TEXT NOT NULL REFERENCES "UniformOrder"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "studentName" TEXT NOT NULL,
  "backNumber" TEXT,
  "topSize" TEXT,
  "bottomSize" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "UniformOrder_partnerRequestId_key"
  ON "UniformOrder" ("partnerRequestId");
CREATE INDEX IF NOT EXISTS "UniformOrder_createdAt_idx"
  ON "UniformOrder" ("createdAt");
CREATE INDEX IF NOT EXISTS "UniformOrder_stizSyncStatus_nextRetryAt_idx"
  ON "UniformOrder" ("stizSyncStatus", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "UniformOrder_parentPhoneDigits_createdAt_idx"
  ON "UniformOrder" ("parentPhoneDigits", "createdAt");
CREATE INDEX IF NOT EXISTS "UniformOrderItem_uniformOrderId_idx"
  ON "UniformOrderItem" ("uniformOrderId");
CREATE INDEX IF NOT EXISTS "UniformOrderItem_studentName_idx"
  ON "UniformOrderItem" ("studentName");

ALTER TABLE "UniformOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UniformOrderItem" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON "UniformOrder" FROM anon, authenticated;
REVOKE ALL ON "UniformOrderItem" FROM anon, authenticated;
