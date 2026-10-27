# STIZ 아이폰 앱과 Codemagic 준비

## 현재 진행: 등록 아이폰용 격리 서명 시험
- 사용자 후속 승인으로 STIZ 전용 Ad Hoc 프로파일을 연결하고 `stiz-ios-sandbox-adhoc` 수동 빌드를 1회 시작했다.
- [서명 시험 #1](https://codemagic.io/app/6adf8936614a5060c363fedd/build/6ae0ed15206ce93970c693ed), 실제 소스 `8d19749e`, 검증 브랜치·M2·SSH/VNC 끔. 아직 Mac 배정 대기이며 설치 완료를 뜻하지 않는다.
- [현재 정본](stiz-ios-signed-device-validation.md)에 서명·IPA·실기기 결과를 이어서 기록한다. 운영 홈페이지·main·TestFlight 업로드는 계속 제외한다.

2026-10-27 사용자 요청에 따라 BDR 기록앱에서 사용한 **Codemagic 원격 Mac → TestFlight** 방식을 채택한다. GitHub Actions로 별도 경로를 만들지 않는다. BDR는 Flutter이며 STIZ는 기존 웹 업무 화면을 UIKit/WKWebView로 여는 구조이므로 빌드 명령은 다르다.

기존 BDR를 빌드한 Codemagic 계정의 GitHub 연동에서 `cobby8/stiz-dasan`을 **별도 iOS 앱으로 등록**했다. [STIZ Codemagic 앱](https://codemagic.io/builds?team_id=6ab35084460c69aad6ee4723&app_id=6adf8936614a5060c363fedd). BDR 앱 설정·키·테스터 그룹은 변경하지 않았다. 최초 앱 등록 당시에는 설정 미푸시로 `No configuration file found` 상태였다. 이후 승인된 원격 검증은 아래 후속 기록을 기준으로 한다. 연결 증빙은 `.tmp/stiz-app-foundation-qa/codemagic-stiz-connected.jpg`다.

## 2026-10-28 격리 연결 코드 무서명 검증 #3

- 사용자 명시 승인: 이미 검증 브랜치에 푸시한 `88f74d37`·`9dea3b21`의 새 iOS 코드를 무서명으로 1회 실행한다. 운영 배포·TestFlight 업로드·실기기 설치 제외.
- [빌드 #3](https://codemagic.io/app/6adf8936614a5060c363fedd/build/6ae0e346206ce93970c690dd): 실제 커밋 `9dea3b211a17a7eaed443e4a3ee3ecd7c6eed355`, `codex/stiz-app-codemagic`, `stiz-ios-simulator`, Mac mini M2, SSH/VNC 해제. 시작 요청은 정확히 1회다. 이전 턴의 브라우저 중단 때는 새 빌드를 시작하지 않았다.
- 약14분 Mac 배정 대기 뒤 03:00 KST에 실행해 **finished / 1분24초**로 완료했다. 추가 실행·재시도는 하지 않았다.
- 실제 Swift 탐색38건·인증 인계13건과 신규 sandbox의 유효/잘못된 origin·Release 분리·탐색/리소스 규칙 검사가 통과했다. Xcode 전체 로그의 `CODE_SIGNING_ALLOWED=NO`, `BUILD SUCCEEDED`와 `WebViewController.swift`·`NavigationPolicy.swift`·`NativeAuthCoordinator.swift`의 arm64/x86_64 컴파일을 직접 확인했다.
- 새 `STIZ-simulator.zip` **266.49 KB** 표시와 artifact 보관 로그를 확인했다. 화면의 Publishing은 이 zip 보관 단계이며 스토어 업로드가 아니다. 다운로드·내부 파일 해시·시뮬레이터 UI 실행·아이폰 설치는 하지 않았다. 경고는 AppIntents 의존성이 없어 메타데이터 추출을 생략한다는1건, 컴파일 오류0이다.
- Python 프로젝트 참조28·로컬 준비 도구 시험13 통과, 원격 검증 브랜치/HEAD `9dea3b21`, main `7f7673d6` 유지. 운영 별칭은 기존 `dpl_6ku1QzfDeWaidLt3ZcLyRZ4o8ajU`이며 검증 브랜치 신규 배포는 없다.
- 로컬 증빙 `.tmp/stiz-ios-build3/`: 실행 전 설정·queued/finished 화면·run-scope·remote-build·Swift 정책/Xcode 전체 표시 로그. 사용자 직접 로그인 후 Apple 조직·기존 STIZ App ID·프로파일·기기 등록 상태를 읽기 전용으로 조사했다. [아이폰 설치 준비](stiz-ios-device-install-preparation.md).
- 운영 별칭은 완료 후에도 같은 배포를 유지했다. 무서명 컴파일은 실제 WKWebView 차단 규칙 설치·로그인 왕복·사진 선택·실기기 TLS 신뢰의 통과 근거가 아니다. 기기용 서명·등록·설치·TestFlight·운영 반영은 미실행이다.

## 2026-10-28 새 코드 무서명 검증 #2

- 사용자 명시 승인: 미푸시2개 `490637ed`·`1954bfd8`를 검증 브랜치에 푸시하고 새 iOS 무서명 빌드 1회. 운영 홈페이지 배포·TestFlight 업로드 제외.
- `codex/stiz-app-codemagic` 원격이 `1954bfd833bbb99a6b566359bdbe3fc1777f7af7`로 반영됐다. 원격 main `7f7673d6`, 로컬 main `d870b839`는 유지했다. 독립 workflow17·Python구성28·TypeScript 검사를 통과했다.
- [빌드 #2](https://codemagic.io/app/6adf8936614a5060c363fedd/build/6ae0cff1206ce93970c68a28): 실제 커밋1954bfd8, `stiz-ios-simulator`, Mac mini M2, SSH/VNC 해제, 시작요청1회. 추가 실행·서명·업로드 없음.
- 약17분 Mac 배정 대기 후 **finished / 1분17초**로 완료했다. 실제 Swift 주소 정책38건·새 인증 인계 정책13건 통과, Xcode `BUILD SUCCEEDED` 확인. `NativeAuthCoordinator.swift`와 WebView를 arm64·x86_64로 실제 컴파일했다.
- `CODE_SIGNING_ALLOWED=NO`, 새 `STIZ-simulator.zip` **233.80 KB** 생성 표시와 보관 단계 완료를 확인했다. 다운로드·내부 해시·시뮬레이터 UI 실행·아이폰 설치는 하지 않았다. 전체 로그 경고는 사용하지 않는 AppIntents 메타데이터 추출 생략 안내1건이며 컴파일 오류는 없다.
- 푸시 전후 운영 도메인 배포는 `dpl_6ku1QzfDeWaidLt3ZcLyRZ4o8ajU`로 동일하고, 최근 배포5건에 검증 브랜치 신규 배포0건이다.
- 실행 원장·증빙은 `.tmp/stiz-ios-build2/`에 보관한다. 비밀키·인증 파일·비공개 산출물 주소는 기록하지 않는다. 아래 #1 기록은 이전 코드의 이력이며 #2의 검증을 대신하지 않는다.

## 2026-10-27 이전 빌드 #1 기록

### 2026-10-28 결과 확인

- 동일한 빌드 #1/8546d139가 `finished`, 실행 시간 1분 11초로 완료됐다. 새 실행·재시도는 하지 않았다.
- 실제 Swift 주소 정책 검사 로그 `38 cases passed`, Xcode 로그 `BUILD SUCCEEDED`를 확인했다. arm64·x86_64 시뮬레이터 앱이 생성됐고 `STIZ-simulator.zip` 122.91 KB가 표시된다.
- 다운로드 과정에서 Chrome의 `ERR_BLOCKED_BY_CLIENT`가 표시됐다. 차단을 우회하지 않았으며, 파일 내부·해시·실행·아이폰 설치는 미검증이다. 아래의 대기·컴파일 미검증 표기는 최초 관찰 기록이며 이 결과로 갱신한다.
- 서명·TestFlight·운영 홈페이지·main 변경 없음. 남은 출시 작업은 앱 내 인증 인계·파일 첨부·푸시·실기기 기능 검증 및 STIZ 전용 서명 준비다.
- 로컬 증빙: `.tmp/stiz-app-codemagic-run/xcode-build-visible.txt`, `finished.jpg`. 서명 키나 산출물의 비공개 다운로드 주소는 기록하지 않는다.

- 사용자 승인: 두 커밋과 검증 브랜치 배포 차단을 검사한 뒤 별도 브랜치 푸시·무서명 빌드 1회. 서명·TestFlight 업로드·운영 반영 제외.
- `codex/stiz-app-codemagic`에 `8546d13983202b66848e73068dbca1aa8e8e9065`까지 푸시했다. 이 브랜치만 Vercel 자동 배포를 차단했고 다른 설정은 유지했다. 독립 설정11/11·Python 구성·TypeScript 통과.
- 원격 main은 `7f7673d6ddcc81626d38c5a0cca5ce5fd24057a5`, 로컬 main은 `d870b839`로 유지했다. 운영은 기존 `dpl_6ku1QzfDeWaidLt3ZcLyRZ4o8ajU`를 유지한다.
- [빌드 #1](https://codemagic.io/app/6adf8936614a5060c363fedd/build/6adf8b944a72334e32e56cd9): `stiz-ios-simulator`, Mac mini M2, SSH/VNC 해제, 시작 요청1회.
- 현재 **QUEUED / 원격 Mac 배정 대기**. Swift 검사·Xcode 컴파일·산출물 생성 결과가 없어 코드 성공/실패로 판정하지 않는다.
- 새로고침·전체 빌드 목록에서 같은 상태를 확인했다. 동시 다른 실행·한도 소진 표시·브라우저 오류는 없다. 저장소 pack 약49.54MiB, 공식 플랫폼 상태 operational. 대기 원인은 미확정이다.
- 재실행·요금제 변경·지원 메시지 발송은 하지 않았다. 두 번째 원격 실행은 자동 재시도하지 않고 현재 #1 결과만 확인한다.
- `.tmp/stiz-app-codemagic-run/`에 branch-config/post-push/remote-build 독립 결과·run-scope·before-start/queued 이미지를 보관한다. 비밀키·서명·전체 환경변수는 수집하지 않았다.

## 최초 기반 그룹 (2026-10-27 당시)

- `apps/stiz-ios/STIZ.xcodeproj`와 공유 `STIZ` scheme, 첫 주소 `/store-app`을 준비했다. 실제 권한과 역할 분기는 웹 서버가 판단한다.
- iOS는 학부모·선생님·관리자용이다. 기사님 위치 공유는 Android 네이티브 서비스에서 제공하며 iOS 위치 권한을 추가하지 않는다.
- 공식 HTTPS 호스트의 화면만 앱 안에서 연다. 전화·이메일·허용한 지도 주소는 사용자가 누른 경우에만 외부 앱으로 연다. 임의 외부 주소와 iframe의 외부 앱 실행은 차단한다. TLS 인증서를 우회하지 않는다.
- 웹의 공식 STIZ 로고와 스타일을 그대로 표시한다. 네이티브 상단 메뉴를 중복 추가하지 않았다. 오프라인 재시도와 뒤로 가기 제스처를 제공한다.
- 최초 단계의 간편로그인 인계 미구현은 후속1954bfd8에서 개발용 코드로 보완했다. #2 컴파일은 통과했으나 기본 비활성이며 실제 공급자 로그인·기기 복귀는 미검증이다. 브라우저 쿠키 복사·URL 토큰·JavaScript 인증 주입은 사용하지 않는다.

## 빌드와 설치 단계

1. Windows: `python apps/stiz-ios/tools/validate-project.py`로 참조·plist·scheme·수동 무서명 설정을 검사한다. 이 검사는 Swift 컴파일이 아니다.
2. 별도 승인 후 준비된 설정을 검증용 브랜치에 푸시하고 **STIZ 아이폰 앱 빌드 검증 (업로드 없음)**을 수동 실행한다. Vercel 자동 배포가 섞이지 않도록 브랜치별 차단을 먼저 적용해야 한다. `events: []`로 자동 실행을 막았다. 실제 원격 실행에는 이용 요금/분 사용이 생길 수 있다.
3. 이 단계의 산출물은 **시뮬레이터용 `STIZ-simulator.zip` 안의 `.app`**이다. 아이폰에 직접 설치하는 IPA가 아니며 TestFlight에도 올라가지 않는다.
4. STIZ 정식 번들 ID·업턴랩스 Apple 팀·App Store Connect 앱 레코드를 확인하고 STIZ 전용 서명 구성을 연결한다. 현재 `kr.stiz.academy.dev`는 개발용 임시 식별자이고 코드 서명을 꺼 두었다. BDR 앱 ID·인증서·Codemagic 연동명·테스터 그룹은 복사하지 않는다.
5. 간편로그인 인계·필수 계정 삭제·상점 아이콘/개인정보 명세·실기기 기능 검증을 완료한 뒤 서명 IPA 생성과 TestFlight 수동 업로드 그룹을 추가한다. 대상 버전과 영향은 실행 직전 승인받는다. 공개 App Store 제출은 별도 단계다.

로컬 Mac은 없지만 원격 #2에서 Xcode 컴파일을 완료했다. **시뮬레이터 UI 실행·아이폰 설치는 미검증**이다. 업로드 워크플로와 비밀키 참조를 미리 활성화하지 않는다. 로컬 `.p8` 파일은 읽거나 복사하지 않는다.

`NavigationPolicyTests.swift`의 실제 Swift 실행은 #2에서 완료했다. 앱 안 본인인증·외부 결제 복귀·사진 업로드·네이티브 푸시·자녀 연결·실제 로그인·계정 삭제 전체 흐름은 출시 전 기기 검증 대상으로 남아 있다. 웹의 기능 검증을 이 네이티브 기능의 통과 근거로 대신 사용하지 않는다. `/staff/run`과 `/staff/shuttle`의 iOS 기사 운행 진입은 차단하며 관리자 `/admin`의 셔틀 관리는 별도 웹 업무다.

참고: [Codemagic 시뮬레이터 빌드](https://docs.codemagic.io/yaml-code-signing/ios-simulator-builds/), [네이티브 iOS 빌드](https://docs.codemagic.io/yaml-quick-start/building-a-native-ios-app/). 최소 iOS 16은 현재 프로젝트 개발 기준이며 최종 지원 범위와 제출 SDK는 출시 시 다시 확인한다.
