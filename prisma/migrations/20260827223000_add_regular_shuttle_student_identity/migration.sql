-- 정규 차량표의 텍스트 이름을 안정적인 Student 식별값과 함께 보존한다.
-- 기존 행은 다음 월별 시트 재이관 때 안전하게 채워지며, 적용 전에는 NULL을 허용한다.

ALTER TABLE "RegularShuttleStop"
  ADD COLUMN IF NOT EXISTS "studentId" TEXT;

CREATE INDEX IF NOT EXISTS "RegularShuttleStop_studentId_serviceMonth_idx"
  ON "RegularShuttleStop" ("studentId", "serviceMonth");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'RegularShuttleStop_studentId_fkey'
  ) THEN
    ALTER TABLE "RegularShuttleStop"
      ADD CONSTRAINT "RegularShuttleStop_studentId_fkey"
      FOREIGN KEY ("studentId") REFERENCES "Student"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
