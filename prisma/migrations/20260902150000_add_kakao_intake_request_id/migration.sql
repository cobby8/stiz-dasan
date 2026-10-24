ALTER TABLE "KakaoParentIntake"
  ADD COLUMN IF NOT EXISTS "providerRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "KakaoParentIntake_identityId_providerRequestId_key"
  ON "KakaoParentIntake" ("identityId", "providerRequestId");

ALTER TABLE "KakaoParentIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KakaoParentIntake" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "KakaoParentIdentity" FROM anon, authenticated;
REVOKE ALL ON TABLE "KakaoParentIntake" FROM anon, authenticated;
