-- 선생님 출석부의 체험수업 아이 출결(출시 전 수정 f1, 2026-11-13 원장 지시).
--
-- 왜 필요한가: 체험 신청(TrialLead)에는 «체험 완료(ATTENDED)» 단계는 있지만 «불참» 단계가 없다.
-- 체험 아이를 정규 출석 표(Attendance)에 섞으면 청구·출석률·보강권이 틀어지므로, 체험 장부에 최소한의 칸만 둔다.
--  staffAttendanceStatus  : 선생님이 출석부에서 찍은 값 PRESENT / LATE / ABSENT, NULL = 아직 안 찍음
--  staffAttendanceAt      : 마지막으로 찍은 시각
--  staffAttendanceByUserId: 찍은 직원(User.id)
-- 출석·지각을 찍으면 코드가 단계도 SCHEDULED → ATTENDED 로 올린다(src/lib/staff-session-rules.ts trialLeadStatusAfterStaffMark).
-- 코드는 칸이 없어도(이 마이그레이션 전) 출석부가 열리게 체험 명단 조회 실패를 로그로만 남긴다.
--
-- 되돌림:
--   ALTER TABLE public."TrialLead" DROP CONSTRAINT IF EXISTS "TrialLead_staffAttendanceStatus_check";
--   ALTER TABLE public."TrialLead" DROP COLUMN IF EXISTS "staffAttendanceByUserId";
--   ALTER TABLE public."TrialLead" DROP COLUMN IF EXISTS "staffAttendanceAt";
--   ALTER TABLE public."TrialLead" DROP COLUMN IF EXISTS "staffAttendanceStatus";
ALTER TABLE public."TrialLead" ADD COLUMN IF NOT EXISTS "staffAttendanceStatus" TEXT;
ALTER TABLE public."TrialLead" ADD COLUMN IF NOT EXISTS "staffAttendanceAt" TIMESTAMPTZ;
ALTER TABLE public."TrialLead" ADD COLUMN IF NOT EXISTS "staffAttendanceByUserId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrialLead_staffAttendanceStatus_check') THEN
    ALTER TABLE public."TrialLead" ADD CONSTRAINT "TrialLead_staffAttendanceStatus_check"
      CHECK ("staffAttendanceStatus" IS NULL OR "staffAttendanceStatus" IN ('PRESENT', 'LATE', 'ABSENT'));
  END IF;
END $$;

-- 출석부가 «이 반·이 날 체험 아이»를 찾을 때 쓰는 색인.
CREATE INDEX IF NOT EXISTS "TrialLead_scheduledClassId_scheduledDate_idx"
  ON public."TrialLead" ("scheduledClassId", "scheduledDate");
