ALTER TABLE "KakaoParentIntake"
  ADD COLUMN IF NOT EXISTS "decidedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "decisionNote" TEXT,
  ADD COLUMN IF NOT EXISTS "operationsRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "KakaoParentIntake_operationsRequestId_key"
  ON "KakaoParentIntake" ("operationsRequestId");

CREATE TABLE IF NOT EXISTS "KakaoParentIntakeAudit" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "intakeId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "fromStatus" TEXT NOT NULL,
  "toStatus" TEXT NOT NULL,
  "note" TEXT,
  "detailsJson" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "KakaoParentIntakeAudit_intakeId_fkey"
    FOREIGN KEY ("intakeId") REFERENCES "KakaoParentIntake"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "KakaoParentIntakeAudit_intakeId_createdAt_idx"
  ON "KakaoParentIntakeAudit" ("intakeId", "createdAt" DESC);

ALTER TABLE "KakaoParentIntakeAudit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "KakaoParentIntakeAudit" FROM anon, authenticated;
