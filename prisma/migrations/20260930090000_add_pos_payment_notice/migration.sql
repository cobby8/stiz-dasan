-- 토스POS 결제 1건 = 슬랙 DM 1통 기록.
--
-- 왜 필요한가: 청구서의 원본은 랠리즈다. 학원 POS 로 결제를 받으면 원장이 랠리즈 청구서를
-- 손으로 "현장결제" 처리해야 하는데, 이 한 단계가 잘 잊힌다. 그래서 POS 결제마다
-- "랠리즈에서 현장결제 처리하셨나요?" DM 을 보내고, 그 답(버튼)을 여기에 남긴다.
--
-- 중복 방지: 같은 결제에 대해 주문 알림·결제 알림이 따로 와도 DM 은 한 통이어야 한다.
-- 그래서 토스 **결제 ID**(tossPaymentId)에 유일 제약을 건다. 코드로 "있나 확인 후 INSERT"
-- 하면 알림 두 개가 동시에 오면 뚫린다 — DB 가 막는다.
--
-- 돈을 지키는 장치: 같은 사이트 청구서(sitePaymentId)를 두 결제가 동시에 "납부 반영"하지
-- 못하도록, 실제로 납부 반영한 행(siteMarkedPaid = true) 사이에서 sitePaymentId 가 유일하다.

BEGIN;

CREATE TABLE IF NOT EXISTS "PosPaymentNotice" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tossPaymentId"       TEXT NOT NULL,
  "tossOrderId"         TEXT NOT NULL,
  "amount"              BIGINT NOT NULL,
  "approvedAt"          TIMESTAMPTZ,
  -- POS 품목 이름(반 이름)을 이어 붙인 값. 예: "금요일 3교시"
  "lineItems"           TEXT,
  "memo"                TEXT,
  -- 메모 이름이 원생 1명과 정확히 일치했거나, 원장이 버튼으로 고른 원생
  "resolvedStudentId"   TEXT,
  "targetYear"          INTEGER,
  "targetMonth"         INTEGER,
  -- 짝이 되는 사이트 미납 청구서(정확히 1건일 때만)
  "sitePaymentId"       TEXT,
  -- 처음 받았을 때의 분류(바뀌지 않는다)
  "kind"                TEXT NOT NULL,
  -- 원장이 원생을 고른 뒤 다시 판정한 분류(고르기 전에는 NULL)
  "pickedKind"          TEXT,
  "status"              TEXT NOT NULL DEFAULT 'PENDING',
  "slackChannel"        TEXT,
  "slackTs"             TEXT,
  "error"               TEXT,
  "decidedBySlackUser"  TEXT,
  "decidedAt"           TIMESTAMPTZ,
  "siteMarkedPaid"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "PosPaymentNotice_kind_check"
    CHECK ("kind" IN ('AUTO_CANDIDATE', 'NO_MEMO', 'AMBIGUOUS', 'NOT_IN_ROSTER',
                      'NO_SITE_INVOICE', 'ALREADY_PAID', 'AMOUNT_MISMATCH')),
  CONSTRAINT "PosPaymentNotice_pickedKind_check"
    CHECK ("pickedKind" IS NULL OR "pickedKind" IN ('AUTO_CANDIDATE', 'NO_SITE_INVOICE',
                                                    'ALREADY_PAID', 'AMOUNT_MISMATCH')),
  -- PENDING: 기록만 됨(DM 전) / NOTIFIED: DM 보냄 / STUDENT_CHOSEN: 원생을 골라 최종 확인 대기
  -- CONFIRMED: 원장이 처리 확인 / IGNORED: 학원 외 결제 / FAILED: DM 실패(스윕이 재시도)
  CONSTRAINT "PosPaymentNotice_status_check"
    CHECK ("status" IN ('PENDING', 'NOTIFIED', 'STUDENT_CHOSEN', 'CONFIRMED', 'IGNORED', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "PosPaymentNotice_tossPaymentId_key" ON "PosPaymentNotice"("tossPaymentId");
CREATE INDEX IF NOT EXISTS "PosPaymentNotice_status_createdAt_idx" ON "PosPaymentNotice"("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PosPaymentNotice_tossOrderId_idx" ON "PosPaymentNotice"("tossOrderId");
-- 한 사이트 청구서는 POS 결제 한 건으로만 납부 반영된다(동시 클릭·이중결제 방어).
CREATE UNIQUE INDEX IF NOT EXISTS "PosPaymentNotice_sitePaymentId_marked_key"
  ON "PosPaymentNotice"("sitePaymentId") WHERE "siteMarkedPaid" = true;

-- 서버에서만 접근한다. 브라우저의 공개 키 요청에는 열지 않는다.
ALTER TABLE "PosPaymentNotice" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PosPaymentNotice" FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE "PosPaymentNotice" TO service_role;
-- 기록은 지우지 않는다. 지우면 같은 결제에 DM 이 다시 나가고 누가 무엇을 눌렀는지도 사라진다.
REVOKE DELETE, TRUNCATE ON TABLE "PosPaymentNotice" FROM service_role;

COMMIT;
