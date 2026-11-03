-- 운영 적용은 별도 승인 대상. 자료 보정·배차·발송은 실행하지 않는다.
CREATE TABLE "EnrollmentShuttleReview" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "applicationId" TEXT NOT NULL REFERENCES "EnrollmentApplication"(id) ON DELETE RESTRICT,
  "studentId" TEXT NOT NULL REFERENCES "Student"(id) ON DELETE RESTRICT,
  "serviceMonth" TEXT NOT NULL CHECK ("serviceMonth" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  "driverUserId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "sourceFingerprint" TEXT NOT NULL CHECK ("sourceFingerprint" ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROPOSED','NEEDS_CONFIRMATION','SUPERSEDED')),
  note TEXT CHECK (char_length(note) <= 1000),
  proposals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(proposals) = 'array'),
  "requestedByUserId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reviewedAt" TIMESTAMPTZ,
  "supersededAt" TIMESTAMPTZ
);
CREATE INDEX "EnrollmentShuttleReview_application_month_idx" ON "EnrollmentShuttleReview" ("applicationId", "serviceMonth", "requestedAt");
CREATE INDEX "EnrollmentShuttleReview_driver_month_status_idx" ON "EnrollmentShuttleReview" ("driverUserId", "serviceMonth", status);
CREATE UNIQUE INDEX "EnrollmentShuttleReview_one_current" ON "EnrollmentShuttleReview" ("applicationId", "serviceMonth") WHERE status <> 'SUPERSEDED';
ALTER TABLE "EnrollmentShuttleReview" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "EnrollmentShuttleReview" FROM PUBLIC, anon, authenticated;
