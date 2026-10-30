-- 로컬 검증용 준비 SQL. 운영 적용·기존 schema 변경은 별도 승인한다.
CREATE TABLE "NativeAuthFlow" (
  id text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  provider text NOT NULL CHECK (provider IN ('google','kakao','naver','apple')),
  challenge text NOT NULL,
  state text NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED','BROWSER','READY','CONSUMED','CANCELLED')),
  "expiresAt" timestamptz NOT NULL,
  "browserHash" text,
  "codeHash" text,
  "codeExpiresAt" timestamptz,
  "sealedSession" text,
  "consumedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "NativeAuthFlow_expiry" ON "NativeAuthFlow" ("expiresAt");
ALTER TABLE "NativeAuthFlow" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "NativeAuthFlow" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "NativeAuthFlow" FROM anon; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "NativeAuthFlow" FROM authenticated; END IF;
END $$;
