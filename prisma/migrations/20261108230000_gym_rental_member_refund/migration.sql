-- 체육관 대관: 재원생 무료 대관 · 보증금 환불 계좌 · 개인정보 동의 · 거절 사유 · 신청자 문자 결과 (2026-11-08 원장 승인)
-- 운영 적용: Supabase apply_migration. 컬럼 추가(전부 비어 있어도 되거나 기본값 있음) + 문자 규칙 1건 추가만이라
-- 기존 행·기존 규칙은 바꾸지 않는다. 여러 번 실행해도 같은 결과(IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- 컬럼
--   memberFree         재원생 무료 대관(로그인한 학부모 계정의 연결 학생이 재원 중일 때만 true — 서버 확인)
--   memberStudentId    확인된 학생 id(관리자 화면 «재원생 무료(학생명)» 표시용)
--   applicantUserId    로그인해서 신청한 계정(User.id). 비로그인 신청은 비어 있다
--   refundBank/refundAccount(숫자만)/refundHolder  보증금 환불 계좌(보증금 있는 신청만)
--   privacyAgreedAt    개인정보 수집·이용 동의 시각
--   rejectReason       거절 사유(신청자 거절 문자에 그대로 나간다)
--   applicantSmsStatus 마지막 신청자 문자 결과 «SENT|FAILED|OFF:approved|rejected|confirmed»
--
-- 되돌림 SQL:
--   DELETE FROM "MessageAutomationRule" WHERE trigger = 'RENTAL_REJECTED_APPLICANT';
--   ALTER TABLE "GymRentalRequest" DROP CONSTRAINT IF EXISTS "GymRentalRequest_refund_account_check";
--   ALTER TABLE "GymRentalRequest"
--     DROP COLUMN IF EXISTS "memberFree", DROP COLUMN IF EXISTS "memberStudentId",
--     DROP COLUMN IF EXISTS "refundBank", DROP COLUMN IF EXISTS "refundAccount", DROP COLUMN IF EXISTS "refundHolder",
--     DROP COLUMN IF EXISTS "privacyAgreedAt", DROP COLUMN IF EXISTS "rejectReason", DROP COLUMN IF EXISTS "applicantSmsStatus",
--     DROP COLUMN IF EXISTS "applicantUserId";

ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "memberFree" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "memberStudentId" TEXT;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "refundBank" TEXT;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "refundAccount" TEXT;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "refundHolder" TEXT;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "privacyAgreedAt" TIMESTAMPTZ(6);
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "rejectReason" TEXT;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "applicantSmsStatus" TEXT;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "applicantUserId" TEXT;

DO $$
BEGIN
  -- 계좌번호는 숫자 10~16자리만(비어 있으면 통과 — 재원생 무료·옛 행)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GymRentalRequest_refund_account_check') THEN
    ALTER TABLE "GymRentalRequest" ADD CONSTRAINT "GymRentalRequest_refund_account_check"
      CHECK ("refundAccount" IS NULL OR "refundAccount" ~ '^[0-9]{10,16}$');
  END IF;
END $$;

-- 거절 안내 문자 규칙(/admin/sms 목록에 «체육관 대관 거절 안내 (신청자)» 로 뜬다). 다른 신청자 문자처럼 꺼진 채로 만든다.
-- 실제 발송은 환경변수 RENTAL_APPLICANT_SMS_ENABLED=1 + 이 규칙 켜기 둘 다 있어야 한다.
INSERT INTO "MessageAutomationRule"
  (id, trigger, name, "audienceScope", target, "isActive", "requestedChannel", "fallbackEnabled", "fallbackChannel", "templateId", description, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'RENTAL_REJECTED_APPLICANT', '체육관 대관 거절 안내 (신청자)', 'EXTERNAL', 'PARENT', false, 'SMS', true, 'SMS', NULL,
   '원장 거절 시 신청자에게 사유와 다시 신청 안내', now(), now())
ON CONFLICT (trigger) DO NOTHING;
