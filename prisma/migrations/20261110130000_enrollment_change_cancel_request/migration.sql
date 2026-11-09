-- 승인된 휴원·퇴원의 «취소 요청»(2026-11-10 원장 결정 d8).
--
-- ■ 무엇
--   원장이 승인했지만 아직 적용일 전인 휴원·퇴원(EnrollmentChangeRequest status=APPROVED, appliedAt NULL,
--   effectiveFrom > KST 오늘)에 학부모가 «취소해 주세요»를 보낸다. 원장이 승인하면 그 신청이 CANCELED 가 되고
--   (적용 전에만), 거절하면 원래 승인이 그대로 간다. 결과는 1단계 알림 경로(앱 알림)로 학부모에게 간다.
--
-- ■ 왜 새 kind(CANCEL_SCHEDULED 행)가 아니라 대상 신청의 칸인가
--   EnrollmentChangeRequest 의 행은 «수강을 바꾸는 신청»이다. 승인되면 적용일 크론(applyDueEnrollmentChanges)이
--   반영하고, 관리자 목록·일일 요약·검토 중 1건 유일 제약이 모두 그 뜻으로 읽는다. 취소 요청을 행으로 넣으면
--   그 경로 전부가 «이건 바꾸는 신청이 아니다»를 따로 알아야 하고, 대상 신청 id 를 담을 칸도 없다.
--   대상 신청에 «취소 요청 상태» 칸을 붙이면 기존 경로는 아무것도 몰라도 된다(새 칸은 전부 NULL 기본).
--
-- ■ 기존 데이터
--   NULL 칸 5개 + CHECK + 작은 부분 인덱스뿐 — 기존 행·칸은 바꾸지 않는다. 여러 번 실행해도 같은 결과.
--
-- 운영 적용: Supabase apply_migration (PM). ⚠️ 새 코드보다 «먼저» 적용해야 한다 —
--   새 코드는 학부모 수업 탭 타임라인·관리자 수강 변경 화면에서 이 칸을 읽는다
--   (없으면 그 부분만 빈 목록으로 보이고 화면은 열리게 막아 두었지만, 취소 요청 버튼은 실패한다).
--
-- 사전 확인(SELECT):
--   SELECT count(*) FROM "EnrollmentChangeRequest" WHERE status = 'APPROVED' AND "appliedAt" IS NULL;
-- 되돌림 SQL:
--   DROP INDEX IF EXISTS "EnrollmentChangeRequest_cancel_pending_idx";
--   ALTER TABLE "EnrollmentChangeRequest" DROP CONSTRAINT IF EXISTS "EnrollmentChangeRequest_cancelRequestStatus_check";
--   ALTER TABLE "EnrollmentChangeRequest"
--     DROP COLUMN IF EXISTS "cancelRequestStatus", DROP COLUMN IF EXISTS "cancelRequestedAt",
--     DROP COLUMN IF EXISTS "cancelRequestedByUserId", DROP COLUMN IF EXISTS "cancelRequestReason",
--     DROP COLUMN IF EXISTS "cancelDecisionNote";

ALTER TABLE "EnrollmentChangeRequest"
  ADD COLUMN IF NOT EXISTS "cancelRequestStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelRequestedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancelRequestedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelRequestReason" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelDecisionNote" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentChangeRequest_cancelRequestStatus_check'
  ) THEN
    ALTER TABLE "EnrollmentChangeRequest"
      ADD CONSTRAINT "EnrollmentChangeRequest_cancelRequestStatus_check"
      CHECK ("cancelRequestStatus" IS NULL OR "cancelRequestStatus" IN ('PENDING', 'APPROVED', 'REJECTED'));
  END IF;
END $$;

-- 관리자 «처리할 취소 요청» 목록용(대부분 NULL 이라 아주 작다)
CREATE INDEX IF NOT EXISTS "EnrollmentChangeRequest_cancel_pending_idx"
  ON "EnrollmentChangeRequest" ("cancelRequestedAt")
  WHERE "cancelRequestStatus" = 'PENDING';
