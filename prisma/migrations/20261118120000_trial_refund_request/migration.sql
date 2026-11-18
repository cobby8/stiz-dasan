-- 체험 신청 학부모 온라인 취소 — 체험비를 이미 낸 신청의 환불 계좌 접수 + 원장 환불 알림 문자 규칙 (2026-11-18 원장 승인)
-- 운영 적용: Supabase apply_migration. 새 표 1개 + 문자 규칙 1건 추가만이라 기존 행·규칙은 바꾸지 않는다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
-- TrialRefundRequest
--   trialLeadId       취소된 체험 신청(신청을 지우면 같이 지운다 — 환불 처리 기록은 ApplicationContactLog 에도 남는다)
--   amount            돌려줄 체험비(원) — 결제 행 금액, 없으면 당시 체험비 설정값
--   refundBank/refundAccount(숫자만 10~16자리)/refundHolder  학부모가 적은 환불 계좌. 관리자 화면에서만 본다
--   status            PENDING(환불 대기) | DONE(환불 완료)
--   adminSmsStatus    원장 알림 문자 결과(SENT | FAILED | OFF)
--   completedAt/completedByName  관리자가 «환불 완료»를 누른 시각·사람
--
-- 되돌림 SQL:
--   DELETE FROM "MessageAutomationRule" WHERE trigger = 'TRIAL_REFUND_REQUEST_ADMIN';
--   DROP TABLE IF EXISTS "TrialRefundRequest";

CREATE TABLE IF NOT EXISTS "TrialRefundRequest" (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "trialLeadId"     TEXT NOT NULL REFERENCES "TrialLead"(id) ON DELETE CASCADE,
  amount            INTEGER NOT NULL CHECK (amount >= 0),
  "refundBank"      TEXT NOT NULL,
  "refundAccount"   TEXT NOT NULL CHECK ("refundAccount" ~ '^[0-9]{10,16}$'),
  "refundHolder"    TEXT NOT NULL CHECK (char_length("refundHolder") BETWEEN 1 AND 20),
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
  "adminSmsStatus"  TEXT,
  "completedAt"     TIMESTAMPTZ(6),
  "completedByName" TEXT,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 신청 하나에 환불 요청은 하나(취소는 한 번만 되지만 동시 요청 대비)
CREATE UNIQUE INDEX IF NOT EXISTS "TrialRefundRequest_trialLeadId_key" ON "TrialRefundRequest" ("trialLeadId");
CREATE INDEX IF NOT EXISTS "TrialRefundRequest_status_createdAt_idx" ON "TrialRefundRequest" (status, "createdAt" DESC);

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근(상담 신청·체육관 대관 표와 같은 방식)
ALTER TABLE "TrialRefundRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TrialRefundRequest" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "TrialRefundRequest" FROM %I', r);
  END IF;
END LOOP; END $$;

-- 원장 환불 알림 문자 규칙(/admin/sms 목록에 «체험 취소 환불 요청 (관리자)» 로 뜬다). 원장 요청이라 켠 채로 만든다.
INSERT INTO "MessageAutomationRule"
  (id, trigger, name, "audienceScope", target, "isActive", "requestedChannel", "fallbackEnabled", "fallbackChannel", "templateId", description, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'TRIAL_REFUND_REQUEST_ADMIN', '체험 취소 환불 요청 (관리자)', 'INTERNAL', 'ADMIN', true, 'SMS', true, 'SMS', NULL,
   '체험비를 낸 학부모가 온라인으로 체험을 취소하고 환불 계좌를 남기면 원장에게 알림', now(), now())
ON CONFLICT (trigger) DO NOTHING;
