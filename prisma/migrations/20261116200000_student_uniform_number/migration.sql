-- 학생 유니폼 번호(등번호) 칸 두 개 — 취미반·대표팀 (2026-11-16 원장 지시)
--
-- 왜 필요한가: 학생마다 유니폼 등번호를 사이트에서 보고 고친다. 취미반과 대표팀 번호가 달라 칸을 나눈다.
--   uniformNumber       취미반 유니폼 번호
--   teamUniformNumber   대표팀 유니폼 번호
-- 숫자 글자로 둔다("0"·"23") — 계산하는 값이 아니라 «적힌 그대로» 보여 주는 값이라 TEXT. "0" 도 번호다.
-- 운영 DB 에는 이미 두 칸이 있고 값도 채워져 있다 → IF NOT EXISTS 로 다시 돌아도 안전하게.
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "uniformNumber" TEXT;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "teamUniformNumber" TEXT;
