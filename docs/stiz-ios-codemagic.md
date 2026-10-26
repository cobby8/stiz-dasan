# STIZ 아이폰 앱과 Codemagic 준비

2026-10-27 사용자 요청에 따라 BDR 기록앱에서 사용한 **Codemagic 원격 Mac → TestFlight** 방식을 채택한다. GitHub Actions로 별도 경로를 만들지 않는다. BDR는 Flutter이며 STIZ는 기존 웹 업무 화면을 UIKit/WKWebView로 여는 구조이므로 빌드 명령은 다르다.

기존 BDR를 빌드한 Codemagic 계정의 GitHub 연동에서 `cobby8/stiz-dasan`을 **별도 iOS 앱으로 등록**했다. [STIZ Codemagic 앱](https://codemagic.io/builds?team_id=6ab35084460c69aad6ee4723&app_id=6adf8936614a5060c363fedd). BDR 앱 설정·키·테스터 그룹은 변경하지 않았다. 원격에 설정 파일을 아직 푸시하지 않았으므로 콘솔은 `No configuration file found` 상태이며 빌드 시작 버튼을 실행하지 않았다. 연결 증빙은 `.tmp/stiz-app-foundation-qa/codemagic-stiz-connected.jpg`다.

## 이번 그룹

- `apps/stiz-ios/STIZ.xcodeproj`와 공유 `STIZ` scheme, 첫 주소 `/store-app`을 준비했다. 실제 권한과 역할 분기는 웹 서버가 판단한다.
- iOS는 학부모·선생님·관리자용이다. 기사님 위치 공유는 Android 네이티브 서비스에서 제공하며 iOS 위치 권한을 추가하지 않는다.
- 공식 HTTPS 호스트의 화면만 앱 안에서 연다. 전화·이메일·허용한 지도 주소는 사용자가 누른 경우에만 외부 앱으로 연다. 임의 외부 주소와 iframe의 외부 앱 실행은 차단한다. TLS 인증서를 우회하지 않는다.
- 웹의 공식 STIZ 로고와 스타일을 그대로 표시한다. 네이티브 상단 메뉴를 중복 추가하지 않았다. 오프라인 재시도와 뒤로 가기 제스처를 제공한다.
- **간편로그인의 앱↔시스템 브라우저 인계는 아직 미구현이다.** Google/Apple 인증을 WebView에서 시작하지 않으며 준비 중임을 알린다. 브라우저 쿠키 복사·URL 토큰·JavaScript 인증 주입은 사용하지 않는다. 이메일 비밀번호 로그인도 iOS 실빌드/기기 검증 전이다.

## 빌드와 설치 단계

1. Windows: `python apps/stiz-ios/tools/validate-project.py`로 참조·plist·scheme·수동 무서명 설정을 검사한다. 이 검사는 Swift 컴파일이 아니다.
2. 별도 승인 후 준비된 설정을 검증용 브랜치에 푸시하고 **STIZ 아이폰 앱 빌드 검증 (업로드 없음)**을 수동 실행한다. Vercel 자동 배포가 섞이지 않도록 브랜치별 차단을 먼저 적용해야 한다. `events: []`로 자동 실행을 막았다. 실제 원격 실행에는 이용 요금/분 사용이 생길 수 있다.
3. 이 단계의 산출물은 **시뮬레이터용 `STIZ-simulator.zip` 안의 `.app`**이다. 아이폰에 직접 설치하는 IPA가 아니며 TestFlight에도 올라가지 않는다.
4. STIZ 정식 번들 ID·업턴랩스 Apple 팀·App Store Connect 앱 레코드를 확인하고 STIZ 전용 서명 구성을 연결한다. 현재 `kr.stiz.academy.dev`는 개발용 임시 식별자이고 코드 서명을 꺼 두었다. BDR 앱 ID·인증서·Codemagic 연동명·테스터 그룹은 복사하지 않는다.
5. 간편로그인 인계·필수 계정 삭제·상점 아이콘/개인정보 명세·실기기 기능 검증을 완료한 뒤 서명 IPA 생성과 TestFlight 수동 업로드 그룹을 추가한다. 대상 버전과 영향은 실행 직전 승인받는다. 공개 App Store 제출은 별도 단계다.

현재 Mac이 없으므로 **Xcode 빌드·시뮬레이터 실행·아이폰 설치는 미검증**이다. 업로드 워크플로와 비밀키 참조를 미리 활성화하지 않는다. 로컬 `.p8` 파일은 읽거나 복사하지 않는다.

현재 로컬 검증은 구성 검사이며 `NavigationPolicyTests.swift`의 실제 Swift 실행은 Codemagic 단계에 준비했다. 앱 안 본인인증·외부 결제 복귀·사진 업로드·네이티브 푸시·자녀 연결·실제 로그인·계정 삭제 전체 흐름도 출시 전 실빌드/기기 검증 대상으로 남아 있다. 웹의 기능 검증을 이 네이티브 기능의 통과 근거로 대신 사용하지 않는다. `/staff/run`과 `/staff/shuttle`의 iOS 기사 운행 진입은 차단하며 관리자 `/admin`의 셔틀 관리는 별도 웹 업무다.

참고: [Codemagic 시뮬레이터 빌드](https://docs.codemagic.io/yaml-code-signing/ios-simulator-builds/), [네이티브 iOS 빌드](https://docs.codemagic.io/yaml-quick-start/building-a-native-ios-app/). 최소 iOS 16은 현재 프로젝트 개발 기준이며 최종 지원 범위와 제출 SDK는 출시 시 다시 확인한다.
