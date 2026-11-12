-- 학부모 아이디·비밀번호 찾기(2026-11-13): 가입한 휴대폰 문자 인증으로 본인을 확인한 뒤
-- 아이디를 보여 주고 비밀번호를 새로 정한다. 학부모 아이디는 `아이디@member.stiz.kr` 같은
-- 받을 수 없는 주소라 메일 재설정을 쓸 수 없다.
-- 번호 원문은 인증·재확인에만 쓰고, 7일이 지난 행은 다음 요청 때 지운다(가입 인증과 같은 정리 규칙).
CREATE TABLE IF NOT EXISTS "ParentPasswordReset" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "tokenHash" text NOT NULL UNIQUE,
  "phone" text NOT NULL,
  "phoneHash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "expiresAt" timestamptz(6) NOT NULL,
  "otpHash" text,
  "otpExpiresAt" timestamptz(6),
  "otpSentAt" timestamptz(6),
  "otpAttempts" integer NOT NULL DEFAULT 0,
  "lockedAt" timestamptz(6),
  "verifiedAt" timestamptz(6),
  "proofHash" text,
  "proofExpiresAt" timestamptz(6),
  "targetUserId" text,
  "consumedAt" timestamptz(6),
  "createdAt" timestamptz(6) NOT NULL DEFAULT NOW(),
  "updatedAt" timestamptz(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ParentPasswordReset_status_check"
    CHECK ("status" IN ('PENDING', 'VERIFIED', 'PROCESSING', 'CONSUMED', 'CANCELLED'))
);
CREATE INDEX IF NOT EXISTS "ParentPasswordReset_phoneHash_createdAt_idx"
  ON "ParentPasswordReset" ("phoneHash", "createdAt");

CREATE TABLE IF NOT EXISTS "ParentPasswordResetOtpSend" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "resetId" text NOT NULL,
  "phoneHash" text NOT NULL,
  "requestHash" text,
  "status" text NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ParentPasswordResetOtpSend_phoneHash_createdAt_idx"
  ON "ParentPasswordResetOtpSend" ("phoneHash", "createdAt");
CREATE INDEX IF NOT EXISTS "ParentPasswordResetOtpSend_requestHash_createdAt_idx"
  ON "ParentPasswordResetOtpSend" ("requestHash", "createdAt");

-- 서버(Prisma)만 읽고 쓴다. 공개 API(anon/authenticated)로는 보이지 않게 한다(가입 인증 테이블과 같은 설정).
ALTER TABLE "ParentPasswordReset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ParentPasswordReset" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ParentPasswordResetOtpSend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ParentPasswordResetOtpSend" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "ParentPasswordReset" FROM anon, authenticated;
REVOKE ALL ON TABLE "ParentPasswordResetOtpSend" FROM anon, authenticated;
