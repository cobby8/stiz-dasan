-- 체험 수업 셔틀(2026-11-19 원장 결정) — 체험 학생을 «체험 날 하루만» 셔틀에 태운다.
--
-- 왜 필요한가: 체험 학생은 정식 등록 전이라 Student 표에 없고 TrialLead 에만 있다.
--   정규 셔틀 명단(RegularShuttleStop)에 넣으면 매주 반복되고, 이름만 있는 줄은 청구 자동 발행을 멈춘다.
--   그래서 «하루 탑승» 표를 따로 두고, 기사님 운행표가 그날 정규 운행 묶음 안에 끼워 보여 준다.
--   체험 셔틀은 무료다 — 청구(Payment)·정규 명단과 이어지는 칸이 하나도 없다.
--
-- ① TrialLead 새 칸 — 셔틀 요청(신청서·관리자 입력)과 배정 상태
--   shuttleNeeded         : 셔틀을 요청했는가
--   shuttleDirection      : BOTH(등·하원) · PICKUP(등원만) · DROPOFF(하원만)
--   shuttlePickup*        : 등원 때 탈 곳(이름·주소·좌표)
--   shuttleDropoff*       : 하원 때 내릴 곳 — 전부 NULL 이면 «등원과 같은 곳»
--   shuttleStatus         : NONE(요청 없음) · REQUESTED(배정 대기) · ASSIGNED(배정됨) · UNAVAILABLE(셔틀 어려움)
--   shuttleRequestedAt    : 요청한 시각(timestamptz)
--   shuttleAdminNote      : 관리자 메모(«셔틀 어려움» 사유 등)
--
-- ② TrialShuttleRide — 한 행 = 체험 학생 한 명의 «그날 한 방향» 탑승.
--   trialLeadId     : 체험 신청(TrialLead.id) — FK 는 이것 하나(신청이 지워지면 같이 지워진다)
--   serviceDate     : 타는 날 'YYYY-MM-DD'(KST 달력 날짜 문자열 — ShuttleBoarding.serviceDate 와 같은 모양)
--   direction       : BOARD(등원) · ALIGHT(하원) — 정규 명단(RegularShuttleStop.direction)과 같은 값
--   classTime       : 끼울 정규 운행 묶음(그 요일 명단의 수업시간 글자, 예 '16:00~17:00')
--   afterStopName   : 그 묶음에서 «이 정류장 다음»에 들른다. NULL = 묶음 맨 앞
--   sortOrder       : 같은 자리에 체험 학생이 둘 이상일 때의 순서
--   stopName        : 위치명(필수 — 기사님 운행표의 정류장 이름)
--   address · latitude · longitude : 주소·좌표
--   arriveTime      : 예상 시각 'HH:MM'
--   status          : ACTIVE · CANCELLED(일정 변경·취소·배정 풀기)
--   cancelReason    : 풀린 이유(RESCHEDULED · CANCELLED · LOST · ADMIN_RELEASE · UNAVAILABLE · REASSIGNED 등)
--   createdByUserId : 배정한 관리자(User.id) — 기록용이라 FK 없이 둔다
--   revision        : 배정 내용(묶음·자리·위치명·시각)이 바뀐 횟수 — 기사님 알림 키에 섞어 X→Y→X 로 되돌려도 알림이 다시 간다
--   driverNotifiedAt · parentSmsSentAt : 기사님 알림·학부모 문자를 보낸 시각
--   시간 칸은 모두 timestamptz
--
-- 탑승 체크는 기존 ShuttleBoarding 에 direction='TRIAL', shuttleRequestId=TrialShuttleRide.id 로 저장한다(표 변경 없음).
--
-- 이 SQL 은 «추가»만 한다 — 기존 표·행을 바꾸거나 지우는 문장은 없다. 여러 번 실행해도 같다.
-- 이 SQL 이 적용되기 전에도 사이트는 그대로 동작한다(운행표는 체험 줄 없이, 배정 화면은 «준비 중» 안내).
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."TrialShuttleRide";
-- DELETE FROM public."ShuttleBoarding" WHERE direction = 'TRIAL';
-- DROP INDEX IF EXISTS public."TrialLead_shuttleStatus_idx";
-- ALTER TABLE public."TrialLead"
--   DROP CONSTRAINT IF EXISTS "TrialLead_shuttleStatus_check",
--   DROP CONSTRAINT IF EXISTS "TrialLead_shuttleDirection_check",
--   DROP COLUMN IF EXISTS "shuttleNeeded", DROP COLUMN IF EXISTS "shuttleDirection",
--   DROP COLUMN IF EXISTS "shuttlePickupName", DROP COLUMN IF EXISTS "shuttlePickupAddress",
--   DROP COLUMN IF EXISTS "shuttlePickupLat", DROP COLUMN IF EXISTS "shuttlePickupLng",
--   DROP COLUMN IF EXISTS "shuttleDropoffName", DROP COLUMN IF EXISTS "shuttleDropoffAddress",
--   DROP COLUMN IF EXISTS "shuttleDropoffLat", DROP COLUMN IF EXISTS "shuttleDropoffLng",
--   DROP COLUMN IF EXISTS "shuttleStatus", DROP COLUMN IF EXISTS "shuttleRequestedAt",
--   DROP COLUMN IF EXISTS "shuttleAdminNote";

-- ① TrialLead 새 칸
ALTER TABLE public."TrialLead"
  ADD COLUMN IF NOT EXISTS "shuttleNeeded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shuttleDirection" TEXT,
  ADD COLUMN IF NOT EXISTS "shuttlePickupName" TEXT,
  ADD COLUMN IF NOT EXISTS "shuttlePickupAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "shuttlePickupLat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "shuttlePickupLng" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "shuttleDropoffName" TEXT,
  ADD COLUMN IF NOT EXISTS "shuttleDropoffAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "shuttleDropoffLat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "shuttleDropoffLng" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "shuttleStatus" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "shuttleRequestedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "shuttleAdminNote" TEXT;

-- 값 범위(CHECK) — 이미 있으면 다시 만들지 않는다
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrialLead_shuttleStatus_check') THEN
    ALTER TABLE public."TrialLead" ADD CONSTRAINT "TrialLead_shuttleStatus_check"
      CHECK ("shuttleStatus" IN ('NONE','REQUESTED','ASSIGNED','UNAVAILABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TrialLead_shuttleDirection_check') THEN
    ALTER TABLE public."TrialLead" ADD CONSTRAINT "TrialLead_shuttleDirection_check"
      CHECK ("shuttleDirection" IS NULL OR "shuttleDirection" IN ('BOTH','PICKUP','DROPOFF'));
  END IF;
END $$;

-- «배정 대기 N건»을 세는 조회용(대기·배정 줄만 담는 작은 인덱스)
CREATE INDEX IF NOT EXISTS "TrialLead_shuttleStatus_idx"
  ON public."TrialLead" ("shuttleStatus") WHERE "shuttleStatus" <> 'NONE';

-- ② 하루 탑승 표
CREATE TABLE IF NOT EXISTS public."TrialShuttleRide" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "trialLeadId" TEXT NOT NULL REFERENCES public."TrialLead"(id) ON DELETE CASCADE,
  "serviceDate" TEXT NOT NULL CHECK ("serviceDate" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  direction TEXT NOT NULL CHECK (direction IN ('BOARD','ALIGHT')),
  "classTime" TEXT NOT NULL CHECK (char_length("classTime") BETWEEN 1 AND 40),
  "afterStopName" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "stopName" TEXT NOT NULL CHECK (char_length(btrim("stopName")) BETWEEN 1 AND 150),
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  "arriveTime" TEXT NOT NULL CHECK ("arriveTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  "cancelReason" TEXT,
  "cancelledAt" TIMESTAMPTZ(6),
  "createdByUserId" TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  "driverNotifiedAt" TIMESTAMPTZ(6),
  "parentSmsSentAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 한 체험 학생은 방향마다 «살아 있는» 탑승이 하나뿐이다(두 번 눌러도 한 줄)
-- 표가 이미 있던 DB(이 파일의 예전 판을 적용한 곳)에도 변경 차수 칸이 생기게 한 번 더 보장한다
ALTER TABLE public."TrialShuttleRide" ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "TrialShuttleRide_active_lead_direction_key"
  ON public."TrialShuttleRide" ("trialLeadId", direction) WHERE status = 'ACTIVE';

-- 기사님 운행표가 날짜로 읽는다
CREATE INDEX IF NOT EXISTS "TrialShuttleRide_serviceDate_idx"
  ON public."TrialShuttleRide" ("serviceDate") WHERE status = 'ACTIVE';

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(보호자 전화·위치가 이어지는 표)
ALTER TABLE public."TrialShuttleRide" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TrialShuttleRide" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."TrialShuttleRide" FROM anon, authenticated;
