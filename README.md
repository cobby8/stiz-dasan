This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Shuttle map configuration

방학특강 신청서에서 카카오 지도 위치 선택을 사용하려면 배포 환경에 다음 공개 JavaScript 키를 등록합니다.

```env
NEXT_PUBLIC_KAKAO_MAP_JS_KEY=your_kakao_javascript_key
```

카카오 개발자 콘솔의 JavaScript SDK 허용 도메인에 운영 도메인과 로컬 개발 주소를 등록해야 합니다. 키가 없거나 지도 SDK가 일시적으로 실패하면 신청서는 기존 텍스트 위치 입력 방식으로 자동 전환됩니다.

## Online payment configuration

기본값은 토스페이먼츠 직접 결제입니다. 운영 환경에 다음 값을 등록합니다.

```env
PAYMENT_PROVIDER=TOSS
NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY=your_toss_client_key
TOSS_PAYMENTS_SECRET_KEY=your_toss_secret_key
NEXT_PUBLIC_SITE_URL=https://www.stiz-dasan.kr
```

토스 관리자에는 웹훅 주소를 `https://www.stiz-dasan.kr/api/payments/toss/webhook`으로 등록합니다. 실제 결제 요청 없이 설정만 확인할 때는 다음 명령을 사용합니다.

본사 카페24 결제로 넘길 때는 본사 서버가 카페24 주문/결제 링크를 만들어주는 브리지 API를 준비한 뒤 아래 값으로 전환합니다.

```env
PAYMENT_PROVIDER=CAFE24_BRIDGE
CAFE24_PAYMENT_BRIDGE_URL=https://custom.stiz.kr/api/payments/cafe24/checkout
STIZ_PARTNER_SECRET=64_char_hex_shared_secret
NEXT_PUBLIC_SITE_URL=https://www.stiz-dasan.kr
```

본사 브리지는 다산점에서 받은 서명 요청을 검증한 뒤 `checkoutUrl`을 돌려줘야 합니다. 본사가 결제 완료를 다산점에 알려줄 주소는 `https://www.stiz-dasan.kr/api/payments/cafe24/webhook`입니다. 요청/응답/웹훅 계약은 [본사 카페24 결제 브리지 계약](docs/cafe24-payment-bridge-contract.md)에 정리되어 있습니다.

```bash
npm run payments:preflight
```

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
