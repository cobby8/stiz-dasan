-- 간편가입 방식에 Apple 추가 (2026-10-26).
-- Apple 로그인을 켰는데 이 CHECK 가 네 가지 방식만 허락해, 애플로 들어온 학부모의 휴대폰 인증 기록을 저장할 수 없었다.
-- 허용 범위를 넓히기만 한다 — 기존 행(PASSWORD 등)은 그대로 통과한다.
-- 되돌림: 같은 이름으로 DROP 후 ('PASSWORD','GOOGLE','KAKAO','NAVER') 로 다시 건다(APPLE 행이 있으면 먼저 정리).
ALTER TABLE "ParentSignupVerification"
  DROP CONSTRAINT IF EXISTS "ParentSignupVerification_signupMethod_check";

ALTER TABLE "ParentSignupVerification"
  ADD CONSTRAINT "ParentSignupVerification_signupMethod_check"
  CHECK ("signupMethod" IN ('PASSWORD', 'GOOGLE', 'KAKAO', 'NAVER', 'APPLE'));
