-- 관리자 «기간 결석» — 부상·질병을 «11/6부터, 복귀 미정»처럼 기간으로 한 번에 등록한다(2026-11-09 원장 결정).
--
-- ■ 왜 휴원이 아니라 결석인가
--   휴원(Enrollment 상태 변경)은 청구·출석부·셔틀 명단에서 아이를 뺀다. 부상·질병은 반 자리·셔틀 명단·승하차 위치를
--   그대로 두고, 그 기간의 수업일만 날짜별 결석(RegularAbsence, CONFIRMED)으로 남긴다.
--   기사 정규 운행(regularRun)·청구 작업대(이월 후보)는 이미 RegularAbsence 를 읽으므로 새 연결이 필요 없다.
--
-- ■ 모양
--   RegularAbsencePeriod 1행 = 등록 1건(시작일·복귀일(NULL=미정)·사유·대상 반·상태).
--   RegularAbsence."periodId" = 이 기간이 만든(또는 되살린) 날짜별 결석 행. 학부모 신고·출석부 표시 행은 NULL.
--   coveredUntil = 결석 행을 만들어 둔 마지막 날. 복귀 미정이면 매일 크론(/api/cron/absence-periods)이 «다음 달 말일»까지 늘린다.
--   classIds 빈 배열 = 그 학생의 수강 중(ACTIVE) 반 전부(나중에 생긴 반 포함).
--
-- ■ 기존 데이터
--   표 추가 + RegularAbsence 에 NULL 칸 하나 추가뿐 — 기존 행·칸은 바꾸지 않는다. 여러 번 실행해도 같은 결과(IF NOT EXISTS).
--
-- 운영 적용: Supabase apply_migration (PM). ⚠️ 새 코드보다 «먼저» 적용해야 한다 —
--   새 코드는 알림 재조정·학생 상세·기간 결석 크론에서 이 표/칸을 읽는다.
--
-- 되돌림 SQL(기간 결석이 만든 결석 행은 남고 periodId 연결만 사라진다):
--   SELECT count(*) FROM "RegularAbsencePeriod";   -- 먼저 확인
--   ALTER TABLE "RegularAbsence" DROP CONSTRAINT IF EXISTS "RegularAbsence_periodId_fkey";
--   DROP INDEX IF EXISTS "RegularAbsence_periodId_idx";
--   ALTER TABLE "RegularAbsence" DROP COLUMN IF EXISTS "periodId";
--   DROP TABLE IF EXISTS "RegularAbsencePeriod";

CREATE TABLE IF NOT EXISTS "RegularAbsencePeriod" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "studentId" TEXT NOT NULL REFERENCES "Student"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  reason TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  -- 복귀 첫 수업일(이 날부터 다시 출석). NULL = 복귀 미정
  "returnDate" DATE,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  -- 결석 행을 만들어 둔 마지막 날(처음엔 시작일 전날 — 아직 아무것도 안 만든 상태)
  "coveredUntil" DATE NOT NULL,
  "classIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdByUserId" TEXT NOT NULL,
  "endedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- 코드 VALID_REASONS / PERIOD_STATUSES 와 같은 집합(tests/absence-period-plan.test.mjs 가 비교)
  CONSTRAINT "RegularAbsencePeriod_reason_check"
    CHECK (reason IN ('ILLNESS_INJURY','PERSONAL','FAMILY_TRIP','SCHOOL_EVENT','ETC')),
  CONSTRAINT "RegularAbsencePeriod_status_check" CHECK (status IN ('ACTIVE','ENDED','CANCELLED')),
  CONSTRAINT "RegularAbsencePeriod_return_after_start_check"
    CHECK ("returnDate" IS NULL OR "returnDate" > "startDate"),
  CONSTRAINT "RegularAbsencePeriod_covered_check" CHECK ("coveredUntil" >= "startDate" - 1)
);

CREATE INDEX IF NOT EXISTS "RegularAbsencePeriod_studentId_status_idx" ON "RegularAbsencePeriod" ("studentId", status);
CREATE INDEX IF NOT EXISTS "RegularAbsencePeriod_status_idx" ON "RegularAbsencePeriod" (status);

-- 날짜별 결석 행 → 이 기간. 기간 행을 지워도 결석 행은 남긴다(SET NULL).
ALTER TABLE "RegularAbsence" ADD COLUMN IF NOT EXISTS "periodId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RegularAbsence_periodId_fkey') THEN
    ALTER TABLE "RegularAbsence" ADD CONSTRAINT "RegularAbsence_periodId_fkey"
      FOREIGN KEY ("periodId") REFERENCES "RegularAbsencePeriod"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "RegularAbsence_periodId_idx" ON "RegularAbsence" ("periodId");

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "RegularAbsencePeriod" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "RegularAbsencePeriod" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "RegularAbsencePeriod" FROM %I', r);
  END IF;
END LOOP; END $$;
