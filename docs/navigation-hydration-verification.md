# 화면 전환 React 418 원인과 수정 검증

검증일: 2026-10-19. 운영 DB·외부 발송·결제·배포 없이 격리 복사본에서 검증했다.

## 결과

| 조건 | 결과 |
|---|---|
| 기존 Next 16.1.6 생산 빌드, 6화면 × 5회 × 3폭 | 90회 중 React 418 발생 12회 |
| 기존 개발 모드, 같은 6화면 × 3회, 390px | 18회 오류 0. 개발 모드만으로 해결 판정 불가 |
| Next 16.2.12 생산 빌드, 같은 90회 | React 418·기타 pageerror 0 |
| 후보 문서 이동·실제 Link 복합 검사 | 108회 통과, 실제 Link 27회, 오류 0 |
| 정식 수정 버전 독립 검사 | 문서 이동·실제 Link 전환 36회 통과, 실제 Link 9회, 오류 0 |

검사 화면은 `/admin`, `/admin/apply`, `/admin/attendance`, `/staff`, `/staff/quick-post`, `/staff/seasonal`이다. 폭은 390·834·1440px이며 각 진입 후 800ms 대기와 동일 문서 재사용 조건을 유지했다. 합성 계정으로 역할을 나눴으며 실제 로그인·기기 검증은 별도다.

## 코드 수준 원인

서버가 만든 화면에 브라우저의 버튼 기능을 연결하는 초기 단계에서, React가 중단된 작업을 다시 시작할 때 이미 읽은 DOM 위치를 되돌리지 않는 문제였다. 서버의 HTML과 화면 코드가 서로 다른 문제로 단정하지 않았다.

React가 418을 던지는 지점에 임시 계측을 넣어 다음 순서를 확보했다.

1. 선생님 역할의 바깥 `div[data-academy-role="teacher"]`를 정상 확인한다.
2. 지연 도착한 화면 조각을 처리하며 같은 `div` 작업을 다시 실행한다.
3. 현재 DOM 위치는 이미 그 안의 `header`로 들어가 있다.
4. 같은 `div`를 `header`와 비교하면서 잘못된 불일치로 판단한다.

계측은 격리 브라우저가 받는 JS 응답에만 넣었다. 저장소·의존 패키지를 임의로 패치하거나 오류를 숨기지 않았다. 관리자에서도 화면 본문 `div`와 Suspense 경계의 위치가 어긋나는 형태를 확인했다.

정식 근거는 React의 병합된 [수정 PR #35494](https://github.com/facebook/react/pull/35494)다. [재현 보고 #37584](https://github.com/react/react/issues/37584)는 관찰한 순서와 일치하며, 해당 보고의 추측만으로 원인을 확정하지 않고 실제 커서 이동과 배포 패키지 코드를 함께 대조했다.

## 최소 버전 선정

공식 npm 패키지의 실제 내장 React DOM을 비교했다. 함수 이름은 생산 코드에서 인라인되므로 이름 검색만으로 판정하지 않았다. `replaySuspendedUnitOfWork`의 host 작업 재실행 분기에서 `hydrationParentFiber`를 확인하고 `nextHydratableInstance`를 자신의 DOM 노드로 복원하는지 비교했다.

| Next 버전 | 해당 위치 복원 코드 |
|---|---|
| 16.1.6·16.1.7 | 없음 |
| 16.2.0·16.2.9·16.2.12 | 있음 |
| 16.3.0·16.3.4·16.4.0·16.4.2 | 있음 |

최소 변경 계열인 **16.2의 최신 패치 16.2.12**를 선택했다. 업무 기능·API·DB·직접 사용하는 React/React DOM 19.2.3은 유지한다. Next가 함께 사용하는 `@next/env`, Windows SWC는 16.2.12로 맞춘다. PM이 저장소의 의존성 원장과 정상 설치를 같은 묶음으로 반영했으며 실제 세 패키지 버전을 확인했다.

격리 실험은 `next`, `@next/env`, `@next/swc-win32-x64-msvc`만 별도 공식 패키지로 두고 나머지 기존 의존성을 읽기 연결해 비교했다. 실험 결과와 정상 설치 이후의 최종 소스·통합 회귀·실기기 검사는 각각 구분한다.

## 검증 범위와 재실행

후보 16.2.12에서 최적화 생산 빌드·TypeScript·정적 페이지 66개 생성을 통과했다. 외부 요청은 차단하고 새 loopback PostgreSQL의 합성 자료만 사용했다. 지연 폰트 외부 요청 차단과 선택하지 않은 요청 링크의 추가 스키마 누락은 이 격리 실험의 제한이며, 위 6개 화면은 모두 HTTP 200이었다.

```powershell
# 합성 역할 서버 전용. 실제 사이트·외부 발송·저장 요청은 허용하지 않는다.
node scripts/test-navigation-hydration-browser.mjs http://127.0.0.1:4054 1 .tmp/navigation-hydration/browser.json
npx eslint scripts/test-navigation-hydration-browser.mjs
```

스크립트는 문서 전체 이동과 실제 Next Link 클릭을 구분한다. 접힌 메뉴의 링크를 검사할 때도 저장 버튼을 누르지 않는다. 외부 연결과 GET 이외 요청은 차단하고, 합성 계정 표시가 없으면 즉시 실패한다. 오류 메시지를 필터링하거나 `suppressHydrationWarning`을 추가하지 않는다.

## 증거

- 기존 90회: `.tmp/navigation-production/protected-browser-results.json` (생산 빌드 30927cad, Next 16.1.6).
- 계측 120회: `.tmp/navigation-production/instrumented.json` (오류 25회). 이 계측 라운드는 기존 90회와 따로 기록하며 합쳐 통과율을 계산하지 않는다.
- 재실행 위치: `.tmp/navigation-production/instrumented-deep.json` (동일 host 작업의 중복 확인과 자식으로 이동한 커서).
- 공식 패키지 SHA256·의미 비교: `.tmp/navigation-production/package-comparison.json`.
- 후보 90회: `.tmp/navigation-upgrade-results/protected-progress-{390,834,1440}.json`.
- 후보 빌드: `.tmp/navigation-upgrade-results/protected-build.log`.
- 후보 복합 검사 108회: `.tmp/navigation-upgrade-results/document-link.json`.
- 독립 36회: `.tmp/qa-followup/navigation-candidate.json`.
- 실험 요약·패키지 해시·정리 확인: `.tmp/navigation-upgrade-results/summary.json`.

후보 소스는 fc7a900 이후 승인된 선생님 헤더 보완을 포함한다. 기존/후보의 화면·폭·반복수·대기 조건은 같고, 상위 역할 DOM 구조를 바꾸지 않았다. 최초 계측으로 얻은 원인과 정식 패키지 복원 코드가 함께 개선을 뒷받침한다. 후보 검증은 실제 Supabase 세션·실제 기기·운영 자료 검증을 대신하지 않는다.

기존·후보의 전용 서버 4053·4054와 PostgreSQL 55452·55453은 검사 종료 후 중지했고, 초기화 비밀번호 파일과 임시 DB를 삭제했다. PM에게 넘긴 실기기용 개발 서버 4051은 별도 소유이므로 이 정리에 포함하지 않았다.

## 정상 설치 이후 최종 역할 화면 확인

PM이 실제 저장소에 정상 설치한 Next 16.2.12를 사용해 최신 역할 화면을 다시 복사·생산 빌드했다. 최종 빌드에서도 TypeScript와 정적 페이지 66개 생성을 통과했다. 서버는 실기기 검증을 위해 PM에게 단독 양도했으며 이 문서는 실제 기기 통과를 주장하지 않는다.

- 교사·리포트·관련 관리자 화면 27조합에서 HTTP 200, pageerror·가로 넘침 0. 이 중 선생님 역할에 허용하지 않는 `/staff/shuttle` 3폭은 의도대로 `/staff`로 이동했다.
- 세 폭에서 실제 출석 명단과 청구 상세의 100,000원·미납 1건 표시가 일치했다. 정확한 입력과 해시를 확인한 조회 전용 Server Action 2개만 허용했다.
- 관리자 3화면·원래 학부모·교사 화면을 3폭에서 15회 더 검사했다. 관리자 본인 자녀와 원래 학부모 자녀를 별도로 넣고 학부모 화면 6회에서 서로의 학생이 섞이지 않는 것을 확인했다.
- 역할 화면·권한 확인 관련 10개 파일이 저장소와 바이트 단위로 같음을 확인했다. 스냅샷 이후 공개 홈의 `PublicAccountControls` 중복 제거 1파일은 이 기기용 빌드에 포함되지 않으며 PM이 별도로 검증한다.
- 증거: `.tmp/final-device-validation/live-validation-summary.json`, `source-proof.json`, `role-smoke.json`, `protected-build.log`. 조회 전용 Action의 정확한 경로·입력·해시는 같은 폴더의 `handoff.json`에 기록했다.

기기용 서버·격리 DB의 종료와 최종 실기기 결과는 PM이 관리한다. 합성 인증 공급자만 복사본에 넣었으며 실제 권한 검사와 SQL은 원본을 유지했다. 운영 자료나 환경 파일을 복사하지 않았다.
