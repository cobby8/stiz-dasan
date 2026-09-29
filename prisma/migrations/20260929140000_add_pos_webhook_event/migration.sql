-- 토스플레이스 웹훅 수신 기록.
--
-- 왜 필요한가: 토스는 우리 서버가 2xx 로 답하지 않으면 **같은 알림을 다시 보낸다**.
-- 받은 기록이 없으면 같은 결제를 두 번 처리하게 된다. 그래서 토스가 주는
-- 사건 번호(x-toss-webhook-id)를 유일값으로 걸어 "이미 받은 것"을 DB 가 막는다.
-- (재시도마다 바뀌는 것은 delivery-id 이고, webhook-id 는 그대로다)
--
-- 이 표는 받은 사실만 남긴다. 청구서·결제를 바꾸는 값은 들어가지 않는다.

BEGIN;

CREATE TABLE IF NOT EXISTS "PosWebhookEvent" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- 중복 방지의 핵심. 같은 사건이 두 번 와도 두 번째는 INSERT 가 막힌다.
  "webhookId"    TEXT NOT NULL,
  "deliveryId"   TEXT,
  "eventId"      TEXT,
  "eventType"    TEXT,
  "merchantId"   TEXT,
  "payload"      JSONB NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'RECEIVED',
  "note"         TEXT,
  "receivedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processedAt"  TIMESTAMPTZ,

  -- RECEIVED: 받아서 저장함 / IGNORED: 관심 없는 종류라 넘김
  -- MATCHED·HELD: 다음 단계(청구서 연결)에서 쓸 값. 지금은 쓰지 않는다.
  CONSTRAINT "PosWebhookEvent_status_check"
    CHECK ("status" IN ('RECEIVED', 'IGNORED', 'MATCHED', 'HELD'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "PosWebhookEvent_webhookId_key" ON "PosWebhookEvent"("webhookId");
CREATE INDEX IF NOT EXISTS "PosWebhookEvent_receivedAt_idx" ON "PosWebhookEvent"("receivedAt" DESC);
CREATE INDEX IF NOT EXISTS "PosWebhookEvent_eventType_receivedAt_idx" ON "PosWebhookEvent"("eventType", "receivedAt" DESC);

-- 서버에서만 접근한다. 브라우저의 공개 키 요청에는 열지 않는다.
ALTER TABLE "PosWebhookEvent" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PosWebhookEvent" FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE "PosWebhookEvent" TO service_role;
-- 수신 기록은 지우지 않는다. 지우면 중복 방지가 뚫리고 추적도 끊긴다.
REVOKE DELETE, TRUNCATE ON TABLE "PosWebhookEvent" FROM service_role;

COMMIT;
