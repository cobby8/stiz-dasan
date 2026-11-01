# Android 첨부 실기기 시험 준비

기준일: 2026-11-02. 사용자 승인 범위는 출시 준비표 현재화, 기존 합성 시험의 안전 보완과 로컬 APK 준비다. 기기 설치·실행·원격 빌드·운영 변경·푸시는 포함하지 않는다.

## 준비 결과

- `AttachmentFixtureActivity`와 `AttachmentWebViewChecks`만 보완했다. `DEBUG && STIZ_SANDBOX && STIZ_UNIFIED_APP && !STIZ_NATIVE_AUTH`와 정확한 `kr.stiz.driver.sandbox` 패키지를 모두 요구한다.
- 첫 검사에서 파일·content 접근 차단에 더해 네트워크 차단도 확인한다. WebView 리소스 요청은403, 권한 요청은 거부한다. 운영 main 코드·Manifest 권한·build.gradle·TLS 정책은 변경하지 않았다.
- 고정 합성 provider의 파일을 선택 결과로 전달하는 9개 검사를 준비했다: 설정 보호, PNG 단일·복수, JSON, 취소, 늦은 중복 응답, 잘못된 이미지, 크기 초과, 탐색 취소. 이 검사는 실제 시스템 선택창을 열지 않으며 카메라·개인 사진·위치·운영 자료를 사용하지 않는다.
- 일반 debug/release/androidTest/Lint 기준선 빌드 50초, 지정 CA의 sandbox 최종 빌드 10초, 모두 `--offline` 종료0이다. Lint 오류0·경고8. 기존 개발용 debug 서명을 사용하며 새 서명키·정식 출시 서명은 준비하지 않았다. Release 산출물은 unsigned다.

## 산출물

| 파일 | 패키지/역할 | 크기 | SHA-256 |
|---|---|---:|---|
| app-debug.apk | kr.stiz.driver.sandbox · 0.1.0/1 | 2451644 | c750f86bb505ed0b8d96a507c0a2806d8a2962ac0d2c9a955602008962223990 |
| app-debug-androidTest.apk | kr.stiz.driver.sandbox.test · 합성 계측 | 16744 | 8ac88e68f1ec9faa120fc4045c97fd52f805f1fdd5be06d61038516192e62d08 |
| app-release-unsigned.apk | 기존 Release·시험 코드 없음 | 1824529 | b3d01081d62234a6b7ca6e4aa9507b7c7bc0ecd4016b7eb731910a422e604f04 |

- 경로는 모듈의 `app/build/outputs/apk/` 아래다. 시험 runner는 `kr.stiz.driver.DriverSmokeInstrumentation`, target은 sandbox 패키지다.
- 정확 origin `https://172.30.1.25:8453`, native auth=false·sandbox=true. 앱에는 run43d의 공개 CA만 포함한다. SHA-256 89A607503232B78090D2565367FD77F496110BB5F4036E7458864F9A6CDF79AF, 만료 2026-11-04 02:06:45 KST. 서버 개인키·시스템/user CA 신뢰·HTTP 허용을 추가하지 않는다.
- 공개 CA를 포함했다는 사실은 HTTPS 실기기 연결 성공이 아니다. 오프라인 계측은 서버를 켜지 않고 실행하며, 이후 실제 선택창·합성 서버 수신 시험을 별도 구분한다.

## 검증과 한계

- 독립 준비 검사15/15, APK 격리24/24, 직접 APK/DEX 검사10/10 통과. 3개 산출물의 크기·해시와 소스32개 지문을 재계산해 일치했다. 소스 지문은 빌드 후 snapshot이며 빌드 전후 두 snapshot이 있다는 뜻은 아니다.
- sourceFingerprint: f7236f4bb4bd56b478ebd7d8797e48f9673d9e177b6687b68ce131f5cf380b21.
- 실제 9개 계측·설치·FileReader 실행·시스템 선택창·사진 첨부·서버 시작·운영 접속·에뮬레이터 실행·원격 빌드는0회다. Gradle 컴파일·정책 검사를 실제 파일 읽기 성공으로 표시하지 않는다.
- 단일 시험 provider는 고정 합성 바이트만 제공하고 계측 APK 안에만 있다. 실제 사용자 파일 제공자·카메라·HEIC·권한 거부·회전·네트워크 복구는 후속 검사다.

## 다음 실행 전 확인

1. 사용자가 후보로 답한 Z Fold8을 USB로 확인한다. 이번 준비 직전 ADB는0대였고 사용자 연결 완료 답변 후1대 unauthorized(디버깅 승인 대기)로 바뀌었다. 모델·현재 sandbox 패키지의 존재 여부는 아직 읽지 못했으며 사용자 승인 창 확인을 요청했다. 설치는 실행하지 않았다.
2. 정확한 기기와 위 두 시험 APK·덮어쓰기 범위를 제시하고 설치 및 오프라인 합성 계측 실행 승인을 받는다. 운영 unified/driver 앱은 설치 대상으로 삼지 않는다.
3. 설치 전 APK 해시·debug 서명·target 패키지를 다시 확인하고, 설치 후 실제 버전과9개 결과를 읽는다. 실패하면 파일 접근 제한을 임의로 해제하지 말고 재현된 경계부터 분석한다.
4. 오프라인 계측과 별도로 실제 Files/사진 선택·합성 비저장 수신을 검증한다. Android 다운로드·계정 기반 통합 운행은 별도 구현 그룹이다.

## 증거

`apps/driver-android/.tmp/attachment-preparation-result.json`, `attachment-{default-build,sandbox-build,artifact-safety}.log`, `attachment-{debug,release,test}-manifest.txt`, `attachment-source-hashes.json`과 독립 검토 결과. 증거는 로컬에 두고 기기 식별자·키·전체 연락처는 Git에 올리지 않는다.

[출시 준비표](native-device-release-readiness.md) · [Android 격리 정책](../apps/driver-android/SANDBOX.md)
