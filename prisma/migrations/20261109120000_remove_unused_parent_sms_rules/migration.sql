-- 2026-11-09 학부모(외부) 문자 규칙 정리 — 체험·수강신청·등록 흐름 점검 결과 «보내는 코드가 없거나 원장이 없애기로 한» 규칙 3개 삭제
--
-- 지우는 것(원장 결정 d-dead-rules · d-trial-done)
--   ENROLL_APPROVED_PARENT  수강 확정(학부모)   — 이 트리거로 보내는 코드가 저장소에 없다(규칙만 켜져 화면 혼동)
--   INVOICE_PARENT          수납 안내(학부모)   — 보내는 코드 없음(월 청구서 링크는 앱 알림만 보낸다)
--   TRIAL_ATTENDED_PARENT   체험 완료 감사 안내 — 원장 «제거». 발송 코드·재시도 버튼도 같은 커밋에서 삭제
--
-- 남기는 것(체험·수강·등록 흐름 · 실제 발송 코드 있음)
--   TRIAL_CONFIRM_PARENT      체험 신청 접수 확인 — public.ts 공개 신청 + 관리자 재발송. 꺼짐 유지(남의 번호 위험)
--   TRIAL_SCHEDULED_PARENT    체험 일정 확정      — updateTrialLead. 알림톡 1차
--   TRIAL_ENROLL_GUIDE_PARENT 수강신청서 안내     — sendPostTrialEnrollGuide. 알림톡 1차
--   ENROLL_CONFIRM_PARENT     수강 신청 접수 확인 — public.ts 공개 수강 신청. 꺼짐 유지
--
-- ⚠️ 순서: **코드 배포 → 이 SQL**. 옛 코드의 ensureSmsTemplates 는 지운 틀을 다시 넣고 규칙까지 되살린다.
-- ⚠️ 적용 전 백업 SELECT(아래 «사전 확인»)를 먼저 돌려 결과를 보관한다 — 운영 문구가 기본값과 다르면 되돌림 SQL 의 body 를 그 값으로 바꾼다.
--
-- 사전 확인(읽기):
--   SELECT t.trigger, t."isActive", t.body, t.name, t.description, t.variables,
--          r."isActive" AS rule_active, r."requestedChannel", r."fallbackEnabled", r."fallbackChannel"
--     FROM "SmsTemplate" t LEFT JOIN "MessageAutomationRule" r ON r.trigger = t.trigger
--    WHERE t.trigger IN ('ENROLL_APPROVED_PARENT','INVOICE_PARENT','TRIAL_ATTENDED_PARENT');
--   SELECT COUNT(*) FROM "NotificationDelivery"
--    WHERE trigger IN ('ENROLL_APPROVED_PARENT','INVOICE_PARENT','TRIAL_ATTENDED_PARENT'); -- 발송 장부는 지우지 않는다(이력 보존)

-- 규칙 먼저(템플릿 외래키는 SET NULL 이지만 순서를 명시)
DELETE FROM "MessageAutomationRule"
 WHERE trigger IN ('ENROLL_APPROVED_PARENT', 'INVOICE_PARENT', 'TRIAL_ATTENDED_PARENT');

DELETE FROM "SmsTemplate"
 WHERE trigger IN ('ENROLL_APPROVED_PARENT', 'INVOICE_PARENT', 'TRIAL_ATTENDED_PARENT');

-- 사후 확인(0이어야 한다):
--   SELECT COUNT(*) FROM "SmsTemplate" WHERE trigger IN ('ENROLL_APPROVED_PARENT','INVOICE_PARENT','TRIAL_ATTENDED_PARENT');
--   SELECT COUNT(*) FROM "MessageAutomationRule" WHERE trigger IN ('ENROLL_APPROVED_PARENT','INVOICE_PARENT','TRIAL_ATTENDED_PARENT');

-- 되돌림 SQL(필요할 때만 수동 실행 — 코드도 함께 되돌려야 발송이 살아난다):
--   INSERT INTO "SmsTemplate" (id, trigger, name, target, body, "isActive", description, variables, "createdAt", "updatedAt") VALUES
--     (gen_random_uuid()::text, 'ENROLL_APPROVED_PARENT', '수강 확정 (학부모)', 'PARENT',
--      E'[STIZ] {{childName}} 수강이 확정되었습니다.\n배정 반: {{className}}\n상세 안내는 별도 연락드리겠습니다.', true,
--      '관리자가 수강 신청을 승인하면 학부모에게 발송', '["childName","className","academyPhone"]', NOW(), NOW()),
--     (gen_random_uuid()::text, 'INVOICE_PARENT', '수납 안내 (학부모)', 'PARENT',
--      E'[STIZ] {{month}}월 수강료 안내\n{{childName}}: {{amount}}원\n납부기한: {{dueDate}}', true,
--      '월별 청구서 생성 시 학부모에게 발송', '["childName","month","amount","dueDate"]', NOW(), NOW()),
--     (gen_random_uuid()::text, 'TRIAL_ATTENDED_PARENT', '체험 완료 감사 안내 (학부모)', 'PARENT',
--      E'[STIZ] {{childName}} 학생의 체험수업 참여 감사합니다.\n정규 수강신청을 원하시면 아래 링크에서 신청해주세요.\n{{enrollLink}}\n문의: {{academyPhone}}', false,
--      '관리자가 체험 리드를 체험완료로 변경하면 학부모에게 자동 발송', '["childName","parentName","academyPhone","enrollLink"]', NOW(), NOW())
--   ON CONFLICT (trigger) DO NOTHING;
--   INSERT INTO "MessageAutomationRule" (id, trigger, name, "audienceScope", target, "isActive", "requestedChannel",
--          "fallbackEnabled", "fallbackChannel", "templateId", description, "createdAt", "updatedAt")
--   SELECT gen_random_uuid()::text, t.trigger, t.name, 'EXTERNAL', 'PARENT', t."isActive", 'SMS', true, 'SMS', t.id, t.description, NOW(), NOW()
--     FROM "SmsTemplate" t
--    WHERE t.trigger IN ('ENROLL_APPROVED_PARENT', 'INVOICE_PARENT', 'TRIAL_ATTENDED_PARENT')
--   ON CONFLICT (trigger) DO NOTHING;
--   (사전 확인 결과의 isActive·채널·body 가 위와 다르면 그 값으로 바꿔 넣는다)
