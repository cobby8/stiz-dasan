-- 총 재원기간 기준값(Student 3칸) + 3년 이상 재원생 유니폼 무료 증정 링크(UniformFreeGrant)
-- 운영 적용은 별도 승인 대상. 기준값 입력·링크 발급은 이 파일에서 하지 않는다.
-- 여러 번 실행해도 같은 결과가 되도록(IF NOT EXISTS / 제약 존재 확인) 작성했다.

-- 1) Student: 옛 구글시트 기준 재원기간
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "tenureBaselineMonths" INTEGER;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "tenureBaselineThrough" TEXT;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "tenureFirstMonth" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_tenureBaselineMonths_check') THEN
    ALTER TABLE "Student" ADD CONSTRAINT "Student_tenureBaselineMonths_check"
      CHECK ("tenureBaselineMonths" IS NULL OR ("tenureBaselineMonths" >= 0 AND "tenureBaselineMonths" <= 600));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_tenureBaselineThrough_check') THEN
    ALTER TABLE "Student" ADD CONSTRAINT "Student_tenureBaselineThrough_check"
      CHECK ("tenureBaselineThrough" IS NULL OR "tenureBaselineThrough" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_tenureFirstMonth_check') THEN
    ALTER TABLE "Student" ADD CONSTRAINT "Student_tenureFirstMonth_check"
      CHECK ("tenureFirstMonth" IS NULL OR "tenureFirstMonth" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$');
  END IF;
END $$;

-- 2) UniformFreeGrant: 학생별 전용 링크 1개 = 무료 유니폼 1벌
CREATE TABLE IF NOT EXISTS "UniformFreeGrant" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "studentId" TEXT NOT NULL,
  token TEXT NOT NULL CHECK (token ~ '^[A-Za-z0-9_-]{32}$'),
  reason TEXT NOT NULL DEFAULT 'TENURE_3Y',
  "tenureMonths" INTEGER NOT NULL CHECK ("tenureMonths" >= 0),
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','USED','REVOKED')),
  "uniformOrderId" TEXT,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "usedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "UniformFreeGrant_used_has_usedAt" CHECK (status <> 'USED' OR "usedAt" IS NOT NULL),
  CONSTRAINT "UniformFreeGrant_studentId_fkey" FOREIGN KEY ("studentId")
    REFERENCES "Student"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "UniformFreeGrant_uniformOrderId_fkey" FOREIGN KEY ("uniformOrderId")
    REFERENCES "UniformOrder"(id) ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "UniformFreeGrant_token_key" ON "UniformFreeGrant" (token);
CREATE INDEX IF NOT EXISTS "UniformFreeGrant_studentId_idx" ON "UniformFreeGrant" ("studentId");
-- 학생·사유별로 취소되지 않은 링크는 하나만(중복 증정 방지). 다시 발급하려면 기존 링크를 REVOKED 로.
CREATE UNIQUE INDEX IF NOT EXISTS "UniformFreeGrant_one_active_per_reason"
  ON "UniformFreeGrant" ("studentId", reason) WHERE status <> 'REVOKED';

-- 공개 키(anon/authenticated)로는 못 읽게 — 서버(Prisma)만 접근
ALTER TABLE "UniformFreeGrant" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "UniformFreeGrant" FROM PUBLIC, anon, authenticated;
