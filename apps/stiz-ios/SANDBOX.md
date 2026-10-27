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
5. TLS 인증서 검증을 무시하거나 ATS 예외를 추가하지 않는다. 서버 인증서에는 실제 접속 IP의 SAN이 있어야 하고, 기기에서 승인된 수동 신뢰 준비가 필요하다. 앱의 로컬 네트워크 접근 목적 안내는 추가했으나 인증서·신뢰 설정은 자동 설치하지 않는다.

## 검증과 남은 한계

- `python -X utf8 apps/stiz-ios/tools/validate-project.py`: 프로젝트 28개 참조, Info.plist·기본 빈 설정·원격 수동 무서명 유지·차단 준비 전 로드 금지·임시 저장소·TLS 예외 없음 검사 통과.
- `tools/NavigationPolicyTests.swift`에는 유효/잘못된 시험 origin, Release 격리, 운영·공급자·전화·다른 호스트/포트·기사/결제 경로 차단과 리소스 정규식 반례를 추가했다.
- 최초 Windows 단계에서는 Swift/Xcode 실행을 못 했으나, 후속 승인 Codemagic #3의 `9dea3b21`에서 새 Swift 정책·Xcode 컴파일이 통과했다. **WebKit 규칙 실제 설치·iPhone 실기기 연결은 미검증**이다. 과거 #2의 `1954bfd8`을 신규 코드의 근거로 사용하지 않는다. 정본은 `docs/stiz-ios-codemagic.md`다.
- 이 환경은 화면·합성 자료 처리용이다. 실제 공급자 인증, 결제, 가족 알림 발송, 네이티브 푸시의 성공 근거가 아니다. 신뢰할 인증서와 승인된 서명 기기용 빌드가 마련된 뒤 실제 기기에서 통신 차단·회전·키보드·첨부·페이지 이동을 확인한다.
