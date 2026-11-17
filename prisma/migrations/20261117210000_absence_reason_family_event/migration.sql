-- 결석 사유에 «경조사(직계 가족)» FAMILY_EVENT 추가 (2026-11-17 원장 결정)
--
-- ■ 왜
--   약관상 결석 이월(다음 달 수강료 1회분 차감)은 «수강생 본인 질병·부상»과 «직계 가족 경조사»만이다.
--   지금까지 경조사를 고를 사유가 없어 «개인 사정»으로 들어가 보강권만 받았다.
--
-- ■ 무엇을 바꾸나
--   RegularAbsence.reason 은 CHECK 제약이 없는 TEXT 라 바꿀 것이 없다(앱 검증만).
--   RegularAbsencePeriod.reason 에만 CHECK 제약(20261109180000)이 있어, 같은 집합에 FAMILY_EVENT 를 더한다.
--   코드 VALID_REASONS(src/lib/regular/regularAbsenceRules.ts)와 같은 집합(tests/absence-period-plan.test.mjs 가 비교).
--
-- ■ 기존 데이터
--   제약을 넓히기만 한다 — 기존 행은 그대로 통과한다. 여러 번 실행해도 같은 결과(DROP IF EXISTS → ADD).
--
-- 운영 적용: Supabase apply_migration (PM). ⚠️ 새 코드보다 «먼저» 적용해야 한다 —
--   적용 전에 기간 결석을 «경조사»로 등록하면 이 제약이 INSERT 를 거절한다(하루 결석 신고는 영향 없음).
--
-- 되돌림 SQL(경조사로 등록된 기간 결석이 있으면 먼저 다른 사유로 바꿔야 한다):
--   SELECT count(*) FROM "RegularAbsencePeriod" WHERE reason = 'FAMILY_EVENT';   -- 먼저 확인(0이어야 함)
--   ALTER TABLE "RegularAbsencePeriod" DROP CONSTRAINT IF EXISTS "RegularAbsencePeriod_reason_check";
--   ALTER TABLE "RegularAbsencePeriod" ADD CONSTRAINT "RegularAbsencePeriod_reason_check"
--     CHECK (reason IN ('ILLNESS_INJURY','PERSONAL','FAMILY_TRIP','SCHOOL_EVENT','ETC'));

ALTER TABLE "RegularAbsencePeriod" DROP CONSTRAINT IF EXISTS "RegularAbsencePeriod_reason_check";
ALTER TABLE "RegularAbsencePeriod" ADD CONSTRAINT "RegularAbsencePeriod_reason_check"
  CHECK (reason IN ('ILLNESS_INJURY','PERSONAL','FAMILY_TRIP','SCHOOL_EVENT','ETC','FAMILY_EVENT'));
