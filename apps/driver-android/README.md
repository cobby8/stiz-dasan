# STIZ 통합 안드로이드 기반 — 출시 전 검증본

2026-10-27 통합 앱 기반 G1: 기본 시작은 `/store-app`, 개발 debug 패키지는 `kr.stiz.driver.unified`다. 기존 기기 시험(`stizDeviceTest=true`)은 기사 전용 흐름을 유지한다. **[현재 통합 범위와 미완료 인증](UNIFIED_FOUNDATION.md)을 먼저 읽는다.**

출시 주체는 **업턴랩스**이며 통합 앱 이름은 `스티즈 농구교실`로 준비한다. 아래 기사 전용 운행·기기 시험 기록은 별도 모드의 기존 검증 범위다. Play Console 법인/개발자 정보는 업턴랩스 기준으로 확인한다.

기존 공식 운행 화면을 재사용하고, 위치 수집·전송만 Android 위치 foreground service가 담당한다. 화면 잠금이나 T맵 전환 시 WebView가 일시 정지되어도 서비스는 별도로 실행된다. OS 강제 종료, 사용자의 앱 중지, 위치 권한 철회, 제조사 배터리 제한, 통신 장애까지 무조건 유지된다고 보장하지 않는다.

## 빌드

- Android Studio JDK 17 이상 / Android SDK 36 / Gradle 8.14 / AGP 8.10.1.
- 최소 Android 8(API 26), target/compile 36. Java 17. 별도의 Google Play Services 의존성 없음.
- `JAVA_HOME`과 `ANDROID_HOME`을 해당 PC에 맞게 설정하고 이 폴더에서 `./gradlew.bat :app:assembleDebug :app:lintDebug` 실행.
- 오프라인 Android 실행환경 검사: `./gradlew.bat :app:assembleDebugAndroidTest` 후 테스트 APK까지 설치하고 `adb shell am instrument -w kr.stiz.driver.unified.test/kr.stiz.driver.DriverSmokeInstrumentation`. 기존 URL·KeyStore 검사와 통합 페이지/위치 메시지 경계를 검사하며 서버 호출·위치 수집을 하지 않는다. 기기 실행은 별도 승인 후 진행한다. 이번 G1에서는 계측 APK를 컴파일했으며 기기에서 실행하지 않았다.
- 디버그 APK: `app/build/outputs/apk/debug/app-debug.apk`. 개발 서명이며 고객 배포·Play 출시용이 아니다.
- 승인된 HTTPS 미리보기 서버 검증 시 `./gradlew.bat :app:assembleDebug -PstizOrigin=https://승인된-호스트`로 해당 **정확한 origin 하나**를 빌드에 고정한다. WebView와 API 모두 동일한 상수를 사용한다. release는 이 옵션과 관계없이 공식 운영 origin으로 고정된다. HTTP·임의 포트·SSL 우회는 제공하지 않는다.
- 삼성 탭 실기기의 격리 서버 검증 빌드: `./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug -PstizOrigin=https://localhost:8443 -PstizDeviceTest=true -PstizLocalTlsDir=C:/0.programing/stiz-academy-A/.tmp/driver-device-test/tls`. 공개 `ca.crt` 한 파일만 debug 리소스로 변환하고 localhost에만 추가 신뢰한다. 다른 도메인은 시스템 CA만 신뢰하며 HTTP는 전부 차단한다. 공개 CA의 유효기간·CA 여부도 빌드 때 확인한다. 8443 예외는 `stizDeviceTest=true`인 localhost에만 허용하며 일반 빌드는 기존 HTTPS 443 제한을 유지한다.
- 이 옵션의 설치 패키지는 `kr.stiz.driver.devicetest`, 테스트 패키지는 `kr.stiz.driver.devicetest.test`다. 기존 앱 데이터와 분리한다. release에는 debug 전용 CA·networkSecurityConfig·패키지 접미사가 포함되지 않는다. 개인키는 읽거나 복사하지 않는다. OS 전역 CA 설치나 인증서 오류 무시는 하지 않는다.
- `https://localhost:8443`의 단말 연결을 host 8443으로 이어 주는 설정과 기기 설치·조작은 담당 PM 한 명만 수행한다. 삼성 탭은 비특권 앱의 443 listener가 거부되어 테스트용 8443을 사용한다. 빌드 담당자는 단말을 조작하지 않는다. 공개 CA/서버 인증서의 하루 유효기간이 지나면 재생성·재빌드한다.
- release 서명키·스토어 계정·출시 메타데이터는 포함하지 않는다. SDK 라이선스를 자동 승인하지 않는다.

## 운행

1. 관리자에게 받은 `https://www.stiz-dasan.kr/driver/<token>` 링크를 입력하거나 링크를 앱으로 연다.
2. 운행 시작을 직접 누른 뒤 위치 공유 설명에 동의하고 정확한 위치와 알림 권한을 허용한다.
   권한 창 때문에 운행 화면이 잠시 비활성화되면 동의한 같은 운행을 최대 2분 동안만 기다린다. 실제 화면으로 돌아온 뒤 권한을 다시 확인해 한 번만 시작하며, 거절·취소·종료·다른 링크 전환 시 시작 대기를 지운다. 백그라운드에서 임의로 시작하지 않는다.
3. 알림을 유지하며 GPS/네트워크 위치의 새 표본만 약 10초마다 전송한다. 정차 중에도 새 표본을 요청한다.
4. 화면 또는 알림의 운행 종료는 즉시 기기 수집을 중단한다. 서버 확인에 실패하면 종료 미확인 상태를 보존하고 제한된 재시도 후 앱 복귀 시 다시 확인한다.
5. 앱/기기 재시작 시 몰래 위치 수집을 시작하지 않는다. 남은 세션은 사용자 시작 시에만 재사용하며 서버가 끝난 세션이라고 확인하면 다음 시작에서 새 세션을 생성한다.

운영 서버의 `DRIVER_MOBILE_TRACKING_ENABLED` 및 신규 테이블이 아직 적용되지 않았다면 위치 공유 시작은 503으로 실패한다. 미배포 상태의 운영 주소 APK로는 실제 운행 흐름을 증명할 수 없다. 이 문서는 활성화 승인이나 DB 변경·배포 승인이 아니다.

현재 사용자가 **차량 1대 운행**으로 확정했으므로 `ROLLING × REGULAR` 공용 token당 한 기기 보호가 현재 범위에 맞는다. 여러 차량의 동시 위치 분리는 향후 증차 시 차량별 링크 정책과 함께 구현·검증할 과제다. 현재 출시의 보류 사유는 실기기 지속 동작·운영 활성화·스토어 심사 준비가 남아 있다는 점이다.

## 안전 경계

- 허용된 HTTPS origin과 `/driver/<token>` 최상위 화면에서만 origin-bound WebView 메시지를 처리한다. 하위 프레임 메시지, 외부 문서, SSL 오류, HTTP, 파일 접근, 임의 intent URL을 허용하지 않는다.
- `StizDriverGpsTransport.postMessage`는 navigation 전에 설치한다. native 이벤트는 `stiz-driver-gps`, token과 상태만 보내며 세션 비밀은 보내지 않는다.
- 위치 sender는 서비스의 단일 직렬 worker 하나다. 웹 위치 권한을 끄고, 웹 hook도 native transport가 있으면 브라우저 sender를 시작하지 않는다.
- 25초 이상 오래된 위치나 이미 시도한 표본을 재전송하지 않는다. 위치를 디스크에 쌓지 않는다. 통신 구간에만 최대 30초 wake lock을 잡는다.
- 세션 비밀·sequence·종료 미확인 상태를 AndroidKeyStore AES-GCM으로 암호화하여 저장한다. 클라우드 백업·기기 이전을 제외한다. 로그에 토큰·비밀·좌표를 쓰지 않는다.
- `serverStopConfirmed`는 서버의 실제 종료 접수 응답에서만 기록한다. 단말 중단·인증 만료를 서버 접수 성공으로 표시하지 않는다.
- 권한 거절·foreground service 승격 실패는 같은 운행 화면의 오류로 보존한다. 화면 복귀 때 빈 초기 상태로 덮지 않으며 새로운 명시적 시작이나 실제 서비스 상태에서 갱신한다.
- 한 운행 중 다른 token 링크에서 시작/종료하려 하면 기존 링크에서 확인하도록 막는다.
- 실제 로고는 `public/stiz-logo.png` 원본을 그대로 복사했다. 출시용 adaptive launcher icon·스토어 아이콘은 별도 마무리가 필요하다.

## 출시 전 필수 실기기 검사

실제 기사님 휴대폰을 연결한 검증 결과 없이 지속 동작이 확인되었다고 표시하지 않는다.

| 시나리오 | 확인할 증거 |
|---|---|
| 화면 잠금 30분 / T맵 30분 / 홈 이동 | 관리자 화면 서버 접수 시각과 새 좌표가 계속 갱신되는지 |
| 정차 10분 | 좌표가 같아도 새로운 capturedAt이 접수되는지 |
| 통신 끊김 5분 → 복구 | 과거 표본을 현재 위치처럼 재생하지 않고 새 위치만 접수하는지 |
| 알림 종료 / 화면 종료 | 기기 수집 즉시 중단, 서버 STOPPED 후 공유 해제 |
| 종료 응답 유실 / 앱 복귀 | stop-unknown 보존, 위치 재시작 없이 종료 재시도 |
| 기기 재부팅 / 강제 종료 | 자동 수집 없이 중단 안내·사용자 재개 필요 |
| 정확 위치/알림 거절 / GPS 설정 끄기 | 실패가 보이며 공유 성공으로 표시하지 않는지 |
| 다른 기기 / 다른 운행 링크 | 충돌을 표시하고 기존 운행을 몰래 중단하지 않는지 |
| 삼성 절전/최적화 / Android 8·13·14·16 | 해당 OS와 제조사 제한에서 수신 간격·소모·복구 확인 |

Play Console 조직 계정, 패키지 이름 확정, release 서명, 개인정보 처리방침/데이터 보안, 위치 foreground service 선언, 심사용 운행 영상·테스트 접근, 내부 테스트 트랙을 준비한 뒤 별도 승인으로 출시한다. foreground service 사용에도 위치의 백그라운드 이용에 관한 Play 심사가 적용될 수 있다.

## 공식 근거

- [location foreground service와 권한/시작 제한](https://developer.android.com/develop/background-work/services/fgs/service-types#location)
- [origin-bound WebView 메시지](https://developer.android.com/reference/androidx/webkit/WebViewCompat#addWebMessageListener(android.webkit.WebView,java.lang.String,java.util.Set,androidx.webkit.WebViewCompat.WebMessageListener))
- [AGP 8.10: API 36, Gradle/JDK 지원](https://developer.android.com/build/releases/agp-8-10-0-release-notes)
- [Google Play 위치 이용 심사](https://support.google.com/googleplay/android-developer/answer/9799150)

검증 로그와 한계는 상위 `docs/driver-android-background-tracking.md` 또는 해당 작업 보고에 남긴다.

권한 복귀 순수 Java 회귀는 실제 `PendingRunStart` 정책 함수를 실행한다. JDK에서 `javac --release 17 -d app/build/pending-start-test app/src/main/java/kr/stiz/driver/PendingRunStart.java tests/PendingRunStartTest.java` 후 `java -ea -cp app/build/pending-start-test kr.stiz.driver.PendingRunStartTest`로 33개 조건을 확인한다. Android 화면·권한 동작 자체의 실기기 검증은 별도로 필요하다.

위치 샘플 대기는 실패와 구분한다. 최초 수집 25초까지는 `requesting/idle`, 그 이후에도 새 표본이 없거나 표본이 오래되면 위치 갱신 지연을 안내한다. 아직 신선한 동일 표본은 아무 상태도 바꾸지 않으며 재전송하지 않는다. 대기·지연은 직전 전송 실패를 성공으로 지우지 않으며 새 위치의 실제 서버 응답만 접수 시각을 갱신한다. `LocationSamplePolicy.java`와 `tests/LocationSamplePolicyTest.java`를 `javac`로 함께 컴파일하고 `java -ea -cp <출력폴더> kr.stiz.driver.LocationSamplePolicyTest`로 13개 경계를 확인한다.
