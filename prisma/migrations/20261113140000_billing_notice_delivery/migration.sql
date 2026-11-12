-- 청구서 안내·미납 안내 발송 대기열 연결표(2026-11-13).
--
-- 왜 필요한가: 예전에는 청구서 «발송됨»(sentAt)을 먼저 전부 찍고 문자를 한 통씩 보냈다.
-- 60초 한도에 끊기면 뒷사람은 문자를 못 받았는데도 «발송됨»으로 남았다.
-- 이제는 «발송 예약(이 표 + 문자 대기열) → 매분 cron 이 묶음 발송 → 실제 성공한 건만 sentAt 기록» 순서다.
--
-- 한 행 = 학부모에게 나가는 안내 한 통(청구서 1장 또는 한 학생의 미납 묶음).
--  noticeKey : 같은 안내를 두 번 예약하지 않게 하는 열쇠. 진행 중·성공·결과 불확실·앱 알림만 행 중에서는 하나만 허용.
--              실패(FAILED) 행은 여러 개 있어도 된다 → 다시 누르면 «못 보낸 건만» 새 행으로 이어 보낸다.
--  deliveryId: 문자 대기열(NotificationDelivery) 행 id. 결과(SENT/FAILED/UNCERTAIN)를 여기서 읽어 온다.
CREATE TABLE IF NOT EXISTS public."BillingNoticeDelivery" (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  "noticeKey" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "studentId" TEXT,
  "studentName" TEXT,
  "invoiceIds" TEXT[] NOT NULL DEFAULT '{}',
  "paymentIds" TEXT[] NOT NULL DEFAULT '{}',
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  "deliveryId" TEXT,
  "batchId" TEXT,
  "errorCode" TEXT,
  "actorUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "finalizedAt" TIMESTAMPTZ(6),
  CONSTRAINT "BillingNoticeDelivery_kind_check" CHECK (kind IN ('INVOICE', 'UNPAID')),
  CONSTRAINT "BillingNoticeDelivery_channel_check" CHECK (channel IN ('ALIMTALK', 'SMS', 'APP_ONLY')),
  CONSTRAINT "BillingNoticeDelivery_status_check" CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'UNCERTAIN', 'APP_ONLY'))
);

-- 같은 안내는 «살아 있는» 행이 하나만(두 번 누르거나 두 사람이 동시에 눌러도 한 번만 예약)
CREATE UNIQUE INDEX IF NOT EXISTS "BillingNoticeDelivery_active_noticeKey_key"
  ON public."BillingNoticeDelivery" ("noticeKey")
  WHERE status IN ('QUEUED', 'SENT', 'UNCERTAIN', 'APP_ONLY');
CREATE UNIQUE INDEX IF NOT EXISTS "BillingNoticeDelivery_deliveryId_key"
  ON public."BillingNoticeDelivery" ("deliveryId");
CREATE INDEX IF NOT EXISTS "BillingNoticeDelivery_batchId_idx"
  ON public."BillingNoticeDelivery" ("batchId");
CREATE INDEX IF NOT EXISTS "BillingNoticeDelivery_kind_period_idx"
  ON public."BillingNoticeDelivery" (kind, "periodKey", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "BillingNoticeDelivery_queued_idx"
  ON public."BillingNoticeDelivery" ("createdAt")
  WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS "BillingNoticeDelivery_paymentIds_idx"
  ON public."BillingNoticeDelivery" USING GIN ("paymentIds");

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(NotificationDelivery 와 같은 방식)
ALTER TABLE public."BillingNoticeDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BillingNoticeDelivery" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."BillingNoticeDelivery" FROM anon, authenticated;
