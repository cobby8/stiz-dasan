# 안드로이드 검증 기록 — 2026-10-19

## 2026-10-28 사진·개발용 인증 후속

- `MEDIA_AUTH_FOLLOWUP.md` 정본. JVM 파일 정책55·인증 정책42·탐색75·시작33·표본13 통과.
- debug/unsigned release/androidTest/Lint 로컬 빌드 성공, 오류0·경고8(새 debug fixture JS 경고1 포함). 개발 옵션 true에서 debug true/release false를 생성 BuildConfig로 확인했다. 기본 옵션을 복원한 최종 산출물을 보관한다.
- 설치·사진/카메라/로그인 실제 조작·운영 업로드·서명·원격 실행은 하지 않았다. 기기 UI와 WebView FileList 통합은 미검증으로 남긴다.

## 2026-10-27 G1 통합 앱 기반 검증

현재 구현 범위는 `UNIFIED_FOUNDATION.md`를 기준으로 한다. 아래 10월19일 실기기 기록과 이 새 기반의 검증을 구분한다.

- 기본 통합 debug 패키지 `kr.stiz.driver.unified`, 앱 이름 `스티즈 농구교실`, 운영 origin을 APK의 실제 manifest/BuildConfig로 확인했다. release는 기존 `kr.stiz.driver`의 **unsigned** 결과이며 최종 출시 패키지·서명이 확정된 것은 아니다.
- 정확한 일반 앱 origin/페이지와 driver-only GPS 메시지 권한을 분리했다. `/staff/run`은 미지원 안내로 차단하고 조회 화면으로 돌아간다. 로그인으로 여는 운행을 공개 토큰 URL로 우회하지 않는다.
- 통합 모드의 별도 탐색 관찰자는 최상위 프레임의 경로만 전달한다. Next.js의 pushState·replaceState·popstate에도 운행 이동 확인과 미지원 운행 경로 차단을 적용한다. 이 메시지에는 GPS 조회·시작·종료 권한이 없다.
- 실제 순수 Java 코드 실행: 통합 탐색·위치 메시지 경계 **75**, 기존 시작 동의 **33**, 기존 위치 샘플 정책 **13**, 총 **121개 조건 통과**. HTTP·좌표 수집 없이 실행했다.
- 웹 bridge/기존 GPS 상태 관련 Node 회귀 **31/31 통과**. 이는 Android 실기기 지속성 증거가 아니다.
- 통합 모드 `assembleDebug`·`assembleRelease`·`assembleDebugAndroidTest`·`lintDebug` 성공. 기존 기사 기기 시험 모드(`stizDeviceTest=true`, localhost:8443, 공개 시험 CA)도 같은 네 작업이 성공했다. **계측 APK는 컴파일만 했으며 새 기기 런타임 검사는 실행하지 않았다.**
- 최종 Android Lint: **오류0·경고7**. 기존4개에서 추가3개는 feature guard가 있는 새 WebMessage/DocumentStart 호출2곳을 도구가 인식하지 못한 RequiresFeature 경고와 새 한국어 안내문 리소스 분리1건이다. 억제 설정이나 lint baseline을 추가하지 않았다.
- 잘못된 포트 구성2건도 실제 Gradle 구성 단계에서 거부했다. deviceTest 없는 localhost:8443, deviceTest를 붙인 외부 호스트:8443이 모두 정확한 origin 검증 오류로 실패했다(일반 빌드 실패와 구분).
- 기존 debug/release TLS 격리 **14/14 통과**. 공개 시험 CA만 별도 로컬 임시 경로에 만들었고 개인키 파일은 저장하지 않았다. 출시 APK에 custom CA·debug networkSecurityConfig·시험 패키지 접미사가 섞이지 않는다.
- 첫 offline 시도는 현재 Gradle cache에 AGP가 없어 구성 단계에서 실패했다. 표준 의존성 다운로드 후 일반 빌드가 성공했고, 최종 통합/기사 기기 시험 빌드는 다시 offline으로 성공했다. SDK 라이선스를 자동 승인하지 않았다.
- 통합 산출물은 Git 제외 `.tmp/android-unified-foundation/unified/`에 별도로 보존했다. `stiz-unified-debug.apk` SHA256 `67CAA0C84070CF37B656FA480AD429E815042EB88F813EAA2CBE3F031BC64BD6`, `stiz-unified-release-unsigned.apk` SHA256 `EC7B9D5E74F2D99AE93583548BAF8891AE059F8BFBC4CC7C84A33FCBCA27C0E1`.
- 통합 `bundleRelease -PstizUnified=true`도 성공했다. unsigned AAB `stiz-unified-release-unsigned.aab` SHA256 `BE86D8E90E2F4D1707C26D58FCCDE8ADBAED5759A86862E1D1D12D6B67C64F2C`를 보존했으며 `jarsigner -verify`에서 unsigned를 확인했다. 서명·Play 업로드는 하지 않았다.
- 정본 빌드 로그: `app/build/unified-foundation-g1-final-build.log`, `app/build/unified-g1-final-driver-tls-build.log`, `app/build/unified-web-regression.log`. 독립 검증은 PM의 `.tmp/stiz-app-foundation-qa/` 결과에 별도로 남긴다.

운영 데이터·실제 로그인·기기 설치·위치 공유·스토어 서명·원격 실행·배포 없음. OAuth/본인인증 handoff·계정에 결합된 기사 운행·로그아웃/역할 회수 연계·장시간 실기기·푸시/딥링크는 출시 전 G3 이후 검증 과제이며 완료로 표시하지 않는다.

---

최신 실기기 결과는 `../../docs/driver-device-validation.md`를 기준으로 한다. 삼성 태블릿 USB 충전 조건에서 수정본 수동 재시작·잠금189초 위치+10·T맵193초+18·복귀 상태 유지·종료 후55초 추가수신0을 확인했다. 시험 서버/위치 DB/임시 비밀/USB 전달은 정리했다. 아래 초기 에뮬레이터·시험 준비 기록을 운영 출시나 장시간 배터리 검증 완료로 해석하지 않는다.

대상: `apps/driver-android` 초안, 업턴랩스 출시 준비. 운영 배포·운영 DB 변경·스토어 업로드 없음.

- JDK: Android Studio JBR 21, Java 소스/대상 17. SDK 36, Gradle 8.14, AGP 8.10.1.
- `./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug` 최종 성공.
- Android Lint: **0 errors, 4 warnings**. 필수 React 웹 화면의 JS 사용, 역조건 후 return하는 feature 지원 guard를 도구가 인식하지 못한 경고, Gradle 패치 업데이트 안내(8.14→8.14.6), 한국어 안내문 번역 리소스 미분리. 오류를 baseline으로 숨기지 않았다.
- APK와 테스트 APK를 API 35 `Pixel_Tablet` 에뮬레이터(`emulator-5580`)에 설치했다.
- 실제 Android 런타임 검사 **13/13 통과**: 정확한 운행 origin/path 허용 및 HTTP/외부/위조/하위 경로/임의 포트/파일/userinfo 거부 10건, AndroidKeyStore 암복호화·sequence/stopPending 복구·평문 부재 3건. 별도 `.instrumentation` 저장소를 쓰고 지운다. 서버 호출과 위치 수집은 하지 않았다.
- 기본 운영 origin 초안 APK SHA256: `AF4C786A3DE98DB7DE8FF2A5ABA28E12CEFE129474AF9B08CF561A18DFF11BB3` (아래 실기기용 로컬 빌드와 구분).
- 최종 서비스 소스의 `stopRequested` 가드까지 포함한 APK로 runtime 13건을 다시 통과했다. 시작 HTTP 대기 중 종료 요청이 오면 위치 구독으로 전환하지 않고 종료 확인으로 넘어간다.
- 진입 화면에서 공식 로고·운행 링크 입력·열기 버튼의 실제 표시를 확인했다. `app/build/driver-entry-final.png`, `app/build/driver-entry-final.xml`에 기록했다. 검사 후 이 작업에서 시작한 emulator-5580만 종료했다.
- 빌드 로그: `app/build/final-build.log`; runtime 검사: `app/build/android-runtime-test.log`; Lint: `app/build/reports/lint-results-debug.html`. 빌드 산출물과 로그는 Git 제외.
- 원본 로고와 복사본 SHA256이 일치한다: `831F0C43E74BAABEDD059B4F360FC1A9C77CA1FD24782655A8670616E9FCF6EB`.

검사 경계: 이 결과는 실제 기사님의 잠금 화면·T맵·제조사 절전·30분 연속 GPS 전송 증거가 아니다. 연결된 실제 휴대폰은 없었다. 운영 신규 API는 미배포이며 기본 비활성화된다. 사용자가 차량 1대 운행으로 확정했으므로 token당 한 기기 구조는 현재 범위에 맞고, 다차량 분리는 향후 증차 과제다. README의 실기기 시나리오를 승인된 검증 서버에서 수행한 뒤 출시를 판단한다.

## 삼성 탭 S7+ 실기기 검증용 HTTPS 빌드 준비

- 사용자가 Android 13 삼성 탭 S7+ `SM-T975N`으로 검증하기로 정했다. 기기 조작은 PM 한 명이 담당하며 앱 빌드 작업자는 adb·설치·에뮬레이터 조작을 하지 않았다.
- `stizOrigin=https://localhost:8443`, `stizDeviceTest=true`, `stizLocalTlsDir=.../.tmp/driver-device-test/tls`로 debug APK와 기존 13건 계측 APK를 재빌드했다. PM은 초기 443 빌드의 실제 기기 계측 13건 통과를 확인했으며, 포트 수정 빌드의 기기 재검증·위치 동작 결과는 PM 기록으로 별도 확인한다. 단말의 비특권 443 listener가 거부되어 localhost 8443만 테스트 예외로 추가했고 일반 origin의 443 제한은 유지한다.
- 패키지: `kr.stiz.driver.devicetest` / 계측 패키지 `kr.stiz.driver.devicetest.test`, runner `kr.stiz.driver.DriverSmokeInstrumentation`.
- 공개 `ca.crt`만 파싱하고 X.509 CA 여부·유효기간을 검사하여 DER 공개 인증서를 debug 전용 generated raw resource로 넣었다. TLS 개인키 파일은 읽거나 APK에 복사하지 않았다.
- custom CA는 localhost domain-config에만 한정했다. 다른 origin은 시스템 CA만 사용하며 cleartext/SSL 우회/OS CA 설치를 허용하지 않는다.
- local TLS 옵션을 그대로 넣은 `assembleRelease` 성공. release APK·manifest·BuildConfig와 debug trust 범위 자동 검사 **14/14 통과**: release CA/설정/접미사 미포함, 운영 origin 고정, debug 패키지 격리, 정확한 localhost 테스트 포트, localhost 외 custom CA·HTTP 허용 없음. 추가로 외부 도메인 8443·deviceTest 미지정 localhost 8443 빌드 거부 2건을 통과했다.
- debug + androidTest + Lint 빌드 성공, **오류 0·경고 4**. 초기 빌드와 같은 경고 범위다.
- 기기용 APK SHA256: `DBF1F10DEA427377A2D59F2C88E9BFEE0D63CB543D90A22384E6786CA131BE0E` (아래 권한 복귀·snapshot 경쟁 상태·위치 대기 구분 수정 포함).
- 계측 APK SHA256: `06C8C5F36F7F9422A464DF429C22B8F5A82C8AE01D0EE1C9C67083241BB7B38E`.
- 근거: `app/build/local-tls-debug-build.log`, `app/build/release-local-tls-isolation-build.log`, `app/build/local-tls-isolation-check.log`. 재검사: `./verify-local-tls-build.ps1 -AndroidSdk <SDK경로>`.
- 운영 배포·실제 청구/알림·스토어 업로드·release 서명은 수행하지 않았다.

## 권한 창 복귀 시 시작 요청 유실 수정

- Android 13 권한 결과가 onResume보다 먼저 전달될 수 있는데 기존 visible 검사에서 다음 단계를 버리고 있었다. 실제 OS 원본 `ActivityThread.handleSendResult`의 pause → deliverResults → resume 순서와 현재 코드 경로를 확인했다.
- `PendingRunStart` 순수 Java 정책으로 명시적 동의, 같은 token, 2분 유효기간, 권한 창 대기, 화면 재개, 한 번만 시작을 구분했다. 동의 버튼을 누르기 전에는 대기를 만들지 않으며 거절/취소/종료/다른 링크/화면 파기에서는 취소한다. 보이는 화면 조건을 삭제하지 않았다.
- foreground service 승격 실패는 intent token을 포함한 error/running=false로 전달한다. 권한 거절·서비스 실패 메시지를 Activity가 같은 token에서 보존하여 빈 snapshot이 덮어쓰지 않도록 했다.
- worker가 예전 vault snapshot을 읽는 동안 새 서비스가 시작되었다면 UI 반영 시 실제 서비스 snapshot을 다시 요청하고 예전 값을 버린다. 서비스의 requesting/error를 오래된 off/idle이 덮지 않는다.
- 실제 정책 함수 javac/java 실행 **33개 조건 통과**, 독립 reviewer 추가 정책 **9개 시나리오 통과**. resume 전 결과·중복 resume·동의 없음·거절·취소·다른 token·만료·늦은 콜백을 검사했다. 근거: `app/build/pending-start-test.log`, `tests/PendingRunStartTest.java`.
- 수정 소스로 debug/test/release 빌드 성공, Lint 오류 0·경고 4 유지, debug/release TLS 격리 14건 및 잘못된 포트 빌드 거부 2건 재통과.
- 기존 Android 계측 13건 APK는 재빌드했으며 계측 APK 해시는 그대로다. 수정 앱의 실제 권한 복귀 동작과 서버 요청 수신은 PM의 단일 실기기 검증으로 확인한다. 앱 작업자는 기기·서버·CA를 조작하지 않았다.

## 정상 위치 대기와 위치 지연·전송 실패 구분

- `LocationSamplePolicy`는 Android에 의존하지 않는 실제 서비스 판단 함수다. 최초 위치를 25초까지 기다릴 때는 오류를 만들지 않고, 그 뒤에도 없거나 표본이 25초보다 오래되면 `requesting/idle`과 위치 갱신 지연 안내를 전달한다. 미래 monotonic 표본도 보내지 않는다.
- 신선한 동일·역순 표본은 상태를 바꾸지 않고 보내지 않는다. 대기·지연으로 이전 전송 실패를 덮지 않는다. 송신 10초 간격, 표본 신선도 25초, 순서 증가, 과거 표본 재생 금지와 실제 응답 후 접수 시각 갱신은 유지한다.
- 자체 Java 위치 정책 **13개 경계**, 기존 권한 복귀 **33개 조건**, 독립 QA 위치 정책 **14개 경계** 통과. 독립 QA는 서비스의 duplicate no-op·전송 오류 보존·응답 이후 접수 시각 갱신도 읽기 검토했다.
- debug/test/release 빌드·Lint 재통과(오류 0·기존 경고 4), TLS debug/release 격리 **14개 통과**, `git diff --check` 통과. 최종 APK 해시는 위와 같다. 이 수정의 실제 기기 설치·화면·배경 지속성은 PM 검증 결과로 별도 기록한다.
