-- 본사 쇼핑몰(stiz.kr·카페24) 유니폼 주문 사본(2026-11-16 원장 «쇼핑몰 주문도 학부모 화면에 보이게»).
-- cron /api/cron/uniform-shop-sync 가 본사 창구에서 받아 upsert 만 한다(지우지 않는다).
-- 이름·주소·금액은 저장하지 않는다 — 학생 이름은 품목의 «학생 이름» 하나뿐.
-- 여러 번 실행해도 안전하게 IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "UniformShopOrder" (
  "id" TEXT PRIMARY KEY,                       -- 카페24 주문번호
  "orderDate" DATE NOT NULL,                   -- KST 주문일(본사가 달력 날짜로 준다)
  "paid" BOOLEAN NOT NULL DEFAULT false,
  "canceled" BOOLEAN NOT NULL DEFAULT false,
  "buyerPhoneDigits" TEXT,
  "receiverPhoneDigits" TEXT,
  "syncedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "UniformShopOrderItem" (
  "id" TEXT PRIMARY KEY,                       -- `${카페24 주문번호}:${품목 코드}`
  "shopOrderId" TEXT NOT NULL REFERENCES "UniformShopOrder"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "productNo" INTEGER NOT NULL,
  "design" TEXT,
  "studentName" TEXT,
  "printName" TEXT,
  "backNumber" TEXT,
  "topSize" TEXT,
  "bottomSize" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',    -- UNPAID | PAID | PREPARING | SHIPPING | DELIVERED | CANCELED | RETURNED | UNKNOWN
  "trackingNo" TEXT,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "UniformShopOrder_buyerPhoneDigits_idx"
  ON "UniformShopOrder" ("buyerPhoneDigits");
CREATE INDEX IF NOT EXISTS "UniformShopOrder_receiverPhoneDigits_idx"
  ON "UniformShopOrder" ("receiverPhoneDigits");
CREATE INDEX IF NOT EXISTS "UniformShopOrder_orderDate_idx"
  ON "UniformShopOrder" ("orderDate");
CREATE INDEX IF NOT EXISTS "UniformShopOrderItem_shopOrderId_idx"
  ON "UniformShopOrderItem" ("shopOrderId");

-- 서버(Prisma)만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 못 읽게
ALTER TABLE "UniformShopOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UniformShopOrderItem" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON "UniformShopOrder" FROM anon, authenticated;
REVOKE ALL ON "UniformShopOrderItem" FROM anon, authenticated;
