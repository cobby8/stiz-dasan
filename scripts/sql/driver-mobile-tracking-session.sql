-- 승인 후 운영 적용. 이 파일을 만드는 작업은 DB 적용을 포함하지 않는다.
BEGIN;
CREATE TABLE IF NOT EXISTS "DriverMobileTrackingSession" (
  id uuid PRIMARY KEY,
  token text NOT NULL REFERENCES "ShuttleRunLink"(token) ON DELETE CASCADE,
  "secretHash" text NOT NULL CHECK ("secretHash" ~ '^[0-9a-f]{64}$'),
  "deviceId" uuid NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','STOPPED','EXPIRED')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "stoppedAt" timestamptz,
  "lastSequence" integer NOT NULL DEFAULT 0 CHECK ("lastSequence">=0),
  "capturedAt" timestamptz,
  "lastSentAt" timestamptz,
  accuracy double precision
);
CREATE UNIQUE INDEX IF NOT EXISTS "DriverMobileTrackingSession_one_active" ON "DriverMobileTrackingSession"(token) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS "DriverMobileTrackingSession_token_expiry" ON "DriverMobileTrackingSession"(token,"expiresAt");
ALTER TABLE "DriverMobileTrackingSession" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "DriverMobileTrackingSession" FROM PUBLIC;
-- Data API 계정에는 권한을 주지 않는다. 서버 DB 역할만 사용한다.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "DriverMobileTrackingSession" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "DriverMobileTrackingSession" FROM authenticated; END IF;
END $$;
COMMIT;
