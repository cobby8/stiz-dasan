# iOS 사진 첨부·개발용 로그인 인계

2026-10-28 사용자 승인 로컬 구현이다. 운영 설정·Apple 서명·원격 빌드·기기 설치·TestFlight는 실행하지 않는다.

## 사진 첨부

기존 웹의 HTML 파일 입력과 WebKit 기본 선택창을 유지한다. 이 방식은 웹의 `accept`, `multiple`, `capture`를 운영체제가 해석하므로 별도의 선택창으로 바꿔 기존 촬영·문서 가져오기를 망가뜨리지 않는다. 카메라·사진 선택 목적 문구를 Info.plist에 추가했다. 앱 시작 시 사진·카메라 권한을 요청하지 않는다.

iOS 18.4의 사용자 정의 `WKOpenPanelParameters`는 복수 선택 여부와 디렉터리 여부만 알려 주며 웹의 형식·촬영 요청 정보는 제공하지 않는다. 이 메서드를 덮어쓰지 않는다. 선택·취소·페이지 전환 시 선택 결과 전달은 WebKit 기본 동작을 사용한다. 현재 Windows에서는 이 기본 동작의 실제 사진 선택·취소·회전 결과를 검증할 수 없다.

`tools/media-input-fixture.html`은 촬영·복수 사진·문서 선택 검사용이다. 파일 내용을 읽거나 업로드하지 않으며 건수·형식만 표시한다. 실제 사용자 사진을 시험에 사용하지 않는다. iPhone HEIC 사진의 JPG 변환과 웹 허용 형식(JPG·PNG·WebP) 일치는 실기기 확인 항목이다.

## 로그인 인계

- `NativeAuthCoordinator`는 앱 메모리에서 32바이트 임의 verifier·state를 만들고 SHA-256 challenge만 시작 API에 전송한다. 시스템의 `ASWebAuthenticationSession`으로 공급자 로그인 화면을 연다.
- 개발 빌드이면서 `STIZNativeAuthDevelopmentEnabled`를 직접 켠 경우에만 사용한다. 저장소 기본값은 false이고 Release는 항상 비활성이다. 서버도 기본 비활성이며 운영 모드에서는 개발 복귀 주소를 거절한다.
- 기본 역할 홈으로 이동하는 `intent=login`만 지원한다. 가입·로그인 수단 연결·수강신청 인계·특정 상세 복귀 요청은 무시하지 않고 기존 준비 안내로 차단한다.
- 서버가 반환한 공식 호스트·정확한 브라우저 경로·flow를 확인한다. 임의 URL을 시스템 인증창에서 열지 않는다. 시작·취소 API의 외부 주소 전환도 거절한다.
- 개발 복귀 `stiz-academy-dev://auth/return`의 flow·state·단회 code가 정확히 일치할 때만 WebView에서 `/auth/native/consume`에 POST한다. 로그인 토큰을 URL·JavaScript·앱 저장소로 전달하지 않는다.
- 동시 요청 1개, 5분 만료, 취소·화면 이동 시 대기 해제, 늦은 콜백 무시를 적용했다. 서버가 세션 설치와 현재 학원 계정 자격을 판단한다.
- 서버 쿠키 표식은 권한 정보가 아니다. 새 앱 세션의 HttpOnly·Secure 보호를 갱신 때 유지하며, 기존 웹 무표식 정책은 그대로 둔다.

## 검증 범위와 출시 보류

Python 구성 검사로 프로젝트 참조·권한 목적·기본 비활성·수동 무서명을 확인했다. 후속 승인 Codemagic #2/1954bfd8에서 기존 주소 정책38건과 인증 경로·다른 요청·중복 파라미터·플랫폼 구분13건 실제 Swift 실행 및 Xcode arm64/x86_64 컴파일이 통과했다. 이전 #1 결과를 이 수정본 검증으로 대신하지 않았다. 시뮬레이터 UI·아이폰 설치·실제 인증은 미검증이다.

개발용 커스텀 주소는 다른 앱이 가로챌 수 있다. verifier가 없는 앱은 코드를 교환할 수 없지만 복귀 방해까지 막지는 못한다. 출시에는 확정된 앱 ID·서명과 검증된 HTTPS Universal Link가 필요하다. 실제 공급자·본인인증·취소/만료/재시도·사진 선택·업로드 전체 흐름을 기기에서 검증하기 전에는 활성화하지 않는다.

공식 근거: [WebKit 파일 입력 매개변수](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKOpenPanelParameters.h), [Apple 시스템 인증 세션](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).
