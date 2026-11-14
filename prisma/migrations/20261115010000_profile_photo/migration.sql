-- 학생·학부모 프로필 사진(2026-11-15, 원장 요청 «학생과 학부모 프로필 사진 넣는 기능도 만들자»).
--
-- 왜 필요한가: 학부모 앱이 아이를 이름 글자로만 보여 줘 밋밋하다. 아이·보호자 사진을 올려 홈·아이 기록에 보인다.
--
-- 저장 방식:
--   · 사진 파일은 비공개 버킷 profile-private 에만 둔다(공개 주소 없음).
--   · 열에는 «버킷 안 경로»만 저장한다 — students/{studentId}/{uuid}.jpg (512px), 같은 이름 뒤 -s.jpg (128px).
--   · 보여 줄 때는 서버가 권한(학부모 본인 자녀·담당 선생님·관리자)을 확인한 뒤 내려받아 전달한다.
--   · photoUpdatedAt 은 timestamptz — 화면 주소의 캐시 버전(?v=)으로 쓴다.
--
-- ── 되돌림 SQL(필요할 때만. 사진 파일을 먼저 비울 것) ─────────────────────────────
-- ALTER TABLE public."Student" DROP COLUMN IF EXISTS "photoPath", DROP COLUMN IF EXISTS "photoUpdatedAt";
-- ALTER TABLE public."User" DROP COLUMN IF EXISTS "photoPath", DROP COLUMN IF EXISTS "photoUpdatedAt";
-- -- 버킷은 안의 파일을 모두 지운 뒤에만 지워진다(Supabase 대시보드 → Storage → profile-private → 비우기)
-- DELETE FROM storage.buckets WHERE id = 'profile-private';

ALTER TABLE public."Student" ADD COLUMN IF NOT EXISTS "photoPath" TEXT;
ALTER TABLE public."Student" ADD COLUMN IF NOT EXISTS "photoUpdatedAt" TIMESTAMPTZ(3);
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "photoPath" TEXT;
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "photoUpdatedAt" TIMESTAMPTZ(3);

-- 프로필 사진 저장소(비공개 버킷) — 수업 영상 버킷(20261114120000_session_video)과 같은 방식.
-- 서버가 512px·128px JPEG 로 다시 만든 파일만 올리므로 형식은 JPEG 하나, 크기 상한은 2MB 면 넉넉하다.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-private', 'profile-private', false, 2097152, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;
