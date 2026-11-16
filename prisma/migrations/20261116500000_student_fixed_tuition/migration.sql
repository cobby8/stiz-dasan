-- 학생별 고정 월 수강료(2026-11-16 원장 결정 — 결정표 x4).
--
-- 왜 필요한가: «이번 달 청구 준비»는 등록 반마다 프로그램 요금(주N회 규칙 포함)을 더한다.
--   그래서 원장이 «매달 15만 원 고정»으로 정한 학생(예: 서우빈 수7+토7)도 반별 합산 금액으로 계산됐다.
--   이 표에 한 줄이 있으면 그 학생의 그 달 정규반 수강료를 반별 합산 대신 이 금액 1건으로 제안한다.
--   형제할인·3회 달 차감은 붙이지 않는다(대회준비반 고정 요금과 같은 규칙). 셔틀비는 따로 그대로 계산한다.
--
-- StudentFixedTuition — 한 행 = 한 학생의 «고정 수강료 기간» 1개.
--   studentId   : 학생(Student.id). 기록용이라 FK 없이 둔다 — 청구 준비가 등록(Enrollment)과 학생 id 로만 맞춘다
--   amount      : 월 수강료(원, 0 이상)
--   startMonth  : 적용 시작 달 'YYYY-MM'
--   endMonth    : 적용 끝 달 'YYYY-MM'(포함). NULL = 끝 없음
--   memo        : 원장 메모(예: 원장 합의)
--   actorUserId : 저장한 원장(User.id)
--   같은 학생의 기간이 겹치지 않게 하는 것은 저장 서버 동작이 막는다(학생 행 잠금 후 확인). 겹쳐도 청구 준비는 가장 나중에 만든 것을 쓴다.
--   시간 칸은 모두 timestamptz
--
-- 이 표가 없어도 사이트는 그대로 동작한다(청구 준비가 표 존재를 확인하고 없으면 예전과 똑같이 계산).
-- 기존 표·행을 바꾸는 문장은 없다.
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."StudentFixedTuition";

CREATE TABLE IF NOT EXISTS public."StudentFixedTuition" (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 10000000),
  "startMonth" TEXT NOT NULL CHECK ("startMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "endMonth" TEXT CHECK ("endMonth" IS NULL OR "endMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  memo TEXT CHECK (memo IS NULL OR char_length(memo) <= 200),
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "StudentFixedTuition_month_order" CHECK ("endMonth" IS NULL OR "endMonth" >= "startMonth")
);

-- 학생 상세에서 그 학생 것 읽기 · 청구 준비에서 학생별로 고르기
CREATE INDEX IF NOT EXISTS "StudentFixedTuition_studentId_idx"
  ON public."StudentFixedTuition" ("studentId");

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가(금액이라 부원장·학부모에게 새지 않게)
ALTER TABLE public."StudentFixedTuition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StudentFixedTuition" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."StudentFixedTuition" FROM anon, authenticated;
