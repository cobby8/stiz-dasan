CREATE TABLE IF NOT EXISTS "KakaoParentIdentity" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "botId" TEXT NOT NULL,
  "userKeyHash" TEXT NOT NULL,
  "parentUserId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "linkTokenHash" TEXT UNIQUE,
  "linkExpiresAt" TIMESTAMPTZ(6),
  "linkedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "KakaoParentIdentity_parentUserId_fkey"
    FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "KakaoParentIdentity_botId_userKeyHash_key" UNIQUE ("botId", "userKeyHash")
);

CREATE INDEX IF NOT EXISTS "KakaoParentIdentity_parentUserId_status_idx"
  ON "KakaoParentIdentity" ("parentUserId", "status");

CREATE TABLE IF NOT EXISTS "KakaoParentIntake" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "identityId" TEXT NOT NULL,
  "studentId" TEXT,
  "kind" TEXT NOT NULL,
  "sourceText" TEXT NOT NULL,
  "structuredJson" JSONB,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "confirmedAt" TIMESTAMPTZ(6),
  "appliedAt" TIMESTAMPTZ(6),
  "errorCode" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "KakaoParentIntake_identityId_fkey"
    FOREIGN KEY ("identityId") REFERENCES "KakaoParentIdentity"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "KakaoParentIntake_identityId_status_createdAt_idx"
  ON "KakaoParentIntake" ("identityId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "KakaoParentIntake_studentId_createdAt_idx"
  ON "KakaoParentIntake" ("studentId", "createdAt" DESC);
