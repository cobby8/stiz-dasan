-- 문자 기록(NotificationDelivery) 상태에 UNCERTAIN 허용 (2026-11-13 출시 전 점검).
--
-- 왜: 코드(src/lib/message-ledger.ts)는 «10분 넘게 보내는 중에 멈춘 건»·«대기열 내용 복호화 실패»를
-- status='UNCERTAIN'(발송 여부 불확실)으로 바꾸는데, 기존 CHECK 제약에 UNCERTAIN 이 없었다.
-- 그런 건이 하나라도 생기면 UPDATE 가 제약 위반으로 실패해 «대기열 꺼내기» 트랜잭션 전체가 실패하고,
-- 원장이 예약한 문자 전체가 멈춘다. 허용 값을 넓히는 변경이라 기존 행에는 영향이 없다.
--
-- 되돌림:
--   ALTER TABLE public."NotificationDelivery" DROP CONSTRAINT IF EXISTS "NotificationDelivery_status_check";
--   ALTER TABLE public."NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_status_check"
--     CHECK (status IN ('PENDING','SENDING','SENT','PARTIAL','FAILED','SKIPPED')) NOT VALID;
ALTER TABLE public."NotificationDelivery" DROP CONSTRAINT IF EXISTS "NotificationDelivery_status_check";
ALTER TABLE public."NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_status_check"
  CHECK (status IN ('PENDING','SENDING','SENT','PARTIAL','FAILED','SKIPPED','UNCERTAIN')) NOT VALID;
