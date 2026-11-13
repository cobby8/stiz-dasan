-- 앱 간편로그인 인계 원장(a1, 2026-11-13).
--
-- 왜 필요한가: 스토어 앱(웹뷰) 안에서는 구글이 로그인을 막고, 카카오·애플도 앱 밖 브라우저에서 해야 한다.
-- 그래서 앱이 시스템 브라우저로 로그인을 보낸 뒤, 돌아올 때 «1회용 짧은 code»만 받아 서버에 내고
-- 웹뷰 로그인 쿠키를 받는다. 이 표는 그 1회용 요청(5분)과 암호화한 세션(소비 즉시 삭제)을 잠깐 보관한다.
--
-- 한 행 = 앱 로그인 시도 1회.
--  challenge      : 앱 메모리 비밀값(verifier)의 SHA-256 — 원본은 서버에 오지 않는다(PKCE)
--  state          : 앱이 만든 요청 표식(복귀 주소 대조용)
--  browserHash    : 처음 연 브라우저에만 묶는 쿠키 값의 해시
--  codeHash       : 앱에 돌려준 1회용 code 의 해시(원본 저장 안 함)
--  sealedSession  : AES-256-GCM 으로 암호화한 로그인 세션 — 소비·취소 즉시 NULL
-- 공개 Data API(anon·authenticated)에서 읽을 수 없게 RLS 를 켜고 권한을 회수한다(서버 연결만 사용).
-- 정리: 시작할 때 만료분 100행 + 매일 data-retention 크론이 하루 지난 행을 지운다.
-- 내용은 src/lib/native-auth/schema.sql(로컬 합성 DB용)과 같다.
CREATE TABLE IF NOT EXISTS public."NativeAuthFlow" (
  id text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  provider text NOT NULL CHECK (provider IN ('google','kakao','naver','apple')),
  challenge text NOT NULL,
  state text NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED','BROWSER','READY','CONSUMED','CANCELLED')),
  "expiresAt" timestamptz NOT NULL,
  "browserHash" text,
  "codeHash" text,
  "codeExpiresAt" timestamptz,
  "sealedSession" text,
  "consumedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "NativeAuthFlow_expiry" ON public."NativeAuthFlow" ("expiresAt");
ALTER TABLE public."NativeAuthFlow" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."NativeAuthFlow" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public."NativeAuthFlow" FROM anon; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public."NativeAuthFlow" FROM authenticated; END IF;
END $$;
