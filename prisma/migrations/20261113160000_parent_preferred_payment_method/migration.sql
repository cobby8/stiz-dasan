-- 학부모 «자주 쓰는 결제 방법»(2026-11-13 원장 결정 방식 ①).
--
-- 왜 필요한가: 카드 정보는 저장하지 않는다. 대신 결제 화면 맨 위에 «지난번 결제 방법» 큰 버튼을 보여 주려고
-- 학부모 계정에 마지막(또는 설정에서 고른) 결제 방법 코드만 남긴다.
--  preferredPaymentMethod          : TOSSPAY / KAKAOPAY / NAVERPAY / CARD / TRANSFER / VIRTUAL_ACCOUNT, NULL = 정하지 않음
--  preferredPaymentMethodUpdatedAt : 마지막으로 바뀐 시각(승인 완료 또는 설정 저장)
-- 값 목록은 src/lib/payments/preferredMethod.ts 의 PREFERRED_PAYMENT_METHODS 와 같아야 한다(테스트가 비교).
-- 코드는 칸이 없어도(이 마이그레이션 전) 결제가 실패하지 않게 읽기·쓰기 실패를 로그로만 남긴다.
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "preferredPaymentMethod" TEXT;
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "preferredPaymentMethodUpdatedAt" TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_preferredPaymentMethod_check') THEN
    ALTER TABLE public."User" ADD CONSTRAINT "User_preferredPaymentMethod_check"
      CHECK ("preferredPaymentMethod" IS NULL OR "preferredPaymentMethod" IN ('TOSSPAY', 'KAKAOPAY', 'NAVERPAY', 'CARD', 'TRANSFER', 'VIRTUAL_ACCOUNT'));
  END IF;
END $$;
