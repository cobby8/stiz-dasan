-- 정규 차량 변동 문자의 승인 상태는 실제 전송 장부(NotificationDelivery)와 분리한다.
-- 운영 적용 전 코드 검증용 정식 migration이며, 이 작업에서는 실행하지 않는다.

CREATE TABLE IF NOT EXISTS "RegularShuttleNoticeBatch" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "serviceMonth" TEXT NOT NULL,
  "compareMonth" TEXT NOT NULL,
  "stableEventKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL UNIQUE,
  "studentId" TEXT NOT NULL,
  "studentName" TEXT NOT NULL,
  "recipientPhone" TEXT NOT NULL,
  "messageBody" TEXT NOT NULL,
  "beforeText" TEXT,
  "afterText" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'HELD'
    CHECK (status IN ('HELD','APPROVED','SENDING','SENT','CANCELLED','UNCERTAIN')),
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMPTZ,
  "sentAt" TIMESTAMPTZ,
  "errorCode" TEXT,
  "lockedAt" TIMESTAMPTZ,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "RegularShuttleNoticeBatch_stableEventKey_createdAt_idx"
  ON "RegularShuttleNoticeBatch" ("stableEventKey", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "RegularShuttleNoticeBatch_status_createdAt_idx"
  ON "RegularShuttleNoticeBatch" (status, "createdAt" DESC);

ALTER TABLE "RegularShuttleNoticeBatch" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "RegularShuttleNoticeBatch" FROM anon, authenticated;

-- 자동 트리거가 아니라 관리자 승인형 수동 경로다. 채널 정책만 등록하고 route의 APPROVED CAS가 발송을 통제한다.
INSERT INTO "MessageAutomationRule"
  (id,trigger,name,"audienceScope",target,"isActive","requestedChannel","fallbackEnabled","fallbackChannel",description,"createdAt","updatedAt")
VALUES
  (gen_random_uuid()::text,'REGULAR_SHUTTLE_CHANGE','정규 차량 변동 승인 안내','EXTERNAL','PARENT',true,'SMS',false,NULL,
   '관리자가 서버 canonical 미리보기를 승인하고 발송을 다시 실행한 경우에만 사용',now(),now())
ON CONFLICT (trigger) DO UPDATE SET
  name=EXCLUDED.name,"audienceScope"=EXCLUDED."audienceScope",target=EXCLUDED.target,
  "isActive"=true,
  "requestedChannel"=EXCLUDED."requestedChannel","fallbackEnabled"=false,"fallbackChannel"=NULL,
  description=EXCLUDED.description,"updatedAt"=now();
