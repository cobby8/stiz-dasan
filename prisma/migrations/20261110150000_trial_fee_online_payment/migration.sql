-- 체험비 온라인 결제 + 체험·등록 안내 자동 발송 준비 (2026-11-10 원장 결정표 m8)
--
-- ■ 무엇을 바꾸나
--   1) TrialLead: 결제 링크 토큰 해시(paymentTokenHash) · 체험비 온라인 결제 요약(trialFeePaymentStatus) · 결제 완료 시각(trialFeePaidAt)
--   2) TrialFeePayment(새 표): 체험비 토스 주문 1건 = 1행. 청구 거래표(PaymentTransaction)는 청구·청구서·학생 id 가 필수라
--      아직 원생이 아닌 체험 신청자를 담을 수 없어 따로 둔다(모양·상태 이름은 같게).
--   3) AcademySettings: 체험비 금액(trialFeeAmount, 기본 10000) · 온라인 결제 켜기(기본 false)
--      · 안내 자동 발송 스위치 2개(기본 false — 원장 문구 승인 전)
--   4) MessageAutomationRule: 안내 문자 규칙 2개를 «꺼짐(isActive=false)»으로 추가(스위치를 켜도 규칙이 꺼져 있으면 안 나간다)
--
-- ■ 이중 확정 방지(DB 마지막 방어선): 신청당 결제 완료(DONE) 1건 · 입금 대기 계좌(WAITING_FOR_DEPOSIT) 1건 — 부분 유일 인덱스
--
-- 운영 적용: Supabase apply_migration (PM). 칸·표·인덱스 추가만 — 기존 행 값은 바꾸지 않는다(규칙 2행 INSERT 만).
-- ⚠️ 코드보다 «먼저» 적용 권장. 코드는 칸이 없어도 공개 신청 화면이 죽지 않게 짰지만(설정 SELECT * · 토큰 발급 실패 = 계좌 안내),
--    관리자 체험비 설정 저장·결제 화면은 이 표·칸이 있어야 동작한다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS · ON CONFLICT DO NOTHING).
--
-- 되돌림 SQL(체험비 온라인 결제가 한 건도 없을 때만 — 있으면 결제 기록이 사라진다):
--   SELECT count(*) FROM "TrialFeePayment";   -- 0 인지 먼저 확인
--   DROP TABLE IF EXISTS "TrialFeePayment";
--   DROP INDEX IF EXISTS "TrialLead_paymentTokenHash_key";
--   ALTER TABLE "TrialLead" DROP CONSTRAINT IF EXISTS "TrialLead_trialFeePaymentStatus_check";
--   ALTER TABLE "TrialLead" DROP COLUMN IF EXISTS "paymentTokenHash", DROP COLUMN IF EXISTS "trialFeePaymentStatus", DROP COLUMN IF EXISTS "trialFeePaidAt";
--   ALTER TABLE "AcademySettings" DROP COLUMN IF EXISTS "trialFeeAmount", DROP COLUMN IF EXISTS "trialOnlinePaymentEnabled",
--     DROP COLUMN IF EXISTS "trialGuideAutoSend", DROP COLUMN IF EXISTS "enrollGuideAutoSend";
--   DELETE FROM "MessageAutomationRule" WHERE trigger IN ('TRIAL_PAID_GUIDE_PARENT', 'ENROLL_WELCOME_GUIDE_PARENT');

-- ── 1) TrialLead ────────────────────────────────────────────────────────────
ALTER TABLE "TrialLead" ADD COLUMN IF NOT EXISTS "paymentTokenHash" TEXT;
ALTER TABLE "TrialLead" ADD COLUMN IF NOT EXISTS "trialFeePaymentStatus" TEXT;
ALTER TABLE "TrialLead" ADD COLUMN IF NOT EXISTS "trialFeePaidAt" TIMESTAMPTZ(6);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrialLead_trialFeePaymentStatus_check') THEN
    ALTER TABLE "TrialLead" ADD CONSTRAINT "TrialLead_trialFeePaymentStatus_check"
      CHECK ("trialFeePaymentStatus" IS NULL OR "trialFeePaymentStatus" IN ('WAITING_FOR_DEPOSIT', 'PAID', 'REFUNDED', 'NEEDS_REFUND'));
  END IF;
END $$;

-- 결제 링크 토큰(해시)으로 신청 찾기 — 같은 해시가 두 신청에 붙지 않게 유일
CREATE UNIQUE INDEX IF NOT EXISTS "TrialLead_paymentTokenHash_key" ON "TrialLead" ("paymentTokenHash") WHERE "paymentTokenHash" IS NOT NULL;

-- ── 2) TrialFeePayment ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TrialFeePayment" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- 신청을 지워도(관리자 «삭제») 돈 기록은 남긴다 → 연결만 끊는다
  "trialLeadId" TEXT REFERENCES "TrialLead"(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'TOSS',
  "orderId" TEXT NOT NULL UNIQUE CHECK ("orderId" ~ '^TRIAL-[A-Za-z0-9]{6,32}$'),
  "paymentKey" TEXT UNIQUE,
  -- 결제 시작 순간의 설정 금액 스냅샷 · 면세 금액(taxFreeAmountFor — 지금은 전액 면세)
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1000 AND 100000),
  "taxFreeAmount" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY'
    CHECK (status IN ('READY', 'WAITING_FOR_DEPOSIT', 'DONE', 'CANCELED', 'EXPIRED', 'FAILED', 'NEEDS_REFUND')),
  method TEXT,
  "receiptUrl" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  -- 토스 승인 «진행 중» 표시(두 탭 동시 승인 방지, 10분)
  "confirmStartedAt" TIMESTAMPTZ(6),
  "approvedAt" TIMESTAMPTZ(6),
  "canceledAt" TIMESTAMPTZ(6),
  -- 토스 응답(secret 원문은 지우고 무통장 입금 알림 대조용 해시만 — buildIssuedRawResponse)
  "rawResponse" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "TrialFeePayment_taxfree_check" CHECK ("taxFreeAmount" BETWEEN 0 AND amount)
);

CREATE INDEX IF NOT EXISTS "TrialFeePayment_trialLeadId_idx" ON "TrialFeePayment" ("trialLeadId", "createdAt");
-- 신청당 결제 완료 1건 · 열린 입금 계좌 1건(이중 확정·이중 입금의 DB 방어선)
CREATE UNIQUE INDEX IF NOT EXISTS "TrialFeePayment_one_done_per_lead" ON "TrialFeePayment" ("trialLeadId") WHERE status = 'DONE';
CREATE UNIQUE INDEX IF NOT EXISTS "TrialFeePayment_one_waiting_per_lead" ON "TrialFeePayment" ("trialLeadId") WHERE status = 'WAITING_FOR_DEPOSIT';

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "TrialFeePayment" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TrialFeePayment" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "TrialFeePayment" FROM %I', r);
  END IF;
END LOOP; END $$;

-- ── 3) AcademySettings ──────────────────────────────────────────────────────
ALTER TABLE "AcademySettings" ADD COLUMN IF NOT EXISTS "trialFeeAmount" INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE "AcademySettings" ADD COLUMN IF NOT EXISTS "trialOnlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AcademySettings" ADD COLUMN IF NOT EXISTS "trialGuideAutoSend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AcademySettings" ADD COLUMN IF NOT EXISTS "enrollGuideAutoSend" BOOLEAN NOT NULL DEFAULT false;

-- ── 4) 안내 문자 규칙(꺼짐) ─────────────────────────────────────────────────
INSERT INTO "MessageAutomationRule"
  (id, trigger, name, "audienceScope", target, "isActive", "requestedChannel", "fallbackEnabled", "fallbackChannel", "templateId", description, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'TRIAL_PAID_GUIDE_PARENT', '체험 확정 안내 (학부모)', 'EXTERNAL', 'PARENT', false, 'SMS', true, 'SMS', NULL,
   '체험비 결제 완료 직후 위치·준비물·확정 안내(원장 문구 승인 전 — 꺼짐)', now(), now()),
  (gen_random_uuid()::text, 'ENROLL_WELCOME_GUIDE_PARENT', '등록 안내 (학부모)', 'EXTERNAL', 'PARENT', false, 'SMS', true, 'SMS', NULL,
   '수강 등록 안내 — 담당 코치·셔틀 기사님 연락처 자동(원장 문구 승인 전 — 꺼짐)', now(), now())
ON CONFLICT (trigger) DO NOTHING;
