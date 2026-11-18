-- 로그인하지 않은 사람의 본인인증 시작 장부 (2026-11-18 원장 결정 «가입·본인인증 통일» 4단계).
--
-- 왜: 아이디 가입·기존 계정 활성화·아이디/비밀번호 찾기가 이제 본인인증(포트원)을 먼저 쓴다. 로그인 전이라
--     «누가 시작했는지»를 세션으로 묶을 수 없어서, 서버가 건 번호를 만들 때 이 장부에 한 줄 적는다.
--     - 같은 IP 한도(시간·하루)와 전체 하루 한도를 센다 — 본인인증은 건당 비용이 든다.
--     - 확인(verify) 때 그 줄을 «한 번만» 소진한다(consumedAt) — 같은 건 번호·쿠키를 다시 써도 통과하지 못한다.
--     - 10분이 지난 줄은 확인에서 받지 않는다. 7일 지난 줄은 다음 시작 때 지운다.
--     IP 원문·이름·번호는 적지 않는다(IP 는 HMAC 해시만).
-- 안전: 표 하나를 «추가»만 한다. 몇 번 실행해도 같다(IF NOT EXISTS).
--     ⚠️ 이 표를 쓰는 코드(/api/auth/parent-signup/identity/*, /api/auth/parent-password-reset/identity/*)보다
--        «먼저» 운영 DB 에 적용해야 한다. 없으면 본인인증 시작이 실패한다(문자 인증 샛길은 그대로 동작).
--
-- ── 되돌림 SQL(필요할 때만 — 코드도 함께 되돌린 뒤) ──
-- DROP TABLE IF EXISTS "IdentityVerificationStart";

CREATE TABLE IF NOT EXISTS "IdentityVerificationStart" (
  "id" text PRIMARY KEY,
  "purpose" text NOT NULL,
  "requestHash" text NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT NOW(),
  "consumedAt" timestamptz(6),
  CONSTRAINT "IdentityVerificationStart_purpose_check" CHECK ("purpose" IN ('SIGNUP', 'RESET'))
);
CREATE INDEX IF NOT EXISTS "IdentityVerificationStart_requestHash_createdAt_idx"
  ON "IdentityVerificationStart" ("requestHash", "createdAt");
CREATE INDEX IF NOT EXISTS "IdentityVerificationStart_createdAt_idx"
  ON "IdentityVerificationStart" ("createdAt");

-- 서버(Prisma)만 읽고 쓴다. 공개 API(anon/authenticated)로는 보이지 않게 한다(가입 인증 표와 같은 설정).
ALTER TABLE "IdentityVerificationStart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityVerificationStart" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "IdentityVerificationStart" FROM anon, authenticated;
