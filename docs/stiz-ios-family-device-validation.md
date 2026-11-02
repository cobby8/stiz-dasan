# 최신 화면과 가족 연결 아이폰 실기기 검증

기준일: 2026-11-02. 최신 main 3f032d06 기반 codex/main-validation-20261101에서 준비했다. 사용자 요청은 최신 화면의 아이폰 시험 앱 반영과 본인인증→가족 요청→승인 실기기 검사다. 전용 MID 미발급 답변에 따라 본인인증은 합성 시험으로 한정한다. 운영·TestFlight·실제 고객 자료/발송/결제는 제외한다.

## 2026-11-02 빌드 5 설치·합성 가족 연결 실기기 완료

- 대상: 등록된 iPhone 16 Pro, STIZ 시험 앱 0.1.0/5. USB 설치 성공 후 별도 버전 조회로 5를 확인했다. 새 원격 빌드·운영 배포·TestFlight 업로드는 실행하지 않았다.
- 최초 앱 실행의 인증서 오류(-1202)는 당시 도구로 관측했다. 사용자가 신뢰 설정을 켠 뒤 USB 화면에서 정확한 STIZ Sandbox CA 0770a090ca1016e2가 ON임을 직접 확인하고 STIZ 앱만 다시 실행해 정상 웹 진입을 확인했다. 최초 오류 PNG는 정상 진입 캡처로 덮였으므로 초기 오류의 파일 증거로 쓰지 않는다.
- 실제 WebView에서 합성 인증 취소 → 미인증 유지/오류, 인증 완료 → 입력창 표시를 확인했다. 가족 정보 불일치 시 입력 유지·오류·요청 미생성, 정확 일치 시 PENDING·승인 전 접근 차단을 확인했다.
- 기존 부모 합성 세션은 인증 전 승인함이 없고, 인증 후 요청을 표시했다. 대상 자녀·요청자를 재확인한 뒤 승인했으며 서버는 APPROVED/접근 허용으로 바뀌었다. 요청자 화면으로 돌아가 연결 완료 및 합성 자녀 접근 허용까지 직접 확인했다.
- 성공 단계 9개를 묶은 증거 검사 13/13 통과. 독립 QA는 준비 완료 DOM 19개 모두 402×750·가로 넘침 0과 상태/PNG 일치를 확인했다. 중간 검사 연결 실패·초기 페이지 미발견·로딩 ready:false는 성공 집계에서 제외하고 후속 완료 기록으로 확인했다. JavaScript 콘솔 오류는 수집하지 않았으므로 오류 0으로 선언하지 않는다.
- 이 시험은 고정 합성 actor 전환·합성 본인인증·메모리 요청 원장 기준이다. 실제 공급자 본인인증, 실제 계정 간 세션 격리, 운영 SQL 또는 실제 자녀 자료 접근 검증은 아니다. 전용 MID 미발급으로 실제 인증은 보류한다.
- 서버는 도구 추적 전경 실행으로 900초 후 정상 종료(exit0·fifteen_minute_lease_expired)했고 server.lock 제거를 확인했다. 공개 CA 전달 전경 실행도 제한 시간 후 exit0으로 종료됐다. 종료 확인은 PM 실행 세션 관측이며 독립 QA의 파일 대조와 구분한다. 갱신·상주 재시작하지 않았다.
- 증거(로컬·Git 제외): .tmp/ios-build5-install/device-evidence-result.json, family-{before,verified,mismatch,pending,approved}.json, ui-*.json, stiz-cert-trust-settings.png, family-approval-review.png, family-completed.png, result.log. 독립 QA는 기기·서버·키에 접근하지 않고 증거만 대조했다.
- 남은 별도 시험: 실제 인증사/MID 준비 후 인증·실제 계정 연결 검증, 최신 번들의 날짜 지우기·회전/키보드 확대 회귀. 이번 결과로 전체 출시 준비 완료를 선언하지 않는다.

## 중간 이력: 제한된 서버 실행 허용·아이폰 빌드 5 설치

- 사용자 후속 승인으로 차단 원인을 먼저 읽기 조사했다. 해당 세션 실행 기록에서 CreateProcess 전 generic blocked by policy와 세부 reason 없음만 확인했다. 애플리케이션/인증서 오류가 발생한 기록은 없으며 검토기의 상세 이유를 추정하지 않는다.
- 이전 숨김 Start-Process 상주 명령은 다시 실행하지 않았다. 새 실행은 도구가 추적하는 단일 전경 프로세스·900초 수명·만료/신호/오류 시 instance.close 정리로 제한했다. 원래 startSandbox의 소스/산출물/CA/호스트 검사는 그대로다. 별도 자동 검토를 통과해 실행됐다. 승인 설정·방화벽·TLS 검증을 낮추지 않았다.
- 실제 strict TLS health 200: synthetic-only, DB/발송/결제/GPS false. 기존 파일을 읽기 검사한 67개 소스/4개 산출물과 공개 CA/SAN/서명은 일치한다. 공개 CA는 2026-11-04 00:23:41 KST까지 유효하다.
- 공개 CA 전달도 전경·900초로 제한하고 명시 LAN Host/GET·HEAD/안내와 인증서 두 경로만 열었다. 비밀키나 파일 목록은 제공하지 않는다. 사용자에게 CA 이름/지문을 보여주고 직접 설치·전체 신뢰 완료 답변을 받았다.
- 새 IPA의 정확한 SHA/커밋/0.1.0/5/origin/프로파일과 실제 USB 기기 일치를 메모리에서 검사한 뒤 기존 0.1.0/4 시험 앱만 갱신했다. 결과 guard_ok→install_started→install_complete(exit0)→별도 post_lookup build5 확인. 재설치/삭제/운영/TestFlight 작업 없음.
- 직접 앱 실행·화면 캡처를 시작하려던 시점에는 USB 기기가 0대로 바뀌어 device_count_mismatch로 중단했다. 재조회도 0대였고, 사용자에게 재연결·잠금 해제를 요청했다. 새 앱 실행/가족 실기기 검증은 아직 성공으로 표시하지 않는다.
- 가족 서버 초기 상태는 두 합성 actor 모두 verified=false, incoming/outgoing 비어 있음, 접근 false다. 이 읽기 검사는 실제 사용자 동작으로 인증/요청한 것이 아니다.
- 독립 QA는 제한 실행·정확한 설치 가드·4단계 성공 로그를 확인했다. 임시 설치 도구의 실패 시 셸 exit0 가능성을 찾아 nonzero 처리를 보완했고 구문 검사했다. 이 보완을 이유로 설치를 반복하지 않았다.
- 증거: .tmp/ios-build5-local/{leased-server.mjs,leased-public-ca.mjs,live-health.json}, .tmp/ios-build5-install/{guard.py,install.cjs,result.log,launch.log,family-before.json}. 기기 ID/키·개인정보는 Git 기록하지 않는다.

## 이전 이력: 검증 브랜치 푸시·서명 빌드 5 완료

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

## 최초 실행 제한과 후속 단계 (현재 결과는 상단)

- Start-Process로 새 LAN HTTPS 서버를 숨김 백그라운드 실행하려던 명령은 자동 승인 검토가 blocked by policy로 거절했다. 구체 사유는 제공되지 않았다. 서버 실행 성공으로 기록하지 않고 다른 명령·도구로 우회하지 않았다.
- Codemagic STIZ 앱 연결과 기존 #4 finished는 읽기 확인했다. 최초 준비 때에는 실행 설정 창을 열었다가 취소했으며, 후속 승인 후에는 위 빌드5를 정확히 1회 실행했다.
- 완료된 원격 범위: 검증 브랜치만 푸시, stiz-ios-sandbox-adhoc 수동 작업 1회, 0.1.0/5 산출물의 정확한 버전/주소/서명/등록 기기 검증. main·운영 배포·TestFlight는 제외한다. 해당 푸시·원격 빌드는 후속 승인으로 위와 같이 완료됐다.
- 서버 실행 제한 해소, 새 CA 사용자 설치/전체 신뢰, 산출물 검증 후 기존 등록 기기 설치, 합성 인증 취소/완료→불일치→정확 요청→기존 부모 인증/승인→요청자 접근, 최신 역할 화면·날짜 지우기·회전/키보드를 실물 검증해야 한다.
- 최초 준비 당시에는 아이폰 적용 대기였다. 후속 설치·가족 실기기 완료 결과와 남은 범위는 문서 상단을 따른다.

## 증거

- .tmp/ios-build5-local/{full-tests.log,types.log,python.log,readiness.log,project.log,sandbox-ready.json}
- .tmp/ios-build5-independent/report.json
- .tmp/native-device-sandbox/run-0770a090ca1016e2/web/source-hashes.json
