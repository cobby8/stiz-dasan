-- 학부모가 아이 정보를 직접 고치기(2026-11-14 원장 결정 b4·b5).
--
-- 왜 필요한가: 학부모 «아이 기록 › 아이 정보»는 읽기 전용이라, 학교·주소·건강 특이사항이 바뀌어도 학원에 전화해야 했다.
--   · 학교·학생 전화·주소·건강 특이사항 = 학부모가 바로 고친다(기존 Student 칸 + 새 칸 healthNote).
--   · 이름·생년월일 = 수강료·반 배정에 영향 → «변경 신청»을 남기고 원장·부원장이 승인한다(새 표).
--
-- ① Student."healthNote" — 건강·알레르기·특이사항(300자 이내). 선생님(자기 반)·기사님(자기 노선)·관리자·그 아이의 보호자만 본다.
--    알림 본문·로그·공개 화면에는 쓰지 않는다(코드 가드 tests/child-edit.test.mjs).
-- ② StudentProfileChangeRequest — 한 행 = 이름 또는 생년월일 변경 신청 1건. 이 표 자체가 «누가·언제·무엇을» 이력이다.
--    field           : 'name' | 'birthDate'
--    oldValue/newValue: 글자 그대로(생년월일은 KST 달력 날짜 "YYYY-MM-DD")
--    status          : PENDING(확인 중) → APPROVED(승인·반영) | REJECTED(반려) | CANCELED(학부모 취소)
--    requestedByUserId/decidedByUserId: 앱 계정(User.id) — 기록용이라 FK 없이 둔다(탈퇴해도 이력은 남긴다)
--    시간 칸은 모두 timestamptz
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."StudentProfileChangeRequest";
-- ALTER TABLE public."Student" DROP CONSTRAINT IF EXISTS "Student_healthNote_length_check";
-- ALTER TABLE public."Student" DROP COLUMN IF EXISTS "healthNote";

ALTER TABLE public."Student" ADD COLUMN IF NOT EXISTS "healthNote" TEXT;

-- 300자 상한(코드 HEALTH_NOTE_MAX 와 같은 값). ADD CONSTRAINT 에는 IF NOT EXISTS 가 없어 있는지 먼저 본다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'Student_healthNote_length_check'
       AND conrelid = to_regclass('public."Student"')
  ) THEN
    ALTER TABLE public."Student"
      ADD CONSTRAINT "Student_healthNote_length_check"
      CHECK ("healthNote" IS NULL OR char_length("healthNote") <= 300);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public."StudentProfileChangeRequest" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "studentId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  field TEXT NOT NULL,
  "oldValue" TEXT,
  "newValue" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  note TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "decidedAt" TIMESTAMPTZ(6),
  "decidedByUserId" TEXT,
  CONSTRAINT "StudentProfileChangeRequest_field_check" CHECK (field IN ('name', 'birthDate')),
  CONSTRAINT "StudentProfileChangeRequest_status_check" CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED')),
  CONSTRAINT "StudentProfileChangeRequest_newValue_check" CHECK (char_length("newValue") BETWEEN 1 AND 60),
  CONSTRAINT "StudentProfileChangeRequest_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES public."Student" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 한 아이의 같은 항목에 «확인 중» 신청은 하나만(다시 신청하려면 먼저 취소)
CREATE UNIQUE INDEX IF NOT EXISTS "StudentProfileChangeRequest_pending_unique"
  ON public."StudentProfileChangeRequest" ("studentId", field)
  WHERE status = 'PENDING';
-- 학생 상세 «정보 변경 요청» 칸: 이 학생의 신청을 최신순으로
CREATE INDEX IF NOT EXISTS "StudentProfileChangeRequest_studentId_createdAt_idx"
  ON public."StudentProfileChangeRequest" ("studentId", "createdAt" DESC);

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(ClassSubstitute 와 같은 방식)
ALTER TABLE public."StudentProfileChangeRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StudentProfileChangeRequest" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."StudentProfileChangeRequest" FROM anon, authenticated;
