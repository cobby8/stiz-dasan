# 교사 앱 운영 가이드

## 배포 전 환경변수 게이트

`npm run release:preflight`는 현재 프로세스에 주입된 환경변수의 **존재 여부만** 확인합니다. 비밀값 자체는 출력하지 않습니다.

- Production 확인: `RELEASE_ENV_SCOPE=production` 또는 Vercel의 `VERCEL_ENV=production` 환경에서 실행
- Preview 확인: `RELEASE_ENV_SCOPE=preview` 또는 Vercel의 `VERCEL_ENV=preview` 환경에서 실행
- 로컬 코드 검사만 필요하면 `npm run release:code-check`를 사용합니다. 이 명령은 배포 환경 확인을 대신하지 않습니다.

필수 변수:

- DB/Supabase: `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- 앱/cron: `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`
- 푸시: `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
- 음성 메모: `GEMINI_API_KEY`
- 교사 초대/문자 발송: `INVITE_OTP_SECRET`, `SMS_PROVIDER`, 그리고 선택한 문자 공급자 환경변수
- 결제: `NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY` 또는 `TOSS_PAYMENTS_CLIENT_KEY`, `TOSS_PAYMENTS_SECRET_KEY`

Vercel에서는 같은 이름의 값이라도 Production과 Preview 범위가 별도입니다. 두 범위를 각각 확인하고, Production의 `NEXT_PUBLIC_SITE_URL`은 실제 서비스의 HTTPS 주소여야 합니다.

## 백업과 복구 게이트

`/api/cron/backup`은 전체 DB 백업이 아닙니다. 학원 설정, 프로그램, 코치, 시간표 예외, 차량 경로 등 일부 운영 설정만 JSON으로 보관합니다. 학생, 수강, 출결, 수업, 결제, 동의, 감사 로그와 작업 큐를 복구하는 용도로 사용할 수 없습니다.

운영 SQL 적용 전 다음 중 하나를 준비해야 합니다.

1. Supabase의 전체 데이터베이스 백업/PITR을 활성화하고 복원 가능한 시점을 확인합니다.
2. 또는 `pg_dump`로 전체 DB를 백업하고 별도 테스트 DB에 복원하는 리허설을 완료합니다.

백업 파일이 존재하는지만 확인하면 부족합니다. 복원 후 핵심 테이블 수, 최근 결제·출결·수업 데이터, FK와 인덱스를 확인한 기록이 있어야 합니다. 전체 백업과 복구 확인 없이 운영 SQL을 적용하지 않습니다.

## 운영 적용 순서

1. 전체 DB 백업과 복구 리허설 증거를 확인합니다.
2. `npm run release:preflight`를 Production 환경에서 통과시킵니다.
3. 각 `preflight_*.sql`을 실행합니다.
4. G1 → Push Outbox → Media Revocation → Session Photo Deletion → G5 Class Attribution → Staff Payment Confirmation 순서로 적용합니다.
5. 각 단계 직후 대응하는 `verify_*.sql`을 실행하고, 실패하면 다음 단계와 앱 배포를 중단합니다.
6. 배포 후 cron을 인증된 요청으로 한 번씩 호출하여 처리 건수와 오류 로그를 확인합니다.

## 보존과 롤백 원칙

- 원본 음성은 서버에 저장하지 않고 텍스트 변환 요청 중에만 사용합니다.
- 수업 사진은 비공개가 기본이며 교사 삭제, 관리자 게시, 동의 철회 정책을 따릅니다.
- 결제 거래·감사 로그, 출결·수업 일지, 사진 회수 완료 및 수동 확인 증거는 자동 삭제 대상이 아닙니다.
- 내부 게시와 결제 결과를 과거 상태로 강제로 되돌리지 않습니다. 감사 로그와 대기열을 이용해 복구합니다.
- 운영 SQL, 외부 발송, 배포는 각각 별도 승인 후 수행합니다.
