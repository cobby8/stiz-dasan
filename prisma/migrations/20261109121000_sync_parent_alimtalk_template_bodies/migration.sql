-- 2026-11-09 학부모 알림톡 1차 — 운영 SmsTemplate 문구를 코드 금고(src/lib/messaging/parent-alimtalk-templates.ts)와 맞춘다
--
-- 왜: 알림톡 9종은 이제 **코드 틀이 정본**이다(실제 발송 본문 = 금고 틀). DB body 는 «금고 틀을 못 채웠을 때의 대체 문구»
--     + 관리자 화면 표시용으로만 남는다. 둘이 다르면 화면과 실제 발송 문구가 달라 보이므로 맞춘다.
--     그리고 머리말을 [스티즈농구교실] 로 통일한다(원장 결정 d-prefix — 학부모 대상 문자 전부).
-- 이 SQL 을 안 돌려도 발송은 금고 틀로 정상이다(급하지 않음). 대체 문구·화면 표시만 옛 글자로 남는다.
-- ⚠️ 순서: 코드 배포 뒤(옛 코드는 DB 문구로 보내므로 먼저 돌리면 머리말만 바뀐 문자가 나간다 — 해는 없음).
--
-- 사전 확인(읽기 — 결과를 보관해 두면 되돌림에 쓴다):
--   SELECT trigger, "isActive", body, "updatedAt" FROM "SmsTemplate" WHERE target = 'PARENT' ORDER BY trigger;

-- ① 알림톡 금고 9종 — 금고 문구({{변수}} 표기)로 덮어쓴다
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 체험수업 일정이 확정되었습니다.\n일시: {{scheduledDate}}\n반: {{className}}\n문의: {{academyPhone}}', "updatedAt" = NOW() WHERE trigger = 'TRIAL_SCHEDULED_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 수강신청서\n아래 링크에서 작성해주세요 :)\n{{enrollLink}}\n\n■ 수업 준비물: 실내용 운동화, 물 담은 텀블러\n\n■ 안경 착용 안내\n안경은 부상 위험이 있어 스포츠고글 착용을 권장합니다.\n\n문의: {{academyPhone}}', description = '체험완료 후 관리자가 등록전환하면 학부모에게 자동 발송 (준비물·안경 안내 포함)', "updatedAt" = NOW() WHERE trigger = 'TRIAL_ENROLL_GUIDE_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{학생명}} 셔틀 {{운행방향}} 안내\n{{운행일}} {{예정시간}} / {{정류장}}', "updatedAt" = NOW() WHERE trigger = 'SHUTTLE_ROUTE_CONFIRMED_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{학생명}} 학생이 오늘 {{운행방향}} 셔틀에 미탑승 처리되었습니다. 확인 부탁드립니다.', "updatedAt" = NOW() WHERE trigger = 'SHUTTLE_NO_SHOW_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 학생의 {{offeringTitle}} 특강 결제를 확인해 주세요.\n금액: {{amount}}원\n납부기한: {{dueDate}}\n{{paymentUrl}}', "updatedAt" = NOW() WHERE trigger = 'SPECIAL_PAYMENT_REQUEST_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 학생의 {{offeringTitle}} 특강 신청이 취소되었습니다.\n문의: {{academyPhone}}', "updatedAt" = NOW() WHERE trigger = 'SPECIAL_APPLICATION_CANCELLED_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 학생의 {{seasonTitle}} 특강 신청이 접수되었습니다.\n신청: {{offeringTitle}}\n문의: {{academyPhone}}', "updatedAt" = NOW() WHERE trigger = 'SPECIAL_APPLICATION_RECEIVED_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 학생의 {{offeringTitle}} 특강 신청이 승인되었습니다.\n결제 및 계정 안내를 확인해 주세요.\n문의: {{academyPhone}}', "updatedAt" = NOW() WHERE trigger = 'SPECIAL_APPLICATION_APPROVED_PARENT';
UPDATE "SmsTemplate" SET body = E'[스티즈농구교실] {{childName}} 학생의 {{offeringTitle}} 특강은 대기 접수되었습니다.\n대기순번: {{waitlistOrder}}\n자리 발생 시 안내드리겠습니다.', "updatedAt" = NOW() WHERE trigger = 'SPECIAL_APPLICATION_WAITLISTED_PARENT';

-- ② 아직 문자 전용인 학부모 문구 — 머리말만 바꾼다(관리자가 고친 본문은 그대로, «[STIZ] » 로 시작할 때만)
UPDATE "SmsTemplate"
   SET body = regexp_replace(body, '^\[STIZ\] ', '[스티즈농구교실] '), "updatedAt" = NOW()
 WHERE target = 'PARENT'
   AND trigger IN ('TRIAL_CONFIRM_PARENT', 'ENROLL_CONFIRM_PARENT', 'UNPAID_PARENT',
                   'SPECIAL_APPLICATION_REJECTED_PARENT', 'SPECIAL_ACCOUNT_ACTIVATION_PARENT')
   AND body LIKE '[STIZ] %';

-- 사후 확인: 학부모 문구 중 옛 머리말이 남은 것(0이어야 한다)
--   SELECT trigger, body FROM "SmsTemplate" WHERE target = 'PARENT' AND body LIKE '[STIZ%';

-- 되돌림 SQL(필요할 때만):
--   ② UPDATE "SmsTemplate" SET body = regexp_replace(body, '^\[스티즈농구교실\] ', '[STIZ] '), "updatedAt" = NOW()
--       WHERE target = 'PARENT' AND trigger IN ('TRIAL_CONFIRM_PARENT','ENROLL_CONFIRM_PARENT','UNPAID_PARENT',
--             'SPECIAL_APPLICATION_REJECTED_PARENT','SPECIAL_ACCOUNT_ACTIVATION_PARENT');
--   ① 사전 확인 결과의 body 를 trigger 별로 다시 UPDATE 한다. (사전 확인을 안 했다면 옛 기본값:
--       TRIAL_SCHEDULED_PARENT 등 9종의 옛 문구는 git 의 src/lib/smsTemplate.ts(이 커밋 직전)에 있다.)
--   ※ 되돌려도 실제 발송 문구는 코드 금고가 정한다 — DB 를 되돌리는 것만으로 발송 문구가 바뀌지 않는다.
