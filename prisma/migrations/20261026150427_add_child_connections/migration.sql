-- 연결 기능은 CHILD_CONNECTIONS_ENABLED=true + 아래 표 검증 후에만 연다.
-- 대표 보호자·청구 수신자(Student.parentId)는 변경하지 않는다.
CREATE TABLE "ParentStudentAccess" (
 id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
 "studentId" TEXT NOT NULL REFERENCES "Student"(id) ON DELETE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
 source TEXT NOT NULL CHECK(source IN ('REGISTERED_CONTACT','ADULT_SELF','FAMILY_APPROVAL')),
 "approvedBy" TEXT REFERENCES "User"(id),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("studentId","userId")
);
CREATE INDEX "ParentStudentAccess_user_status_idx" ON "ParentStudentAccess"("userId",status);
CREATE TABLE "ChildIdentityChallenge" (
 id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 "sessionHash" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "expiresAt" TIMESTAMPTZ NOT NULL, "usedAt" TIMESTAMPTZ,
 "verifiedName" TEXT, "phoneHash" TEXT, "phoneLast4" TEXT, "birthHash" TEXT,
 "proofExpiresAt" TIMESTAMPTZ, "proofUsedAt" TIMESTAMPTZ,
 "verifyAttempts" INTEGER NOT NULL DEFAULT 0, "requestAttempts" INTEGER NOT NULL DEFAULT 0,
 CHECK ("verifyAttempts" >= 0 AND "requestAttempts" >= 0)
);
CREATE INDEX "ChildIdentityChallenge_user_created_idx" ON "ChildIdentityChallenge"("userId","createdAt");
CREATE TABLE "ChildLinkRequest" (
 id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
 "studentId" TEXT NOT NULL REFERENCES "Student"(id) ON DELETE CASCADE,
 "requesterId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 "approverId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 "challengeId" TEXT NOT NULL UNIQUE REFERENCES "ChildIdentityChallenge"(id),
 "requesterName" TEXT NOT NULL, "requesterPhoneLast4" TEXT NOT NULL,
 relation TEXT NOT NULL CHECK(relation IN ('PARENT','OTHER')),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELED','EXPIRED')),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "expiresAt" TIMESTAMPTZ NOT NULL,
 "decidedAt" TIMESTAMPTZ, "decidedBy" TEXT REFERENCES "User"(id),
 CHECK("requesterId" <> "approverId")
);
CREATE UNIQUE INDEX "ChildLinkRequest_pending_unique" ON "ChildLinkRequest"("studentId","requesterId") WHERE status='PENDING';
CREATE INDEX "ChildLinkRequest_approver_status_idx" ON "ChildLinkRequest"("approverId",status);
CREATE INDEX "ChildLinkRequest_requester_created_idx" ON "ChildLinkRequest"("requesterId","createdAt");
ALTER TABLE "ParentStudentAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChildIdentityChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChildLinkRequest" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON "ParentStudentAccess","ChildIdentityChallenge","ChildLinkRequest" FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON "ParentStudentAccess","ChildIdentityChallenge","ChildLinkRequest" FROM authenticated;
 END IF;
END $$;
REVOKE ALL ON "ParentStudentAccess","ChildIdentityChallenge","ChildLinkRequest" FROM PUBLIC;

ALTER TABLE "ParentStudentAccess" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ChildIdentityChallenge" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ChildLinkRequest" FORCE ROW LEVEL SECURITY;
