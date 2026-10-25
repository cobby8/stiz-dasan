-- 다중 역할 — 한 사람이 선생님이면서 기사님, 기사님이면서 학부모일 수 있게 한다.
--
-- 왜 User.role 을 바꾸지 않고 표를 따로 두는가:
--   역할 값을 직접 비교하는 곳이 73곳(23개 파일)이다. 칸 자체를 배열로 바꾸면 권한 검사가
--   대거 흔들린다. 그래서 User.role 은 「주 역할」로 그대로 두고, 이 표에 「추가 역할」을 쌓는다.
--
-- 왜 승인 신청도 이 표인가:
--   스토어에서 앱을 받은 사람이 가입할 때 「선생님」을 고를 수 있다. 고르기만 해서 열리면
--   아무나 모든 학생의 개인정보를 보게 된다. 그래서 고르면 PENDING 으로 남고, 원장이 승인하면
--   ACTIVE 가 된다. 초대 링크로 들어온 사람은 바로 ACTIVE 다(원장이 이미 보낸 것이므로).
--
--   PENDING  = 승인 신청 대기
--   ACTIVE   = 부여된 역할(화면이 열린다)
--   REJECTED = 원장이 반려
--   REVOKED  = 부여했다가 회수
--
-- ⚠️ 관리자(ADMIN·VICE_ADMIN)는 이 표로 줄 수 없다(CHECK). 관리자 권한은 지금처럼
--    원장이 기존 경로(updateUserRole)로만 부여한다 — 신청 표에 섞이면 승인 실수 한 번이 사고다.
--    학부모(PARENT)도 없다 — 자녀가 등록돼 있으면 자동으로 학부모 화면이 열린다(기존 규칙).

CREATE TABLE IF NOT EXISTS public."UserRoleGrant" (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"      TEXT        NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  role          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'PENDING',
  source        TEXT        NOT NULL DEFAULT 'REQUEST',
  "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "decidedAt"   TIMESTAMPTZ,
  "decidedBy"   TEXT        REFERENCES public."User"(id) ON DELETE SET NULL,
  note          TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "UserRoleGrant_role_check"   CHECK (role IN ('INSTRUCTOR', 'DRIVER')),
  CONSTRAINT "UserRoleGrant_status_check" CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED')),
  CONSTRAINT "UserRoleGrant_source_check" CHECK (source IN ('REQUEST', 'INVITE', 'ADMIN')),
  -- 처리된 건에는 처리 시각이 있어야 한다(누가 언제 열었는지 남아야 한다).
  CONSTRAINT "UserRoleGrant_decided_check" CHECK (status = 'PENDING' OR "decidedAt" IS NOT NULL)
);

-- 같은 사람·같은 역할에 살아 있는 건(신청 중이거나 부여됨)은 하나뿐이다.
-- 둘이면 하나를 회수해도 다른 하나로 화면이 계속 열린다.
CREATE UNIQUE INDEX IF NOT EXISTS "UserRoleGrant_live_unique"
  ON public."UserRoleGrant" ("userId", role) WHERE status IN ('PENDING', 'ACTIVE');

-- 원장 승인 대기 목록.
CREATE INDEX IF NOT EXISTS "UserRoleGrant_pending_idx"
  ON public."UserRoleGrant" ("requestedAt") WHERE status = 'PENDING';

-- 권한 판정(로그인할 때마다 읽는다).
CREATE INDEX IF NOT EXISTS "UserRoleGrant_user_active_idx"
  ON public."UserRoleGrant" ("userId") WHERE status = 'ACTIVE';

-- 공개 스키마 표는 RLS 를 켜고 브라우저 쪽 키(anon·authenticated)의 직접 접근을 막는다.
-- 이 표가 열리면 누구나 자기에게 선생님 권한을 쓸 수 있다.
ALTER TABLE public."UserRoleGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."UserRoleGrant" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."UserRoleGrant" FROM anon, authenticated;
