-- 학부모 온라인 «묶음 결제» — 미납 청구 여러 건(형제 포함)을 토스 결제 한 번으로 (2026-11-09 원장 결정 D2~D5).
--
-- ■ 모양 (POS 묶음 PosChargeRequest / PosChargeRequestItem 과 같은 구조)
--   PaymentTransaction 1건(토스 주문: 대표 청구 = 1번 항목의 paymentId·invoiceId, amount = 합계)
--   ─ PaymentTransactionItem N건(청구·청구서별 금액·면세 금액 스냅샷).
--   기존 PaymentTransaction 은 칸을 하나도 바꾸지 않는다 → 항목이 없는 거래 = 옛 단건 거래(지금 코드 그대로 동작).
--   면세 = 항목 taxFreeAmount 의 합(src/lib/payments/checkoutBundle.ts bundleTotals).
--
-- ■ 지우기
--   거래를 지우면 항목도 지운다(관리자 «기록 영구 삭제»가 대표 청구의 거래를 지운다).
--   청구·청구서를 지워도 항목만 지운다 — 기존 삭제 기능이 이 표 때문에 막히지 않게. 그 묶음 주문은 합계가 맞지 않게 되어
--   결제가 들어와도 자동 반영하지 않고 «확인 필요»로 넘어간다(decideBundleFinalize BUNDLE_AMOUNT_MISMATCH).
--
-- 운영 적용: Supabase apply_migration (PM). 표·인덱스 추가만 — 기존 행은 바꾸지 않는다.
-- ⚠️ 새 코드보다 «먼저» 적용해야 한다. 새 코드는 단건 경로(열린 가상계좌 조회·결제 확정·마이페이지·관리자 수납 목록)에서도
--    이 표를 읽는다 — 표가 없으면 그 조회가 실패한다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS).
--
-- 되돌림 SQL(묶음 주문이 하나도 없을 때만 — 있으면 그 거래들의 묶인 청구 정보가 사라진다):
--   SELECT count(*) FROM "PaymentTransactionItem";   -- 0 인지 먼저 확인
--   DROP TABLE IF EXISTS "PaymentTransactionItem";

CREATE TABLE IF NOT EXISTS "PaymentTransactionItem" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "transactionId" TEXT NOT NULL REFERENCES "PaymentTransaction"(id) ON DELETE CASCADE,
  "paymentId" TEXT NOT NULL REFERENCES "Payment"(id) ON DELETE CASCADE,
  "invoiceId" TEXT NOT NULL REFERENCES "PaymentInvoice"(id) ON DELETE CASCADE,
  -- 결제 시작 순간의 청구 금액(서버 DB 값 스냅샷) · 면세 금액(taxFreeAmountFor)
  amount INTEGER NOT NULL CHECK (amount > 0),
  "taxFreeAmount" INTEGER NOT NULL,
  -- 주문 항목 순서(1부터). 1번 = 거래의 대표 청구. 상한 10건(원장 결정 D5) — 코드 MAX_BUNDLE_ITEMS 와 같다(테스트로 비교)
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PaymentTransactionItem_taxfree_check" CHECK ("taxFreeAmount" BETWEEN 0 AND amount),
  CONSTRAINT "PaymentTransactionItem_tx_payment_key" UNIQUE ("transactionId", "paymentId"),
  CONSTRAINT "PaymentTransactionItem_tx_position_key" UNIQUE ("transactionId", position)
);

-- 청구 → 묶음 주문 찾기(열린 가상계좌 확인·마이페이지·관리자 수납 목록)
CREATE INDEX IF NOT EXISTS "PaymentTransactionItem_paymentId_idx" ON "PaymentTransactionItem" ("paymentId");
-- 청구서 → 묶음 주문 찾기(결제 화면의 열린 계좌 조회·계좌 닫기)
CREATE INDEX IF NOT EXISTS "PaymentTransactionItem_invoiceId_idx" ON "PaymentTransactionItem" ("invoiceId");

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "PaymentTransactionItem" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "PaymentTransactionItem" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "PaymentTransactionItem" FROM %I', r);
  END IF;
END LOOP; END $$;
