-- 학부모 «여러 날 결석»(기간 결석) — 2026-11-15 원장 결정(한도 4주·모든 사유 허용).
--
-- 왜 필요한가: 기간 결석은 관리자만 등록할 수 있었다(학생 상세 › 수강·출결). 학부모는 하루씩만 알릴 수 있어
-- 며칠 쉬는 경우 같은 일을 여러 번 눌러야 했다. 학부모도 «결석 알리기»에서 시작일·끝일을 한 번에 알린다.
--
-- 표를 새로 만들지 않고 기존 "RegularAbsencePeriod" 에 칸 3개만 더한다.
--   reportedByUserId  학부모가 알린 기간이면 그 학부모 계정. NULL = 관리자가 등록한 기간(기존 동작 그대로)
--   openEnded         끝일을 «아직 몰라요»로 알렸다(4주까지만 잡아 둔다) — 끝나기 전에 앱 알림 1회
--   reminderSentAt    그 알림을 보낸 시각(한 번만 보내려고) — timestamptz
--
-- 관리자 기간 결석(CONFIRMED·보강권 없음·매일 자동 연장)은 바뀌지 않는다. 학부모 기간은 자동 연장 대상에서 빠지고,
-- 날짜마다 «하루 알리기»와 같은 결석 행(REPORTED·학부모 표시)으로 저장된다.
-- 멱등(IF NOT EXISTS)이라 다시 실행해도 안전하다. 코드는 이 칸들이 없으면 «여러 날» 기능만 숨기고 나머지는 그대로 돈다.
--
-- ── 되돌림(운영에서 문제가 생기면 아래를 그대로 실행) ─────────────────────────────
--   DROP INDEX IF EXISTS public."RegularAbsencePeriod_reportedByUserId_idx";
--   ALTER TABLE public."RegularAbsencePeriod" DROP COLUMN IF EXISTS "reminderSentAt";
--   ALTER TABLE public."RegularAbsencePeriod" DROP COLUMN IF EXISTS "openEnded";
--   ALTER TABLE public."RegularAbsencePeriod" DROP COLUMN IF EXISTS "reportedByUserId";
--   -- ⚠️ 칸을 지우기 전에 학부모가 알린 기간이 있으면(SELECT count(*) … WHERE "reportedByUserId" IS NOT NULL)
--   --    그 기간 행이 «관리자 기간»으로 보여 매일 자동 연장 대상이 된다. 먼저 그 기간들을 status='ENDED' 로 바꾼 뒤 지울 것:
--   --    UPDATE public."RegularAbsencePeriod" SET status = 'ENDED' WHERE "reportedByUserId" IS NOT NULL AND status = 'ACTIVE';

ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "reportedByUserId" TEXT;
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "openEnded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public."RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMPTZ(6);

-- 학부모 화면의 «내가 알린 기간» 목록 · 매일 알림 대상 찾기
CREATE INDEX IF NOT EXISTS "RegularAbsencePeriod_reportedByUserId_idx"
  ON public."RegularAbsencePeriod" ("reportedByUserId") WHERE "reportedByUserId" IS NOT NULL;
