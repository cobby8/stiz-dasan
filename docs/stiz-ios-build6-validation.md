# 아이폰 격리 시험 빌드 6

기준일: 2026-11-02. 사용자 요청: 미푸시 2개 커밋을 검증 브랜치에 푸시하고 수정된 새 시험 앱을 생성·설치·검증한다. 운영 배포·TestFlight는 제외한다.

## 최종 결과: 빌드6 실제 번들 실기기 통과

- 인증서 안내 주소가 열리지 않은 원인은 노트북 주소 변경이 아니라 두 임시 서버의 900초 정상 만료였다. 세션 종료(exit0)를 확인한 뒤 같은 run·CA를 제한 전경 실행으로 재개했다. 안내/인증서200·비밀키 경로404·strict TLS health200과 운영 차단을 재확인했다. 새 CA를 재발급하거나 재빌드/재설치하지 않았다.
- 사용자 새 CA 설치·전체 신뢰 완료 후 USB 검사 연결이0대로 바뀌었다. Windows 장치/서비스 Running과 검사 연결을 구분했고 USB 재연결 후 실제1대가 복구됐다. build6 가드 통과·직접 앱 재실행 후 실제 시험 웹 진입을 PNG로 확인했다. 인증서 신뢰 스위치를 대신 조작하거나 TLS 검증을 우회하지 않았다.
- 이번 검사는 원본 CSS를 포함한 새 run43d 번들이다. 전 단계 임시 CSS 태그는 사용하지 않았고 모든 성공 계측에서 localStyleApplied=false였다. 설치된 앱도 build6으로 확인하는 가드를 유지했다.
- 사용자가 시험 날짜와 사유2글자를 입력했다. 실제 입력은 요청한 ‘합성’과 달라 정확 문구 일치는 false로 유지했다. 입력 보존은 기기 안 메모리 기준값과의 대조 boolean으로 확인하며 원문을 도구 로그에 출력하지 않았다.
- 가로750px·키보드 visual높이82·17px·배율1·가로 넘침0 확인. 초기에는 내용이 아래에 있었고 추가 스크롤 후 신청 버튼 전체가 회색 네이티브 보조 막대 위에 보이는 PNG를 직접·독립 대조했다. 항상 입력칸/버튼 동시 표시는 아니며 신청 버튼을 누르지 않았다.
- 실제 날짜 지우기 handler 실행 후 빈 값·지우기 숨김·입력한 사유2글자 보존 확인. 키보드 닫힘 가로750×354와 세로402×750 복귀 후에도 빈 날짜·사유 대조true·17px·배율1·가로 넘침0을 확인했다. 검사 연결/blur 실패 기록은 성공에서 제외하고 재시도 완료 기록으로 판정했다.
- 마지막 관찰기·메모리 기준값을 제거했고 세로 상태 보존을 재확인했다. 임시 스타일을 추가한 적은 없다. 전후 서버 카운터 page3/나머지0 동일, 업로드·저장·위치 증가 없음. 전체 API 호출0의 의미는 아니다.
- 증거 일관성 검사10/10·독립 PNG/DOM 대조 PASS. JavaScript 콘솔은 수집하지 않았다. 실제 공급자 본인인증·운영 SQL·계정 세션 격리·실제 청구/신청 시험과 구분한다. 운영 배포·TestFlight·새 추가 원격 빌드 없음.
- 추가 증거: `.tmp/ios-build6-local/recovery-health.json`, `.tmp/ios-build6-install/date-{initial,landscape-reconnected,reason-baseline,landscape-submit-scroll,cleared,keyboard-closed-retry,portrait-final,cleanup,counters-before,counters-after}.json`, `date-{landscape-submit-scroll,portrait-final}.png`, `device-evidence.json`. 기존 초기-1202 PNG도 보존했다.

- 시험 종료 정리: 재개한 공개 CA·HTTPS 전경 서버 모두 제한 시간 후 exit0으로 종료했다. HTTPS는 fifteen_minute_lease_expired, workspace server.lock 없음·8453 리스너 없음까지 PM 실행 세션으로 확인했다. 서버를 다시 켜지 않았다. 증거 `.tmp/ios-build6-local/cleanup.json`.

## 푸시·빌드

- e02da3b0·8a737f44를 `codex/main-validation-20261101`에 푸시했다. 이어 새 시험 빌드에 필요한 c99e11381d9a6ae5e8c6e856fd86f313fef8343d도 같은 브랜치에 푸시했다. main은 전후 3f032d06ae2d407a2a04936f8f3d8ea75c6f50dc로 동일하다. 검증 브랜치 자동 배포 차단은 유지했다.
- build6 준비는 4개 파일만 변경했다. 버전을 0.1.0/6으로 올리고 이전 build1~5를 설정·완성 앱 검사에서 거부한다. origin·ATS·STIZ ID/팀/프로파일·실제 인증 차단·Release·워크플로 명령은 유지했다. Python9/Node준비15/프로젝트28·독립검토 통과.
- [Codemagic 빌드6](https://codemagic.io/app/6adf8936614a5060c363fedd/build/6ae77237efa74786046fd1b2), `stiz-ios-sandbox-adhoc` 시작 1회. actual c99e1138·Mac mini M2·SSH/VNC 꺼짐. 2026-11-02 02:09 KST 시작, finished 72초. Swift·서명·IPA 검사 통과. 스토어 업로드 없음.
- 브라우저 다운로드 IPA는 169135바이트, SHA-256 fc11184fb9b4c64ce80a55e34ea665ac0df141ce8640f22402886b52b8ddbc7b. 공개 보고서 16필드와 일치한다.
- 독립 IPA 28/28: 버전·커밋·정확 주소·엄격 ATS·인증 비활성·단일 기존 승인 기기·CMS 수학 서명·CodeDirectory28페이지/7슬롯·자원6개 해시. 공개 PKCS7 BER 경고는 별도 OpenSSL CMS 검사 통과와 구분한다. Windows에서 Apple 신뢰체인 전체를 독립 평가한 것은 아니다.

## 새 시험 환경과 설치

- run-43dda12bda18f902: 수정된 CSS를 포함한 실제 67개 소스·4개 산출물 해시 일치. sourceHash 0bb840b8a7d539657914c7815c6c1c9660493692456530fefdc8d5cdc015f2d6. JavaScript는 이전과 같고 CSS만 바뀌었다. 임시 CSS 태그를 넣어 완료로 대체하지 않는다.
- exact HTTPS 주소는 https://172.30.1.25:8453. 도구 추적 전경 프로세스·900초 자동 종료·정리로 실행했다. strict TLS health200, 합성 전용·DB/발송/결제/위치 false 확인. 공개 CA 전달도 exact LAN·GET/HEAD·안내/인증서 두 경로·900초로 제한했다.
- 새 CA: STIZ Sandbox CA 43dda12bda18f902, SHA-256 89A607503232B78090D2565367FD77F496110BB5F4036E7458864F9A6CDF79AF. 만료 2026-11-04 02:06:45 KST. CA 비밀키는 발급 후 삭제됐다. 기존0770 인증서의 신뢰 완료를 재사용하지 않는다.
- 정확 IPA 해시/커밋/버전/주소/프로파일·현재 USB 기기 일치를 메모리에서 검사한 뒤 기존 0.1.0/5만 갱신했다. 설치 로그 guard_ok → install_started → install_complete(exit0) → 별도 post_lookup build6. 앱 삭제·새 기기 등록·권한 변경 없음.

## 초기 실기기 제한 이력 (최종 결과는 상단)

- build6 직접 실행과 네이티브 화면 캡처를 완료했다. 현재는 보안 연결 오류 NSURLErrorDomain -1202가 표시된다. 오류 문구는 정상 표시되며 초기 PNG를 별도로 보존했다.
- 사용자에게 새 CA 설치·전체 신뢰를 요청한 상태다. 보안 설정은 사용자가 직접 조작하며 검증을 우회하지 않는다. 서버의 인증서 서명·SAN·유효기간·주소와 strict TLS 응답은 독립 확인했다.
- 신뢰 완료 후 실제 build6 웹 진입, 임시 태그 없는 수정 CSS, 날짜 선택/지우기·사유 보존, 가로 키보드 17px/배율1·스크롤 버튼 전체 표시·세로 복귀를 확인해야 한다. 이는 초기 보류 당시의 상태이며 후속 완료 결과는 상단을 따른다.
- 이전 빌드5에 임시 CSS를 적용한 실물 결과는 [입력 글씨 검증](academy-touch-input-validation.md)을 따른다. 이번 정식 시험 번들 검사와 구분한다. 실제 인증 공급자/MID·운영 계정·SQL 검증도 별도다.

## 로컬 증거

- `.tmp/ios-build6-local/{python.log,readiness.log,project.log,health.json,leased-server.mjs,leased-public-ca.mjs}`
- `.tmp/ios-build6-remote/{started.png,finished.png,execution.json,verification.json,STIZ-sandbox.ipa,reports.zip}`
- `.tmp/ios-build6-independent/remote-ipa/independent-ipa-report.json`
- `.tmp/ios-build6-install/{guard.py,install.cjs,result.log,initial-certificate-error.png}`

기기 식별자·키·전체 개인 연락처는 기록하지 않는다. 운영 배포·TestFlight·실제 발송·결제·위치 수집 없음.
