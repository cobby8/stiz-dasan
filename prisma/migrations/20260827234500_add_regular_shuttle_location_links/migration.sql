-- 정규반 학부모 좌표 요청 링크. 운영 DB에는 이 작업에서 적용하지 않는다.
CREATE TABLE "RegularShuttleLocationLink" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "studentId" TEXT NOT NULL REFERENCES "Student"(id) ON DELETE CASCADE,
  "parentId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'REGULAR_SHUTTLE_LOCATION'
    CHECK (purpose = 'REGULAR_SHUTTLE_LOCATION'),
  "tokenHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "lastSubmittedAt" TIMESTAMPTZ,
  "submissionCount" INTEGER NOT NULL DEFAULT 0 CHECK ("submissionCount" >= 0),
  "lastPayloadHash" TEXT,
  "createdByUserId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE NO ACTION,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "RegularShuttleLocationLink_studentId_expiresAt_idx" ON "RegularShuttleLocationLink"("studentId","expiresAt");
CREATE INDEX "RegularShuttleLocationLink_parentId_expiresAt_idx" ON "RegularShuttleLocationLink"("parentId","expiresAt");

CREATE TABLE "RegularShuttleLocationLinkAudit" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "linkId" TEXT NOT NULL REFERENCES "RegularShuttleLocationLink"(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  "detailsJson" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "RegularShuttleLocationLinkAudit_linkId_createdAt_idx" ON "RegularShuttleLocationLinkAudit"("linkId","createdAt" DESC);

ALTER TABLE "RegularShuttleLocationLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegularShuttleLocationLinkAudit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "RegularShuttleLocationLink", "RegularShuttleLocationLinkAudit" FROM anon, authenticated;
