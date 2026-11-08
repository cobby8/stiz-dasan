-- 체육관 대관: 시작 10분 단위·이용 30분 단위(2026-11-08 원장 지시)를 위해 «그날 KST 0시부터 분» 컬럼 추가.
-- 운영 적용: Supabase apply_migration. 컬럼 추가 + 기존 행 채우기만이라 기존 값은 바꾸지 않는다.
-- 여러 번 실행해도 같은 결과(IF NOT EXISTS / 제약 존재 확인 / 비어 있는 행만 채움).
--
-- 저장 규칙(코드 gym-rental-service.createRentalRequest)
--   startMinute·endMinute = 그날 KST 0시부터 분(0~1440). 예) 20:40 = 1240
--   startHour = floor(startMinute/60), endHour = ceil(endMinute/60) — 기존 NOT NULL·CHECK(endHour > startHour) 유지
--   겹침 판정의 진짜 기준은 여전히 startAt/endAt(TIMESTAMPTZ + EXCLUDE 제약 GymRentalRequest_no_overlap) — 분 단위로 정확히 넣는다.
--
-- 왜 NOT NULL 이 아닌가: 배포 전환 틈(이 마이그레이션 → 새 코드 배포 사이)에 옛 코드가 분 없이 INSERT 해도 실패하지 않게.
--   코드는 COALESCE("startMinute", "startHour"*60) 으로 읽는다. 안정되면 후속으로 SET NOT NULL 해도 된다.
--
-- 되돌림 SQL:
--   ALTER TABLE "GymRentalRequest" DROP CONSTRAINT IF EXISTS "GymRentalRequest_minutes_check";
--   ALTER TABLE "GymRentalRequest" DROP CONSTRAINT IF EXISTS "GymRentalRequest_minutes_hours_check";
--   ALTER TABLE "GymRentalRequest" DROP COLUMN IF EXISTS "startMinute", DROP COLUMN IF EXISTS "endMinute";

ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "startMinute" INTEGER;
ALTER TABLE "GymRentalRequest" ADD COLUMN IF NOT EXISTS "endMinute" INTEGER;

-- 기존 행 채우기(정시 신청이었으므로 시×60)
UPDATE "GymRentalRequest"
   SET "startMinute" = "startHour" * 60,
       "endMinute" = "endHour" * 60
 WHERE "startMinute" IS NULL OR "endMinute" IS NULL;

DO $$
BEGIN
  -- 범위: 0 ≤ 시작 < 끝 ≤ 1440 (둘 다 채우거나 둘 다 비움)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GymRentalRequest_minutes_check') THEN
    ALTER TABLE "GymRentalRequest" ADD CONSTRAINT "GymRentalRequest_minutes_check" CHECK (
      ("startMinute" IS NULL AND "endMinute" IS NULL)
      OR ("startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute")
    );
  END IF;
  -- 정시 컬럼과 어긋나지 않게: startHour = 내림, endHour = 올림(정수 나눗셈은 양수에서 내림)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GymRentalRequest_minutes_hours_check') THEN
    ALTER TABLE "GymRentalRequest" ADD CONSTRAINT "GymRentalRequest_minutes_hours_check" CHECK (
      "startMinute" IS NULL
      OR ("startHour" = "startMinute" / 60 AND "endHour" = ("endMinute" + 59) / 60)
    );
  END IF;
END $$;
