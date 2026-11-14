-- 질병·부상 결석 «이월 검토»(2026-11-14, 원장 결정표 a1~a8).
--
-- 왜 필요한가: 지금까지는 결석을 알리면 사유와 상관없이 보강권이 바로 나갔다. 원장 결정으로
-- 사유가 «질병·부상»이면 보강권을 바로 주지 않고, 증빙 사진을 본 원장이 [이월 승인](다음 달 수강료에서
-- 1회분 차감) 또는 [보강권으로]를 고른다. 알린 뒤 7일 안에 사진이 없으면 보강권 1장으로 자동 전환한다.
--
-- 표 3개:
--   RegularAbsenceCarryReview   결석 1건당 검토 1줄(상태·사유 글·알린 시각·결정)
--   RegularAbsenceEvidence      증빙 사진(비공개 버킷 경로) — 결석당 살아 있는 사진 최대 3장(코드가 강제)
--   RegularAbsenceEvidenceView  관리자가 증빙 사진을 연 기록(누가·어느 사진·언제) — 건강 정보 열람 추적
--
-- 이월 금액·적립은 새로 만들지 않는다 — 기존 BillingCarryCredit / BillingAbsenceResolution 을 그대로 쓴다
-- (src/lib/billing/workbench-absence.ts resolveWorkbenchAbsence 의 CARRY 규칙).
--
-- 시간 칼럼은 모두 timestamptz(시간대 변환을 한 번만 건다). 멱등(IF NOT EXISTS)이라 다시 실행해도 안전하다.
--
-- ── 되돌림(운영에서 문제가 생기면 아래를 그대로 실행) ─────────────────────────────
--   DROP TABLE IF EXISTS public."RegularAbsenceEvidenceView";
--   DROP TABLE IF EXISTS public."RegularAbsenceEvidence";
--   DROP TABLE IF EXISTS public."RegularAbsenceCarryReview";
--   -- 저장소: Supabase Storage 의 비공개 버킷 «absence-evidence» 는 코드가 처음 올릴 때 만든다.
--   --        되돌릴 때는 대시보드에서 버킷을 비우고 지운다(표를 지워도 파일은 남는다).
--   -- 코드는 두 표가 없으면 예전 방식(사유 무관 즉시 보강권)으로 돌아간다 — 표만 지워도 서비스는 죽지 않는다.

CREATE TABLE IF NOT EXISTS public."RegularAbsenceCarryReview" (
  -- 결석 1건당 1줄. 결석 행이 지워지면(학생 병합에서 겹친 행 정리 등) 검토도 함께 지운다
  "absenceId" TEXT PRIMARY KEY,
  -- PENDING 검토 중 · APPROVED 이월 승인 · MAKEUP 보강권으로 전환 · CLOSED 닫힘(신고 취소·사유 변경)
  status TEXT NOT NULL DEFAULT 'PENDING',
  -- 어디서 생겼나: PARENT 학부모 앱 · KAKAO 카카오 대화 · STAFF 학원(기간 결석·출석부 표시·청구 준비 화면)
  source TEXT NOT NULL DEFAULT 'PARENT',
  -- 학부모가 적은 사유 글(예: 독감). 건강 정보 — 로그·알림 본문에 싣지 않는다
  "reasonText" TEXT,
  -- 검토가 시작된 시각 — «7일 안에 사진» 기준점
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "decidedAt" TIMESTAMPTZ(6),
  -- ADMIN 원장이 결정 · AUTO 7일 지나 자동 전환
  "decidedBy" TEXT,
  "decidedByUserId" TEXT,
  -- 보강권 전환 이유: REJECTED 원장이 [보강권으로] · NO_EVIDENCE 7일 안에 사진 없음
  "convertReason" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- 코드의 상수(ILLNESS_REVIEW_STATUSES 등)와 같은 집합 — 테스트가 비교한다
  CONSTRAINT "RegularAbsenceCarryReview_status_check"
    CHECK (status IN ('PENDING', 'APPROVED', 'MAKEUP', 'CLOSED')),
  CONSTRAINT "RegularAbsenceCarryReview_source_check"
    CHECK (source IN ('PARENT', 'KAKAO', 'STAFF')),
  CONSTRAINT "RegularAbsenceCarryReview_decidedBy_check"
    CHECK ("decidedBy" IS NULL OR "decidedBy" IN ('ADMIN', 'AUTO')),
  CONSTRAINT "RegularAbsenceCarryReview_convertReason_check"
    CHECK ("convertReason" IS NULL OR "convertReason" IN ('REJECTED', 'NO_EVIDENCE')),
  CONSTRAINT "RegularAbsenceCarryReview_reasonText_check"
    CHECK ("reasonText" IS NULL OR char_length("reasonText") <= 100),
  CONSTRAINT "RegularAbsenceCarryReview_absenceId_fkey"
    FOREIGN KEY ("absenceId") REFERENCES public."RegularAbsence" (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- cron: 7일 지난 «검토 중» 찾기 · 신청함 목록
CREATE INDEX IF NOT EXISTS "RegularAbsenceCarryReview_status_requestedAt_idx"
  ON public."RegularAbsenceCarryReview" (status, "requestedAt");

CREATE TABLE IF NOT EXISTS public."RegularAbsenceEvidence" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  -- 결석 행이 지워져도 사진 행은 남겨(absenceId NULL) cron 이 저장소 파일까지 치우게 한다
  "absenceId" TEXT,
  "storageBucket" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  -- 올린 학부모 계정 — 사진은 «올린 본인»과 관리자만 연다
  "uploadedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- 화면에서 뺀 시각(학부모가 지움·교체, 업로드 중단, 검토 닫힘). NULL = 살아 있는 사진
  "removedAt" TIMESTAMPTZ(6),
  -- 저장소 파일까지 지운 시각. NULL = 아직 파일이 있다(cron 이 지울 대상일 수 있다)
  "purgedAt" TIMESTAMPTZ(6),
  CONSTRAINT "RegularAbsenceEvidence_sizeBytes_check" CHECK ("sizeBytes" > 0),
  CONSTRAINT "RegularAbsenceEvidence_absenceId_fkey"
    FOREIGN KEY ("absenceId") REFERENCES public."RegularAbsence" (id)
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RegularAbsenceEvidence_absenceId_idx"
  ON public."RegularAbsenceEvidence" ("absenceId") WHERE "removedAt" IS NULL;
-- cron: 저장소 파일을 아직 안 지운 사진
CREATE INDEX IF NOT EXISTS "RegularAbsenceEvidence_purge_idx"
  ON public."RegularAbsenceEvidence" ("createdAt") WHERE "purgedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "RegularAbsenceEvidence_storagePath_key"
  ON public."RegularAbsenceEvidence" ("storageBucket", "storagePath");

-- 관리자 열람 기록(보안 검수 2026-11-14). 사진 행과 FK 로 묶지 않는다 — 90일 뒤 사진 파일을 지워도 기록(사진 id)은 남긴다.
-- 사유 글·파일 내용은 담지 않는다.
CREATE TABLE IF NOT EXISTS public."RegularAbsenceEvidenceView" (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "evidenceId" TEXT NOT NULL,
  "viewerUserId" TEXT NOT NULL,
  "viewedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "RegularAbsenceEvidenceView_evidenceId_viewedAt_idx"
  ON public."RegularAbsenceEvidenceView" ("evidenceId", "viewedAt");

-- 서버(서비스 키·Prisma 직결)만 접근한다 — 다른 표와 같은 방식(RLS 켜고 정책 없음 + 권한 회수)
ALTER TABLE public."RegularAbsenceCarryReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RegularAbsenceCarryReview" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."RegularAbsenceEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RegularAbsenceEvidence" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."RegularAbsenceEvidenceView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RegularAbsenceEvidenceView" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."RegularAbsenceEvidenceView" FROM PUBLIC;
REVOKE ALL ON TABLE public."RegularAbsenceCarryReview" FROM PUBLIC;
REVOKE ALL ON TABLE public."RegularAbsenceEvidence" FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public."RegularAbsenceCarryReview" FROM %I', r);
      EXECUTE format('REVOKE ALL ON TABLE public."RegularAbsenceEvidence" FROM %I', r);
      EXECUTE format('REVOKE ALL ON TABLE public."RegularAbsenceEvidenceView" FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- 이미 청구 준비 화면에서 이월·보강으로 정산한 질병·부상 결석 → 검토 «끝남»으로 채워 둔다
-- (안 채우면 신청함 «이월 검토»에 끝난 결석이 다시 뜬다). 정산 표가 없는 환경이면 건너뛴다. 다시 실행해도 같은 결과.
DO $$
BEGIN
  IF to_regclass('public."BillingAbsenceResolution"') IS NOT NULL THEN
    INSERT INTO public."RegularAbsenceCarryReview"
      ("absenceId", status, source, "requestedAt", "decidedAt", "decidedBy", "decidedByUserId", "convertReason")
    SELECT a.id,
           CASE WHEN r.resolution = 'CARRY' THEN 'APPROVED' ELSE 'MAKEUP' END,
           'STAFF', a."createdAt", r."createdAt", 'ADMIN', r."actorUserId",
           CASE WHEN r.resolution = 'CARRY' THEN NULL ELSE 'REJECTED' END
      FROM public."BillingAbsenceResolution" r
      JOIN public."RegularAbsence" a ON a.id = r."absenceId"
     WHERE a.reason = 'ILLNESS_INJURY'
    ON CONFLICT ("absenceId") DO NOTHING;
  END IF;
END $$;
