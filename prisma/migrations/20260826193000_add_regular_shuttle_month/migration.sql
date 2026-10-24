-- 정규 차량표와 저장 배차를 월별로 보존한다.
-- 기존 운영 데이터는 현재 사용 중인 2026년 9월 차량표로 승격한다.

ALTER TABLE "RegularShuttleStop"
  ADD COLUMN IF NOT EXISTS "serviceMonth" TEXT NOT NULL DEFAULT '2026-09';

DROP INDEX IF EXISTS "RegularShuttleStop_weekday_sortOrder_idx";
CREATE INDEX IF NOT EXISTS "RegularShuttleStop_serviceMonth_weekday_sortOrder_idx"
  ON "RegularShuttleStop" ("serviceMonth", "weekday", "sortOrder");

ALTER TABLE "RegularDispatchRoute"
  ADD COLUMN IF NOT EXISTS "serviceMonth" TEXT NOT NULL DEFAULT '2026-09';

DROP INDEX IF EXISTS "RegularDispatchRoute_dayOfWeek_direction_key";
CREATE UNIQUE INDEX IF NOT EXISTS "RegularDispatchRoute_serviceMonth_dayOfWeek_direction_key"
  ON "RegularDispatchRoute" ("serviceMonth", "dayOfWeek", "direction");

ALTER TABLE "RegularShuttleStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegularDispatchRoute" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "RegularShuttleStop", "RegularDispatchRoute" FROM anon, authenticated;
