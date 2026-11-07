-- 토스 POS «현장 결제» 묶음 — 같은 학생의 미납 청구 여러 건을 POS 결제 한 번으로 (2026-11-08 원장 결정
-- «같은 학생이면 한 번에 결제»).
--
-- ■ 모양
--   PosChargeRequest 1건(번호·합계·면세 합계·상태) ─ PosChargeRequestItem N건(청구서별 금액·면세).
--   요청의 "paymentId" 는 그대로 두고 «대표 청구»(항목 1번)를 넣는다 → 기존 단건 코드·인덱스가 그대로 동작한다.
--   단건 요청도 항목 1개로 같이 적는다(새 코드). 이 파일 적용 전에 만든 요청은 아래 «채우기»로 항목 1개를 만든다.
--
-- ■ 같은 청구가 두 «열린» 요청에 들어가지 않게
--   부분 유일 인덱스는 다른 표(요청 상태)를 볼 수 없어서, 항목에 "open" 표시를 두고 «"open" = true 인 항목의
--   paymentId 는 하나»로 막는다. 요청이 열린 상태(PENDING·SENT)를 벗어나면 트리거가 그 요청의 항목을 open=false 로 바꾼다
--   (만료·취소·납부·보류 — 상태를 바꾸는 UPDATE 가 어디서 오든 빠짐없이). 열린 상태로 «되돌아가는» 길은 없다.
--   ⚠️ 열린 상태 목록은 코드 OPEN_CHARGE_STATUSES(src/lib/pos/charge-request.mjs)와 같아야 한다(테스트로 비교).
--
-- 운영 적용: Supabase apply_migration (PM). 표·트리거 추가 + 기존 요청의 항목 채우기(INSERT 만)라 기존 행은 바꾸지 않는다.
-- ⚠️ 새 코드보다 «먼저» 적용해야 한다(새 코드가 이 표를 읽고 쓴다). 새 코드는 항목이 없는 요청을 «항목 1개»로 읽어
--    적용 전후 틈에 옛 코드가 만든 요청도 그대로 처리한다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR REPLACE).
--
-- 되돌림 SQL:
--   DROP TRIGGER IF EXISTS "PosChargeRequest_close_items_trg" ON "PosChargeRequest";
--   DROP FUNCTION IF EXISTS pos_charge_request_close_items();
--   DROP TABLE IF EXISTS "PosChargeRequestItem";

CREATE TABLE IF NOT EXISTS "PosChargeRequestItem" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "requestId" TEXT NOT NULL REFERENCES "PosChargeRequest"(id) ON DELETE CASCADE,
  "paymentId" TEXT NOT NULL REFERENCES "Payment"(id) ON DELETE CASCADE,
  -- 요청 순간의 청구 금액(서버 DB 값 스냅샷) · 면세 금액(taxFreeAmountFor)
  amount INTEGER NOT NULL CHECK (amount > 0),
  "taxFreeAmount" INTEGER NOT NULL,
  -- POS 주문 항목 순서(1부터). 1번 = 요청의 대표 청구("PosChargeRequest"."paymentId")
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
  -- 요청이 열려 있나(PENDING·SENT). 트리거가 닫는다. 같은 청구의 «열린 항목»은 하나만(아래 유일 인덱스)
  "open" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PosChargeRequestItem_taxfree_check" CHECK ("taxFreeAmount" BETWEEN 0 AND amount),
  CONSTRAINT "PosChargeRequestItem_request_payment_key" UNIQUE ("requestId", "paymentId"),
  CONSTRAINT "PosChargeRequestItem_request_position_key" UNIQUE ("requestId", position)
);

-- 같은 청구서는 열린 요청 하나에만(단건이든 묶음이든)
CREATE UNIQUE INDEX IF NOT EXISTS "PosChargeRequestItem_open_payment_key"
  ON "PosChargeRequestItem" ("paymentId") WHERE "open";
-- 청구서 → 요청 찾기(관리자 창·결제 취소·미납 목록)
CREATE INDEX IF NOT EXISTS "PosChargeRequestItem_paymentId_idx" ON "PosChargeRequestItem" ("paymentId");

-- 요청이 열린 상태를 벗어나면 그 요청의 항목을 닫는다
CREATE OR REPLACE FUNCTION pos_charge_request_close_items() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PENDING','SENT') THEN
    UPDATE "PosChargeRequestItem" SET "open" = false WHERE "requestId" = NEW.id AND "open";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "PosChargeRequest_close_items_trg" ON "PosChargeRequest";
CREATE TRIGGER "PosChargeRequest_close_items_trg"
  AFTER UPDATE OF status ON "PosChargeRequest"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION pos_charge_request_close_items();

-- 채우기: 이 파일 적용 전에 만든 요청(전부 단건)에 항목 1개. 열린 요청만 open=true.
INSERT INTO "PosChargeRequestItem" ("requestId", "paymentId", amount, "taxFreeAmount", position, "open", "createdAt")
SELECT r.id, r."paymentId", r.amount, r."taxFreeAmount", 1, r.status IN ('PENDING','SENT'), r."createdAt"
  FROM "PosChargeRequest" r
 WHERE NOT EXISTS (SELECT 1 FROM "PosChargeRequestItem" i WHERE i."requestId" = r.id)
ON CONFLICT DO NOTHING;

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "PosChargeRequestItem" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "PosChargeRequestItem" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "PosChargeRequestItem" FROM %I', r);
  END IF;
END LOOP; END $$;
