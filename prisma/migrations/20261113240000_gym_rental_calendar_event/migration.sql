-- 확정된 체육관 대관을 «스티즈 다산점» 구글 캘린더에 넣은 일정 ID(취소·수정 때 그 일정을 찾아 지우거나 옮긴다). 2026-11-13 원장 요청.
-- 되돌림: ALTER TABLE "GymRentalRequest" DROP COLUMN IF EXISTS "calendarEventId";
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "calendarEventId" TEXT;
