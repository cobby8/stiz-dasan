-- 학부모 문의 «이어 쓰기»(대화) + 환불 문의의 청구 연결 (2026-11-14 원장 결정표 c3·c11).
--
-- 왜 필요한가:
--   · 지금 문의(ParentRequest)는 «학부모 글 1개 + 학원 답 1줄(adminNote)»이 전부라, 답을 받은 뒤 한마디 더 하려면
--     새 문의를 또 만들어야 했다. → 문의 한 건 아래에 글을 계속 붙이는 표를 둔다.
--   · 환불 문의는 «어느 청구에 대한 것인지»를 글이 아니라 값으로 남겨야 관리자가 그 청구를 바로 찾는다.
--
-- ① ParentRequestMessage — 한 행 = 문의에 이어 붙인 글 1개.
--    requestId    : 어느 문의인가(문의를 지우면 글도 함께 지워진다)
--    authorRole   : 'PARENT'(학부모) | 'ADMIN'(학원)
--    authorUserId : 쓴 사람 User.id — 기록용이라 FK 없이 둔다(탈퇴해도 글은 남긴다)
--    body         : 1~2,000자(코드 INQUIRY_BODY_MAX 와 같은 값)
--    createdAt    : timestamptz
--    문의의 첫 글(ParentRequest.content)과 옛 답변(adminNote)은 옮기지 않는다 — 화면이 «첫 글 → 옛 답변 → 이 표의 글» 순서로 이어 보인다.
-- ② ParentRequest."paymentId" / "paymentAmount" — 환불 문의가 가리키는 청구와 그때의 금액(원). 일반 문의는 둘 다 NULL.
--    청구를 지워도 문의는 남아야 해서 FK 없이 둔다.
--
-- 이 SQL 을 적용하기 «전»에도 화면은 동작한다: 대화는 «첫 글 + 옛 답변»만 보이고, 학원 답은 예전처럼 adminNote 에 저장되며,
-- 학부모 «이어 쓰기»와 «환불 문의»의 청구 연결만 빠진다(환불 문의 자체는 제목에 청구 내용이 적혀 접수된다).
--
-- ── 되돌림 SQL(필요할 때만) ─────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public."ParentRequestMessage";
-- DROP INDEX IF EXISTS public."ParentRequest_paymentId_idx";
-- ALTER TABLE public."ParentRequest" DROP COLUMN IF EXISTS "paymentAmount";
-- ALTER TABLE public."ParentRequest" DROP COLUMN IF EXISTS "paymentId";

CREATE TABLE IF NOT EXISTS public."ParentRequestMessage" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "requestId" TEXT NOT NULL,
  "authorRole" TEXT NOT NULL,
  "authorUserId" TEXT,
  body TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ParentRequestMessage_authorRole_check" CHECK ("authorRole" IN ('PARENT', 'ADMIN')),
  CONSTRAINT "ParentRequestMessage_body_check" CHECK (char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT "ParentRequestMessage_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES public."ParentRequest" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 문의 한 건의 글을 쓴 순서대로 읽는다
CREATE INDEX IF NOT EXISTS "ParentRequestMessage_requestId_createdAt_idx"
  ON public."ParentRequestMessage" ("requestId", "createdAt");

-- 서버만 읽고 쓴다 — 브라우저 키(anon·authenticated)로는 직접 접근 불가
ALTER TABLE public."ParentRequestMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ParentRequestMessage" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."ParentRequestMessage" FROM anon, authenticated;

-- 환불 문의 → 청구 연결(일반 문의는 NULL)
ALTER TABLE public."ParentRequest" ADD COLUMN IF NOT EXISTS "paymentId" TEXT;
ALTER TABLE public."ParentRequest" ADD COLUMN IF NOT EXISTS "paymentAmount" INTEGER;

-- «이 청구에 열려 있는 환불 문의가 있는가»를 찾는다(환불 문의만 색인)
CREATE INDEX IF NOT EXISTS "ParentRequest_paymentId_idx"
  ON public."ParentRequest" ("paymentId")
  WHERE "paymentId" IS NOT NULL;
