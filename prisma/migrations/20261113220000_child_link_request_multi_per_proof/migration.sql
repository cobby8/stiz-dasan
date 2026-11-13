-- 형제 간편 연결(2026-11-13 f8): 본인인증 1건으로 여러 아이의 가족 승인 요청을 보낼 수 있게 한다.
-- 예전: 인증 1건 = 요청 1건(challengeId UNIQUE) → 형제마다 본인인증을 다시 해야 했다.
-- 바꾼 뒤: 같은 인증으로 아이마다 요청 1건씩. «같은 아이에게 진행 중 요청 1건»은 기존 ChildLinkRequest_pending_unique 가 그대로 막는다.
-- 데이터는 지우거나 바꾸지 않는다(제약만 일반 색인으로 교체). 되돌림: 같은 challengeId 가 2건 이상인 행이 없을 때만
--   DROP INDEX "ChildLinkRequest_challengeId_idx"; ALTER TABLE "ChildLinkRequest" ADD CONSTRAINT "ChildLinkRequest_challengeId_key" UNIQUE ("challengeId");
ALTER TABLE "ChildLinkRequest" DROP CONSTRAINT IF EXISTS "ChildLinkRequest_challengeId_key";
CREATE INDEX IF NOT EXISTS "ChildLinkRequest_challengeId_idx" ON "ChildLinkRequest"("challengeId");
