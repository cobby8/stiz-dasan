-- 카카오 채널 정책 답변(Gemini) — 정책 문서 이력 · 켜기/끄기 설정 · 질문 기록.
--
-- 왜 필요한가: 카카오 챗봇이 업무 접수와 화면 링크만 안내하고, 요금·환불·보강·셔틀 같은
-- "학원 정책 질문"에는 답하지 못했다. 원장님이 고칠 수 있는 정책 문서 한 벌을 두고,
-- 그 문서에 적힌 내용만으로 짧게 답하게 한다. 모르는 건 지어내지 않고 원장님 확인으로 넘긴다.
--
-- 테이블 3개
--  1) KakaoPolicyDocumentVersion : 정책 문서 버전 이력. 저장할 때마다 한 줄 추가(덮어쓰지 않는다).
--                                  가장 최근 행이 "현재 문서"다. 누가·언제·이전 내용이 그대로 남는다.
--  2) KakaoPolicyQaSetting       : 정책 답변 켜기/끄기(킬 스위치). 행이 1개뿐이다. 기본값은 꺼짐.
--  3) KakaoPolicyQaLog           : 질문·답·결과·소요시간 기록. 카카오 사용자키는 해시만, 전화번호는 저장하지 않는다.
--                                  180일 지난 기록은 data-retention 크론이 지운다.

BEGIN;

CREATE TABLE IF NOT EXISTS "KakaoPolicyDocumentVersion" (
  "id"             TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "content"        TEXT NOT NULL,
  -- 저장한 관리자(계정이 지워져도 이력은 남도록 이름도 함께 적는다)
  "editorUserId"   TEXT,
  "editorName"     TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- 문서가 끝없이 커지지 않게 막는다(프롬프트에 통째로 들어간다)
  CONSTRAINT "KakaoPolicyDocumentVersion_content_length_check" CHECK (char_length("content") <= 30000)
);
CREATE INDEX IF NOT EXISTS "KakaoPolicyDocumentVersion_createdAt_idx"
  ON "KakaoPolicyDocumentVersion" ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS "KakaoPolicyQaSetting" (
  "id"              TEXT PRIMARY KEY DEFAULT 'default',
  "enabled"         BOOLEAN NOT NULL DEFAULT false,
  "updatedByUserId" TEXT,
  "updatedByName"   TEXT,
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- 설정은 한 벌뿐이다
  CONSTRAINT "KakaoPolicyQaSetting_singleton_check" CHECK ("id" = 'default')
);
-- 처음엔 꺼진 상태로 한 줄 넣어 둔다(꺼져 있으면 기존 챗봇 동작과 100% 같다)
INSERT INTO "KakaoPolicyQaSetting" ("id", "enabled") VALUES ('default', false)
  ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "KakaoPolicyQaLog" (
  "id"           TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  -- 질문 원문은 500자까지만 저장한다
  "question"     VARCHAR(500) NOT NULL,
  "answer"       TEXT,
  -- ANSWERED: 답함 / ESCALATE: 문서에 없어 원장님 확인으로 넘김 / TIMEOUT: 시간 초과 / ERROR: 호출 오류
  "outcome"      TEXT NOT NULL,
  -- SYNC: 5초 안에 바로 답 / CALLBACK: 카카오 콜백으로 나중에 답
  "mode"         TEXT NOT NULL,
  "linked"       BOOLEAN NOT NULL,
  "latencyMs"    INTEGER NOT NULL,
  -- 카카오 사용자키의 HMAC 해시(원문 저장 금지). 같은 사람의 반복 질문만 묶어 볼 수 있다.
  "userKeyHash"  TEXT NOT NULL,
  -- 콜백 전송 성공 여부(동기 경로는 NULL)
  "callbackOk"   BOOLEAN,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "KakaoPolicyQaLog_outcome_check" CHECK ("outcome" IN ('ANSWERED', 'ESCALATE', 'TIMEOUT', 'ERROR')),
  CONSTRAINT "KakaoPolicyQaLog_mode_check" CHECK ("mode" IN ('SYNC', 'CALLBACK'))
);
CREATE INDEX IF NOT EXISTS "KakaoPolicyQaLog_createdAt_idx" ON "KakaoPolicyQaLog" ("createdAt" DESC);
-- 비용 남용 한도(같은 사용자 1분 5회·24시간 30회)를 셀 때 쓴다
CREATE INDEX IF NOT EXISTS "KakaoPolicyQaLog_userKeyHash_createdAt_idx" ON "KakaoPolicyQaLog" ("userKeyHash", "createdAt" DESC);
-- 전체 하루 상한(KST 하루 1,500건)·180일 정리를 셀 때 쓴다(오름차순 범위 조회)
CREATE INDEX IF NOT EXISTS "KakaoPolicyQaLog_createdAt_asc_idx" ON "KakaoPolicyQaLog" ("createdAt");

-- 서버에서만 접근한다. 브라우저의 공개 키(anon)·로그인 사용자 키로는 열지 않는다.
ALTER TABLE "KakaoPolicyDocumentVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KakaoPolicyQaSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KakaoPolicyQaLog" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "KakaoPolicyDocumentVersion" FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE "KakaoPolicyQaSetting" FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE "KakaoPolicyQaLog" FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE "KakaoPolicyDocumentVersion" TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE "KakaoPolicyQaSetting" TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE "KakaoPolicyQaLog" TO service_role;

COMMIT;
