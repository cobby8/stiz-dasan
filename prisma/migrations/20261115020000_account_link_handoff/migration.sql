-- 앱 간편로그인 «연결하기» 1회용 표(2026-11-15, 원장 승인 A안).
--
-- 왜 필요한가: 스토어 앱(웹뷰) 안에서는 카카오·구글·애플 연결 화면을 열 수 없다. 그래서 앱 화면이
-- 1회용 표(토큰)를 붙인 주소를 휴대폰 기본 브라우저로 열고, 그 브라우저가 같은 계정으로 잠깐 들어가
-- 연결을 마친 뒤 바로 나온다. 이 표는 «어느 계정에 어느 제공자를 붙일지»를 5분 동안만 보관한다.
--
-- 한 행 = 앱 화면에 그린 «연결하기» 버튼 1개.
--  id          : 토큰의 SHA-256(base64url) — 원문 토큰은 저장하지 않는다(앱 화면 링크에만 있다)
--  authUserId  : 표를 발급받은 학부모 본인의 Supabase 로그인 id
--  provider    : 붙일 간편로그인(google·kakao·naver·apple)
--  expiresAt   : 발급 + 5분(같은 계정·제공자의 안 쓴 옛 표는 새로 발급할 때 consumedAt 으로 막는다)
--  consumedAt  : [계속]을 눌러 쓴 시각 — 한 번 쓰면 다시 못 쓴다(조건부 UPDATE 로 원자적 소비)
-- 공개 Data API(anon·authenticated)에서 읽을 수 없게 RLS 를 켜고 권한을 회수한다(서버 연결만 사용).
-- 정리: 발급할 때 만료분 50행 + 매일 data-retention 크론이 하루 지난 행을 지운다.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────
-- DROP TABLE IF EXISTS public."AccountLinkHandoff";
CREATE TABLE IF NOT EXISTS public."AccountLinkHandoff" (
  id text PRIMARY KEY,
  "authUserId" text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google','kakao','naver','apple')),
  "expiresAt" timestamptz NOT NULL,
  "consumedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "AccountLinkHandoff_expiry" ON public."AccountLinkHandoff" ("expiresAt");
ALTER TABLE public."AccountLinkHandoff" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."AccountLinkHandoff" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public."AccountLinkHandoff" FROM anon; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public."AccountLinkHandoff" FROM authenticated; END IF;
END $$;
