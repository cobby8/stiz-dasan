# 통합 앱 격리 시험 환경

2026-10-28 사용자 승인: 실제 운영 자료·발송·결제를 차단한 환경을 Android·iPhone 앱에서 검사할 수 있도록 준비한다. 운영 배포·TestFlight·Apple 서명·실기기 설치는 실행하지 않는다.

## 구조와 검증 범위

- 실제 React 클라이언트 화면을 별도 번들로 컴파일하고 새로 작성한 합성 학생·반·수업·청구 자료를 전달한다. 운영 Next 서버·DB·Supabase·로그인 공급자를 실행하거나 중계하지 않는다.
- `/store-app`에서 관리자·선생님·학부모·기사님을 선택한다. 실제 로그인·권한·자녀 연결·서버 저장을 통과한 환경이 아니다. 합성 화면임을 항상 상단에 표시한다.
- 실제 관리자 홈·메뉴, 선생님 홈·수업 명단, 학부모 홈·수강 변경, 기사님 명단을 사용한다. 구현하지 않은 메뉴는 막고 운영 사이트로 보내지 않는다. 일부 동적 시트·운영 버튼은 시험 대체 처리하므로 모든 메뉴 검증 완료가 아니다.
- 서버 액션은 시험 대체 모듈로 바꾸고, 번들에 원본 서버 액션·Prisma·Supabase·알림 모듈이 들어오면 컴파일을 중단한다. 원본 서비스 코드는 변경하지 않는다.
- 기사님 GPS는 합성 hook으로 대체하여 기기 위치를 수집하지 않는다. 음성·푸시·본인인증·실제 청구·발송·결제는 차단한다. 원래 기능이 성공한 것처럼 처리하지 않는다.
- URL·Host·Origin·메서드·본문 크기를 제한한다. 명시한 페이지·합성 조회·첨부 수신 이외에는 403을 반환한다. 외부 HTTP 요청·리디렉션·프록시 기능은 없다.
- CSP와 브라우저 가드로 외부 전송·새 창·링크·폼·Service Worker 등록을 차단한다. Android·iOS 시험 앱의 같은 origin 제한을 함께 사용한다.

## 준비 명령

```powershell
# 기존 서버·인증서·환경 파일은 재사용하지 않는다.
node scripts/native-device-sandbox.mjs prepare

# iPhone을 같은 사설망에서 연결할 때만 노트북의 현재 사설 IPv4를 명시한다.
node scripts/native-device-sandbox.mjs prepare --lan-host <노트북의-사설-IPv4>

# prepare 결과의 run-... ID를 사용한다.
node scripts/native-device-sandbox.mjs serve <run-ID>
```

기본 주소는 `https://localhost:8453/store-app`이다. LAN을 명시하면 loopback과 그 사설 IPv4에만 각각 바인딩한다. `0.0.0.0`이나 공인 호스트를 받지 않는다. 사용 중인 포트를 강제로 종료하지 않는다. `Ctrl+C`로 이 실행의 서버와 잠금만 정리한다. 프로세스 비정상 종료로 잠금이 남으면 실제 포트/PID를 확인한 담당자가 소유 상태부터 확인한다.

명령은 `.tmp/native-device-sandbox/run-.../`에만 새 준비물을 쓴다. 원본 코드의 이름·해시와 새 산출물 해시를 기록하고 실행 때 다시 대조한다. 준비 후 코드·합성 자료·스타일·산출물이 바뀌면 새 `prepare`를 요구한다. 이전 실행의 키를 재사용하지 않는다.

현재 로컬에는 과거 시각 검사에 보관한 공개 Material Symbols 폰트 `.tmp/staff-header/material-full.woff2`가 있어 사용한다. 이름과 실제 형식이 달라질 수 있으므로 머리글을 읽어 TTF/WOFF2를 구분하고 새 출력 파일·MIME·CSS 형식을 맞춘다. 폰트가 없는 새 PC에서는 준비를 중단하며 외부 다운로드를 자동으로 하지 않는다. 기존 캐시 파일은 변경하지 않는다.

## TLS와 앱 연결

- 매번 별도의 단기 CA와 서버 인증서를 새로 만든다. 공개 CA는 `run-.../ca.crt`다. CA는 `CA:TRUE`, 서버 인증서는 `CA:FALSE`, SAN은 `localhost`·`127.0.0.1`·명시한 사설 IPv4뿐이다.
- CA 비밀키·CSR·일련번호 파일은 발급 후 삭제한다. 서버 비밀키는 해당 로컬 실행 폴더 안에만 두며 Git·문서·대화·앱 리소스에 복사하지 않는다. 앱에 전달하는 것은 공개 CA뿐이다.
- 실행 전 CA 유효기간·서버 서명 체인·SAN·공개 CA 지문을 확인한다. 만료되면 새로 준비한다. OS·브라우저·기기에 인증서를 자동 신뢰 설치하거나 인증서 오류를 무시하지 않는다.
- Android는 별도 시험 APK에서 이 공개 CA만 신뢰하고 `https://localhost:8453` 또는 명시한 사설 주소를 사용한다. USB 포트 연결·앱 빌드·설치는 각각 담당 범위와 승인에 따른다.
- iPhone은 개발용 앱의 같은 origin 설정과 신뢰되는 TLS 연결이 필요하다. 이 서버를 만들었다고 iPhone 서명·설치·인증서 신뢰가 완료된 것은 아니다. Safari 시험과 WKWebView 앱 시험도 구분한다.
- 자세한 앱 설정·명령은 각 앱의 `SANDBOX.md`를 정본으로 사용한다. Apple 서명·TestFlight 업로드·스토어 제출은 이번 작업에 포함되지 않는다.

## 허용된 경로

| 경로 | 동작 |
|---|---|
| `/store-app`, `/__entry/admin`, `/__entry/teacher`, `/__entry/parent`, `/__entry/driver` | 합성 역할 선택·실제 화면 렌더링 |
| `/admin`, `/staff`, `/staff/sessions/sandbox-session`, `/mypage`, `/mypage/enrollment-change`, `/driver/sandbox-only` | 준비한 실제 클라이언트 화면 |
| `/__sandbox/media` | 사진·촬영·복수 선택·문서 파일 선택 시험 |
| `/__sandbox/health`, `/__sandbox/counters` | 합성 여부·개인정보 없는 수신 건수/바이트 |
| `/api/admin/dashboard`, `/api/admin/dashboard/system`, `/api/account/child-links`, `/api/staff/sessions/sandbox-session/photos` GET | 고정 합성 조회. 가족 연결 비활성·사진 목록 비어 있음 |
| `/__sandbox/upload`, `/api/staff/sessions/sandbox-session/photos` POST | 같은 Origin에서 허용 형식의 한 파일만 메모리 수신·내용 폐기 |

본문 최대 8 MiB, 파일 최대 5 MiB다. 이름·파일 내용·위치·세션·쿠키는 저장하지 않으며, 반환값은 합성 표시·크기·형식·해시·`stored:false`다. 수업 사진 POST의 이미지 URL은 시험용 공식 로고를 가리키고 실제 사진 저장을 뜻하지 않는다. 조회 목록도 계속 비어 있다.

HEIC/HEIF는 `/__sandbox/upload`에서 `ftyp`·브랜드·크기를 확인해 raw 파일 수신만 시험한다. 디코딩·사진 변환·실제 운영 업로드 검증이 아니다. 실제 수업 사진 시험 endpoint는 기존 JPEG/PNG/WebP 형식으로 제한한다. 원본 사진을 장기 보관하지 않으며 개인 사진 대신 합성 이미지를 사용한다.

## 자동 검증과 남은 일

`node --test tests/native-device-sandbox.test.mjs`에서 Host·경로 우회, 역할 렌더링 응답, 운영/발송/결제 경로 거부, 합성 조회, 파일 수신·무저장, Origin·MIME·본문 제한, HEIC raw와 수업사진 구분, 로컬 폰트 MIME, CSP·권한·서버 모듈 경계를 검사한다.

실제 HTTPS 서버·CA 연결·각 화면의 브라우저 렌더링·앱 빌드는 PM과 독립 tester의 최종 결과를 별도로 기록한다. 이번 서버의 200 응답은 운영 인증·권한·결제·발송·GPS의 성공 증거가 아니다. 실제 공급자·DB 경합·권한 회수·장기 운행·결제 복귀는 다음 승인 그룹이다.

## 2026-10-28 통합 실행·독립 검증 결과

| 그룹 | 담당 | 결과·완료 범위 |
|---|---|---|
| 서버·합성 화면 | 서버 담당 / PM 실행 | 실제 클라이언트 기반 49개 원본·정책·자료·스타일 파일 해시, 합성 메모리 수신, 새 CA→서버 인증서, 정확한 로컬/LAN 리스너 |
| Android 연결 | Android 담당 / 독립 tester | 별도 `kr.stiz.driver.sandbox`, 오프라인 debug/release/test/lint 빌드, 새 공개 CA만 신뢰, 실제 인증·GPS·외부 연결 차단 |
| iOS 연결 | iOS 담당 / PM 보완 / 독립 tester | DEBUG 명시 origin·임시 저장소·외부 리소스 차단 코드, Python 프로젝트 참조 28개. 신규 Swift 컴파일·WebKit 실행·아이폰 설치 미검증 |
| 통합 시험 | PM / 독립 tester | 아래 실제 HTTPS·합성 브라우저·APK 검사. 운영·기기 설치·원격 빌드·TestFlight 미실행 |

- `node --test tests/native-device-sandbox.test.mjs`: **12/12** 통과. 전체 `npm test`: **2,581/2,581**, 학생 보호 **5/5** 통과.
- 실제 HTTPS·브라우저 시험 **55조건**, 독립 loopback HTTPS **47조건**, 독립 VM 브라우저 가드·메모리 수신 **18조건** 통과. 새 공개 CA를 제공한 연결은 성공하고, 시스템 기본 신뢰만 사용하거나 잘못된 서버 이름으로 연결하면 TLS에서 거부됐다. 위조 Host·외부 Origin·결제·발송·위치 전송·인증·환경 파일 경로는 403이었다.
- 네 역할 **360px**, 기사 **320px**에서 실제 원본 클라이언트가 합성 자료로 표시됐다. 각 화면 `scrollWidth`가 표시 폭과 같고 JavaScript 오류0, 외부 요청 시도0을 확인했다. 첨부 선택→합성 수신 결과가 화면에 표시됐다.
- 브라우저는 새 임시 프로필에서 실행했다. 요청은 Playwright의 시험 전송 연결을 거쳐 **CA·SAN을 검증하는 Node HTTPS 클라이언트**로 실제 서버에 전달했다. 인증서 오류 무시·OS 신뢰 설치를 사용하지 않았다. 이 방식은 화면·서버 검증이며 Android WebView/iPhone WKWebView의 실제 TLS 신뢰·파일 선택 성공 증거가 아니다.
- Android Java 정책 **321조건**, 위험 빌드 설정 거부 **7조건**, 최종 APK 분리 검사 **24조건** 통과. 독립 검증에서 새 공개 CA와 APK 내 CA가 일치했다. lint 오류0·경고9이며 이전8개와 새 서비스워커 통신 가드 경고1개를 구분한다. debug는 기존 개발용 키로 자동 서명되고 정식 출시 서명·새 키 등록은 하지 않았다. [Android 정본](../apps/driver-android/SANDBOX.md), [iOS 정본](../apps/stiz-ios/SANDBOX.md).
- 독립 검토가 발견한 iOS 기본 인자 함수의 `Optional.map` 참조 문제는 명시 closure로 고치고 정적 회귀를 추가했다. 새 Swift 실행·컴파일을 통과했다고 표시하지 않는다.
- 최종 독립 검토에서 문서 상대 링크 17/17, 변경 32개 파일의 승인 범위와 키·인증서·산출물 staging 제외를 확인했다. `src/`·패키지·Vercel·Codemagic·AGENTS 설정 변경은 없다.
- 준비 명령에서 잘못된 확장자의 실제 TTF 폰트와 webpack 의존 목록의 디렉터리를 발견해 형식 판별·일반 파일 검사를 보완했다. 기존 폰트 캐시는 변경하지 않았다. 앞선 실패 실행 폴더는 키 발급 전 중단됐고 삭제하지 않았다.

현재 로컬 실행 ID는 `run-25e9c4bd1ddb0821`, 원본 해시는 `219761c0ab1e033d13daece61d0f877c02c8a4ffcc2312af3c287aee8d5f8384`다. 실행 원장·공개 CA·합성 스크린샷·결과는 Git 제외 `.tmp/native-device-sandbox/`에 보관한다. 실제 접속 주소와 바인딩은 해당 실행의 `ready.json`을 사용하며 네트워크가 바뀌면 새로 준비한다. OS 방화벽·인증서 신뢰·기기 USB 설정은 변경하지 않았다.

현재 PC의 명시 사설 주소에서도 새 CA로 검증한 HTTPS 요청이 200·`synthetic-only`로 응답했다. 이는 PC 내부의 LAN 주소 접속 검사이며 다른 휴대폰에서의 네트워크 접근·방화벽 통과 증거는 아니다.

시험 인증서는 약 2일 후 만료된다. 새로 준비하면 새 CA가 발급되므로 Android 시험 APK도 그 공개 CA로 다시 빌드해야 한다. 이전 APK와 새 서버의 신뢰가 맞는다고 추정하지 않는다. iPhone은 명시한 LAN 주소의 SAN·승인된 인증서 신뢰·서명 기기용 앱을 준비한 뒤 검사한다. 브라우저 인증서 경고를 무시해 시험하지 않는다.

후속 사용자 승인으로 신규 iOS 코드 `9dea3b21`의 무서명 원격 빌드 #3을 정확히1회 실행해 Swift·Xcode 컴파일을 확인했다. [빌드 정본](stiz-ios-codemagic.md)과 [아이폰 설치 준비](stiz-ios-device-install-preparation.md)를 따른다. 이전 본문의 iOS 컴파일 미검증은 환경 구성 당시 기록이며, 실제 WebKit·기기·OS 신뢰는 여전히 미검증이다. 설치·기기 등록·서명·추가 원격 빌드·발송·운영 활성화·TestFlight를 자동 실행하지 않는다.
