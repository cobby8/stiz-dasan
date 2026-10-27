# Android 격리 시험 연결

2026-10-28 사용자 승인: 운영 자료·발송·결제를 차단한 합성 시험 환경 준비. 실제 기기 설치·GPS 수집·운영 배포·서명 출시·원격 빌드는 하지 않는다.

## 구성

- `-PstizSandbox=true`를 명시한 debug에서만 활성화한다. 별도 패키지 `kr.stiz.driver.sandbox`, 이름 `STIZ 격리시험`을 사용해 운영 앱의 로그인·캐시·운행 저장소와 분리한다.
- 기본 origin은 `https://localhost:8453`이다. LAN 연결이 필요하면 `-PstizOrigin=https://192.168.x.x:8453`처럼 정확한 사설 IPv4를 명시한다. 10/8·172.16/12·192.168/16·127/8 및 localhost만 허용한다. 공개 도메인·다른 포트·userinfo·경로·쿼리·fragment는 거부한다.
- `stizNativeAuth=true`를 함께 넣어도 sandbox에서 실제 공급자 로그인은 활성화되지 않는다. 시험 서버의 `/store-app` 역할 선택과 합성 자료만 사용한다.
- WebView의 모든 리소스·주 화면 이동·서비스 워커 요청은 정확한 시험 origin만 허용한다. 외부 전화·지도 Intent도 열지 않는다. 실제 로그인/인증 handoff는 차단한다. 서버가 응답에 CSP를 붙여 WebSocket·worker·프레임·폼도 독립 제한한다.
- 기존 `/staff/run` 미지원 안내는 sandbox UI 검사에 한해 건너뛴다. 실제 앱의 계정 운행 연결을 구현한 것이 아니다.
- sandbox에서는 GPS bridge·위치 서비스 시작·DriverApi 전송을 모두 차단한다. 기사 화면은 서버의 합성 상태로 검사하며 실제 좌표·운행 인증정보를 수집하지 않는다.

## HTTPS 준비

`stizLocalTlsDir`는 sandbox 빌드에 필수다. 새 격리시험 경로의 **공개 `ca.crt`만** 읽어 debug APK에 넣는다. sandbox의 base/domain trust 모두 새 시험 CA만 사용하고 시스템·사용자 CA를 포함하지 않는다. 정확한 시험 origin 요청 제한과 함께 외부 리소스의 공개 인증서로 연결되는 리다이렉트도 거부한다. 서버는 localhost·선택한 사설 주소만 SAN에 넣어 발급해야 한다. 서버 개인키는 앱 빌드에서 열거나 복사하지 않는다. 자체 서명 오류를 무시하지 않고 `onReceivedSslError`는 취소를 유지한다. OS 인증서 자동 설치도 하지 않는다.

예정 명령(서버가 새 시험 CA를 준비한 뒤 실행):

```powershell
./gradlew.bat :app:assembleDebug -PstizSandbox=true -PstizLocalTlsDir=<새_격리시험_CA_디렉터리> --offline
```

USB localhost 전달·LAN 접근·인증서 신뢰·실기기 설치는 PM의 단일 기기 담당자가 별도 준비한다. 위 명령은 서버·기기·운영 연결을 시작하지 않는다. release는 이 옵션을 받아도 `STIZ_SANDBOX=false`, 운영 origin, native auth=false이고 custom CA·시험 패키지는 포함하지 않는다.

## 검증 경계

순수 Java 정책 시험 `tests/SandboxNavigationPolicyTest.java`는 허용/거부 주소를 실제 정책 함수로 검사한다. 로컬 Gradle 컴파일·lint·APK/BuildConfig 검사와 기기 실행·파일 업로드·HTTPS handshake는 별도다. 실기기 통과나 정식 앱 출시 완료로 표시하지 않는다.

2026-10-28 최종 로컬 검증:

- 실제 Java 정책 총321조건 통과: 기존 탐색75·파일55·인증42·시작33·위치13, 신규 sandbox103. 네트워크·위치 호출 없음.
- 실제 Gradle 잘못된 origin5종·누락 CA·모호한 boolean(`TRUE`) 거부 총7건 통과.
- 일반 debug/release 기본 회귀 빌드 성공: 기존 패키지·운영 origin, 양쪽 sandbox/auth 기본false 유지.
- 새 격리 공개CA를 명시한 최종 `assembleDebug assembleRelease assembleDebugAndroidTest lintDebug --offline` 1회 성공(12초). `stizNativeAuth=true`를 함께 넣어도 sandbox auth는false다. debug는 `kr.stiz.driver.sandbox`, release는 기존 운영 origin·sandbox/authfalse·unsigned다. debug는 기존 개발용 키로 자동 서명되며 정식 출시 서명·새 키 등록은 하지 않았다.
- `verify-sandbox-build.ps1` 24/24 통과: 패키지·CA/NSC 포함범위·개인키 파일 미포함·정확한 origin·release 차단값·시스템/user CA 미신뢰·HTTP 금지 확인. lint 오류0·경고9. 기존8개에 서비스 워커 기능 guard를 도구가 인식하지 못하는 경고1개가 추가됐으며 억제하지 않았다.
- 증빙: 이 모듈 `.tmp/sandbox-final-build.log`, `.tmp/sandbox-default-regression-build.log`, `.tmp/sandbox-missing-ca-rejection.log` 및 generated BuildConfig/NSC. 앱·서버 키는 문서/Git에 넣지 않는다.

| 산출물 | SHA-256 |
|---|---|
| debug APK | `ABC75DF969D68B52169F23E6AE86723A3B7D980273EC465DE3C0F44A11F46281` |
| unsigned release APK | `B3D01081D62234A6B7CA6E4AA9507B7C7BC0ECD4016B7EB731910A422E604F04` |
| androidTest APK | `A306C2C01031E00AA3963BCC45984A33642C27A896F24C6B8F9239C10F47DEFD` |

기기 설치·HTTPS 실기기 연결·카메라/사진 실제 조작·GPS·운영 자료/발송/결제·원격 빌드·스토어 업로드는 실행하지 않았다.
