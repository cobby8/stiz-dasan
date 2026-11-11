-- POS 미결제 요청 취소의 처리 상태. 승인된 결제의 환불 상태와 독립적으로 기록한다.
ALTER TABLE "PosChargeRequest"
  ADD COLUMN "dismissState" text,
  ADD COLUMN "dismissReportedAt" timestamptz(6),
  ADD COLUMN "dismissReportMessage" text,
  ADD CONSTRAINT "PosChargeRequest_dismiss_state_check"
    CHECK ("dismissState" IN ('REQUESTED', 'DONE', 'FAILED', 'NEEDS_LOCAL_CANCEL', 'ACKNOWLEDGED'));

CREATE INDEX "PosChargeRequest_pending_dismissal_idx"
  ON "PosChargeRequest" ("claimedByTokenId", "cancelledAt")
  WHERE "dismissState" = 'REQUESTED';

-- POS에 이전 주문이 남아 있는 동안 같은 청구를 다시 보내면 이중 결제가 생길 수 있다.
-- 취소 확인 전에는 기존 open 항목 유일 인덱스의 예약을 유지한다.
CREATE OR REPLACE FUNCTION pos_charge_request_close_items() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PENDING', 'SENT')
     AND COALESCE(NEW."dismissState", '') NOT IN ('REQUESTED', 'FAILED', 'NEEDS_LOCAL_CANCEL') THEN
    UPDATE "PosChargeRequestItem" SET "open" = false WHERE "requestId" = NEW.id AND "open";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER "PosChargeRequest_close_items_trg" ON "PosChargeRequest";
CREATE TRIGGER "PosChargeRequest_close_items_trg"
  AFTER UPDATE OF status, "dismissState" ON "PosChargeRequest"
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD."dismissState" IS DISTINCT FROM NEW."dismissState"
  )
  EXECUTE FUNCTION pos_charge_request_close_items();

-- 단말이 메모의 짧은 번호로 기존 주문을 찾으므로 취소 확인 전까지 그 번호도 예약한다.
DROP INDEX "PosChargeRequest_open_shortCode_key";
CREATE UNIQUE INDEX "PosChargeRequest_open_shortCode_key" ON "PosChargeRequest" ("shortCode")
  WHERE status IN ('PENDING', 'SENT') OR "dismissState" IN ('REQUESTED', 'FAILED', 'NEEDS_LOCAL_CANCEL');
