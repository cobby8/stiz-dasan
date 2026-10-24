-- 사이트 월 장부 준비. 기존 수강/청구/시트 자료를 이관하거나 변경하지 않는다.
-- 운영 적용 전 별도 DB 승인·백업·테스트 DB 검증이 필요하다.
BEGIN;
CREATE TABLE "MonthlyEnrollmentRegister" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "payload" JSONB NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMPTZ(6),
  CONSTRAINT "MonthlyEnrollmentRegister_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlyEnrollmentRegister_month_check" CHECK ("month" ~ '^(20[2-9][0-9]|2100)-(0[1-9]|1[0-2])$'),
  CONSTRAINT "MonthlyEnrollmentRegister_version_check" CHECK ("version" > 0),
  CONSTRAINT "MonthlyEnrollmentRegister_status_check" CHECK ("status" IN ('DRAFT', 'CONFIRMED')),
  CONSTRAINT "MonthlyEnrollmentRegister_confirmation_check" CHECK (("status" = 'CONFIRMED') = ("confirmedAt" IS NOT NULL)),
  CONSTRAINT "MonthlyEnrollmentRegister_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND "payload" ?& ARRAY['studentId', 'month', 'classes', 'shuttleAmount', 'shuttleBasis', 'reason']
    AND ("payload" ->> 'studentId') IS NOT DISTINCT FROM "studentId"
    AND ("payload" ->> 'month') IS NOT DISTINCT FROM "month"
    AND jsonb_typeof("payload" -> 'classes') = 'array'
  )
);
CREATE UNIQUE INDEX "MonthlyEnrollmentRegister_studentId_month_key" ON "MonthlyEnrollmentRegister"("studentId", "month");
CREATE INDEX "MonthlyEnrollmentRegister_month_status_idx" ON "MonthlyEnrollmentRegister"("month", "status");

CREATE TABLE "MonthlyEnrollmentRegisterRevision" (
  "id" TEXT NOT NULL,
  "registerId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_registerId_fkey" FOREIGN KEY ("registerId")
    REFERENCES "MonthlyEnrollmentRegister"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_version_check" CHECK ("version" > 0),
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_status_check" CHECK ("status" IN ('DRAFT', 'CONFIRMED')),
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_action_check" CHECK ("action" IN ('SAVE_DRAFT', 'CONFIRM', 'REOPEN')),
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_month_check" CHECK ("month" ~ '^(20[2-9][0-9]|2100)-(0[1-9]|1[0-2])$'),
  CONSTRAINT "MonthlyEnrollmentRegisterRevision_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND "payload" ?& ARRAY['studentId', 'month', 'classes']
    AND ("payload" ->> 'studentId') IS NOT DISTINCT FROM "studentId"
    AND ("payload" ->> 'month') IS NOT DISTINCT FROM "month"
    AND jsonb_typeof("payload" -> 'classes') = 'array'
  )
);
CREATE UNIQUE INDEX "MonthlyEnrollmentRegisterRevision_registerId_version_key" ON "MonthlyEnrollmentRegisterRevision"("registerId", "version");
CREATE INDEX "MonthlyEnrollmentRegisterRevision_studentId_month_version_idx" ON "MonthlyEnrollmentRegisterRevision"("studentId", "month", "version");

-- 관리자 인증 서버에서만 접근한다. 브라우저의 Supabase 직접 요청에는 공개하지 않는다.
ALTER TABLE "MonthlyEnrollmentRegister" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MonthlyEnrollmentRegisterRevision" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "MonthlyEnrollmentRegister", "MonthlyEnrollmentRegisterRevision" FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE "MonthlyEnrollmentRegister" TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE "MonthlyEnrollmentRegister" FROM service_role;
GRANT SELECT, INSERT ON TABLE "MonthlyEnrollmentRegisterRevision" TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "MonthlyEnrollmentRegisterRevision" FROM service_role;
COMMIT;
