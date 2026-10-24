ALTER TABLE "ParentOperationsRequestLink"
ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'GENERAL';

ALTER TABLE "ParentOperationsRequestLink"
ADD CONSTRAINT "ParentOperationsRequestLink_purpose_check"
CHECK ("purpose" IN ('GENERAL', 'KAKAO_RECONFIRMATION'));

CREATE INDEX "ParentOperationsRequestLink_purpose_expiresAt_idx"
ON "ParentOperationsRequestLink"("purpose", "expiresAt");
