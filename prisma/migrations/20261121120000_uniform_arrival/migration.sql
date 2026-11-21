-- 유니폼 «학원 도착»·«수령 완료» 기록 + 도착 문자 규칙(2026-11-21 원장 «학원 도착을 누르면 학부모에게 도착 알림»).
--
-- 왜 주문 표에 적지 않나: 본사 쇼핑몰 품목(UniformShopOrderItem.status)은 매시 동기화가 덮어쓴다.
--   도착·수령은 원장이 학원에서 하는 일이라 이 표에 따로 둔다. (출처, 품목 id) 하나에 한 줄 — 두 번 눌러도 한 줄·문자 한 통.
-- sourceType: SITE = UniformOrderItem.id · SHOP = UniformShopOrderItem.id (두 표를 가리키므로 FK 는 두지 않는다)
-- noticeStatus: SENT | FAILED | SKIPPED_NO_STUDENT | SKIPPED_NO_PHONE | DISABLED (전화번호·문자 본문은 저장하지 않는다)
-- 여러 번 실행해도 안전하게 IF NOT EXISTS · ON CONFLICT.
--
-- 되돌림 SQL:
--   DELETE FROM "MessageAutomationRule" WHERE trigger = 'UNIFORM_ARRIVED_PARENT';
--   DELETE FROM "SmsTemplate" WHERE trigger = 'UNIFORM_ARRIVED_PARENT';
--   DROP TABLE IF EXISTS "UniformArrival";

CREATE TABLE IF NOT EXISTS "UniformArrival" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceType"     TEXT NOT NULL CHECK ("sourceType" IN ('SITE', 'SHOP')),
  "sourceItemId"   TEXT NOT NULL,
  "studentId"      TEXT REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  "arrivedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "arrivedByName"  TEXT,
  "receivedAt"     TIMESTAMPTZ(6),
  "receivedByName" TEXT,
  "noticeStatus"   TEXT CHECK ("noticeStatus" IS NULL OR "noticeStatus" IN ('SENT', 'FAILED', 'SKIPPED_NO_STUDENT', 'SKIPPED_NO_PHONE', 'DISABLED')),
  "noticeReason"   TEXT,
  "noticeSentAt"   TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "UniformArrival_sourceType_sourceItemId_key"
  ON "UniformArrival" ("sourceType", "sourceItemId");
CREATE INDEX IF NOT EXISTS "UniformArrival_studentId_idx" ON "UniformArrival" ("studentId");

-- 서버(Prisma)만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 못 읽게
ALTER TABLE "UniformArrival" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "UniformArrival" FROM anon, authenticated;

-- 도착 문자 틀(/admin/sms «유니폼 학원 도착 (학부모)»). 원장이 «학원 도착»을 누를 때만 나간다 — 원장 요청이라 켠 채로 만든다.
-- 문구는 /admin/sms 에서 고칠 수 있다. 앱의 ensureSmsTemplates 도 같은 값을 ON CONFLICT DO NOTHING 으로 넣는다.
INSERT INTO "SmsTemplate" (id, trigger, name, target, body, "isActive", description, variables, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'UNIFORM_ARRIVED_PARENT', '유니폼 학원 도착 (학부모)', 'PARENT',
        E'[스티즈농구교실] {{childName}} 학생 유니폼이 학원에 도착했어요. 수업 오실 때 받아 가세요.', true,
        '관리자 «유니폼 신청 현황»에서 «학원 도착»을 누르면 그 학생 보호자에게 발송', '["childName"]', NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO "MessageAutomationRule"
  (id, trigger, name, "audienceScope", target, "isActive", "requestedChannel", "fallbackEnabled", "fallbackChannel", "templateId", description, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'UNIFORM_ARRIVED_PARENT', '유니폼 학원 도착 (학부모)', 'EXTERNAL', 'PARENT', true, 'SMS', true, 'SMS', t.id,
       '관리자 «유니폼 신청 현황»에서 «학원 도착»을 누르면 그 학생 보호자에게 발송', NOW(), NOW()
  FROM "SmsTemplate" t WHERE t.trigger = 'UNIFORM_ARRIVED_PARENT'
ON CONFLICT (trigger) DO NOTHING;
