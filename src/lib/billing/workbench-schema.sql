-- 준비 파일: 운영 적용 금지. 승인된 격리 로컬 검증에서만 실행한다.
BEGIN;
CREATE TABLE "BillingWorkbenchDraft" (
 id text NOT NULL, month text NOT NULL CHECK(month ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$'),
 "studentId" text NOT NULL REFERENCES "Student"(id), "classId" text NOT NULL REFERENCES "Class"(id),
 version integer NOT NULL CHECK(version > 0), status text NOT NULL CHECK(status IN ('DRAFT','CONFIRMED','ISSUED','ZERO')),
 payload jsonb NOT NULL, reason text NOT NULL, "sourceVersion" text NOT NULL,
 "periodStart" text,"periodEnd" text,"scheduledDates" jsonb NOT NULL DEFAULT '[]',"calculationBasis" jsonb NOT NULL DEFAULT '{}',
 "paymentId" text UNIQUE REFERENCES "Payment"(id), "actorUserId" text NOT NULL,
 "updatedAt" timestamptz NOT NULL DEFAULT NOW(), PRIMARY KEY(id,month), UNIQUE("studentId","classId",month)
);
CREATE TABLE "BillingWorkbenchRevision" (
 id text PRIMARY KEY,"draftId" text NOT NULL,month text NOT NULL,version integer NOT NULL,action text NOT NULL,
 payload jsonb NOT NULL,reason text NOT NULL,"actorUserId" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT NOW(),
 FOREIGN KEY("draftId",month) REFERENCES "BillingWorkbenchDraft"(id,month), UNIQUE("draftId",month,version)
);
CREATE TABLE "BillingWorkbenchOperation" (
 "requestId" text PRIMARY KEY,fingerprint text NOT NULL,result jsonb NOT NULL,"actorUserId" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE "BillingAbsenceResolution" (
 "absenceId" text PRIMARY KEY REFERENCES "RegularAbsence"(id),"studentId" text NOT NULL REFERENCES "Student"(id),
 resolution text NOT NULL CHECK(resolution IN ('CARRY','MAKEUP')),reason text NOT NULL,"evidenceConfirmed" boolean NOT NULL,
 eligibility text NOT NULL,"actorUserId" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE "BillingCarryCredit" (
 id text PRIMARY KEY,"studentId" text NOT NULL REFERENCES "Student"(id),"absenceId" text NOT NULL UNIQUE REFERENCES "RegularAbsence"(id),
 numerator numeric(24,0) NOT NULL CHECK(numerator>=0),denominator numeric(12,0) NOT NULL CHECK(denominator>0),
 "availableMonth" text NOT NULL,basis jsonb NOT NULL,"actorUserId" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE "BillingCarryUsage" (
 id text PRIMARY KEY,"studentId" text NOT NULL REFERENCES "Student"(id),month text NOT NULL,"draftId" text NOT NULL,
 amount integer NOT NULL CHECK(amount>0),"paymentId" text REFERENCES "Payment"(id),"actorUserId" text NOT NULL,
 "sourceCreditIds" text[] NOT NULL CHECK(cardinality("sourceCreditIds")>0),basis jsonb NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT NOW(),FOREIGN KEY("draftId",month) REFERENCES "BillingWorkbenchDraft"(id,month), UNIQUE("draftId",month)
);
CREATE INDEX ON "BillingCarryCredit"("studentId","availableMonth");
CREATE INDEX ON "BillingCarryUsage"("studentId");
ALTER TABLE "BillingWorkbenchDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingWorkbenchRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingWorkbenchOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAbsenceResolution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingCarryCredit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingCarryUsage" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "BillingWorkbenchDraft","BillingWorkbenchRevision","BillingWorkbenchOperation","BillingAbsenceResolution","BillingCarryCredit","BillingCarryUsage" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON "BillingWorkbenchDraft","BillingWorkbenchRevision","BillingWorkbenchOperation","BillingAbsenceResolution","BillingCarryCredit","BillingCarryUsage" FROM %I',r); END IF;
END LOOP; END $$;
COMMIT;
