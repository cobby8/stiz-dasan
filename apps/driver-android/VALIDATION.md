# 안드로이드 검증 기록 — 2026-10-19

대상: `apps/driver-android` 초안, 업턴랩스 출시 준비. 운영 배포·운영 DB 변경·스토어 업로드 없음.

- JDK: Android Studio JBR 21, Java 소스/대상 17. SDK 36, Gradle 8.14, AGP 8.10.1.
- `./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug` 최종 성공.
- Android Lint: **0 errors, 4 warnings**. 필수 React 웹 화면의 JS 사용, 역조건 후 return하는 feature 지원 guard를 도구가 인식하지 못한 경고, Gradle 패치 업데이트 안내(8.14→8.14.6), 한국어 안내문 번역 리소스 미분리. 오류를 baseline으로 숨기지 않았다.
- APK와 테스트 APK를 API 35 `Pixel_Tablet` 에뮬레이터(`emulator-5580`)에 설치했다.
- 실제 Android 런타임 검사 **13/13 통과**: 정확한 운행 origin/path 허용 및 HTTP/외부/위조/하위 경로/임의 포트/파일/userinfo 거부 10건, AndroidKeyStore 암복호화·sequence/stopPending 복구·평문 부재 3건. 별도 `.instrumentation` 저장소를 쓰고 지운다. 서버 호출과 위치 수집은 하지 않았다.
- 최종 APK SHA256: `AF4C786A3DE98DB7DE8FF2A5ABA28E12CEFE129474AF9B08CF561A18DFF11BB3`.
- 최종 서비스 소스의 `stopRequested` 가드까지 포함한 APK로 runtime 13건을 다시 통과했다. 시작 HTTP 대기 중 종료 요청이 오면 위치 구독으로 전환하지 않고 종료 확인으로 넘어간다.
- 진입 화면에서 공식 로고·운행 링크 입력·열기 버튼의 실제 표시를 확인했다. `app/build/driver-entry-final.png`, `app/build/driver-entry-final.xml`에 기록했다. 검사 후 이 작업에서 시작한 emulator-5580만 종료했다.
- 빌드 로그: `app/build/final-build.log`; runtime 검사: `app/build/android-runtime-test.log`; Lint: `app/build/reports/lint-results-debug.html`. 빌드 산출물과 로그는 Git 제외.
- 원본 로고와 복사본 SHA256이 일치한다: `831F0C43E74BAABEDD059B4F360FC1A9C77CA1FD24782655A8670616E9FCF6EB`.

검사 경계: 이 결과는 실제 기사님의 잠금 화면·T맵·제조사 절전·30분 연속 GPS 전송 증거가 아니다. 연결된 실제 휴대폰은 없었다. 운영 신규 API는 미배포이며 기본 비활성화된다. 사용자가 차량 1대 운행으로 확정했으므로 token당 한 기기 구조는 현재 범위에 맞고, 다차량 분리는 향후 증차 과제다. README의 실기기 시나리오를 승인된 검증 서버에서 수행한 뒤 출시를 판단한다.
