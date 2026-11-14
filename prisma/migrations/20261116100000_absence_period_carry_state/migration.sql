-- 부상·질병 «기간 결석» 복귀 정산 — 승인 상태와 정산 결과 칸 (2026-11-15 원장 승인)
--
-- 왜 필요한가: 기간 결석은 «인정(승인)»과 «금액 확정(정산)»을 나눈다. 승인은 금액 없이 먼저 하고,
-- 금액은 복귀한 뒤 한 번에 정한다. 새 표를 만들지 않고 "RegularAbsencePeriod" 에 칸 6개만 더한다.
--   carryState              NONE(기본) · APPROVED(인정, 금액 미정) · SETTLED(이월 확정) · REFUND_REVIEW(환불 검토) · REFUND_DONE
--   carryApprovedAt / carryApprovedByUserId   승인 시각·사람
--   carrySettledAt / carrySettledByUserId     확정 시각·사람
--   carrySettlement (jsonb)                    확정 때의 달별 표 사본
--
-- 멱등. 기존 행은 carryState='NONE' 으로 채워져 동작이 바뀌지 않는다. 적용: Supabase apply_migration 을 코드보다 먼저.
-- 코드는 이 칸들이 없으면(periodCarryColumnsReady) 새 기능만 숨기고 나머지는 그대로 돈다.
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "carryState" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "carryApprovedAt" TIMESTAMPTZ(6);
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "carryApprovedByUserId" TEXT;
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "carrySettledAt" TIMESTAMPTZ(6);
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "carrySettledByUserId" TEXT;
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "carrySettlement" JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RegularAbsencePeriod_carryState_check') THEN
    ALTER TABLE public."RegularAbsencePeriod" ADD CONSTRAINT "RegularAbsencePeriod_carryState_check"
      CHECK ("carryState" IN ('NONE','APPROVED','SETTLED','REFUND_REVIEW','REFUND_DONE'));
  END IF;
END $$;
-- 보류 판정·신청함 조회용(대부분 NONE 이라 작다)
CREATE INDEX IF NOT EXISTS "RegularAbsencePeriod_carryState_idx"
  ON public."RegularAbsencePeriod" ("studentId") WHERE "carryState" <> 'NONE';
-- RLS: 표는 이미 RLS 켜짐 + anon/authenticated 권한 회수 상태(20261109180000). 칸 추가라 더 할 것 없음.

-- 되돌림(먼저 SELECT count(*) FROM "RegularAbsencePeriod" WHERE "carryState" <> 'NONE' 이 0 인지 확인.
--  0 이 아니면 승인·정산 근거가 사라지므로 화면에서 먼저 승인 취소):
--   DROP INDEX IF EXISTS public."RegularAbsencePeriod_carryState_idx";
--   ALTER TABLE public."RegularAbsencePeriod" DROP CONSTRAINT IF EXISTS "RegularAbsencePeriod_carryState_check";
--   ALTER TABLE public."RegularAbsencePeriod" DROP COLUMN IF EXISTS "carrySettlement", DROP COLUMN IF EXISTS "carrySettledByUserId",
--     DROP COLUMN IF EXISTS "carrySettledAt", DROP COLUMN IF EXISTS "carryApprovedByUserId",
--     DROP COLUMN IF EXISTS "carryApprovedAt", DROP COLUMN IF EXISTS "carryState";
