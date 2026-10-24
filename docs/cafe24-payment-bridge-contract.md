# 본사 카페24 결제 브리지 계약

다산점 청구서는 자체 DB의 `PaymentInvoice`를 기준으로 만들고, 실제 결제창은 본사 카페24 서버가 만들어 주는 구조로 연결한다.

이 구조에서 다산점은 결제 금액과 청구서 소유권을 검증한 뒤 본사에 서명된 요청을 보낸다. 본사는 카페24 주문과 결제 URL을 만들고 다산점에는 결제 URL만 돌려준다. 납부 완료 처리는 브라우저 복귀 화면을 믿지 않고, 본사가 다시 보내는 서명 웹훅으로만 확정한다.

## 다산점 환경변수

Vercel Production과 Preview에 다음 값을 등록한다. 비밀값은 문서, Git, 로그에 남기지 않는다.

```env
PAYMENT_PROVIDER=CAFE24_BRIDGE
CAFE24_PAYMENT_BRIDGE_URL=https://custom.stiz.kr/api/payments/cafe24/checkout
STIZ_PARTNER_SECRET=64_char_hex_shared_secret
NEXT_PUBLIC_SITE_URL=https://www.stiz-dasan.kr
```

`CAFE24_PAYMENT_BRIDGE_SECRET`을 별도로 둘 수도 있지만, 유니폼 본사 연동과 같은 키를 쓰려면 `STIZ_PARTNER_SECRET` 하나로 맞춘다.

## 결제 링크 발급 요청

다산점 서버가 본사 서버로 요청한다.

```http
POST ${CAFE24_PAYMENT_BRIDGE_URL}
Content-Type: application/json
X-STIZ-Partner: dasan
X-STIZ-Purpose: cafe24-payment-checkout
X-STIZ-Timestamp: 1790000000
X-STIZ-Signature: hmac_sha256_hex
```

서명 원문은 아래 형식이다.

```text
{timestamp}.dasan.{canonical_json_body}
```

`canonical_json_body`는 객체 키를 알파벳순으로 정렬한 JSON 문자열이다. 다산점 코드는 `src/lib/cafe24-payment.ts`의 `canonicalCafe24PaymentJson()`과 `signCafe24PaymentPayload()`를 사용한다.

요청 본문 예시는 다음과 같다.

```json
{
  "partnerRequestId": "STIZ-C24-1790000000000-invoice1",
  "invoiceId": "payment-invoice-id",
  "invoiceNo": "STIZ-202609-abcdef12",
  "paymentId": "payment-id",
  "amount": 180000,
  "orderName": "2026년 9월 수강료",
  "customer": {
    "name": "학부모명",
    "phone": "masked-or-raw-server-only",
    "email": "parent@example.com"
  },
  "returnUrls": {
    "successUrl": "https://www.stiz-dasan.kr/payments/cafe24/success?invoiceId=payment-invoice-id",
    "failUrl": "https://www.stiz-dasan.kr/payments/fail?invoiceId=payment-invoice-id",
    "webhookUrl": "https://www.stiz-dasan.kr/api/payments/cafe24/webhook"
  },
  "metadata": {
    "source": "stiz-dasan",
    "studentName": "수강생명"
  }
}
```

본사 서버는 `partnerRequestId`를 멱등키로 사용한다. 같은 `partnerRequestId`와 같은 금액이 다시 오면 기존 결제 URL을 재사용하고, 금액이나 주문명이 다르면 `409`로 거절한다.

## 결제 링크 발급 응답

성공 시 본사 서버는 아래 중 하나의 URL 필드를 반드시 돌려준다. 다산점은 `checkoutUrl`, `paymentUrl`, `redirectUrl` 순서로 읽는다.

```json
{
  "ok": true,
  "checkoutUrl": "https://...",
  "cafe24OrderId": "order-id",
  "expiresAt": "2026-09-02T12:30:00+09:00"
}
```

실패 시에는 HTTP 상태와 함께 사람이 읽을 수 있는 메시지를 준다.

```json
{
  "ok": false,
  "error": "결제 링크를 만들 수 없습니다."
}
```

다산점은 본사 서버가 `5xx` 또는 `429`를 돌려주면 잠시 후 재시도 가능한 오류로 표시한다. `4xx`와 잘못된 URL 응답은 설정 또는 요청 오류로 표시한다.

## 결제 완료 웹훅

카페24 결제가 완료되면 본사 서버가 다산점으로 웹훅을 보낸다.

```http
POST https://www.stiz-dasan.kr/api/payments/cafe24/webhook
Content-Type: application/json
X-STIZ-Partner: dasan
X-STIZ-Timestamp: 1790000300
X-STIZ-Signature: hmac_sha256_hex
```

웹훅도 결제 링크 요청과 같은 서명 규칙을 사용한다. 다산점은 10분을 넘긴 timestamp 또는 서명이 틀린 요청을 거절한다.

```json
{
  "eventId": "cafe24-payment-event-id",
  "eventType": "PAYMENT_COMPLETED",
  "data": {
    "partnerRequestId": "STIZ-C24-1790000000000-invoice1",
    "status": "PAID",
    "amount": 180000,
    "cafe24OrderId": "order-id",
    "receiptUrl": "https://..."
  }
}
```

다산점은 `partnerRequestId`로 `PaymentTransaction.orderId`를 찾고, 금액이 저장 금액과 같을 때만 납부 완료로 바꾼다. 금액이 다르면 `CAFE24_AMOUNT_MISMATCH`로 기록하고 완료 처리하지 않는다.

완료로 인정하는 상태값은 `PAID`, `DONE`, `COMPLETED`, `PAYMENT_COMPLETED`, `PAYMENT_DONE`이다. 실패로 기록하는 상태값은 `FAILED`, `CANCELED`, `CANCELLED`, `REFUNDED`, `PAYMENT_FAILED`이다.

## 운영 점검 순서

1. 본사 서버에 브리지 API를 배포한다.
2. 다산점 Vercel에 `PAYMENT_PROVIDER=CAFE24_BRIDGE`, `CAFE24_PAYMENT_BRIDGE_URL`, `STIZ_PARTNER_SECRET`, `NEXT_PUBLIC_SITE_URL`을 등록한다.
3. 다산점에서 `npm run payments:preflight`로 결제 설정 형식만 확인한다.
4. 운영 배포 전 `npm run release:preflight`를 실행한다.
5. 소액 테스트 청구서 1건으로 링크 발급, 카페24 결제창 이동, 본사 웹훅, 다산점 납부완료 반영을 순서대로 확인한다.

## 본사 구현 주의사항

- 다산점 서버에서 온 요청만 허용한다. 브라우저에서 직접 호출할 수 있는 공개 API로 열지 않는다.
- 서명 검증 실패, timestamp 만료, 금액 불일치, 멱등키 충돌은 결제 링크를 만들지 않는다.
- 로그에는 비밀키, 전체 전화번호, 전체 주소를 남기지 않는다.
- 결제 성공 화면 복귀만으로 납부 완료 처리하지 않는다. 반드시 본사 서버가 다산점 웹훅을 호출한다.
- 카페24 주문 생성과 결제 URL 생성은 본사 쇼핑몰의 계약 범위와 공식 Cafe24 Developers 문서를 기준으로 구현한다.
