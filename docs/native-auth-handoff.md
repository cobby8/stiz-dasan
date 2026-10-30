# 앱 간편로그인 인계 — 로컬 개발 준비

2026-10-28 사용자 승인 범위는 로컬 코드·합성 자료 검증이다. 운영 DB·공급자 설정·서명·원격 빌드·배포·실제 사용자 인증은 변경하지 않는다.

## 작업 그룹과 소유

| 그룹 | 담당 | 의존 관계 | 완료 기준 |
|---|---|---|---|
| 서버 인계 | 서버 개발 담당: auth/native·lib/native-auth·전용 시험 | 기존 Supabase/학원 직접 계정 바인딩 | 기본 비활성·단회 소비·만료·취소·계정 교체 거부 |
| 앱 복귀 | PM iOS / Android 담당 | 아래 고정 HTTP 계약 | 앱이 시작한 flow·state·PKCE만 POST 완료 |
| 독립 검증 | tester | 서버·앱 구현 | 합성 PostgreSQL 경합/RLS·쿠키·라우트 검사 |

## 구현 흐름

1. 앱이 기기에만 남길 무작위 `codeVerifier`와 `state`를 만든다. S256(검증값의 SHA-256)을 `codeChallenge`로 보낸다. 비밀번호처럼 원본을 보내지 않고 나중에 같은 요청인지 대조하는 장치다.
2. `POST /auth/native/start` JSON은 `{provider, platform, codeChallenge, state}`만 받는다. `intent=login`은 선택적으로 허용한다. 제공자는 google/kakao/naver/apple, 플랫폼은 ios/android다. 응답은 `{flowId,browserUrl,expiresAt}`다. 수강 연결·가입·다른 계정 연결·임의 복귀 주소는 받지 않는다.
3. 시스템 브라우저에서 `browserUrl`을 연다. 서버는 해당 flow에 최초 한 번 브라우저를 묶고, 별도 HttpOnly 쿠키 이름 `stiz-native-oauth-<flowId>`로 공급자 PKCE를 시작한다. 기존 웹 로그인 쿠키와 섞지 않는다.
4. 공급자에서 `/auth/native/callback?flow=...&provider=...`로 돌아오면 브라우저 바인딩 쿠키·flow·공급자·Supabase PKCE를 검증한다. 정상적인 공급자 복귀는 교차 사이트 GET이므로 이 경로만 허용하며 POST의 교차 사이트 차단은 유지한다.
5. 실제 Auth 사용자와 학원 원장의 직접 `authUserId` 바인딩을 대조한다. 미연결·중복·탈퇴 완료/접수·미인증 학부모는 로그인 인계를 거부한다. 이름·전화·이메일·사용자가 편집할 수 있는 메타데이터로 권한을 추측하지 않는다. 기존 역할·자녀 자격은 이후 웹 가드가 계속 판단한다.
6. 서버는 세션을 AES-256-GCM으로 암호화해 단기 원장에 보관한다. 앱 복귀 주소에는 세션 대신 무작위 일회용 `code`, 앱이 만든 `state`, `flow`만 붙인다.
7. 앱이 보관한 값과 복귀 값이 맞을 때만 WebView에서 `POST /auth/native/consume`, form `{flowId,code,codeVerifier,state}`를 보낸다. 서버는 한 번의 원자적 DB 갱신으로 소비하고 암호문·codeHash를 지운다. 잘못된 증명은 정상 요청을 소비하지 않는다.
8. 서버는 실제 Auth·학원 계정을 다시 읽고 기존 WebView 로그인과 다른 계정으로 바뀌지 않는지도 확인한다. 성공하면 HttpOnly·Secure 쿠키와 `__Host-stiz-native-session=1` 보호 표식을 발급한 뒤 303으로 `/auth/continue`에 보낸다. 표식은 권한 증명이 아니며 PM의 공통 갱신 도우미가 HttpOnly 보호를 이어간다. 계정을 바꾸려면 기존 계정에서 먼저 로그아웃해야 한다.
9. 앱 취소는 `POST /auth/native/cancel` JSON `{flowId,codeVerifier,state}`로 처리한다. 취소된 flow·기한 만료·재사용·다른 flow는 거부한다.

flow는 5분, 최종 code는 60초다. 앱·브라우저·URL·JavaScript 사이에서 로그인 토큰이나 쿠키를 복사하지 않는다. 로그인 후 복귀는 기본 역할 홈만 지원한다. 청구서·수업의 상세 주소 복귀, 간편가입·로그인 수단 추가는 후속 범위이며 기존 웹 흐름으로 계속 제공한다.

## 활성화 보호와 개발 식별자

- `NATIVE_AUTH_ENABLED`와 `NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED`가 모두 정확히 `true`이고 32바이트 base64url `NATIVE_AUTH_ENCRYPTION_KEY`가 있을 때만 개발 경로를 연다. 키 값은 Git·문서·로그에 기록하지 않는다.
- `NODE_ENV=production`에서는 위 설정이 있어도 **항상 차단**한다. 현재 코드는 개발 scheme 검증용이며 운영 간편로그인 활성화 코드가 아니다.
- iOS 고정 개발 복귀: `stiz-academy-dev://auth/return`.
- Android 고정 개발 복귀: `stiz-academy-android-dev://auth/return`.
- 요청자가 callback 주소나 호스트를 정할 수 없다. HTTPS 서버 주소는 공식 호스트 하나만 허용한다. 테스트는 이 주소를 요청 객체로 만든 모의 서버에서 수행하며 실제 운영 호스트로 접속하지 않는다.
- 정식 출시는 STIZ 식별자·서명과 결합한 검증 HTTPS App Link/Universal Link, 공급자 callback 등록, 원장 권한/만료 정리·시도 제한 운영 구성을 갖춘 뒤 별도로 승인한다. 개발 scheme은 정식 앱 소유권 검증을 대신하지 않는다.

## 로컬 DB와 개인정보 보관

`src/lib/native-auth/schema.sql`은 로컬 합성 DB용 준비 SQL이다. Prisma 기존 schema와 운영 테이블은 변경하지 않았다. `NativeAuthFlow`에 RLS를 켜고 PUBLIC/anon/authenticated의 접근을 회수한다. 서버 소유 연결만 사용한다.

암호문은 flow ID를 추가 인증 정보로 결합해 다른 행과 교체할 수 없다. 정상 소비·취소 때 바로 지운다. 새 start 때 기한 만료 flow나 만료 READY code를 최대 100행 정리한다. 이는 **기한이 되면 반드시 지워지는 예약 작업이 아니다**. 새 요청이 없으면 만료된 암호문이 DB에 남을 수 있으므로 정식 활성화 전에 별도 보존 기간·정기 정리 실행기를 확정해야 한다. 운영 정리·삭제는 이 작업에서 실행하지 않는다.

## 검증과 한계

- `node --test tests/native-auth-handoff.test.mjs`: 정책·암호화·바인딩·잘못된 증명·메모리 경합·만료·취소·HTTP 본문·정상 교차 사이트 callback·초기 HttpOnly 쿠키·다른 계정 교체 거부 검사.
- 실제 공급자는 모의 객체다. 실제 Google/Apple/카카오/네이버 로그인, 본인인증, 휴대폰·브라우저 앱 전환, 세션 장기 갱신을 통과했다는 뜻이 아니다.
- 독립 tester가 소유한 합성 PostgreSQL에서 실제 저장 SQL·동시 소비/취소·RLS를 따로 검사한다. 운영 연결은 사용하지 않는다.
- 기존 브라우저 클라이언트가 HttpOnly 세션을 읽을 수 없으므로 앱에서는 서버 가드로 판단한다. 공통 계정 표시·로그아웃·만료 갱신은 PM 통합 검증과 실기기 검증 대상으로 유지한다.
- 포트원 STIZ 전용 MID/apikey는 아직 없다. 본인인증의 네이티브 전환 검증을 대신하지 않는다.

공식 근거: [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [Supabase OAuth 시작](https://supabase.com/docs/reference/javascript/auth-signinwithoauth). 2026-10-28 changelog에서 TLS CBC 폐기 공지를 확인했으며 지원 OS의 정상 TLS를 사용하고 인증서 우회를 추가하지 않았다.
