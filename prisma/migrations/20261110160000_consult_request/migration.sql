-- 상담 신청(ConsultRequest) — 2026-11-10 원장 승인(k1·m4)
--
-- ■ 무엇
--   «학생 인적 사항·희망 수업·요청사항을 입력하면 관리자가 확인 후 유선 연락하는 기능».
--   접수 경로 3곳: 홈페이지 /apply/consult(PUBLIC_WEB) · 챗봇 [ACTION:CONSULT] 버튼(CHATBOT) · 학부모 앱 형제 상담(PARENT_APP).
--   관리자 신청함 «상담» 탭에서 NEW(새 상담) → CONTACTED(연락함) → DONE(완료) / CANCELED(취소).
--
-- ■ 기존 데이터
--   새 표 하나 추가뿐 — 기존 표·행은 건드리지 않는다. 여러 번 실행해도 같은 결과(IF NOT EXISTS / 제약 존재 확인).
--
-- ■ 개인정보 최소 수집
--   학생 이름·학년(나이), 보호자 이름(선택)·연락처, 희망 요일·시간, 요청사항만. 생년월일·학교·주소는 받지 않는다.
--   접속 주소는 원문 대신 sha256 지문만(남용 방지 한도용). 공개 키(anon/authenticated)로는 못 읽게 막는다.
--
-- ⚠️ 상태·경로 목록은 코드 CONSULT_STATUSES / CONSULT_SOURCES(src/lib/consult/consult-rules.ts)와 같아야 한다
--    (tests/consult-request.test.mjs 가 비교한다 — 한쪽만 바꾸면 DB 가 INSERT/UPDATE 를 통째로 거부한다).
--
-- 운영 적용: Supabase apply_migration (PM). ⚠️ 새 코드보다 «먼저» 적용 —
--   표가 없으면 상담 신청 저장이 실패한다(신청함 «상담» 목록·숫자는 빈 값으로 넘어가게 막아 두었다).
--
-- 사전 확인(SELECT):
--   SELECT to_regclass('public."ConsultRequest"');           -- NULL 이어야 새로 만든다
--   SELECT conname FROM pg_constraint WHERE conname LIKE 'ConsultRequest_%';
-- 되돌림 SQL:
--   DROP TABLE IF EXISTS "ConsultRequest";

CREATE TABLE IF NOT EXISTS "ConsultRequest" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "studentName" TEXT NOT NULL CHECK (length("studentName") BETWEEN 1 AND 40),
  grade TEXT NOT NULL CHECK (length(grade) BETWEEN 1 AND 20),               -- 학년/나이(예: 초3, 6세)
  "guardianName" TEXT CHECK ("guardianName" IS NULL OR length("guardianName") <= 40),
  "guardianPhone" TEXT NOT NULL CHECK ("guardianPhone" ~ '^01[016789][0-9]{7,8}$'), -- 숫자만
  "preferredDays" TEXT CHECK ("preferredDays" IS NULL OR length("preferredDays") <= 100),
  "preferredTimes" TEXT CHECK ("preferredTimes" IS NULL OR length("preferredTimes") <= 100),
  message TEXT CHECK (message IS NULL OR length(message) <= 1000),           -- 요청사항
  source TEXT NOT NULL CHECK (source IN ('PUBLIC_WEB','CHATBOT','PARENT_APP')),
  "requestedByUserId" TEXT,                                                    -- 학부모 앱에서 온 경우 User.id
  "clientIpHash" TEXT CHECK ("clientIpHash" IS NULL OR "clientIpHash" ~ '^[0-9a-f]{64}$'),
  "privacyConsentAt" TIMESTAMPTZ(6) NOT NULL,                                  -- 개인정보 수집·이용 동의 시각
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CONTACTED','DONE','CANCELED')),
  "adminNote" TEXT CHECK ("adminNote" IS NULL OR length("adminNote") <= 1000),
  "contactedAt" TIMESTAMPTZ(6),                                                -- 처음 «연락함» 누른 시각
  "closedAt" TIMESTAMPTZ(6),                                                   -- 완료·취소 시각
  "handledByUserId" TEXT,                                                      -- 마지막으로 처리한 관리자 User.id
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- 앱 신청이면 누가 보냈는지 반드시 남는다(앱이 아니면 비워도 된다)
  CONSTRAINT "ConsultRequest_app_user_check" CHECK (source <> 'PARENT_APP' OR "requestedByUserId" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "ConsultRequest_status_createdAt_idx" ON "ConsultRequest" (status, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "ConsultRequest_phone_createdAt_idx" ON "ConsultRequest" ("guardianPhone", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "ConsultRequest_ip_createdAt_idx" ON "ConsultRequest" ("clientIpHash", "createdAt" DESC);

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근(체육관 대관 표와 같은 방식)
ALTER TABLE "ConsultRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "ConsultRequest" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON "ConsultRequest" FROM %I', r);
  END IF;
END LOOP; END $$;
