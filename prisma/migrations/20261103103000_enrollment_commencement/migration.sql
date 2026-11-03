-- 로컬 준비 전용. 운영 적용은 별도 승인 후 실행한다.
-- 기존 월 문자열과 과거 수강 날짜를 추정하거나 보정하지 않는다.
ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "requestedStartOn" DATE;
ALTER TABLE "Enrollment" ADD COLUMN IF NOT EXISTS "startsOn" DATE;
CREATE INDEX IF NOT EXISTS "Enrollment_classId_status_startsOn_idx" ON "Enrollment" ("classId", status, "startsOn");
