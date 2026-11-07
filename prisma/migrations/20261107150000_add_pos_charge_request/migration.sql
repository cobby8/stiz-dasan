-- 토스 POS «현장 결제» 요청(PosChargeRequest) + POS 플러그인 매장 토큰(PosPluginToken)
-- 설계: docs/toss-pos-plugin-plan.md (2-1 · 3장)
-- 운영 적용: Supabase apply_migration (PM). 표 추가만이라 기존 데이터는 바꾸지 않는다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS / 제약 존재 확인).
--
-- 되돌림 SQL:
--   DROP TABLE IF EXISTS "PosChargeRequest";
--   DROP TABLE IF EXISTS "PosPluginToken";

-- ───────────── 현장 결제 요청 (POS 로 보낼 결제 요청 쪽지함) ─────────────
CREATE TABLE IF NOT EXISTS "PosChargeRequest" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- 사람이 읽는 번호(예: S-482193). POS 주문 메모에 «STIZ:S-482193» 로 들어간다.
  "shortCode" TEXT NOT NULL CHECK ("shortCode" ~ '^S-[0-9]{6}$'),
  "paymentId" TEXT NOT NULL REFERENCES "Payment"(id) ON DELETE CASCADE,
  -- 요청 순간의 청구 금액(서버 DB 값 스냅샷). 플러그인이 보낸 금액은 절대 쓰지 않는다.
  amount INTEGER NOT NULL CHECK (amount > 0),
  "taxFreeAmount" INTEGER NOT NULL,
  -- ⚠️ 상태 목록은 코드 CHARGE_STATUS(src/lib/pos/charge-request.mjs)와 같아야 한다(테스트로 비교).
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENT','PAID','CANCELLED','EXPIRED','HELD')),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  -- 누가 만들었나: ADMIN(관리자 화면) / PLUGIN(POS 탭에서 미납을 골라 만든 것)
  "createdVia" TEXT NOT NULL DEFAULT 'ADMIN' CHECK ("createdVia" IN ('ADMIN','PLUGIN')),
  "createdByUserId" TEXT,
  "createdByName" TEXT,
  -- 플러그인이 가져간 시각·토큰
  "claimedAt" TIMESTAMPTZ(6),
  "claimedByTokenId" TEXT,
  -- 매칭된 토스 주문·결제(웹훅 + Open API 재조회로만 채운다)
  "tossOrderId" TEXT,
  "tossPaymentId" TEXT,
  "paidAt" TIMESTAMPTZ(6),
  -- 보류 사유·취소 메모(사람이 보는 문장)
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  "heldAt" TIMESTAMPTZ(6),
  -- 플러그인 보고(참고 기록만 — 이 값으로 납부 처리하지 않는다)
  -- ⚠️ 보고 종류는 코드 PLUGIN_REPORT_EVENTS(src/lib/pos/chargeRequestService.ts)와 같아야 한다(테스트로 비교).
  "pluginReportedEvent" TEXT CHECK ("pluginReportedEvent" IS NULL OR "pluginReportedEvent" IN ('SENT','PAID','CANCELLED','FAILED','START_FAILED')),
  "pluginReportedAt" TIMESTAMPTZ(6),
  "pluginReportMessage" TEXT CHECK ("pluginReportMessage" IS NULL OR length("pluginReportMessage") <= 300),
  -- 이미 받은 보고 종류(워커·탭이 같은 보고를 둘 다 보내도 한 번만 처리)
  "pluginReportedEvents" TEXT[] NOT NULL DEFAULT '{}',
  -- 취소한 사람(관리자 화면이면 user id, 플러그인이면 token:<id>)
  "cancelledAt" TIMESTAMPTZ(6),
  "cancelledBy" TEXT,
  -- 슬랙 알림을 한 번만 보내기 위한 표시(자동 납부·보류 / POS 취소)
  "slackNotifiedAt" TIMESTAMPTZ(6),
  "cancelNotifiedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PosChargeRequest_taxfree_check" CHECK ("taxFreeAmount" BETWEEN 0 AND amount),
  CONSTRAINT "PosChargeRequest_expires_check" CHECK ("expiresAt" > "createdAt")
);

-- 같은 청구서에 열린 요청은 1개만 / 열린 요청끼리 번호가 겹치지 않게 / 토스 결제 1건은 요청 1개에만.
-- ⚠️ 열린 상태 목록은 코드 OPEN_CHARGE_STATUSES 와 같아야 한다(테스트로 비교).
CREATE UNIQUE INDEX IF NOT EXISTS "PosChargeRequest_open_payment_key"
  ON "PosChargeRequest" ("paymentId") WHERE status IN ('PENDING','SENT');
CREATE UNIQUE INDEX IF NOT EXISTS "PosChargeRequest_open_shortCode_key"
  ON "PosChargeRequest" ("shortCode") WHERE status IN ('PENDING','SENT');
CREATE UNIQUE INDEX IF NOT EXISTS "PosChargeRequest_tossPaymentId_key"
  ON "PosChargeRequest" ("tossPaymentId") WHERE "tossPaymentId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "PosChargeRequest_shortCode_createdAt_idx" ON "PosChargeRequest" ("shortCode", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PosChargeRequest_status_expiresAt_idx" ON "PosChargeRequest" (status, "expiresAt");
CREATE INDEX IF NOT EXISTS "PosChargeRequest_paymentId_createdAt_idx" ON "PosChargeRequest" ("paymentId", "createdAt" DESC);

-- ───────────── POS 플러그인 매장 토큰 (원문은 저장하지 않고 SHA-256 해시만) ─────────────
CREATE TABLE IF NOT EXISTS "PosPluginToken" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tokenHash" TEXT NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  -- 화면에서 어떤 토큰인지 구분하는 앞 글자(예: stizpos_Ab12) — 원문 전체가 아니다
  "tokenPrefix" TEXT NOT NULL CHECK (length("tokenPrefix") BETWEEN 4 AND 20),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lastUsedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "revokedByUserId" TEXT
);
CREATE INDEX IF NOT EXISTS "PosPluginToken_active_idx" ON "PosPluginToken" ("createdAt" DESC) WHERE "revokedAt" IS NULL;

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "PosChargeRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PosPluginToken" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "PosChargeRequest" FROM PUBLIC;
REVOKE ALL ON "PosPluginToken" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "PosChargeRequest" FROM %I', r);
    EXECUTE format('REVOKE ALL ON "PosPluginToken" FROM %I', r);
  END IF;
END LOOP; END $$;
