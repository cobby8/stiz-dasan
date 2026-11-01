# 최신 화면과 가족 연결 아이폰 시험 준비

기준일: 2026-11-02. 최신 main 3f032d06 기반 codex/main-validation-20261101에서 준비했다. 사용자 요청은 최신 화면의 아이폰 시험 앱 반영과 본인인증→가족 요청→승인 실기기 검사다. 전용 MID 미발급 답변에 따라 본인인증은 합성 시험으로 한정한다. 운영·TestFlight·실제 고객 자료/발송/결제는 제외한다.

## 2026-11-02 검증 브랜치 푸시·서명 빌드 5 완료

- 사용자 실행 직전 승인으로 39ef28a5·1799f577 두 커밋을 codex/main-validation-20261101에만 푸시했다. 원격 main은 3f032d06ae2d407a2a04936f8f3d8ea75c6f50dc로 전후 동일하다. 시험 브랜치 자동 배포 차단을 확인했다.
- Codemagic stiz-ios-sandbox-adhoc 최종 시작 버튼은 정확히 1회 눌렀다. [빌드5](https://codemagic.io/app/6adf8936614a5060c363fedd/build/6ae75b62efa74786046fcb07), actual 1799f5775386368e5544c29e0b2cd6844542d4dc, Mac mini M2, SSH/VNC 꺼짐. 2026-11-02 00:31 KST 시작, finished 1분40초. Swift 주소정책·프로젝트 구성·서명/IPA 단계 성공을 확인했다.
- 시작 뒤 UI 오류 토스트가 있었으나 새 빌드 ID·실제 상태가 생성된 것을 확인했다. 중복 시작하지 않았다. 브랜치 새로 읽기 버튼과 실제 드롭다운을 구분해 승인된 검증 브랜치를 선택했고, main으로 실행하지 않았다.
- 일반 CUA 브라우저 다운로드로 IPA 및 보고서 ZIP을 확보했다. IPA 169130바이트, SHA-256 8acca5221bb4b5787bff285a4df670a40cbe28085e13e9a01323d707d9e90673. 보고서 공개16필드·해시 일치 및 독립28/28 통과.
- 독립 검사: 0.1.0/5·exact172.30.1.25:8453·strict ATS·인증 비활성·STIZ Bundle/팀/프로파일·기존 승인과 동일한 등록기기1대·CMS 서명·CodeDirectory28페이지/7특수슬롯·자원6개 해시. 기기 식별값/키는 기록하지 않았다. Windows에서 Apple 신뢰체인을 독립 검증한 것은 아니다.
- 설치·기기 실행·서버 실행·새 CA 신뢰는 하지 않았다. HTTPS 시험 서버 백그라운드 시작의 자동 승인 검토 거절은 여전히 남아 있으며 우회하지 않는다. 운영 홈페이지 배포·TestFlight 업로드 없음.
- 증거: .tmp/ios-build5-remote/{execution.json,config.png,started.png,finished.png,STIZ-sandbox.ipa,reports.zip,verification.json}, .tmp/ios-build5-independent/remote-ipa/independent-ipa-report.json.

## 준비한 구성

- 실제 최신 역할 화면과 ChildConnectionsClient를 합성 HTTPS 번들에 포함했다. 원본 67개 해시 c364ec9de2641c743131985a5c4ca0c37246352991143e9a15aa46035ac92662.
- /__sandbox/family/requester · approver 두 고정 시험 세션을 선택한다. 두 세션은 같은 기기의 합성 actor 전환이며 실제 계정 로그인/세션 격리 검증이 아니다.
- 실제 인증 SDK/통신사에는 접속하지 않는다. 같은 원점의 합성 인증 완료/취소 창→실제 클라이언트 fetch→서버 메모리 상태 전이로 시험한다. 실제 가족 SQL 35건 검사와 구분한다.
- 고정 시험 정보: 합성 기존보호자 / 00000000000 / 합성 자녀, 선택 생일 2016-01-01. 개인 정보는 입력하지 않는다.
- 인증 미완료·취소·만료·재사용·타 세션, 부정확 정보·자기 승인·중복 요청/승인·미인증 승인을 거부한다. 기존 합성 부모의 승인 이후 요청자 접근 결과를 확인한다.
- 앱 빌드 준비는 0.1.0/5, exact https://172.30.1.25:8453만 허용한다. 원본 Swift·Release 프로젝트·Bundle ID·팀·프로파일은 바꾸지 않는다. native auth는 여전히 비활성이다.
- 검증 브랜치만 Vercel 자동 배포를 차단했다. main 정책은 바꾸지 않았다. 후속 승인으로 푸시·원격 빌드를 완료했으며 상세는 위 실행 기록을 따른다.

## 로컬 검증

- npm test: 2766/2766 및 학생 가드5/5 통과. TypeScript noEmit·diff-check 통과.
- sandbox21/21, Python9/9, 관련 Node28/28, 프로젝트참조28, 독립 추가경계19/19 통과.
- 새 준비 run-0770a090ca1016e2, 공개 CA 이름 STIZ Sandbox CA 0770a090ca1016e2, SHA-256 4D5B89896615A78C7C5E5DA58B2CC547FBF09AEF0907410081564F7A39BE49B3. CA 비밀키는 발급 후 삭제, 공개 CA의 자동 신뢰 설치는 하지 않았다.
- 준비 원본 67개 및 산출물4개 해시 일치. 키·운영 환경 파일·기기 식별자는 기록하지 않는다.
- USB 재조회에서 아이폰1대, 정확한 시험 Bundle의 0.1.0/build4 설치 상태를 확인했다. 설치·새 앱 실행은 하지 않았다.

## 실행 제한과 남은 단계

- Start-Process로 새 LAN HTTPS 서버를 숨김 백그라운드 실행하려던 명령은 자동 승인 검토가 blocked by policy로 거절했다. 구체 사유는 제공되지 않았다. 서버 실행 성공으로 기록하지 않고 다른 명령·도구로 우회하지 않았다.
- Codemagic STIZ 앱 연결과 기존 #4 finished는 읽기 확인했다. 최초 준비 때에는 실행 설정 창을 열었다가 취소했으며, 후속 승인 후에는 위 빌드5를 정확히 1회 실행했다.
- 완료된 원격 범위: 검증 브랜치만 푸시, stiz-ios-sandbox-adhoc 수동 작업 1회, 0.1.0/5 산출물의 정확한 버전/주소/서명/등록 기기 검증. main·운영 배포·TestFlight는 제외한다. 해당 푸시·원격 빌드는 후속 승인으로 위와 같이 완료됐다.
- 서버 실행 제한 해소, 새 CA 사용자 설치/전체 신뢰, 산출물 검증 후 기존 등록 기기 설치, 합성 인증 취소/완료→불일치→정확 요청→기존 부모 인증/승인→요청자 접근, 최신 역할 화면·날짜 지우기·회전/키보드를 실물 검증해야 한다.
- 현재는 서명 산출물 검증 완료·아이폰 적용 대기이며 아이폰에서 최신 화면/가족 흐름을 통과한 상태가 아니다. 실제 공급자 인증·운영 계정·운영 DB 검증은 별도다.

## 증거

- .tmp/ios-build5-local/{full-tests.log,types.log,python.log,readiness.log,project.log,sandbox-ready.json}
- .tmp/ios-build5-independent/report.json
- .tmp/native-device-sandbox/run-0770a090ca1016e2/web/source-hashes.json
