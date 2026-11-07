-- 체육관 대관 신청(GymRentalRequest) + 원장 알림/신청자 안내 문자 자동 규칙
-- 운영 적용: Supabase apply_migration. 테이블·규칙 추가만이라 기존 데이터는 바꾸지 않는다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS / 제약 존재 확인 / ON CONFLICT DO NOTHING).
--
-- 되돌림 SQL:
--   DROP TABLE IF EXISTS "GymRentalRequest";
--   DELETE FROM "MessageAutomationRule" WHERE trigger IN
--     ('RENTAL_NEW_ADMIN','RENTAL_RECEIVED_APPLICANT','RENTAL_APPROVED_APPLICANT','RENTAL_CONFIRMED_APPLICANT');

CREATE TABLE IF NOT EXISTS "GymRentalRequest" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "rentalDate" TEXT NOT NULL CHECK ("rentalDate" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  "startHour" INTEGER NOT NULL CHECK ("startHour" >= 0 AND "startHour" <= 23),
  "endHour" INTEGER NOT NULL CHECK ("endHour" >= 1 AND "endHour" <= 24),
  -- 겹침 판정용 절대 시각(서버가 KST 날짜+정시로 계산해 넣는다)
  "startAt" TIMESTAMPTZ(6) NOT NULL,
  "endAt" TIMESTAMPTZ(6) NOT NULL,
  headcount INTEGER NOT NULL CHECK (headcount >= 1 AND headcount <= 100),
  "useAircon" BOOLEAN NOT NULL DEFAULT false,
  "applicantName" TEXT NOT NULL CHECK (length("applicantName") BETWEEN 1 AND 40),
  "applicantPhone" TEXT NOT NULL CHECK ("applicantPhone" ~ '^01[016789][0-9]{7,8}$'),
  purpose TEXT CHECK (purpose IS NULL OR length(purpose) <= 300),
  "usageFee" INTEGER NOT NULL CHECK ("usageFee" >= 0),
  deposit INTEGER NOT NULL CHECK (deposit >= 0),
  "totalAmount" INTEGER NOT NULL,
  -- 환불한 보증금(차감 후). 환불 완료 때만 채운다.
  "depositRefunded" INTEGER CHECK ("depositRefunded" IS NULL OR ("depositRefunded" >= 0 AND "depositRefunded" <= deposit)),
  -- 확정(입금 확인) 뒤 취소할 때 실제로 돌려준 금액(0~입금액). 그 경우에만 채운다.
  "cancelRefundAmount" INTEGER CHECK ("cancelRefundAmount" IS NULL OR ("cancelRefundAmount" >= 0 AND "cancelRefundAmount" <= "totalAmount")),
  -- 남용 방지용 접속 주소 지문(sha256, 원문 IP 는 저장하지 않는다)
  "clientIpHash" TEXT CHECK ("clientIpHash" IS NULL OR "clientIpHash" ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','APPROVED','PAID','COMPLETED','REFUNDED','REJECTED','CANCELLED')),
  "rulesAgreedAt" TIMESTAMPTZ(6) NOT NULL,
  "adminMemo" TEXT CHECK ("adminMemo" IS NULL OR length("adminMemo") <= 500),
  "decidedByUserId" TEXT,
  "approvedAt" TIMESTAMPTZ(6),
  "paidAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "refundedAt" TIMESTAMPTZ(6),
  "closedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "GymRentalRequest_hours_check" CHECK ("endHour" > "startHour"),
  CONSTRAINT "GymRentalRequest_range_check" CHECK ("endAt" > "startAt"),
  CONSTRAINT "GymRentalRequest_total_check" CHECK ("totalAmount" = "usageFee" + deposit)
);

-- 이중 확정 방지: 시간을 «차지하는» 상태끼리는 겹칠 수 없다.
-- ⚠️ 상태 목록은 코드 RENTAL_HOLDING_STATUSES(src/lib/rental/gym-rental-rules.ts)와 같아야 한다(테스트로 비교).
-- 범위 타입 gist 는 기본 내장이라 btree_gist 확장이 필요 없다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GymRentalRequest_no_overlap') THEN
    ALTER TABLE "GymRentalRequest" ADD CONSTRAINT "GymRentalRequest_no_overlap"
      EXCLUDE USING gist (tstzrange("startAt", "endAt", '[)') WITH &&)
      WHERE (status IN ('APPROVED','PAID','COMPLETED','REFUNDED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "GymRentalRequest_rentalDate_idx" ON "GymRentalRequest" ("rentalDate");
CREATE INDEX IF NOT EXISTS "GymRentalRequest_status_createdAt_idx" ON "GymRentalRequest" (status, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "GymRentalRequest_phone_createdAt_idx" ON "GymRentalRequest" ("applicantPhone", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "GymRentalRequest_ip_createdAt_idx" ON "GymRentalRequest" ("clientIpHash", "createdAt" DESC);

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "GymRentalRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "GymRentalRequest" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "GymRentalRequest" FROM %I', r);
  END IF;
END LOOP; END $$;

-- 문자 자동 규칙(/admin/sms 에서 켜고 끈다). 문구는 코드(gym-rental-rules.ts)에 있다.
-- 원장 알림은 켜 두고, 신청자 안내 3종은 꺼 둔다(원장님 문구 확인 후 켬).
-- 승인·확정 문자는 환경변수 RENTAL_APPLICANT_SMS_ENABLED=1, 접수 문자는 남의 번호로도 보낼 수 있어
-- 별도 스위치 RENTAL_APPLICANT_RECEIVED_SMS_ENABLED=1 까지 있어야 나간다.
INSERT INTO "MessageAutomationRule"
  (id, trigger, name, "audienceScope", target, "isActive", "requestedChannel", "fallbackEnabled", "fallbackChannel", "templateId", description, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'RENTAL_NEW_ADMIN', '체육관 대관 신청 접수 (관리자)', 'INTERNAL', 'ADMIN', true, 'SMS', true, 'SMS', NULL,
   '체육관 대관 신청이 들어오면 원장님께 문자·슬랙으로 알림(끄면 슬랙도 함께 멈춤)', now(), now()),
  (gen_random_uuid()::text, 'RENTAL_RECEIVED_APPLICANT', '체육관 대관 접수 안내 (신청자)', 'EXTERNAL', 'PARENT', false, 'SMS', true, 'SMS', NULL,
   '대관 신청 직후 신청자에게 접수 안내', now(), now()),
  (gen_random_uuid()::text, 'RENTAL_APPROVED_APPLICANT', '체육관 대관 승인·입금 안내 (신청자)', 'EXTERNAL', 'PARENT', false, 'SMS', true, 'SMS', NULL,
   '원장 승인 시 신청자에게 입금 계좌·금액 안내', now(), now()),
  (gen_random_uuid()::text, 'RENTAL_CONFIRMED_APPLICANT', '체육관 대관 확정 안내 (신청자)', 'EXTERNAL', 'PARENT', false, 'SMS', true, 'SMS', NULL,
   '입금 확인 시 신청자에게 확정·이용 안내', now(), now())
ON CONFLICT (trigger) DO NOTHING;
