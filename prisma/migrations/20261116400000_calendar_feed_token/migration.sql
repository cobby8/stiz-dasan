-- «내 캘린더에 연동» 개인 일정 주소의 확인 값(2026-11-16 원장 승인).
--
-- 왜 필요한가: 휴대폰 캘린더(구글·아이폰)는 로그인을 못 한다. 그래서 개인 일정(내 수업·우리 아이 수업) 주소 안에
--   추측할 수 없는 값을 넣고, 그 값으로 본인을 찾는다. 학원 일정(공개)만 연동할 때는 이 표를 쓰지 않는다.
--
-- CalendarFeedToken — 한 행 = 연동 주소 1개.
--   userId     : 앱 계정(User.id). 기록용이라 FK 없이 둔다 — 캘린더가 받아 갈 때마다 계정(탈퇴 여부)·역할을 다시 확인한다
--   tokenHash  : 주소 속 값의 sha256 해시. **원문은 저장하지 않는다**(만들 때 한 번만 화면에 돌려준다)
--   kinds      : 고른 항목 쉼표 목록(academy,teaching,children). 받아 갈 때 «지금 역할»로 다시 거른다
--   lastUsedAt : 캘린더가 마지막으로 받아 간 시각(한 시간에 한 번만 갱신)
--   시간 칸은 모두 timestamptz
--
-- 이 표가 없어도 사이트는 그대로 동작한다(코드가 42P01 을 «없음»으로 본다 — 개인 연동만 «잠시 후 다시»로 안내).
-- 기존 표·행을 바꾸는 문장은 없다.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."CalendarFeedToken";

CREATE TABLE IF NOT EXISTS public."CalendarFeedToken" (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  kinds TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "lastUsedAt" TIMESTAMPTZ(6)
);

-- 주소 속 값으로 한 줄을 찾는다(해시는 겹치지 않는다)
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarFeedToken_tokenHash_key"
  ON public."CalendarFeedToken" ("tokenHash");
-- 내 연동 수 세기·오래된 것 지우기·«연동 끊기»
CREATE INDEX IF NOT EXISTS "CalendarFeedToken_userId_idx"
  ON public."CalendarFeedToken" ("userId");

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가
ALTER TABLE public."CalendarFeedToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CalendarFeedToken" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."CalendarFeedToken" FROM anon, authenticated;
