# Android 합성 첨부 실기기 검증

기준일: 2026-11-02. 설치 및 첫 시험은 사용자가 확인된 SM-F971N 기기의 두 시험 APK 신규 설치와 오프라인 합성 검사9개를 명시적으로 승인한 범위다. 운영 앱·사진·카메라·GPS·네트워크·서버·발송·결제는 시험하지 않는다.

## 기기와 설치

- 사용자 후보명 Z Fold8, 실제 조회 모델 SM-F971N·Android17·SDK37, WebView com.google.android.webview 156.0.8078.47. 기기 식별자는 메모리에서만 사용하며 로그·문서에 기록하지 않았다.
- 처음에는 ADB unauthorized였고, 사용자 USB 디버깅 허용 후 정확1대 device로 확인했다. 시험 전 두 패키지 모두 미설치였다.
- 정확한 APK 해시와 단일 기기·모델·패키지 미설치를 다시 확인했다. APK Signature Scheme v2 서명 통과·두 APK의 debug 인증서 일치, 준비 소스32개 해시 일치를 확인했다. 운영/개인 키는 읽지 않았다.
- `kr.stiz.driver.sandbox`와 `kr.stiz.driver.sandbox.test`를 `--no-streaming`으로 신규 설치했다. 덮어쓰기·권한 자동 부여 옵션은 사용하지 않았다. 별도 조회에서 두 패키지와 앱0.1.0을 재확인했다.
- 임시 실행 도구는 `pm path`의 미설치 응답(exit1·빈 stdout/stderr)을 오류로 해석해 최초 설치 전 멈췄다. 그 정확한 정상 부재 응답만 구분한 뒤 설치했다. 다른 명령 실패를 성공으로 바꾸지 않았다.
- 최초 APK: 앱 SHA c750f86bb505ed0b8d96a507c0a2806d8a2962ac0d2c9a955602008962223990, 검사 APK SHA 8ac88e68f1ec9faa120fc4045c97fd52f805f1fdd5be06d61038516192e62d08.

## 첫 계측 결과: 실패·원인 미확정

- 정확한 runner `kr.stiz.driver.sandbox.test/kr.stiz.driver.DriverSmokeInstrumentation`에 `mediaFixture=true`를 전달해1회 실행했다. 일반 운행/저장 검사 분기로 실행하지 않았다.
- 결과: `FAIL AssertionError: Fixture callback timeout`, `INSTRUMENTATION_CODE: 0`. ADB 명령 자체 exit0과 시험 통과는 다르며 실행 도구가 PASS9 및 CODE-1을 함께 요구해 정확히 실패 처리했다.
- 이 로그는 화면 준비·선택 요청·결과 전달·JavaScript 응답 중 어느 대기에서 멈췄는지 구분하지 않는다. 몇 개 검사까지 통과했는지도 확정하지 않는다. 파일 접근 차단이 원인이라는 판정은 하지 않았다.
- 종료 후 시험 앱 프로세스가 남아 있지 않아 해당 PID의 추가 WebView 로그를 읽지 못했다. 다른 앱의 전체 로그를 수집하지 않았다. 원래 실패 기록을 보존하고 같은 명령을 반복 실행하지 않았다.

## 로컬 진단 APK 준비 완료·업데이트 미실행

- 앞서 승인된 시험 코드 보완 범위 안에서 `AttachmentWebViewChecks.java` 한 파일의 대기 지점에 고정 단계명만 추가했다. page-ready·choose-입력명·deliver-result·read-js·cancel-result·navigation-cancel을 구분한다. 반복된 같은 입력명 선택은 몇 번째인지까지 구분하지 않으며 단계 범주를 식별하는 최소 진단이다.
- 대기8초·60회 재시도·100ms 간격·9개 기대값·실제 호출 방식·파일/네트워크 제한·제품 main 코드는 유지했다. androidTest만 --offline 로컬 빌드2초/exit0·격리24개·서명 검사를 통과했고 독립 검토도 일치한다.
- 새 검사 APK SHA-256 d29750d9f9d2d2b021a5f4dd0fdaebce94a875795a6d01b546c87fedff5c2469. 기존 앱 debug·Release 해시는 완전히 동일하다. 최초 검사 APK는 별도 before-androidTest.apk에 보존했다.
- 기기 업데이트·재실행은 아직 하지 않았다. 새 산출물은 검사 APK 한 개만 업데이트 대상으로 제시하고 실행 직전 승인을 받는다. 원래 첫 실패 원인은 여전히 미확정이다.
- 실제 Files/사진 선택창·카메라·회전·HTTPS 비저장 수신·다운로드·Release·실제 로그인·운영 SQL은 미검증이다. 합성 provider 시험의 실패를 실제 시스템 선택창 실패로 확대하지 않는다.

## 증거

- `.tmp/android-attachment-device-20261102/guarded-run.cjs`
- `install-result.json`, `test-result.json`, `instrumentation.log` (같은 폴더)
- `apps/driver-android/.tmp/attachment-diag/{diag-result.json,diag-build.log,before-androidTest.apk}`
- [준비·APK 해시](android-attachment-device-preparation.md) · [출시 준비표](native-device-release-readiness.md)

푸시·원격 빌드·운영 변경·서버 시작·추가 권한 부여·계측 재실행 없음.
