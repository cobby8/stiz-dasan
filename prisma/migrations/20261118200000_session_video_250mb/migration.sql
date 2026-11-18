-- 수업 영상 보관함(session-videos) 파일 크기 상한 50MB → 250MB (2026-11-18 원장 지시 «영상 2분까지»).
--
-- 왜: 실제로 올라온 영상(11-14~18, 7건)이 초당 약 1.6MB 라 2분이면 약 200MB 다. 여유를 두고 250MB.
--     화면 안내·업로드 전 검사는 이 값을 읽어 쓰므로(sessionVideoMaxBytes) 코드의 숫자는 바꿀 필요가 없다.
-- 주의: Supabase 프로젝트 «전체 업로드 상한»(대시보드 → Project Settings → Storage)이 이보다 작으면
--       그 값이 먼저 막는다. 전체 상한도 250MB 이상이어야 2분 영상이 올라간다.
-- 안전: 값 하나만 바꾼다. 몇 번 실행해도 같다. 이미 올라온 파일에는 영향이 없다.
--
-- ── 되돌림 SQL(필요할 때만) ──
-- UPDATE storage.buckets SET file_size_limit = 52428800 WHERE id = 'session-videos';

UPDATE storage.buckets SET file_size_limit = 262144000 WHERE id = 'session-videos';
