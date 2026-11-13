-- 대타 선생님 지정(f4, 2026-11-13).
--
-- 왜 필요한가: 선생님은 시간표의 담당 코치 기준으로만 반 출석부를 연다. 담당 선생님이 빠진 날
-- 대신 들어간 선생님은 그 반 출석부를 못 열어 출석을 못 찍었다.
-- 원장·부원장이 «날짜 · 반 · 대타 선생님»을 지정하면 **그 날짜에만** 그 선생님이 그 반 출석부를 연다.
-- 원래 담당 선생님 권한은 그대로다(빼지 않는다).
--
-- 한 행 = 하루 · 한 반의 대타 한 명.
--  date            : KST 달력 날짜 "YYYY-MM-DD" 문자열(시간대 변환 없이 그대로 비교한다)
--  classId         : 반(Class.id) — 출석부 권한 판정(requireStaffClassAccess)이 쓰는 키와 같다
--  substituteUserId: 대타 선생님 앱 계정(User.id)
--  createdBy       : 지정한 원장·부원장 앱 계정(User.id, 기록용)
CREATE TABLE IF NOT EXISTS public."ClassSubstitute" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  date TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "substituteUserId" TEXT NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ClassSubstitute_date_check" CHECK (date ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "ClassSubstitute_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES public."Class" (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClassSubstitute_substituteUserId_fkey"
    FOREIGN KEY ("substituteUserId") REFERENCES public."User" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 같은 날 같은 반에는 대타 한 명(다시 지정하면 바꿔 끼운다)
CREATE UNIQUE INDEX IF NOT EXISTS "ClassSubstitute_date_classId_key"
  ON public."ClassSubstitute" (date, "classId");
-- 선생님 홈 «오늘 수업»·출석부 권한 판정: 이 선생님의 이 날짜 대타 반
CREATE INDEX IF NOT EXISTS "ClassSubstitute_substituteUserId_date_idx"
  ON public."ClassSubstitute" ("substituteUserId", date);

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(BillingNoticeDelivery 와 같은 방식)
ALTER TABLE public."ClassSubstitute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ClassSubstitute" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."ClassSubstitute" FROM anon, authenticated;
