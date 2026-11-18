-- 새 선생님·기사님 «역할 미리 붙여 두기» 초대 (2026-11-18 원장 결정 «가입·본인인증 통일» 5단계).
--
-- 왜: 새로 오는 선생님·기사님도 학부모와 같은 가입 화면(/signup/parent — 아이디 또는 간편로그인 + 본인인증)으로
--     가입한다. 원장 초대는 «이 번호에 역할을 미리 붙여 두기»로 바뀐다(유효 30일). 가입·계정 연결이 끝나는 순간
--     같은 번호의 미리 붙인 역할을 적용한다(src/lib/staff/rolePreset.ts):
--       - 본인인증 + 실명이 초대 이름과 같음 → 추가 역할(UserRoleGrant) ACTIVE
--       - 문자 인증 샛길·이름 다름·같은 번호 계정 여럿 → UserRoleGrant PENDING(원장 신청함에서 확인)
--     그래서 StaffInvitation.purpose 에 'ROLE_PRESET' 를 더한다. 이 초대는 새 로그인 계정(@staff)을 만들지 않으므로
--     대상 기록(targetUserId)이 없고, 역할은 선생님·기사님만이다.
-- 안전: 허용값을 «넓히기»만 한다(기존 SIGNUP·PASSWORD_RESET 줄은 그대로 통과). 몇 번 실행해도 같다.
--     코드보다 «먼저» 적용해야 한다 — 없으면 원장의 새 초대 만들기가 CHECK 위반으로 실패한다(기존 초대·가입은 영향 없음).
--
-- ── 되돌림 SQL(필요할 때만 — 코드도 함께 되돌리고, ROLE_PRESET 줄을 먼저 정리한 뒤) ──
-- UPDATE "StaffInvitation" SET status = 'CANCELLED', "updatedAt" = NOW() WHERE purpose = 'ROLE_PRESET' AND status = 'PENDING';
-- -- (ROLE_PRESET 줄이 남아 있으면 아래 CHECK 가 실패한다 — 남길 필요가 없으면 DELETE FROM "StaffInvitation" WHERE purpose = 'ROLE_PRESET';)
-- ALTER TABLE "StaffInvitation" DROP CONSTRAINT IF EXISTS "StaffInvitation_role_preset_shape_check";
-- ALTER TABLE "StaffInvitation" DROP CONSTRAINT IF EXISTS "StaffInvitation_purpose_check";
-- ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_purpose_check" CHECK ("purpose" IN ('SIGNUP', 'PASSWORD_RESET'));
-- DROP INDEX IF EXISTS "StaffInvitation_phone_purpose_status_idx";

-- 1) 허용값 넓히기 — 같은 이름의 제약을 지우고 다시 만든다(목록만 늘어난다)
ALTER TABLE "StaffInvitation" DROP CONSTRAINT IF EXISTS "StaffInvitation_purpose_check";
ALTER TABLE "StaffInvitation"
  ADD CONSTRAINT "StaffInvitation_purpose_check"
    CHECK ("purpose" IN ('SIGNUP', 'PASSWORD_RESET', 'ROLE_PRESET'));

-- 2) ROLE_PRESET 모양 — 새 사람 전용(대상 기록 없음) · 선생님·기사님만
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffInvitation_role_preset_shape_check') THEN
    ALTER TABLE "StaffInvitation"
      ADD CONSTRAINT "StaffInvitation_role_preset_shape_check"
        CHECK ("purpose" <> 'ROLE_PRESET' OR ("targetUserId" IS NULL AND role IN ('INSTRUCTOR'::"Role", 'DRIVER'::"Role")));
  END IF;
END $$;

-- 3) 가입 순간 «같은 번호의 대기 중 ROLE_PRESET» 을 찾는 조회용 색인
CREATE INDEX IF NOT EXISTS "StaffInvitation_phone_purpose_status_idx"
  ON "StaffInvitation" (phone, purpose, status);
