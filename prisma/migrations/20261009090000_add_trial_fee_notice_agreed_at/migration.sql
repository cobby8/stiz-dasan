-- 학부모의 「체험비·입금 계좌 확인」 체크를 실제 입금 확인(trialFeeConfirmed)과 분리한다.
-- 새 칸만 추가한다(기존 데이터는 건드리지 않음). 운영에는 ensureTrialLeadTable 의
-- ADD COLUMN IF NOT EXISTS 로도 생기므로 IF NOT EXISTS 로 둘 다 안전하게 만든다.
ALTER TABLE "TrialLead" ADD COLUMN IF NOT EXISTS "trialFeeNoticeAgreedAt" TIMESTAMPTZ(6);
