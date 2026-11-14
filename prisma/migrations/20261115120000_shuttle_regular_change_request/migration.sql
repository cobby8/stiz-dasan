-- 학부모가 셔틀 타는 곳·내리는 곳을 «앞으로 계속» 바꾸는 신청(2026-11-14 원장 결정표 c5).
--
-- 왜 필요한가: 학부모는 «셔틀 변경»으로 하루만 바꿀 수 있었다. 이사·학원 이동처럼 계속 바뀌는 경우는
--   학원에 전화하거나 원장이 위치 링크를 보내야 했다. 이제 학부모가 /mypage/shuttle/regular 에서 직접 신청하고,
--   원장이 셔틀 명단 화면에서 승인하면 적용 시작일에 명단(RegularShuttleStop)에 반영된다.
--   승인 전에는 명단·학생 위치(StudentShuttleLocation)를 건드리지 않는다.
--
-- ShuttleRegularChangeRequest — 한 행 = 신청 1건. 이 표 자체가 «누가·언제·무엇을» 이력이다.
--   kind        : CHANGE(위치 바꾸기) | START(셔틀 이용 시작) | STOP(셔틀 이용 중단)
--   directions  : 대상 방향 — 'PICKUP'(등원·타는 곳) / 'DROPOFF'(하원·내리는 곳)
--   weekdays    : 대상 요일(0=일 … 6=토). NULL = 그 아이의 모든 요일
--   pickupJson / dropoffJson : 새 위치(장소명·주소·좌표 등 — 토큰 링크 제출과 같은 검증을 거친 값). STOP 은 비운다
--   effectiveFrom : 적용 시작일(KST 달력 날짜)
--   status      : PENDING(확인 중) → APPROVED(승인 — 적용일을 기다리거나 원장이 명단을 고치는 중) → APPLIED(명단 반영 끝)
--                 | REJECTED(반려) | CANCELED(학부모 취소)
--   requestedByUserId / decidedByUserId : 앱 계정(User.id) — 기록용이라 FK 없이 둔다(탈퇴해도 이력은 남긴다)
--   시간 칸은 모두 timestamptz
--
-- 이 표가 없어도 사이트는 그대로 동작한다(코드가 to_regclass 로 먼저 확인 — 없으면 «계속 바꾸기» 입구만 숨는다).
-- 기존 표·행을 바꾸는 문장은 없다.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."ShuttleRegularChangeRequest";

CREATE TABLE IF NOT EXISTS public."ShuttleRegularChangeRequest" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "studentId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  kind TEXT NOT NULL,
  directions TEXT[] NOT NULL,
  weekdays INTEGER[],
  "pickupJson" JSONB,
  "dropoffJson" JSONB,
  "effectiveFrom" DATE NOT NULL,
  note TEXT,
  "consentVersion" TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMPTZ(6),
  "decisionNote" TEXT,
  "appliedAt" TIMESTAMPTZ(6),
  "applyResultJson" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ShuttleRegularChangeRequest_kind_check" CHECK (kind IN ('CHANGE', 'START', 'STOP')),
  CONSTRAINT "ShuttleRegularChangeRequest_status_check" CHECK (status IN ('PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELED')),
  CONSTRAINT "ShuttleRegularChangeRequest_directions_check"
    CHECK (cardinality(directions) BETWEEN 1 AND 2 AND directions <@ ARRAY['PICKUP', 'DROPOFF']::text[]),
  CONSTRAINT "ShuttleRegularChangeRequest_weekdays_check"
    CHECK (weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6])),
  CONSTRAINT "ShuttleRegularChangeRequest_note_check" CHECK (note IS NULL OR char_length(note) <= 300),
  CONSTRAINT "ShuttleRegularChangeRequest_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES public."Student" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 한 아이에 «확인 중» 신청은 하나만(다시 신청하려면 먼저 취소) — 코드의 중복 검사 뒤에 서는 마지막 방어선
CREATE UNIQUE INDEX IF NOT EXISTS "ShuttleRegularChangeRequest_pending_unique"
  ON public."ShuttleRegularChangeRequest" ("studentId")
  WHERE status = 'PENDING';
-- 적용일 처리(매일 cron): 승인됐지만 아직 반영 전인 건을 적용일 순으로
CREATE INDEX IF NOT EXISTS "ShuttleRegularChangeRequest_due_idx"
  ON public."ShuttleRegularChangeRequest" ("effectiveFrom")
  WHERE status = 'APPROVED' AND "appliedAt" IS NULL;
-- 학부모 화면·원장 목록: 최신순
CREATE INDEX IF NOT EXISTS "ShuttleRegularChangeRequest_studentId_createdAt_idx"
  ON public."ShuttleRegularChangeRequest" ("studentId", "createdAt" DESC);

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(StudentProfileChangeRequest 와 같은 방식)
ALTER TABLE public."ShuttleRegularChangeRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ShuttleRegularChangeRequest" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."ShuttleRegularChangeRequest" FROM anon, authenticated;
