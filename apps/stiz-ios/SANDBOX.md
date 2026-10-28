# iOS 격리 시험 서버 연결

2026-10-28 사용자 승인: 실제 운영 데이터·발송·결제를 차단한 시험 환경을 Android와 iPhone 앱에서 검증할 수 있도록 준비한다. 이번 변경은 iOS 개발 연결 준비이며 서명·설치·원격 빌드·TestFlight·운영 배포를 실행하지 않는다.

## 연결 설정

- Debug 빌드의 `STIZ_SANDBOX_ORIGIN`에 `https://localhost:8453` 또는 명시적인 사설 IPv4 주소의 `https://<주소>:8453`를 전달한다. 기본값은 빈 문자열이며 기존 운영 진입을 유지한다.
- iPhone의 localhost는 iPhone 자신이다. 같은 네트워크의 PC 서버를 사용할 때는 실제 PC의 사설 IPv4를 명시해야 한다. 임의 DNS 이름·운영 도메인·공인 IP·HTTP·다른 포트·주소 안의 경로/쿼리/사용자 정보는 거절한다.
- 시작 경로는 `/store-app`, 역할별 시험 경로는 `/__entry/admin`, `/__entry/teacher`, `/__entry/parent`다. iOS 기사님 위치 운행은 지원하지 않는다.
- 값이 잘못되면 운영 사이트를 대신 열지 않고 시험 주소 오류 화면에서 멈춘다. Release는 시험 설정을 무시하고 기존 운영 주소 정책을 사용한다. 현재 앱 ID는 개발용 `kr.stiz.academy.dev`이며 정식 앱 ID·서명 결정은 별도다.

후속 승인된 빌드에서 사용할 인자 예시: `-configuration Debug STIZ_SANDBOX_ORIGIN=https://192.168.0.2:8453`. 예시 주소를 실제 기기·PC 주소라고 간주하지 않는다. 이 문서 작성에서 해당 빌드는 실행하지 않았다.

## 운영 연결 차단

1. 화면 위에 ‘시험 환경 · 합성 자료’를 표시하고 WebKit 임시 저장소를 사용한다. 운영 로그인 쿠키·사이트 저장소를 재사용하지 않는다.
2. 주 화면·새 창·iframe은 정확한 시험 origin 안으로 제한한다. 시험 중에는 지도·전화 등의 외부 앱도 열지 않는다. 실제 공급자 로그인과 결제·기사 위치 경로는 차단한다.
3. `WKContentRuleList`를 첫 페이지 로드 전에 설치해 외부 스크립트·이미지·fetch 등도 차단한다. 규칙 생성/설치가 실패하면 페이지를 열지 않는다. 서버의 CSP와 외부 요청 차단은 별도 방어 장치다.
4. `STIZNativeAuthDevelopmentEnabled`가 다른 설정에서 켜져도 sandbox 모드의 `NativeAuthCoordinator.enabled`는 false다. 운영 서버의 인증 시작/소비/취소 경로를 시험하지 않는다.
5. TLS 인증서 검증을 무시하지 않는다. 원본 Info.plist와 Release에는 ATS 설정을 추가하지 않는다. 승인된 실기기 시험 빌드의 생성 Info.plist에만 정확한 시험 IP를 보안 기본값으로 명시한다(아래 참조). 서버 인증서에는 접속 IP의 SAN이 있어야 하고, 기기에서 승인된 수동 신뢰 준비가 필요하다. 인증서·신뢰 설정은 자동 설치하지 않는다.

## 검증과 남은 한계

- 기존 Python 실행 파일의 직접 경로로 `-B -X utf8 apps/stiz-ios/tools/validate-project.py`: 프로젝트 28개 참조, 원본 Info.plist·기본 빈 설정·수동 무서명 유지·차단 준비 전 로드 금지·임시 저장소·원본 TLS 예외 없음 검사.
- `tools/NavigationPolicyTests.swift`에는 유효/잘못된 시험 origin, Release 격리, 운영·공급자·전화·다른 호스트/포트·기사/결제 경로 차단과 리소스 정규식 반례를 추가했다.
- 최초 Windows 단계에서는 Swift/Xcode 실행을 못 했으나, 후속 승인 Codemagic #3의 `9dea3b21`에서 새 Swift 정책·Xcode 컴파일이 통과했다. **WebKit 규칙 실제 설치·iPhone 실기기 연결은 미검증**이다. 과거 #2의 `1954bfd8`을 신규 코드의 근거로 사용하지 않는다. 정본은 `docs/stiz-ios-codemagic.md`다.
- 이 환경은 화면·합성 자료 처리용이다. 실제 공급자 인증, 결제, 가족 알림 발송, 네이티브 푸시의 성공 근거가 아니다. 신뢰할 인증서와 승인된 서명 기기용 빌드가 마련된 뒤 실제 기기에서 통신 차단·회전·키보드·첨부·페이지 이동을 확인한다.

## 등록 아이폰용 서명 시험 작업

후속 사용자 승인에 따라 `stiz-ios-sandbox-adhoc` 수동 작업을 추가했다. 기존 `stiz-ios-simulator`는 무서명으로 유지하며, 두 작업 모두 `events: []`이고 스토어 업로드·TestFlight·이메일 발송 설정이 없다.

- STIZ 명시 ID `kr.co.upturnlabs.stizdasan`, 업턴랩스 팀, Apple 프로파일 이름 `STIZ-Dasan-AdHoc-Sandbox-2026`만 허용한다. Codemagic 참조는 `stiz-dasan-adhoc-sandbox-2026`이다. 기존 팀 배포 서명 항목을 참조하며 키 파일을 저장소로 복사하거나 원문을 읽지 않는다.
- `stiz_ios_sandbox_device` 비공개 그룹의 `STIZ_EXPECTED_DEVICE_SHA256`은 대상 기기 ID의 `-`/`_`를 제거하고 소문자로 정규화한 문자열의 SHA-256이다. 원문·해시는 YAML·Git·빌드 로그·검증 JSON에 넣지 않는다. 값이 없거나 프로파일의 단일 기기와 다르면 서명 전에 중단한다.
- `Debug`·`DEBUG` 조건·실기기 SDK·명시 주소 `https://172.30.1.12:8453`를 빌드 설정에서 확인한다. 잘못된 주소·Release·시뮬레이터 SDK·다른 앱 ID면 중단한다. 소스 프로젝트의 기본 ID·Release 정책은 변경하지 않고 이 수동 작업에만 빌드 인자를 전달한다.
- iOS 17 이상은 IP 접속도 ATS의 명시 대상이므로, 후속 사용자 승인에 따라 시험용 생성 `SandboxInfo.plist`에만 `NSExceptionDomains`의 정확한 `172.30.1.12`를 넣는다. HTTP 허용은 false, 최소 TLS는 1.2, 순방향 비밀성 요구는 true, 하위 도메인 포함은 false다. 임의 네트워크·WebContent·다른 IP·CIDR·추가 키는 허용하지 않으며 인증서 신뢰는 OS가 계속 확인한다. ATS는 포트를 제한하지 못하므로 기존 주소 정책이 HTTPS 8453만 허용한다. [Apple IP 접속 안내](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).
- 이번 재검증 버전은 `0.1.0`/빌드 `2`다. 원본 프로젝트의 빌드 번호는 유지하고 시험 작업의 인자로만 2를 지정한다. 빌드 설정·archive·최종 IPA에서 버전과 ATS의 키·값·불리언 형식을 검사한다. 기존 ‘ATS 설정 없음’ 검증은 원본·Release에 유지하며, 생성된 시험 앱은 정확한 IP 보안 기본값 검증으로 보완한다.
- 선택된 프로파일만 원격 Mac 메모리에서 해석한다. 조직·정확한 앱 ID·프로파일 이름·단일 기기·유효기간·Ad Hoc 권한·keychain 인증서 일치를 확인한다. App Store/전체 기기 허용 프로파일은 거부한다.
- `native_signed_sandbox.py`는 `release-testing`/`destination=export`로 IPA를 로컬 생성한다. 보관 대상은 `STIZ-sandbox.ipa`와 식별자 원문 없는 `verification.json`뿐이다. IPA 안의 서명·embedded 프로파일·시험 주소·앱 ID를 다시 검사하고, 앱 표시 이름을 ‘STIZ 격리시험’으로 구분한다.
- 이 문서와 도구 작성은 원격 서명·실기기 설치 성공 결과가 아니다. 실제 실행·설치 결과는 PM이 별도로 기록한다. 설치 전 소스 커밋·프로파일·IPA 해시와 시험 주소를 대조한다.

공식 문법 근거: [Codemagic 서명 항목의 참조명 지정](https://docs.codemagic.io/yaml-code-signing/signing-ios/). 프로파일·인증서를 각각 참조명으로 지정하며 자동 배포 종류 선택 방식과 혼용하지 않는다.

로컬 검증은 기존 Python 실행 파일의 직접 경로로 수행한다. Windows `python` 설치 관리자 별칭을 자식 프로세스에서 축소 환경으로 실행하지 않는다. 합성 정책 시험은 `tools/test_native_signed_sandbox.py`이며 실제 키·프로파일·기기에 접근하지 않는다.
