-- 휴원 수강료 처리(이월·환불·없음) 기록 — 2026-11-10 원장 결정 m6.
--
-- ■ 무엇
--   원장이 휴원을 승인할 때 «이번 휴원으로 생기는 수강료 처리»를 고른다. 금액은 서버가 계산하고
--   (그 청구 금액 ÷ 그 수강월 수업 수 × 빠지는 수업 수 — src/lib/enrollment/pause-settlement-plan.ts),
--   이 표에 «무엇을·얼마·언제·누가»를 남긴다.
--   EnrollmentChangeSettlement      = 휴원 신청 1건당 1행(UNIQUE requestId — 두 번 처리 금지)
--   EnrollmentChangeSettlementLine  = 청구별 줄: 환불(토스 부분 취소/사람 할 일)·이월 적립·미납 감액·이월 차감·기록만
--
-- ■ 왜 기존 이월 표(BillingCarryCredit)를 쓰지 않나
--   그 표는 «결석 1건»(absenceId NOT NULL UNIQUE)에 묶여 있고, 청구 준비(workbench) 저장 구조와 함께
--   운영에 아직 적용하지 않은 준비 파일(src/lib/billing/workbench-schema.sql)이다. 휴원은 결석이 아니라 기간이라
--   그 표에 넣으려면 제약을 바꿔야 한다 → 휴원 처리만의 작은 표 두 개로 둔다(기존 표·칸은 하나도 바꾸지 않는다).
--
-- ■ 지우기
--   청구를 지워도(관리자 «기록 영구 삭제») 이 표 때문에 막히지 않게 paymentId 는 ON DELETE SET NULL.
--   휴원 신청 행이 지워지면 처리 기록도 함께 지운다(CASCADE).
--
-- 운영 적용: Supabase apply_migration (PM). 표·인덱스 추가만 — 기존 행은 바꾸지 않는다. 여러 번 실행해도 같은 결과.
--   새 코드는 표가 없으면(to_regclass) 미리보기만 보여 주고 «처리 실행»을 막는다 — 적용 순서가 바뀌어도 화면은 열린다.
--
-- 사전 확인(SELECT):
--   SELECT to_regclass('public."EnrollmentChangeSettlement"'), to_regclass('public."EnrollmentChangeSettlementLine"');
-- 되돌림 SQL(처리 기록이 하나도 없을 때만 — 있으면 환불·이월 근거가 사라진다):
--   SELECT count(*) FROM "EnrollmentChangeSettlement";   -- 0 인지 먼저 확인
--   DROP TABLE IF EXISTS "EnrollmentChangeSettlementLine";
--   DROP TABLE IF EXISTS "EnrollmentChangeSettlement";

CREATE TABLE IF NOT EXISTS "EnrollmentChangeSettlement" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "requestId" TEXT NOT NULL REFERENCES "EnrollmentChangeRequest"(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL,
  mode TEXT NOT NULL,
  -- 이미 낸 청구에서 빠지는 금액(이월·환불 대상) · 미납 청구에서 줄인 금액
  "paidAmount" INTEGER NOT NULL,
  "unpaidAmount" INTEGER NOT NULL,
  -- 이월 중 아직 다음 청구에서 차감하지 못한 금액(0 이 되면 이월 끝)
  "carryRemaining" INTEGER NOT NULL DEFAULT 0,
  -- 이 수강월 «뒤»의 미납 청구에서 이월을 차감한다("YYYY-MM")
  "carryAfterYm" TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  -- 원장이 본 미리보기의 지문(실행 순간 다시 계산한 값과 같아야 실행)
  "previewKey" TEXT NOT NULL,
  -- 계산 근거(휴원 시작·복귀일, 청구별 수업일·금액)
  basis JSONB NOT NULL,
  "decidedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "EnrollmentChangeSettlement_requestId_key" UNIQUE ("requestId"),
  CONSTRAINT "EnrollmentChangeSettlement_mode_check" CHECK (mode IN ('CARRY', 'REFUND', 'NONE')),
  CONSTRAINT "EnrollmentChangeSettlement_status_check" CHECK (status IN ('OPEN', 'DONE')),
  CONSTRAINT "EnrollmentChangeSettlement_amount_check" CHECK ("paidAmount" >= 0 AND "unpaidAmount" >= 0
    AND "carryRemaining" >= 0 AND "carryRemaining" <= "paidAmount"),
  CONSTRAINT "EnrollmentChangeSettlement_carry_mode_check" CHECK (mode = 'CARRY' OR "carryRemaining" = 0)
);

CREATE TABLE IF NOT EXISTS "EnrollmentChangeSettlementLine" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "settlementId" TEXT NOT NULL REFERENCES "EnrollmentChangeSettlement"(id) ON DELETE CASCADE,
  "paymentId" TEXT REFERENCES "Payment"(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  -- 이 줄이 뺀 수업일(같은 청구에서 다른 휴원 처리가 같은 날을 두 번 빼지 않게)
  "missedDates" JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 토스 부분 취소에 쓴 거래(PaymentTransaction.id)
  "transactionId" TEXT,
  message TEXT,
  "doneByUserId" TEXT,
  "doneAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "EnrollmentChangeSettlementLine_kind_check"
    CHECK (kind IN ('REFUND', 'CARRY_CREDIT', 'UNPAID_REDUCE', 'NONE', 'CARRY_APPLY', 'CARRY_MANUAL')),
  CONSTRAINT "EnrollmentChangeSettlementLine_channel_check"
    CHECK (channel IN ('TOSS', 'TOSS_VA', 'TOSS_POS', 'RALLYZ', 'MANUAL', 'SITE')),
  CONSTRAINT "EnrollmentChangeSettlementLine_status_check"
    CHECK (status IN ('DONE', 'TODO', 'REQUESTED', 'FAILED', 'DONE_MANUAL')),
  CONSTRAINT "EnrollmentChangeSettlementLine_amount_check" CHECK (amount >= 0),
  -- 한 처리에서 같은 청구·같은 종류는 한 줄(환불 두 번·감액 두 번 금지)
  CONSTRAINT "EnrollmentChangeSettlementLine_unique_key" UNIQUE ("settlementId", "paymentId", kind)
);

CREATE INDEX IF NOT EXISTS "EnrollmentChangeSettlementLine_paymentId_idx" ON "EnrollmentChangeSettlementLine" ("paymentId");
-- 관리자 «수강료 처리 남은 일»(사람 할 일·결과 확인 중·실패) — 대부분 DONE 이라 작다
CREATE INDEX IF NOT EXISTS "EnrollmentChangeSettlementLine_open_idx"
  ON "EnrollmentChangeSettlementLine" ("settlementId") WHERE status IN ('TODO', 'REQUESTED', 'FAILED');
-- 이월이 남은 처리(매일 크론이 다음 청구에서 차감)
CREATE INDEX IF NOT EXISTS "EnrollmentChangeSettlement_carry_open_idx"
  ON "EnrollmentChangeSettlement" ("studentId") WHERE "carryRemaining" > 0;

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "EnrollmentChangeSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EnrollmentChangeSettlementLine" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "EnrollmentChangeSettlement", "EnrollmentChangeSettlementLine" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "EnrollmentChangeSettlement", "EnrollmentChangeSettlementLine" FROM %I', r);
  END IF;
END LOOP; END $$;
