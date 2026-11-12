-- 기존 학부모 계정 활성화에도 신규 가입과 같은 필수 동의(이용약관·개인정보·만 14세)를 기록한다(2026-11-13 a3).
-- 칸 이름·형식은 ParentSignupVerification 과 같다. 기존 행은 비워 둔다(소급 동의로 채우지 않는다).
ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "termsAgreedAt" TIMESTAMPTZ;
ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;
ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "privacyAgreedAt" TIMESTAMPTZ;
ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "privacyVersion" TEXT;
ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "ageConfirmedAt" TIMESTAMPTZ;
