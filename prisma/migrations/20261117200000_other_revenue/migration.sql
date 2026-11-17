-- 기타 매출(2026-11-17) — 학생 청구(Payment)가 아닌 수입을 원장이 직접 적는 표.
--
-- 왜 필요한가: 학교 스포츠클럽 강사료, 사이트 학생이 아닌 특강생 입금 같은 돈은 학생 청구서가 없어서
--   사이트 어디에도 적을 곳이 없었다. 이 표에 한 줄씩 적고, 통계 «수납» 탭에 «기타 매출»로 따로 보인다.
--   수강료 매출(Payment) 숫자에는 섞지 않는다.
--
-- OtherRevenue — 한 행 = 들어온 돈 한 건.
--   revenueDate     : 들어온 날 'YYYY-MM-DD'(KST 달력 날짜 문자열)
--   category        : SCHOOL_CLUB(학교 스포츠클럽) · SPECIAL_NON_STUDENT(특강 — 사이트 학생 아님) · RENTAL(대관) · OTHER(기타)
--   title           : 내용(200자까지)
--   amount          : 금액(원, 1 이상 정수)
--   method          : BANK(계좌이체) · CARD_POS(카드 POS) · CASH(현금) · VOUCHER(이용권) · OTHER(기타)
--   note            : 메모(500자까지 — 승인번호·입금자 등)
--   createdByUserId : 적은 원장(User.id) — 기록용이라 FK 없이 둔다
--   시간 칸은 모두 timestamptz
--
-- 이 표가 없어도 사이트는 그대로 동작한다(읽기는 빈 목록·0원, 쓰기는 «준비 중» 안내).
-- 기존 표·행을 바꾸는 문장은 없다.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."OtherRevenue";

CREATE TABLE IF NOT EXISTS public."OtherRevenue" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "revenueDate" TEXT NOT NULL CHECK ("revenueDate" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  category TEXT NOT NULL CHECK (category IN ('SCHOOL_CLUB','SPECIAL_NON_STUDENT','RENTAL','OTHER')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('BANK','CARD_POS','CASH','VOUCHER','OTHER')),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 화면(그 달 목록)·통계(월별 합계)가 날짜 범위로 읽는다
CREATE INDEX IF NOT EXISTS "OtherRevenue_revenueDate_idx"
  ON public."OtherRevenue" ("revenueDate");

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(금액이라 부원장·학부모에게 새지 않게)
ALTER TABLE public."OtherRevenue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."OtherRevenue" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."OtherRevenue" FROM anon, authenticated;
