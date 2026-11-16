-- «오늘 이 반 휴강» 표시(2026-11-17 원장 결정 — 수업 미처리 장치 1단계).
--
-- 왜 필요한가: 관리자 대시보드 «오늘 수업 처리 현황»은 시작 시각이 지났는데 선생님이 수업 시작을 안 누른 반을
--   «미처리»로 보인다(2단계부터는 알림도 간다). 그날 그 반이 실제로 쉬는 날이면 원장·부원장이 이 표시를 넣어
--   그 수업의 «미처리 독촉»만 멈춘다.
--
-- ⚠️ 이 표시는 독촉만 멈춘다. 학부모 화면·청구·보강권·셔틀·출결에는 아무 영향이 없다.
--   이 표를 읽고 쓰는 곳은 src/lib/class-nudge 뿐이다(tests/class-nudge-dashboard.test.mjs 가 못박는다).
--
-- ClassDayCancel — 한 행 = 한 날짜·한 수업의 휴강 표시 1개. 취소하면 행을 지운다(누가 언제 넣고 풀었는지는 OperationsAuditLog).
--   date        : KST 달력 날짜 "YYYY-MM-DD" 글자(ClassSubstitute.date 와 같은 방식 — 시간대 변환이 끼지 않는다)
--   classId     : 반(Class.id). 반이 지워지면 같이 지워진다
--   kind        : REGULAR(정규) | SEASONAL(특강 회차)
--   startTime   : 정규는 '' · 특강은 회차 시작 "HH:MM"(KST). 특강은 같은 반이 하루에 두 회차일 수 있어 시각이 열쇠다
--   reason      : 사유(200자 이하, 없어도 된다)
--   createdBy   : 누른 원장·부원장 User.id(기록용, FK 없음)
--
-- 이 표가 없어도 사이트는 그대로 동작한다(읽기는 «휴강 없음», 쓰기는 «준비 중» 안내).
-- 추가만 한다 — 기존 표·행을 바꾸는 문장은 없다.
--
-- ── 되돌림 SQL(필요할 때만 · 새 표라 잃을 자료 없음) ──────────────────────────────
-- DROP TABLE IF EXISTS public."ClassDayCancel";

CREATE TABLE IF NOT EXISTS public."ClassDayCancel" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  date TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'REGULAR',
  "startTime" TEXT NOT NULL DEFAULT '',
  reason TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ClassDayCancel_date_check" CHECK (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "ClassDayCancel_kind_check" CHECK (kind IN ('REGULAR', 'SEASONAL')),
  CONSTRAINT "ClassDayCancel_startTime_check" CHECK (
    (kind = 'REGULAR' AND "startTime" = '')
    OR (kind = 'SEASONAL' AND "startTime" ~ '^[0-9]{2}:[0-9]{2}$')
  ),
  CONSTRAINT "ClassDayCancel_reason_check" CHECK (reason IS NULL OR char_length(reason) <= 200),
  CONSTRAINT "ClassDayCancel_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES public."Class" (id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 같은 날 같은 수업에는 표시 하나. 맨 앞이 date 라 «그날 휴강 전부» 조회도 이 인덱스를 쓴다
CREATE UNIQUE INDEX IF NOT EXISTS "ClassDayCancel_date_classId_kind_startTime_key"
  ON public."ClassDayCancel" (date, "classId", kind, "startTime");

-- 서버만 읽고 쓴다(ClassSubstitute 와 같은 방식)
ALTER TABLE public."ClassDayCancel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ClassDayCancel" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."ClassDayCancel" FROM anon, authenticated;
