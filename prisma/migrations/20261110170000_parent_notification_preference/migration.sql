-- 학부모 앱 알림(웹푸시) «종류별 받기»(2026-11-10 원장 결정 k7).
--
-- ■ 무엇
--   학부모 설정 화면 «알림 설정»에서 출결·청구·공지·셔틀 휴대폰 알림을 종류별로 끈다.
--   학부모 한 명당 한 줄. 줄이 없으면 전부 받기(기본값 true).
--   끄는 건 휴대폰 울림(웹푸시)만이다 — 종 목록(Notification)에는 그대로 쌓인다.
--
-- ■ 발송 쪽 연결
--   모든 웹푸시는 src/lib/pushNotification.ts 의 sendPushToUser / sendPushToAllParents 를 지난다.
--   거기서 tag(=알림 종류)로 이 표를 보고 끈 사람에게는 보내지 않는다(pushCategoryOf 규칙).
--
-- ■ 기존 데이터
--   새 표 하나뿐 — 기존 표·칸은 바꾸지 않는다. 여러 번 실행해도 같은 결과(IF NOT EXISTS).
--
-- ■ 운영 적용 순서
--   코드가 먼저 나가도 깨지지 않는다 — 표가 없으면 조회 실패를 «전부 받기»로 보고(알림이 끊기지 않음),
--   설정 화면은 종류별 칸을 숨긴다. 표를 만든 뒤부터 종류별 칸이 보이고 저장된다.
--   운영 적용: Supabase apply_migration (PM, 원장 확인 후).

CREATE TABLE IF NOT EXISTS "ParentNotificationPreference" (
    "userId"         TEXT        NOT NULL,
    "pushAttendance" BOOLEAN     NOT NULL DEFAULT true,
    "pushBilling"    BOOLEAN     NOT NULL DEFAULT true,
    "pushNotice"     BOOLEAN     NOT NULL DEFAULT true,
    "pushShuttle"    BOOLEAN     NOT NULL DEFAULT true,
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "ParentNotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- 다른 표와 같은 방식: 브라우저(anon) 직접 접근 차단. 서버(Prisma)만 읽고 쓴다.
ALTER TABLE "ParentNotificationPreference" ENABLE ROW LEVEL SECURITY;

-- 되돌리기(필요할 때만): DROP TABLE IF EXISTS "ParentNotificationPreference";
