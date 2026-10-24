-- 회원 탈퇴(계정 삭제) 상태. 구글플레이 필수 요건이자 개인정보처리방침 이행 수단.
--
-- 왜 두 칸인가: 재학 중인 아이의 보호자를 즉시 지우면 연락이 끊겨 운영 사고가 된다.
-- 그래서 신청(withdrawRequestedAt)과 실제 처리(withdrawnAt)를 나누고, 재학 중이면
-- 원장이 확인한 뒤 처리한다. 재학 중이 아니면 신청과 처리가 같은 순간에 일어난다.
--
--   둘 다 NULL            = 정상 계정
--   신청만 있음           = 원장 확인 대기
--   withdrawnAt 있음      = 탈퇴 완료(로그인 수단 제거 + 개인정보 익명화)
--
-- 학생·출결·결제 기록은 지우지 않는다 — 학원 장부이고 전자상거래법상 5년 보관 대상이다.
-- 개인정보처리방침도 "법령에 따른 보존 기간이 있는 경우 해당 기간 보관"을 이미 예외로 두고 있다.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "withdrawRequestedAt" TIMESTAMPTZ;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMPTZ;

-- 원장 확인 대기 목록 조회용(신청했고 아직 처리되지 않은 계정만).
CREATE INDEX IF NOT EXISTS "User_withdraw_pending_idx"
  ON "User" ("withdrawRequestedAt") WHERE "withdrawnAt" IS NULL;
