-- 2026-11-14 원장 결정: 이 사이트는 다산2호점만 관리한다(평내호평점은 앞으로 없다).
-- 운영에는 Supabase apply_migration(student_branch_default_dasan2)으로 먼저 적용했다 — Vercel 빌드는 migrate deploy 를 돌리지 않는다.
-- 1) 새 원생의 지점 기본값 = 다산2호점 원본 문장(POS 대사가 startsWith('2호점') 에 의존)
-- 2) 지점이 비어 있던 재원생(ACTIVE 수강 보유·병합 안 됨) 13명을 다산2호점으로 채운다. 되돌림용 사본을 남긴다.
--    되돌리기: UPDATE "Student" s SET branch = b.old_branch FROM "_bak_20261114_student_branch" b WHERE s.id = b.id;
--              ALTER TABLE "Student" ALTER COLUMN "branch" DROP DEFAULT;
CREATE TABLE IF NOT EXISTS "_bak_20261114_student_branch" AS
SELECT s.id, s.name, s.branch AS old_branch, NOW() AS backed_up_at
FROM "Student" s
WHERE (s.branch IS NULL OR TRIM(s.branch) = '')
  AND s."mergedIntoStudentId" IS NULL
  AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."studentId" = s.id AND e.status = 'ACTIVE');

ALTER TABLE "_bak_20261114_student_branch" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "Student" ALTER COLUMN "branch" SET DEFAULT '2호점 : 행정복지센터(다산아트홀) 앞';

UPDATE "Student" s
SET branch = '2호점 : 행정복지센터(다산아트홀) 앞'
WHERE s.id IN (SELECT id FROM "_bak_20261114_student_branch");
