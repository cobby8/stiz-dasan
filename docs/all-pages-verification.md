# 전체 구현 페이지 검증 현황

2026-10-19. 대상은 현재 로컬 구현본 117개 페이지이며 운영 사이트 배포본과 구분한다. 운영 DB·실제 발송·결제·위치 공유·배포를 실행하지 않았다.

## 결과 요약

117개 페이지 경로를 전수 점검하고, 사용자 승인으로 재현된8개 오류 항목을 보완했다. 로컬 검증 결과이며 푸시·배포하지 않았다.

| 확인 층 | 결과 |
|---|---|
| 경로/코드/빌드 | 117경로 정적·전체 빌드·익명 HTTP 확인 |
| 공개 화면 | 40경로×3폭120조합, 화면 오류·넘침0 |
| 보호/토큰 화면 | 76경로×3폭228조합 조사, 관련84조합 새 페이지 재검증 |
| 업무 흐름 | 사진9/4·기사권한25/13·설정정책28·학부모요청45·모바일탭90 독립검증 |
| 수강료 | 실제 Next/격리DB에서3폭 모두100,000원/미납과 학생별 청구창 일치, 수납요청0 |
| 최종 회귀 | 깨끗한 소스273파일2108/2108, TypeScript 통과 |
| 잔여 | 긴 교사명 헤더, 전환시 React418 원인 추적, 기존 lint674, 실인증·운영동일데이터·실기기 |

수치에는 재검사가 섞여 있으므로 더해 고유 테스트 건수로 사용하지 않는다. 한 경로의 빈 목록/없는 토큰/리다이렉트 검사는 모든 데이터 상태·저장 동작의 검증을 뜻하지 않는다.

## 작업 그룹

| 그룹 | 담당 | 의존 관계 | 완료 기준 |
|---|---|---|---|
| 관리자56 | 관리자 tester | 없음 | 전체 정적 경로·권한·연결과 동작 검사 |
| 학부모·선생님19 | 역할 tester | 없음 | 전체 정적 경로·권한·연결과 동작 검사 |
| 공개·공통42 | 공통 tester | 없음 | 전체 정적 경로·권한·연결과 동작 검사 |
| 통합 | PM | 병렬 결과 | 코드 검사·빌드·미검증 목록·오류 재현 취합 |

## 페이지별 점검 원장

**정적**은 코드·권한·연결 확인이며 실제 렌더·저장 통과를 뜻하지 않는다. **브라우저**도 별도 명시가 없으면 합성 데이터·권한·API를 사용하는 격리 검사다. 테스트 건수와 페이지 수는 합산하지 않는다.

| 경로 | 그룹 | 이번 확인 수준 |
|---|---|---|
| `/` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/about` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/account/activate` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/admin` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/absence` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/annual` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/apply` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 · 모바일 탭 보완 독립90검사 |
| `/admin/attendance` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/attendance/report` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/attendance/report/[sessionId]` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/classes` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/classes/[id]` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/coaches` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/enrollment-changes` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/faq` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/feedback` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/finance` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/finance/billing` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/finance/monthly-ledger` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/finance/monthly-register` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/gallery` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/import` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/kakao-policy` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/kakao-requests` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/makeup` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/media-revocations` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/notices` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/notification-deliveries` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/operations-sync` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/payment-confirmations` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/payment-requests` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/pos-reconcile` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/privacy` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 · 저장/조회실패 독립28검사 |
| `/admin/programs` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/registration-readiness` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/requests` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/schedule` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/seasonal` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/seasonal/absence` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/seasonal/attendance` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/seasonal/dispatch` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/seasonal/shuttle` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/seasonal/shuttle-notice` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/settings` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 · 저장/조회실패 독립28검사 |
| `/admin/shuttle` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/shuttle/regular` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/shuttle/regular-dispatch` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/sms` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/staff` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/staff/recovery` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/stats` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/students` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/students/[id]` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/students/[id]/media-consent` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/terms` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 · 저장/조회실패 독립28검사 |
| `/admin/testimonials` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/trial` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 · 모바일 탭 보완 독립90검사 |
| `/admin/uniform` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/admin/waitlist` | 관리자 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/annual` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/apply` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/apply/enroll` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/apply/trial` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/apply/uniform` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/auth/continue` | 공개·공통 | 정적·빌드·역할별 HTTP 이동 |
| `/driver` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/driver/[token]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 · 실제 운행데이터는 기존 UI91/순서9·위치권한13검사 |
| `/faq` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/gallery` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/invite/[token]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/kakao-connect` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/login` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/mypage` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/mypage/enrollment-change` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 · 통신실패 독립45검사 |
| `/mypage/history` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/mypage/makeup` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/mypage/payments` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 · 통신실패 독립45검사 |
| `/mypage/regular-absence` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/mypage/reports` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/mypage/reports/[sessionId]` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 · 사진 RSC9/Chrome4 |
| `/mypage/seasonal` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/mypage/shuttle` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/notices` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/notices/[id]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/parent-app` | 학부모·선생님 | 정적·빌드·공개 실제Next 3폭 |
| `/payments/[invoiceId]` | 공개·공통 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/payments/cafe24/success` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/payments/fail` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/payments/review/fail` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/payments/review/success` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/payments/success` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/privacy` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/programs` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/programs/order` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/request/[token]` | 공개·공통 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/request/reconfirm/[token]` | 공개·공통 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/schedule` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/seasonal` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/seasonal/[slug]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/seasonal/[slug]/apply` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/setup` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/shop` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/shop/product/[productNo]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/shuttle/location/[token]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/shuttle/regular/[token]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 · 실제 운행데이터는 기존 UI91/순서9·위치권한13검사 |
| `/shuttle/run/[token]` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 · 실제 운행데이터는 기존 UI91/순서9·위치권한13검사 |
| `/signup/parent` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/simulator` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |
| `/staff` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/staff/billing` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/staff/quick-post` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/staff/seasonal` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/staff/sessions/[sessionId]` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 · 담당학생/수강료/청구상세 확인 |
| `/staff/shuttle` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 · INSTRUCTOR 이동/ADMIN 본문 별도 |
| `/staff/students` | 학부모·선생님 | 정적·빌드·합성역할/DB 실제Next 3폭 |
| `/teacher-app` | 학부모·선생님 | 정적·빌드·공개 실제Next 3폭 |
| `/terms` | 공개·공통 | 정적·빌드·공개 실제Next 3폭 |

## 통합 검사와 경계

- `npm run release:code-check`: Prisma 스키마·TypeScript 통과. 회귀2082 중2081 통과/1실패. 실패는 `pos-reconcile-service.test.mjs`의 중복 파일 검사이며 `.claude/worktrees/`에 있는 기존 작업 사본6개를 현재 서비스의 중복 구현으로 세었다. 작업 사본을 삭제하거나 검사 결과를 통과로 바꾸지 않았다.
- `node --experimental-strip-types --test src/lib/studentVisibility.test.ts`: 5/5 통과. 전체 회귀가 실패하면서 실행되지 않은 후속 가드를 별도 실행했다.
- 초기 전체 `src` ESLint849파일: 오류676·경고75. 오류 유형은 기존 `no-explicit-any`652, 효과 안 상태 변경14, 문자열 이스케이프2, 불변성1, 오류 경계6, ref1이다. 이 결과는 출시 품질 통과가 아니다. 불필요한 전역 수정은 하지 않는다.
- 운영 환경 파일을 복사하지 않은 별도 임시 소스에서 실제 `next build --webpack` 성공. 외부 HTTP를 차단하고 DB 주소는 접속 불가능한 loopback 합성 주소로 고정했다. 모든 페이지의 컴파일과 정적 생성 확인이며 인증·실데이터 기능 통과는 아니다. `.tmp/all-pages-audit/build.log`, `build-result.json`.
- 같은 복사본의 실제 Next HTTP 서버에서117경로를 GET: 200응답40, 로그인 등307이동75, DB 조회 실패500응답2. 후자는 `/request/[token]`, `/request/reconfirm/[token]`이며 DB를 의도적으로 연결하지 않은 환경이다. 미존재 토큰을 정상 안내하는지 확인하려면 격리 DB를 추가해야 한다. `.tmp/all-pages-audit/http-smoke.json`.
- 정적 주소 검사에서 미존재 관리자 내부 링크·상대 import0. 공개·공통 연결파일243개의 고정 내부 주소에도 실제 미존재 목적지는 발견하지 못했다. 동적 주소·권한 통과 후 결과까지 보장하지 않는다.
- 정규 명단·확정 배차 페이지는 SSR 진입에서 `ensureRegularRosterMonths`를 호출할 수 있다. 단순 운영 화면 조회도 DB 쓰기로 이어질 수 있어 이번에는 운영 브라우징을 하지 않았다.

- 별도 소스 복사본에 필요한 문서·스킬·스크립트와 최신 승인 코드를 포함해 전체 회귀를 재실행: 273파일2108/2108 통과. 기존 작업 사본은 수정·삭제하지 않았다. `.tmp/all-pages-audit/clean-tests.log`, `clean-tests-result.json`. 실제 RSC9검사는 상위 검사1건에서 별도 실행되므로 총 건수에 중복 합산하지 않는다.
- 공개 HTTP200 페이지40개를 실제 Next+Chrome에서390/834/1440으로 검사: 120조합에서 가로 넘침·pageerror·hydration오류·U+FFFD·버튼 내부 잘림0. 아래쪽 스크롤까지 보강해 재검증했다. 당시 기준2b57dbba이며 승인 수정본은 별도 검사한다. 외부 폰트·이미지·API와 POST는 차단한 환경이다.

- 최종 전체 `src` ESLint850파일은 오류674·경고75. 초기676에서 기존 any오류2개를 줄였으며 새 생산 코드 오류를 추가하지 않았다. 신규 검사 도구의 변수명 규칙 오류도 정리해 관련 lint와 RSC9/정책25 재검증을 통과했다. 전체 기존674오류를 해결한 것은 아니다.
- 승인 오류 수정 생산본은 로컬 커밋 `30927cad`다. 푸시·배포하지 않았다.

## 재현한 결함과 처리 상태

| 항목 | 재현과 영향 | 상태 |
|---|---|---|
| 사진 있는 학부모 리포트 | 서버 JSX의 img onError가 실제 RSC 직렬화 실패. 문자열/객체 사진도 혼재 | 사용자 승인 후 수정·독립 RSC9/Chrome4 통과 |
| 기사 웹 GPS | 실제 헤더의 geolocation=() 때문에 권한을 허용해도3기사경로 모두 실패 | 사용자 승인 후 단일토큰3경로만 self 허용. 단위25/Chrome13 독립통과, 기존 staff정책4도 통과 |
| 관리자 기본설정 | 저장 응답 전에 완료 표시. 실패 시도 중 완료가 보임 | 수정·실제 Tiptap 포함 독립 Chrome28/28 통과 |
| 개인정보·약관 | 조회503 이후 기본문구/빈문구로 대체·저장 가능 | SSR page→props 실패 전달까지 수정·위28검사에 포함 |
| 학부모 입금 알림·수강 변경 | 실제 Chrome에서 fetch 거부 시 main0/body빈화면, 입력 소실 | 추가 승인 후 수정·독립 Chrome45/45, 기존 규칙41/41 통과 |

추가 읽기 점검 항목은 확정 재현 결함과 구분한다.

- 학부모 홈은 정식 자녀0명일 때 특강만 신청한 자녀 조회보다 먼저 반환한다. 해당 가족 fixture를 사용하는 후속 행동 검증 필요.
- 보강 화면은 UTC 날짜, 서버는 한국 날짜로 만료를 판단한다. 한국 자정~오전9시의 만료권 표시와 실제 거절을 대조해야 한다.
- 학부모·선생님 manifest의 짙은 배경·네온색·세로 고정은 라이트 라벤더·가로 화면 요구와 다르다. 설치 앱의 실제 시작/회전은 별도 실기기 확인이 필요하다.
- `/auth/continue` 오류 재시도 링크는 기존 redirect/context를 보존하지 않는다. 청구서 진입 복귀 흐름 검증 필요.
- 초대·요청 토큰 경로의 검색 제외 방어는 추가 점검 대상이다. 실제 노출을 확인한 것은 아니다. 기사3경로는 이번 수정에 noindex/no-referrer를 포함했다.
- `/setup` 조회 실패 시 설정 폼이 보이지만 서버 생성은 차단한다. 권한 우회가 아닌 오류 안내 불일치다.
- FAQ 저장/삭제 예외 및 결석 저장 후 재조회 실패는 후속 실패 경로 검사 대상이다.

## 보호 화면의 실제 DB 검증

별도 복사본에 전체 Prisma 스키마와 합성 ADMIN/INSTRUCTOR/PARENT·학생·반·수업을 구성했다. Supabase provider만 복사본에서 합성 응답으로 대체하고 실제 auth-guard·역할 SQL·페이지 코드는 보존했다. 운영 인증·세션 검증을 대신하지 않는다.

- 관리자56·선생7·학부모10 경로와 신청 토큰2·없는 청구서1 경로를390/834/1440으로 실제 Next+Chrome 렌더: 76경로228조합. 빈 표·유효하지 않은 링크·리다이렉트도 각각 구분했다. `.tmp/all-pages-audit/protected-browser-results.json`.
- 최초 시험 DB에 Coach 연결과 일부 정본 스키마가 빠져 수업 본문 및 신청 링크가 실패했다. Coach를 연결하고 선행 열을 대조한 뒤 `20260828090000_complete_operations_sync_infrastructure/migration.sql` 정본을 소유 DB에만 적용했다. 원본 운영 스키마 상태를 점검한 결과가 아니다.
- 새 browser page를 URL마다 분리하여 관련28경로×3=84조합 재검증: HTTP84/84=200, pageerror/문자 깨짐0. 교사 홈의 담당반1·학생1, 두 신청 링크·없는 청구서의 안전 안내, auth/continue→mypage307을 확인했다. `.tmp/all-pages-audit/protected-browser-retest-results.json`, `protected-retest-schema-proof.json`.
- 첫 연속 검사에서 React418 회복 경고17건과 이동 중단이 있었고 새 페이지를 쓰는84검사에서는 재현되지 않았다. 원인을 코드 수준에서 확정하지 않았으므로 전환 조건의 추가 추적 항목으로 남긴다.
- 같은 재검사에서 errorScreen3개는 /admin/media-revocations의 SocialPostDraft 시험 테이블 누락이었다. 소유 DB에 원본 ensureSocialPostDraftTable 함수의 정본을 적용한 후3폭 모두 오류가 사라졌다. 운영 테이블 상태를 확인한 것이 아니다.
- 확정된 제품 레이아웃 문제는 /admin/apply와 같은 화면으로 이동하는 /admin/trial의390px 탭 넘침(415px) 한 원인이다. 사용자 추가 승인으로 한 줄·내부 가로 스크롤·44px 버튼으로 수정했고 실제 AdminShell/AcademyTheme/원본 CSS·폰트를 적용한320/360/390/834/1440 90/90 및 독립90/90 통과. 메뉴/숫자/선택/초점 유지, 페이지 넘침0. `.tmp/apply-tabs/browser.json`. 원본 하위 패널은 격리한 검사다.

## 선생님 수강료·청구 상세 최종 검증

- 원본 staff-billing의 loadStaffSessionMonthlyFees/loadStaffAttendanceBilling과 하위 SQL이 읽기인지 확인한 뒤, 실제 빌드 Action 이름→식별자·loopback URL·합성 session/student ID가 맞는2개 Action만 POST를 허용했다. 다른 POST/외부 요청은 계속 차단했다. 읽기 요청은6회였다.
- 390/834/1440 모두 담당반/학생, 출석 명단100,000원·미납, 학생별 청구창의 동일금액/미납1건을 확인했다. 수납확인 요청0건, Payment PENDING·Invoice ISSUED 유지. `.tmp/all-pages-audit/protected-teacher-fees-results.json`.
- 이 마지막 묶음은27조합 중24측정이며3개는 INSTRUCTOR의 staff/shuttle 정상 역할 이동 중 중단이다. 기존 독립 검사의 최종경로 /staff와 ADMIN 별도3폭 본문을 확인했으므로 페이지 장애로 세지 않는다. 이27건을 ‘전부 통과’로 표기하지 않는다.
- 합성 DB/서버/비밀 파일 정리와4020/55437 포트 반환을 확인했다. 종합 `.tmp/all-pages-audit/public-protected-validation-summary.json`.

## 남은 검증과 개선 순서

1. 긴 교사명에서390px 헤더 역할 문구가 세로로 갈라지는 스트레스 조건: 소스/캡처 확인, 이번 승인 범위 밖으로 수정하지 않았다. 선생님 공통 헤더 반응형 보완 후보다.
2. 최초 연속 진입의 React418은 독립84조합에서 재현되지 않았다. 원인을 확정하지 않았으므로 빠른 화면 전환 조건을 추가 추적한다.
3. 앞서 적은 특강만 신청한 자녀/한국 날짜 경계/설치 manifest와 인증 복귀 등 추가 후보를 실제 상태별로 검증한다.
4. 기존 lint674개는 별도 품질 정리 대상이다. 대부분 any 유형이지만 훅/렌더 규칙 오류도 있어 모두 무해하다고 판정하지 않는다.
5. 실제 Supabase 로그인/세션 만료·운영과 같은 데이터/스키마·전체 모달/저장/외부 전달·물리기기 Safari/Android·설치앱을 검증해야 한다. 이번 합성 계정은 이를 대체하지 않는다. 운영 SSR 자동 쓰기 경로는 실행 직전 승인 없이 열지 않는다.

현재 결과는117경로의 로컬 전수 점검과 승인된 오류 수정 완료다. 모든 데이터 조합/외부 전달/출시 검증 완료가 아니며 배포 승인은 받지 않았다.
