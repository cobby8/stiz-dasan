-- 토스 POS «현장 결제» 결제 취소(사이트 → POS) + 환불 확정 기록 칸 (2026-11-08 원장 지시
-- «사이트에서 결제 취소하면 POS 결제도 취소되게»).
-- 운영 적용: Supabase apply_migration (PM). 칸 추가만이라 기존 데이터는 바꾸지 않는다(전부 NULL 허용).
-- ⚠️ 이 칸들을 읽는 코드보다 **먼저** 적용해야 한다(현장 결제 조회·매칭 SQL 이 이 칸을 읽는다).
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS / 제약 존재 확인).
--
-- 되돌림 SQL:
--   ALTER TABLE "PosChargeRequest" DROP CONSTRAINT IF EXISTS "PosChargeRequest_cancelState_check";
--   ALTER TABLE "PosChargeRequest" DROP CONSTRAINT IF EXISTS "PosChargeRequest_cancelReportMessage_check";
--   ALTER TABLE "PosChargeRequest"
--     DROP COLUMN IF EXISTS "paidRecordedAt", DROP COLUMN IF EXISTS "cancelState",
--     DROP COLUMN IF EXISTS "cancelRequestedAt", DROP COLUMN IF EXISTS "cancelRequestedBy",
--     DROP COLUMN IF EXISTS "cancelClaimedAt", DROP COLUMN IF EXISTS "cancelClaimedByTokenId",
--     DROP COLUMN IF EXISTS "cancelReportedAt", DROP COLUMN IF EXISTS "cancelReportMessage",
--     DROP COLUMN IF EXISTS "refundedAt", DROP COLUMN IF EXISTS "refundNotifiedAt";

ALTER TABLE "PosChargeRequest"
  -- 요청이 PAID 로 «바뀐» 시각(DB 시계). paidAt 은 토스 승인 시각이라 이것과 다르다.
  ADD COLUMN IF NOT EXISTS "paidRecordedAt" TIMESTAMPTZ(6),
  -- 결제 취소 진행 상태. NULL = 취소 없음.
  -- ⚠️ 목록은 코드 CANCEL_STATE(src/lib/pos/charge-request.mjs)와 같아야 한다(테스트로 비교).
  --   REQUESTED 사이트에서 취소 요청 → SENT 플러그인이 가져감 → (토스 웹훅) DONE 환불 확정
  --   FAILED    플러그인이 취소하지 못함(POS 에서 직접 취소 안내)
  --   PARTIAL   분할 결제 중 일부만 취소됨(사람 확인)
  ADD COLUMN IF NOT EXISTS "cancelState" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelRequestedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancelRequestedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelClaimedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancelClaimedByTokenId" TEXT,
  -- 플러그인 보고(참고 기록만 — 환불 확정은 토스 웹훅 재조회로만)
  ADD COLUMN IF NOT EXISTS "cancelReportedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancelReportMessage" TEXT,
  -- 환불 확정 시각 · 환불 슬랙 알림 1회 표시
  ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "refundNotifiedAt" TIMESTAMPTZ(6);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PosChargeRequest_cancelState_check') THEN
    ALTER TABLE "PosChargeRequest" ADD CONSTRAINT "PosChargeRequest_cancelState_check"
      CHECK ("cancelState" IS NULL OR "cancelState" IN ('REQUESTED','SENT','FAILED','PARTIAL','DONE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PosChargeRequest_cancelReportMessage_check') THEN
    ALTER TABLE "PosChargeRequest" ADD CONSTRAINT "PosChargeRequest_cancelReportMessage_check"
      CHECK ("cancelReportMessage" IS NULL OR length("cancelReportMessage") <= 300);
  END IF;
END $$;

-- 플러그인 롱폴링이 «취소할 일»을 가볍게 찾는 인덱스(대부분 NULL 이라 작다)
CREATE INDEX IF NOT EXISTS "PosChargeRequest_cancelState_idx"
  ON "PosChargeRequest" ("cancelState", "cancelRequestedAt") WHERE "cancelState" IS NOT NULL;
