# Android 사진 첨부·개발용 로그인 인계

2026-10-28 사용자 승인 로컬 구현. 운영 DB·공급자 설정·서명·설치·발송·배포는 변경하지 않는다.

## 사진·문서

- `WebFileChooser`가 공식 앱 페이지의 HTML 파일 입력을 시스템 문서 선택창으로 연결한다. capture 사진은 시스템 카메라와 한정된 임시 FileProvider 경로를 사용하며 사진 전체 접근·카메라 권한은 추가하지 않는다.
- 기존 JPG/PNG/WebP 수업 사진·다중 선택·JSON/CSV/Excel/텍스트 가져오기를 유지한다. 알 수 없는 확장자를 모든 파일 허용으로 넓히지 않는다. 상한은 10개·파일당 25 MiB·요청 합계 100 MiB다. 웹 압축·서버 권한/동의/초안/게시 판단은 그대로다.
- 외부 결과는 읽을 수 있는 content URI만 허용한다. 임의 앱 내부 provider·file/HTTP/조작 주소를 거부하고 메타데이터·실제 스트림 크기·사진 Bitmap 헤더를 검사해 임시 캐시로 복사한다. MIME 없는 사진·일부 CSV/JSON 일반 MIME은 알려진 확장자에 한해 정규화한다. 파일명이 없으면 확인된 MIME 확장자를 보충한다.
- 취소·중복 결과·문서 교체·다른 페이지·새 Intent·Activity 종료/회전은 콜백을 한 번만 마친다. 요청 코드는 프로세스 단위로 증가해 회전 전 지연 응답이 새 선택과 같은 코드를 쓰지 않는다. 복사 중 화면이 바뀌면 결과를 버린다. 성공 파일은 WebView가 읽기 전에 삭제하지 않고 다음 앱 실행 때 24시간 지난 캐시를 정리한다.
- WebView file/content 접근 false, SSL 오류 거부, 기존 GPS 경계는 유지한다. onShowFileChooser에는 호출 프레임 정보가 없으므로 최상위 프레임 확인을 주장하지 않는다. 공식 현재 페이지와 명시적 시스템 선택을 검사한다.

## 개발용 간편로그인

- 앱과 서버 모두 기본 비활성화다. Android는 DEBUG·STIZ_UNIFIED_APP·STIZ_NATIVE_AUTH가 모두 참이어야 한다. debug의 `-PstizNativeAuth=true`만 개발용이며 release는 옵션과 무관하게 항상 false다.
- 사용자 동작의 정확한 `/auth/oauth/{provider}?intent=login`만 지원한다. google/kakao/naver/apple이 대상이다. next/redirect/수강신청 handoff/가입/계정 연결은 조용히 버리지 않고 준비 안내로 남긴다. 완료 후 기본 역할 화면으로만 간다.
- 앱 메모리의 32바이트 임의 verifier/state와 S256 challenge를 사용한다. start 응답은 같은 HTTPS origin의 `/auth/native/browser?flow=...`만 허용한다. HTTP 리디렉션·인증서 우회·브라우저 쿠키 복사를 하지 않는다.
- debug 전용 callback `stiz-academy-android-dev://auth/return?flow=...&code=...&state=...`의 주소·세 필드·5분·원 flow/state를 확인한다. JWT/로그인 토큰을 URL이나 JavaScript에 넣지 않는다.
- 검증 callback만 WebView `/auth/native/consume`으로 flowId/code/codeVerifier/state를 POST한다. flow/code는 서버와 같은 43자 형식이다. 네이티브 경로 차단에서는 정확한 POST 한 번만 짧게 허용한다. 세션 설정과 기존 다른 계정 교체 거부는 서버가 맡는다. HTTP/통신/SSL 실패·JSON 응답 잔류·30초 무응답은 원래 페이지로 복귀하고 한국어 안내를 표시한다. 인증서 검증을 우회하지 않는다.
- 취소·만료·탐색·문서 교체·Activity 파기는 cancel API를 요청하고 앱 요청을 닫는다. 네트워크 실패/프로세스 소멸은 서버 만료가 최종 보호다. 재시작한 앱은 verifier를 추측하거나 복원하지 않는다.
- 최종 검증 HTTPS App Links·패키지/서명 연결은 활성화하지 않았다. 커스텀 scheme은 개발용이며 release 출시 기준이 아니다.

## 검증과 한계

- 실제 JVM: 파일 정책 55건·인증 정책 42건·기존 탐색 75건·위치 시작 33건·표본 13건 통과.
- debug/unsigned release/androidTest 컴파일·Lint 통과. 오류 0·경고 8(기능 guard 3·JS 2·문자 리소스 2·Gradle 안내 1). 이 중 새 합성 fixture의 JS 사용 경고 1개가 추가됐다. debug overlay exported 누락 Lint 오류는 기존 공개 Activity와 같은 true를 명시해 수정했고 실패 로그도 보존했다. fixture의 Intent.setClipData 반환형 컴파일 오류도 별도 문장으로 수정하고 재검증했다.
- 근거는 `.tmp/android-media-check/`. 실제 기기/에뮬레이터 설치·선택창·카메라·회전·WebView FileList 읽기·웹 압축→합성 서버 수신·공급자 실제 로그인·본인인증은 미검증이다. 컴파일/순수 정책을 실기기 통과로 대신하지 않는다.
- 기존 emulator/API34 이미지는 읽기 전용 확인했으나, PM의 새 격리 에뮬레이터 시작은 자동 승인 검토에서 차단됐다. 우회 실행·설치·사용자에게 직접 우회 실행 요청을 하지 않았다.
- 실제 FileList 검사용 비공개 debug 전용 `AttachmentFixtureActivity`와 test APK의 고정 합성 바이트 provider, `mediaFixture=true` 계측 분기를 준비했다. 기본 계측은 그대로이며 이 분기는 기본 origin/vault 검사와 분리돼 외부 통신·GPS·실제 사진·카메라 UI를 사용하지 않는다. FileList/FileReader·단일/복수·JSON·취소/중복·오류/크기·탐색 검사는 컴파일 준비만 됐고 실행하지 않았다. release에는 fixture Activity·manifest·provider가 들어가지 않는다.
- 기존 localTLS debug manifest 생성도 개발 callback을 유지하도록 보완했다. localhost 공개 CA의 기존 한정 신뢰 규칙과 release 분리는 바꾸지 않는다.
- 최종 fixture 포함 소스/산출물 정본은 `.tmp/android-media-check/fixture-final-result.json`, `fixture-final-build.log`, `final-sources-before.json`이다. 이전 `final-build.log`는 exported 오류 실패, `fixture-build.log`는 test 컴파일 실패의 보존 기록이므로 최신 성공 결과로 사용하지 않는다.

공식 기준: [WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient), [FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider).
