-- 학부모 «지각·조퇴 알리기»(2026-11-14 원장 결정표 묶음 B).
--
-- 왜 필요한가: 학부모가 알릴 수 있는 것은 «결석»뿐이었다. 늦게 오거나 일찍 가는 날은 전화·카톡으로 알려야 했고,
--   선생님 출석부에는 아무 표시가 없었다. 이제 «결석 알리기» 화면에서 «늦어요 · 일찍 가요»와 예상 시각을 알린다.
--   결석이 아니므로 보강권은 나가지 않는다(이 표는 MakeupCredit·RegularAbsence 와 아무 연결이 없다).
--
-- RegularArrivalNotice — 한 행 = 한 아이·한 반·하루의 지각 또는 조퇴 알림 1건.
--   kind               : LATE(늦어요 — 도착 예정 시각) | EARLY(일찍 가요 — 나가는 예정 시각)
--   expectedTime       : 예상 시각 "HH:mm"(KST 글자 그대로 — 시간대 변환 없음)
--   status             : REPORTED(알림) | CANCELLED(학부모 취소)
--   shuttleExceptionId : 이 알림과 함께 만든 «셔틀 안 타요»(ShuttleDayException.id). 조퇴 → 하원, 지각 → 등원.
--                        기사님 화면이 사유(«조퇴»·«지각»)를 글자로 보이는 데 쓴다. 기록용이라 FK 없이 둔다.
--   changeCount        : 이 행을 알리기·시각 바꾸기·취소한 횟수. 한 아이·한 반·하루의 합(지각 행 + 조퇴 행)이 5 에 닿으면
--                        더 받지 않는다 — 번갈아 바꾸기로 원장·선생님·기사님 알림을 쏟아내지 못하게(보안 검수)
--   reportedByUserId   : 알린 학부모 앱 계정(User.id) — 기록용이라 FK 없이 둔다(탈퇴해도 이력은 남긴다)
--   시간 칸은 모두 timestamptz
--
-- 이 표가 없어도 사이트는 그대로 동작한다(코드가 to_regclass 로 먼저 확인 — 없으면 «늦어요 · 일찍 가요» 입구만 숨는다).
-- 기존 표·행을 바꾸는 문장은 없다. 멱등(IF NOT EXISTS)이라 다시 실행해도 안전하다.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."RegularArrivalNotice";
-- (함께 만든 «셔틀 안 타요» 기록은 ShuttleDayException 에 그대로 남는다 — 기사님 화면에는 «자차»로 보인다)

CREATE TABLE IF NOT EXISTS public."RegularArrivalNotice" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "studentId" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  date DATE NOT NULL,
  kind TEXT NOT NULL,
  "expectedTime" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REPORTED',
  "shuttleExceptionId" TEXT,
  "reportedByUserId" TEXT,
  "changeCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "RegularArrivalNotice_kind_check" CHECK (kind IN ('LATE', 'EARLY')),
  CONSTRAINT "RegularArrivalNotice_status_check" CHECK (status IN ('REPORTED', 'CANCELLED')),
  CONSTRAINT "RegularArrivalNotice_expectedTime_check" CHECK ("expectedTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "RegularArrivalNotice_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES public."Student" (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RegularArrivalNotice_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES public."Class" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 표를 먼저 만든 환경에서도 같은 모양이 되게(멱등)
ALTER TABLE public."RegularArrivalNotice" ADD COLUMN IF NOT EXISTS "changeCount" INTEGER NOT NULL DEFAULT 0;

-- 한 아이·한 반·하루에 지각 1건 + 조퇴 1건까지(다시 알리면 같은 행의 시각만 바뀐다)
CREATE UNIQUE INDEX IF NOT EXISTS "RegularArrivalNotice_student_class_date_kind_key"
  ON public."RegularArrivalNotice" ("studentId", "classId", date, kind);
-- 선생님 출석부: 그 반·그 날의 알림
CREATE INDEX IF NOT EXISTS "RegularArrivalNotice_classId_date_idx"
  ON public."RegularArrivalNotice" ("classId", date);
-- 기사님 운행표: 그 날 셔틀 기록과 이어진 알림
CREATE INDEX IF NOT EXISTS "RegularArrivalNotice_date_idx"
  ON public."RegularArrivalNotice" (date) WHERE status = 'REPORTED';

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(ShuttleRegularChangeRequest 와 같은 방식)
ALTER TABLE public."RegularArrivalNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RegularArrivalNotice" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."RegularArrivalNotice" FROM anon, authenticated;
