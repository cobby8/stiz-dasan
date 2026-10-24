-- 2026-08-09 작업 중 임시로 떠 둔 사본 5개 삭제 (2026-10-02 대표 승인).
-- 이유: 학생 개인정보가 담긴 채 두 달 가까이 방치(51MB). 코드·뷰·외래키 참조 0건 확인.
-- 매일 자동 백업(Supabase Storage backups/)이 따로 돌고 있어 이 사본은 더 쓰이지 않는다.
DROP TABLE IF EXISTS "_bak_20260809_Enrollment";
DROP TABLE IF EXISTS "_bak_20260809_RegularShuttleStop";
DROP TABLE IF EXISTS "_bak_20260809_ScheduleSlot";
DROP TABLE IF EXISTS "_bak_20260809_Student";
DROP TABLE IF EXISTS "_bak_20260809_StudentRegistrationLedger";
