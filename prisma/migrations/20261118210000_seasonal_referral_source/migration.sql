-- 방학특강 신청서 «어떻게 알게 되셨나요»(유입 경로) 칸(2026-11-18 원장 승인).
--
-- 왜 필요한가:
--   정규 수강·체험 신청서는 유입 경로를 받는데 특강 신청서만 없어, 특강 홍보가 어디서 효과가 있는지 셀 수 없다.
--   값은 체험·수강 신청서와 같은 코드(src/lib/enrollment/referralSources.ts, 예: NAVER_SEARCH·INSTAGRAM)로 저장한다.
--
-- 안전:
--   추가만 한다(NULL 허용 칸 하나). 몇 번 실행해도 같다(IF NOT EXISTS).
--   NULL = 고르지 않음(필수 아님) → 기존 신청서·기존 신청 흐름은 그대로.
--
-- ── 되돌림 SQL(필요할 때만 · 받은 유입 경로가 함께 사라진다) ──
-- ALTER TABLE "SpecialProgramApplication" DROP COLUMN IF EXISTS "referralSource";

ALTER TABLE "SpecialProgramApplication"
  ADD COLUMN IF NOT EXISTS "referralSource" TEXT;
