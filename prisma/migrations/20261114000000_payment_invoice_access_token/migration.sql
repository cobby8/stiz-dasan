-- 비회원 결제 링크(2026-11-14 원장 승인): 가입하지 않은 학부모도 받은 링크 하나로 «그 청구서 한 장만» 보고 결제한다.
-- 링크 주소 = /pay/<토큰>. 이 표에는 토큰 원문 없이 SHA-256 해시만 둔다.
-- ⚠️ 단, 안내 발송 기록(BillingNoticeDelivery.body·문자 대기열 본문)에는 링크 원문이 남는다(관리자 «결제 링크 모두 닫기»로 회수).
-- 만료 = max(납부기한, 발급일) + 14일 하루 끝(KST). 결제 완료·청구 취소·환불은 쓰는 순간 청구 상태로 판정한다.
-- 재실행 안전: IF NOT EXISTS · 제약은 이름으로 확인 후 추가.

CREATE TABLE IF NOT EXISTS "PaymentInvoiceAccessToken" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  -- 청구서가 지워지면(미납 청구 삭제) 링크도 같이 지운다 — 남은 링크가 삭제를 막지 않게
  "invoiceId" text NOT NULL REFERENCES "PaymentInvoice"("id") ON DELETE CASCADE,
  "tokenHash" text NOT NULL,
  "expiresAt" timestamptz(6) NOT NULL,
  "revokedAt" timestamptz(6),
  -- 발급 경로: 관리자 «결제 링크 복사» · 청구서 안내 · 미납 안내
  "source" text NOT NULL,
  "createdByUserId" text,
  "createdAt" timestamptz(6) NOT NULL DEFAULT NOW(),
  "lastUsedAt" timestamptz(6),
  "useCount" integer NOT NULL DEFAULT 0
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentInvoiceAccessToken_source_check') THEN
    ALTER TABLE "PaymentInvoiceAccessToken"
      ADD CONSTRAINT "PaymentInvoiceAccessToken_source_check"
      CHECK ("source" IN ('ADMIN_COPY', 'INVOICE_NOTICE', 'UNPAID_NOTICE'));
  END IF;
  -- 해시는 hex 64자(SHA-256)만 — 원문 토큰이 실수로 들어가지 않게
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentInvoiceAccessToken_tokenHash_check') THEN
    ALTER TABLE "PaymentInvoiceAccessToken"
      ADD CONSTRAINT "PaymentInvoiceAccessToken_tokenHash_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentInvoiceAccessToken_tokenHash_key"
  ON "PaymentInvoiceAccessToken" ("tokenHash");
CREATE INDEX IF NOT EXISTS "PaymentInvoiceAccessToken_invoiceId_createdAt_idx"
  ON "PaymentInvoiceAccessToken" ("invoiceId", "createdAt");

-- 서버(Prisma)만 읽고 쓴다. 공개 API(anon/authenticated)로는 보이지 않게 한다(비밀번호 찾기 표와 같은 설정).
ALTER TABLE "PaymentInvoiceAccessToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentInvoiceAccessToken" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PaymentInvoiceAccessToken" FROM anon, authenticated;
