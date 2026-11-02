# 최신 main 환경 정렬·화면·가족 연결·청구 검증

기준일: 2026-11-02 (KST). 대상 코드: main 3f032d06. 사용자 승인: 최신 main 환경 구성·문서 현재화·최신 화면/가족 연결/청구 검증. 푸시·운영 배포·TestFlight·운영 DB 쓰기·발송·실제 결제는 제외한다.

## 환경과 기존 작업 보존

- 기존 앱 검증 HEAD 3c88dc8d는 main의 조상이며 차이는 0/121이다. 이전 앱 검증 9개 커밋도 이미 원격/main에 포함됐다. 과거 미푸시 9개 기록은 현재 상태가 아니다.
- 기존 폴더에는 Claude의 미커밋 운영 기록과 미추적 운영 스크립트가 있어 덮어쓰기·stash·초기화하지 않았다.
- 최신 main에서 별도 worktree .tmp/main-validation-20261101, 브랜치 codex/main-validation-20261101을 만들었다. 기존 node_modules만 로컬 연결해 사용하며 운영 환경 파일은 복사/로드하지 않았다. 향후 개발 기준은 이 폴더다.
- docs/native-device-release-readiness.md, store-release.md, child-connections-and-sport-workspace.md의 현재 요약을 build4·10/30 가족 연결 활성화 기록에 맞췄다. 실제 운영 값 재조회로 표시하지 않았다. 과거 경과는 역사 기록으로 남겼다.

## 실행한 검증

| 계층 | 명령·방법 | 결과 | 범위와 한계 |
|---|---|---|---|
| 전체 회귀 | npm test | Node 2761/2761, 학생 가드 5/5 | 최신 worktree에서 새로 실행 |
| 타입 | npx tsc --noEmit --incremental false | exit 0 | 생성 선언은 로컬 준비, 서비스 설정 변경 없음 |
| 관련 회귀 | 가족/청구/반 이동/토스 관련 node --test | 105/105 | 전체 검사와 중복이므로 합산하지 않음 |
| 가족 서비스·API·SQL | 새 loopback PostgreSQL + 공급자/인증 모의 | 35/35 | 정확 일치 자동 연결, 기존 부모 승인, 타인·자기 승인 차단, 미성년 우회 차단, 만료/재사용/탈퇴/권한 회수, 대표 청구 보존 |
| 청구 서비스·API·SQL | 새 loopback PostgreSQL + 실제 최신 권한 모듈 | 20/20 | 저장→확정→합성 Payment/Invoice 생성, 멱등 재시도, 실패 롤백, 이월·보강 배타, 잔액 보존, 일정 변경 차단, 역할별 거부 |
| 실제 React 화면 | CUA IAB + 최신 소스/합성 응답 | 아래 확인 | 웹 브라우저 검사이며 아이폰 설치 앱 재검증이 아님 |

두 임시 PostgreSQL은 모두 종료했다. 실제 PortOne·토스·운영 DB·고객 발송 연결은 없다. 토스 취소는 판정/연결 소스 검사까지이며 실제 취소 거래의 DB 통합 성공으로 표시하지 않는다.

## 최신 화면 확인

- 최신 역할 UI 65개 원본을 격리 번들로 컴파일했다. 원본 해시 묶음: 63651bffa5484e8dbf9b6564c73fcd86ef00cf3acbe3e4bdd58abec995334687. 서버는 loopback 8462만 사용하고 운영 API/저장 요청을 거부한다.
- 관리자·선생님·학부모·기사님 홈을 360px 및 1440px에서 각각 확인했고, 기사님은 320px도 확인했다. 9조합 모두 페이지 가로 넘침 0이다. 실제 좁은 휴대폰 재검증과 구분한다.
- 관리자 모바일 메뉴 열기→원생 메뉴 이동, 검색 1명→0명→복원, 반별 보기 전환을 확인했다. 합성 대상뿐이므로 운영 전체 메뉴 전수 시험은 아니다.
- 가족 요청 UI는 기존 보호자 승인 검토→대상 재확인→합성 완료 표시를 확인했다. 정보 불일치 오류에서 입력이 보존되고, 320/360px 입력칸 넘침이 없다. 실제 본인인증 버튼이나 SDK는 실행하지 않았다.
- 청구 화면 320px에서 계산 근거를 펼치고 할인 10,000→20,000원 변경 시 3회 달 차감이 22,500→20,000원, 셔틀 포함 합계가 77,500→70,000원으로 바뀌었다. 합성 응답으로 검토 저장→확정 미리보기→확정→발행 미리보기→발행 표시를 확인했다. UI 모의 응답과 위 실SQL 검증은 별도 계층이며 하나의 운영 E2E로 주장하지 않는다.
- 학부모 복귀 날짜 선택→날짜 지우기→빈 값 복원과 320px 가로 넘침 0을 확인했다. 기존 iPhone 번들은 여전히 갱신하지 않았다.
- 검사 탭의 마지막 콘솔 error/warn 조회는 빈 배열이었다. 일시적 화면 폭 override는 복원했다.

## 시험 도구 불일치

- 가족 과거 임시 runner는 탈퇴 인자의 원문 userId를 고정하여 중단했다. 최신 코드는 검증한 target을 넘긴다. 해당 기대 문자열만 메모리에서 보정해 재검증했고 원실패 보고서를 보존했다.
- 청구 공식 PG harness는 새 auth import와 합성 User 컬럼이 빠져 12항목 후 중단했다. 실제 최신 child-access/roles와 필요한 합성 컬럼을 메모리에서 추가한 뒤 20항목을 통과했다. 권한 검사를 생략하지 않았다.
- 제품 코드 오류로 판정한 사항은 없다. 원본 통합 시험 도구의 지속 정비는 남아 있으며 원본 테스트 파일은 이번에 수정하지 않았다.

## 증거

작업 worktree 기준:
- .tmp/main-verification/full-tests.log, types.log, ui-build.json, width-results.json
- .tmp/main-verification/admin-{360,1440}.png 및 teacher/parent/driver 같은 형식, driver-320.png
- .tmp/main-verification/students-360.png, family-approve-360.png, billing-confirm-320.png
- .tmp/child-connections-qa/api-pg-independent-report.json 및 api-pg-original-harness-report.json
- .tmp/main-flow-verification/billing-postgres-result.json, billing-postgres-reproduction.txt

## 남은 출시 검증

- 실제 PortOne 본인인증·기존 부모 요청 수신/승인·거절/계정 전환은 별도 시험이 필요하다. STIZ 전용 MID 발급 완료 근거는 없다.
- 최신 main의 UI가 설치된 iOS build4에 반영됐다는 근거는 없다. 지난 단기 CA는 10월31일 만료해 재사용하지 않는다.
- Drive Files PNG 비활성, 복수 사진·다운로드 수동 취소, 네이티브 푸시, 기사님 장기/계정 운행과 실제 결제 복귀는 별도다.
- 10월31일 운영 대조 기록은 재실행하지 않았다. 운영 배포 일치·운영 키·실제 계정/자료는 이번 합성 검증 결과로 대체하지 않는다.
