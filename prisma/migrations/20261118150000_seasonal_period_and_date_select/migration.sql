-- 방학특강 «기간 선택 · 날짜별 선택»(2026-11-18 원장 승인) — 묶음 0 선행 공용 부품.
--
-- 왜 필요한가:
--   지금 특강 신청은 «요일»만 고른다(주2회 = 월·수 같은 식). 원장은 같은 반을
--   «4주 전체 / 앞 3주만» 처럼 기간을 나눠 다른 값으로 받거나, 아예 «날짜를 하나씩 골라» 회당 단가로
--   받고 싶어 한다. 그래서
--   1) 반(offering)마다 기간 상품표 SpecialProgramOfferingPeriod 를 새로 둔다.
--   2) 시즌(season)에 날짜별 선택 켜기·회당 단가·최소 횟수를 둔다.
--   3) 신청서(application)에 선택 방식·고른 날짜·기간 정보를 기록한다.
--   4) 신청 항목(item)에 어떤 기간을 골랐는지·회수·회당 단가 스냅샷을 남긴다.
--
-- 안전:
--   추가만 한다(기존 칸·행을 바꾸거나 지우는 문장 없음). 몇 번 실행해도 같다(IF NOT EXISTS·duplicate_object 무시).
--   새 칸의 기본값은 지금 동작과 같다(selectionMode='WEEKDAY'·selectedDates 빈 배열·기간 NULL = 지금처럼 요일 전체 기간).
--
-- ── 되돌림 SQL(필요할 때만 · 새 기능 데이터가 함께 사라진다) ──────────────────────
-- ALTER TABLE "SpecialProgramApplicationItem" DROP COLUMN IF EXISTS "offeringPeriodId", DROP COLUMN IF EXISTS "sessionCountSnapshot", DROP COLUMN IF EXISTS "unitPriceSnapshot";
-- ALTER TABLE "SpecialProgramApplication" DROP CONSTRAINT IF EXISTS "SpecialProgramApplication_selectionMode_check";
-- ALTER TABLE "SpecialProgramApplication" DROP COLUMN IF EXISTS "selectionMode", DROP COLUMN IF EXISTS "selectedDates", DROP COLUMN IF EXISTS "periodLabel", DROP COLUMN IF EXISTS "periodStartDate", DROP COLUMN IF EXISTS "periodEndDate";
-- ALTER TABLE "SpecialProgramSeason" DROP COLUMN IF EXISTS "dateSelectEnabled", DROP COLUMN IF EXISTS "perSessionNewPrice", DROP COLUMN IF EXISTS "perSessionExistingPrice", DROP COLUMN IF EXISTS "minSessionCount";
-- DROP TABLE IF EXISTS "SpecialProgramOfferingPeriod";

-- 1) 반별 기간 상품표 — 한 행 = «이 반의 이 기간(시작~종료일, KST 달력 날짜 문자열)을 이 값에»
CREATE TABLE IF NOT EXISTS "SpecialProgramOfferingPeriod" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "offeringId" TEXT NOT NULL REFERENCES "SpecialProgramOffering"("id") ON DELETE CASCADE,
  "label" TEXT NOT NULL,
  "startDate" TEXT NOT NULL,
  "endDate" TEXT NOT NULL,
  "price" INTEGER NOT NULL,
  "newApplicantPrice" INTEGER,
  "existingApplicantPrice" INTEGER,
  "shuttleFee" INTEGER,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "SpecialProgramOfferingPeriod_date_format" CHECK ("startDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "endDate" ~ '^\d{4}-\d{2}-\d{2}$' AND "endDate" >= "startDate"),
  CONSTRAINT "SpecialProgramOfferingPeriod_price_nonneg" CHECK ("price" >= 0 AND COALESCE("newApplicantPrice",0) >= 0 AND COALESCE("existingApplicantPrice",0) >= 0 AND COALESCE("shuttleFee",0) >= 0)
);
-- 같은 반에 같은 기간이 두 줄 생기지 않게
CREATE UNIQUE INDEX IF NOT EXISTS "SpecialProgramOfferingPeriod_offering_range_key" ON "SpecialProgramOfferingPeriod" ("offeringId","startDate","endDate");

-- 다른 특강 테이블과 같게: 서버 직접 연결만 쓴다. 브라우저 키(anon·authenticated)에는 열지 않는다.
ALTER TABLE "SpecialProgramOfferingPeriod" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "SpecialProgramOfferingPeriod" FROM anon, authenticated;

-- 2) 시즌 — 날짜별 선택 켜기·회당 단가(신규/재원)·최소 횟수
ALTER TABLE "SpecialProgramSeason"
  ADD COLUMN IF NOT EXISTS "dateSelectEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "perSessionNewPrice" INTEGER,
  ADD COLUMN IF NOT EXISTS "perSessionExistingPrice" INTEGER,
  ADD COLUMN IF NOT EXISTS "minSessionCount" INTEGER NOT NULL DEFAULT 1;

-- 3) 신청서 — 선택 방식(WEEKDAY=요일·DATE=날짜)·고른 날짜 목록·고른 기간
ALTER TABLE "SpecialProgramApplication"
  ADD COLUMN IF NOT EXISTS "selectionMode" TEXT NOT NULL DEFAULT 'WEEKDAY',
  ADD COLUMN IF NOT EXISTS "selectedDates" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "periodLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "periodStartDate" TEXT,
  ADD COLUMN IF NOT EXISTS "periodEndDate" TEXT;
-- 허용값은 src/lib/seasonal/attendance-rule.ts 의 SELECTION_MODES 와 같아야 한다(짝 테스트 있음)
DO $$ BEGIN ALTER TABLE "SpecialProgramApplication" ADD CONSTRAINT "SpecialProgramApplication_selectionMode_check" CHECK ("selectionMode" IN ('WEEKDAY','DATE')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) 신청 항목 — 고른 기간 id·회수·회당 단가 스냅샷(신청 당시 값 고정)
ALTER TABLE "SpecialProgramApplicationItem"
  ADD COLUMN IF NOT EXISTS "offeringPeriodId" TEXT,
  ADD COLUMN IF NOT EXISTS "sessionCountSnapshot" INTEGER,
  ADD COLUMN IF NOT EXISTS "unitPriceSnapshot" INTEGER;
