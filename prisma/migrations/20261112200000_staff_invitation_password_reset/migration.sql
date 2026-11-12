-- 직원 비밀번호 재설정(2026-11-12): 기존 초대의 문자 인증·1회 사용 절차를 그대로 쓰되,
-- 새 계정을 만들지 않고 이미 가입된 직원(targetUserId)의 로그인 비밀번호만 바꾼다.
ALTER TABLE "StaffInvitation"
  ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'SIGNUP',
  ADD COLUMN IF NOT EXISTS "targetUserId" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffInvitation_purpose_check') THEN
    ALTER TABLE "StaffInvitation"
      ADD CONSTRAINT "StaffInvitation_purpose_check"
        CHECK ("purpose" IN ('SIGNUP', 'PASSWORD_RESET')),
      ADD CONSTRAINT "StaffInvitation_reset_target_check"
        CHECK ("purpose" <> 'PASSWORD_RESET' OR "targetUserId" IS NOT NULL);
  END IF;
END $$;
