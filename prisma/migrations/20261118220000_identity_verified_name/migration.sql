-- 본인인증 실명·시각 보관 (2026-11-18 원장 결정 «가입·본인인증 통일»).
--
-- 왜: User.name 은 이제 «닉네임»(본인이 고칠 수 있는 이름)이다. 결제창 이름 등 실제 이름이 필요한 곳은
--     본인인증(포트원) 결과의 실명을 따로 적어 두고 그것을 먼저 쓴다. 처리방침은 d4325dd3 에서 먼저 고쳤다.
--     CI·생년월일은 저장하지 않는다(실명과 인증 시각만).
-- 가입 요청 표: 어떤 인증으로 통과했는지(문자 SMS / 본인인증 IDENTITY)와, 본인인증이면 그 실명을 계정이 만들어질 때까지 들고 간다.
--     실명은 7일 뒤 개인정보 정리(purgeStaleSignupPersonalData)에서 함께 비운다.
-- 활성화 증표 표(ParentAccountClaim): 본인인증으로 만든 증표에 실명·인증 시각을 실어 두었다가, 활성화를 «끝까지 마칠 때»
--     User 로 옮기고 비운다. 중단·만료되면 User 에는 남지 않고, 만료된 증표의 실명은 같은 정리에서 비운다.
-- 안전: 칸·제약을 «추가»만 한다. 몇 번 실행해도 같다. 기존 행은 모두 NULL 이라 CHECK 를 통과한다.
--     ⚠️ 이 칸을 읽는 코드보다 «먼저» 운영 DB 에 적용해야 한다(없는 칸을 읽으면 결제·가입 SQL 이 실패한다).
--
-- ── 되돌림 SQL(필요할 때만 — 코드도 함께 되돌린 뒤) ──
-- ALTER TABLE "ParentAccountClaim" DROP COLUMN IF EXISTS "identityVerifiedAt";
-- ALTER TABLE "ParentAccountClaim" DROP COLUMN IF EXISTS "verifiedName";
-- ALTER TABLE "ParentSignupVerification" DROP CONSTRAINT IF EXISTS "ParentSignupVerification_verificationMethod_check";
-- ALTER TABLE "ParentSignupVerification" DROP COLUMN IF EXISTS "verificationMethod";
-- ALTER TABLE "ParentSignupVerification" DROP COLUMN IF EXISTS "verifiedName";
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "identityVerifiedName";
-- ALTER TABLE "User" DROP COLUMN IF EXISTS "identityVerifiedAt";

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "identityVerifiedAt" TIMESTAMPTZ(6);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "identityVerifiedName" TEXT;

ALTER TABLE "ParentSignupVerification" ADD COLUMN IF NOT EXISTS "verifiedName" TEXT;
ALTER TABLE "ParentSignupVerification" ADD COLUMN IF NOT EXISTS "verificationMethod" TEXT;

ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "verifiedName" TEXT;
ALTER TABLE "ParentAccountClaim" ADD COLUMN IF NOT EXISTS "identityVerifiedAt" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ParentSignupVerification_verificationMethod_check'
  ) THEN
    ALTER TABLE "ParentSignupVerification"
      ADD CONSTRAINT "ParentSignupVerification_verificationMethod_check"
      CHECK ("verificationMethod" IN ('SMS', 'IDENTITY'));
  END IF;
END $$;
