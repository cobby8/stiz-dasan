-- 방학특강 «기간별 신청 마감 시각»(2026-11-18 원장 결정표 답).
--
-- 왜 필요한가:
--   원장 «1차 마감은 모두 시작 전주 금요일 6시». 1차 시즌 안에서 4주(1/4 시작)는 1/1(금) 18:00,
--   3주(1/11 시작)는 1/8(금) 18:00 에 닫혀야 한다 → 한 시즌에 마감이 둘이라 시즌 마감 칸 하나로는 안 된다.
--   그래서 반별 기간 상품표(SpecialProgramOfferingPeriod)에 «이 기간의 신청 마감 시각»을 둔다.
--
-- 안전:
--   추가만 한다(NULL 허용 칸 하나). 몇 번 실행해도 같다(IF NOT EXISTS).
--   NULL = 지금처럼 시즌 마감을 따른다 → 기존 기간 행·기존 시즌 동작은 그대로.
--   timestamptz(시간대 있는 칸) — 서버는 KST «날짜+시각»을 절대 시각으로 바꿔 저장한다(kst.ts kstAt).
--
-- ── 되돌림 SQL(필요할 때만 · 넣어 둔 기간별 마감 시각이 함께 사라진다) ──
-- ALTER TABLE "SpecialProgramOfferingPeriod" DROP COLUMN IF EXISTS "applicationClosesAt";

ALTER TABLE "SpecialProgramOfferingPeriod"
  ADD COLUMN IF NOT EXISTS "applicationClosesAt" TIMESTAMPTZ(6);
