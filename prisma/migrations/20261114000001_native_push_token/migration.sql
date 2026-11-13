-- 스토어 앱(안드로이드·아이폰) 네이티브 푸시 토큰(e2, 2026-11-14).
--
-- 왜 필요한가: 지금까지 휴대폰 알림은 브라우저 웹푸시(PushSubscription)뿐이라, 스토어 앱(웹뷰) 안에서는
-- 알림을 못 받았다. 앱은 FCM(Firebase Cloud Messaging) 토큰을 받아 여기에 등록하고, 기존 발송 함수
-- (sendPushToUser·sendPushToAllParents)가 웹푸시 구독에 더해 이 토큰에도 보낸다.
--
-- 한 행 = 기기(앱 설치) 하나의 토큰.
--  userId     : 받는 사람 앱 계정(User.id). PushSubscription 과 같이 FK 없이 둔다(탈퇴 시 코드가 지운다).
--  platform   : 'android' | 'ios'
--  token      : FCM 등록 토큰(기기마다 하나). 같은 토큰이 다시 오면 «지금 로그인한 사람»으로 옮긴다.
--  lastSeenAt : 앱이 마지막으로 이 토큰을 확인해 준 시각(오래된 토큰 정리용)
CREATE TABLE IF NOT EXISTS public."NativePushToken" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "userId" TEXT NOT NULL,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "NativePushToken_platform_check" CHECK (platform IN ('android', 'ios')),
  CONSTRAINT "NativePushToken_token_check" CHECK (char_length(token) BETWEEN 20 AND 4096)
);

-- 토큰은 기기마다 하나 — 같은 토큰을 두 사람이 갖지 않는다(재등록 = 주인 바꾸기)
CREATE UNIQUE INDEX IF NOT EXISTS "NativePushToken_token_key"
  ON public."NativePushToken" (token);
-- 발송: 이 사람의 토큰들
CREATE INDEX IF NOT EXISTS "NativePushToken_userId_idx"
  ON public."NativePushToken" ("userId");

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(ClassSubstitute 와 같은 방식)
ALTER TABLE public."NativePushToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."NativePushToken" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."NativePushToken" FROM anon, authenticated;
