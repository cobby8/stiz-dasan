# STIZ 아이폰 실기기 설치 준비

기준일 2026-10-28. 사용자 승인: 검증 브랜치의 새 iOS 무서명 빌드 1회와 실기기 설치 준비. 운영 배포·TestFlight 업로드·기기 설치·기기 등록·서명 설정 변경은 실행하지 않는다.

## Apple 포털에서 새로 확인한 상태

사용자가 직접 로그인한 뒤 읽기 전용으로 확인했다. 계정 주소·전체 전화번호·기기 식별자·키·인증 파일 내용은 이 문서에 기록하지 않는다.

| 항목 | 실제 확인 | 다음 조건 |
|---|---|---|
| 개발자 계정 | UPTURN LABS Co., Ltd., 조직, Apple Developer Program, 갱신일 2027-09-23 | 새 계정 생성 불필요 |
| STIZ App ID | `STIZ Basketball Academy`, 명시 Bundle ID `kr.co.upturnlabs.stizdasan` 등록됨 | 새 ID를 중복 생성하지 않고 설치용 앱에 연결할 범위를 승인받음 |
| 현재 코드 | 임시 `kr.stiz.academy.dev`, 팀 미설정·서명 비활성 | 등록된 STIZ ID·팀과 연결하는 별도 개발 설정 필요 |
| 등록 기기 | 포털 Devices에 시작 안내만 표시, 등록 기기 없음 | 대상 아이폰 확인 후 기기 등록 실행 승인 필요 |
| 프로파일 | 현재 보이는 목록은 기존 BDR App Store 프로파일 1개, STIZ 프로파일 없음 | STIZ ID·대상 기기를 포함한 전용 프로파일 필요. BDR 프로파일 복사 금지 |
| 인증서 | Apple의 유효한 Distribution 인증서 1개, Codemagic에도 같은 조직·만료일의 배포 서명 항목이 표시됨(2027-09-23) | 서명 항목 존재와 실제 기기용 서명 성공은 구분. 개인키를 읽거나 복사하지 않음 |
| App Store Connect | 현재 앱 목록에는 BDR만 표시, STIZ 레코드 없음 | 향후 스토어/TestFlight 준비 시 별도. 이번 등록 기기용 설치와 구분 |
| App ID 기능 | Associated Domains·Push Notifications 미선택 상태 | 실제 앱 링크·푸시 준비 그룹에서 검토. 이번에 선택·저장하지 않음 |

Codemagic 프로파일 목록도 읽기 확인했으며 기존 BDR용 항목만 표시되고 STIZ용 항목은 없었다. 기존 항목을 가져오기·복사·삭제하거나 키·인증서·프로파일을 내려받지 않았다. 팀 공통 배포 인증서를 후속 STIZ 서명에 참조할 수 있는지와 그 승인 범위는 별도로 결정하며, BDR의 앱 전용 프로파일·식별자를 STIZ에 사용하지 않는다.

원래 문서의 ‘정식 ID 미확정’은 등록 여부를 확인하지 못했던 기록이다. 이제 STIZ 전용 등록 ID는 확인했지만, 현재 프로젝트·서명·프로파일 연결이 완료됐다는 뜻은 아니다.

## TestFlight 없는 설치 경로

등록 기기에만 설치하는 Ad Hoc 방식으로 준비할 수 있다. Apple 공식 절차는 App ID·배포 인증서·등록 기기를 요구한다. 따라서 시뮬레이터 zip을 아이폰 설치 파일로 바꾸거나, BDR 프로파일을 그대로 사용하는 방식으로 진행하지 않는다. [Apple Ad Hoc 프로파일 안내](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile), [Codemagic iOS 서명 안내](https://docs.codemagic.io/yaml-code-signing/signing-ios/).

| 순서 | 구체적 대상·작업 | 현재 실행 여부 |
|---|---|---|
| 1 | 새 코드 무서명 빌드 #3/`9dea3b21`의 Swift·Xcode 결과 확인 | finished 1분24초, 실제Swift38+13·신규sandbox정책·Xcode arm64/x86_64 통과, zip266.49KB 표시. UI·기기 실행은 미검증 |
| 2 | 연결한 아이폰의 모델·신뢰·등록 식별자 조회 가능 여부 확인 | 사용자 연결 후 WPD iPhone·Apple USB 장치 정상, 장치 서비스 실행 확인. USB 식별자 후보는 비공개로 조회 가능하며 실제 등록 전 기기 정보와 대조. 원문 대화·Git 저장 없음 |
| 3 | 업턴랩스 조직의 기존 STIZ App ID에 대상 아이폰 등록·전용 Ad Hoc 프로파일 준비 | 미실행. 정확한 기기·팀·ID를 보여주고 실행 승인 필요 |
| 4 | 필요한 서명 항목을 Codemagic 안전 저장소에서 연결하고, **Debug 구성·DEBUG 컴파일 조건·명시한 사설 HTTPS 시험 주소**를 유지해 기기용 앱 구성 | 미실행. 키 파일을 대화로 받거나 Git에 올리지 않음 |
| 5 | 승인된 별도 수동 빌드로 격리 설정을 보존한 기기용 서명 IPA 생성. publishing/TestFlight 단계 없음 | 미실행. 이번 무서명 1회 실행과 별개. 설치 전 빌드 구성과 IPA의 시험 주소 대조 필수 |
| 6 | 등록된 아이폰에 승인된 경로로 설치 후 버전·Bundle ID·시험 표시·서버 TLS·외부 차단 확인 | 미실행. 프로파일/인증서 신뢰는 사용자가 직접 확인 |

Ad Hoc 산출물의 전달·설치 방식은 실제 Codemagic 결과 화면에서 확인한다. 공개 다운로드 링크나 이메일 초대는 만들지 않았다. 프로파일 설치·기기 정보 수집 링크의 외부 전송도 자동 실행하지 않는다. [Codemagic 시험 기기 등록 안내](https://docs.codemagic.io/yaml-testing/ios-provisioning/).

현재 iOS의 격리 연결은 `#if DEBUG`에서만 활성화된다. Ad Hoc은 서명·전달 방식이며 Xcode의 Debug/Release 구성과 별개다. 후속 시험 IPA는 Debug 및 `DEBUG` 조건이 있어야 하고, `STIZ_SANDBOX_ORIGIN`이 정확한 PC 사설 HTTPS 주소인지 검사해야 한다. 일반 Release를 사용하면 시험 주소가 무시되고 기존 운영 진입이 되므로 시험용으로 배포하지 않는다. 구성·Bundle ID·서명 프로파일·IPA 내 주소·소스 커밋을 설치 전에 대조하고 불일치하면 중단한다.

## 격리 서버·Android 준비와 한계

- 격리 서버는 `.tmp/native-device-sandbox/run-25e9c4bd1ddb0821`에 준비돼 있다. 공개 시험 CA의 만료는 2026-10-30 02:23 KST다. 사설 주소가 바뀌거나 인증서가 만료되면 새로 준비해야 한다.
- 새 CA를 발급하면 Android 시험 APK도 그 공개 CA로 다시 빌드해야 한다. 현재 Android APK는 `kr.stiz.driver.sandbox`이며 해시는 [Android 기록](../apps/driver-android/SANDBOX.md)에 있다.
- iPhone의 localhost는 iPhone 자신이므로 같은 사설망의 PC 주소를 명시한다. TLS 오류 무시·OS 신뢰 자동 설치·운영 주소 fallback을 사용하지 않는다.
- 현재 합성 환경은 실제 공급자 로그인·DB 권한·가족 알림·결제·GPS를 시험하지 않는다. 화면 표시·합성 자료·첨부 수신과 운영 연결 차단부터 확인한다.

빌드 정본: [Codemagic 실행 기록](stiz-ios-codemagic.md). 환경 정본: [격리 HTTPS](native-device-sandbox.md), [iOS 연결](../apps/stiz-ios/SANDBOX.md).
