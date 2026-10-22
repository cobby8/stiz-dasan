## 2026-09-04 사이트 월 운영 장부

## 2026-10-22 공개 게시일·신청·이동 표시
- 공개 게시일과 수강 월 표시의 새 순수 함수는 유일한 날짜 창구인 `lib/datetime/kst.ts`의 `formatKstDate`·`kstMonthLabels`를 사용한다. 기존 날짜 저장/계산 함수는 그대로다.
- `apply/trial/trialScheduleSelection.ts`는 공개 폼이 받은 슬롯만으로 날짜·요일·교시·과거일·마감을 검사한다. UI 단계/기존 신청 로드/제출 전 검사에 공유하며 서버 접수 정책은 변경하지 않는다.
- `auth-entry-navigation.ts`는 로그인/가입 UI 링크에 필요한 내부 복귀/신청 연결 정보만 재구성한다. `navigation/publicHistory.ts`는 공개 경로의 이전 동출처 항목 읽기와 부모 경로 대체만 담당한다. 인증·역할별 접근·설치 앱 범위는 기존 모듈이 유지한다.

## 2026-10-22 공개 일정 표시 계층
- 연간 일정은 `AnnualEventsClient`가 연도/월 선택을 관리하고 `annualPeriod.ts`가 한국 현재 월을 계산한다. `annual-months.css`는 공개 스포츠 영역만 꾸민다. 공식 수강월 매핑·기존 서버 조회·상세창은 유지한다.
- 특강의 날짜 정규화·공개 상태 표시는 `components/seasonal/types.ts`로 공유한다. 목록·상세·신청은 같은 표시 기준을 사용하며 서버의 모집/가격/접수 판단은 변경하지 않는다.

## 2026-10-21 공개 홈페이지 스포츠 스타일 경계
- `src/lib/public-site-path.ts`는 공개 안내·상세·신청·공개 로그인/설치 경로를 선택한다. `PublicSiteTheme`와 `public-sport.css`는 공개 렌더링에만 공통 토큰·간격·헤더/푸터 규격을 적용한다.
- 홈은 `LandingPageClient` + `landing/public-home.css`이며 기존 설정·공지·갤러리·후기를 그대로 받는다. 개별 공개 페이지는 공통 hero/content/card/form 클래스로 정리한다.
- `ThemeProvider`는 공개 저장 키와 라이트 기본값을 분리하되, `/admin`, `/staff`, `/mypage`, `/driver` 업무 화면의 기존 테마 경계는 유지한다. QA 전용 재구성 DB·차단 프록시는 `.tmp` 소유 실행기이며 제품 소스에 포함하지 않는다.

## 2026-10-19: 기사 통합 운행 화면 정리
- UnifiedDriverClient 한 파일에서 헤더 시작/종료·날짜 단일화·정차 순서/시각·학생 체크 행을 정리했다. 공용 DriverDateNav/GpsShareBar·저장 API/키·GPS hook은 그대로다.
- 화면 전용 checkSummary는 중복 승객 키·정규 사전결석을 제외하고 확인된 최종 기록만 센다. 실제 운행 위치·차량 진행 완료는 추정하지 않는다. 독립 검증과 상세 경계는 docs/driver-workspace-ux.md.

## 2026-10-19: 안드로이드 기사 위치 검증본
- apps/driver-android는 Java WebView와 별도 location foreground service, AndroidKeyStore 암호화 저장, Gradle wrapper와 오프라인 runtime 검사를 포함한다. nativeDriverGps→useGpsShare는 origin-bound 메시지를 받고 화면 해제 때 native 수집을 끄지 않는다. 기존 웹 controller는 보존한다.
- /api/driver/mobile/session은 기본 비활성이다. DriverMobileTrackingSession 수동 SQL에 단일 활성 세션·만료·비밀 해시·전송 순서·측정/접수 시각을 저장하고 DriverLocation 최신 행을 갱신한다. legacy 위치는 같은 운행 잠금에 참여한다. 운영 SQL/env 적용 없음.
- 기존 정규 토큰은 ROLLING×REGULAR 공용 하나이며 현재 1대 운행이라고 사용자가 확인했다. token당 한 기기로 진행하며 여러 차량 증차 시 별도 자격 범위가 필요하다. 업턴랩스 출시 주체 확인, 실제 폰/스토어 접근 미확인.

## 2026-10-19: USB 실기기 시험 연결
- driver-device-test-server.mjs는 원본 React화면/native adapter/API/Prisma와 loopback HTTPS8443·새 PG55435를 연결한다. 실제 좌표는 최신 한 행만 받으며 관리키로 보호된 상태 요약은 좌표/비밀/기기ID를 제외한다. 실행·준비·조회 CLI가 분리되고 소유 DB/개인키 정리를 확인한다.
- stizDeviceTest=true+localhost:8443+공개CA 디렉터리인 debug에서만 별도 패키지 kr.stiz.driver.devicetest와 localhost 신뢰를 생성한다. release는 운영주소443, CA/별도패키지 미포함. 443 reverse가 기기 권한상 불가해 보안 우회 없이 비특권 포트로 분리했다.

## 2026-10-19: 교사 출석 명단의 금액 조회
- staff-monthly-fees.ts와 순수 policy/types가 세션 권한·로스터·당월 Payment/Invoice·확정 월수강대장·특강 좌석 근거를 묶는다. staff-billing.ts에 읽기 액션 2개만 추가했다.
- SessionInProgressClient에서 출결과 독립적으로 요약을 읽고 실제 ClassBillingSheet로 연결한다. StaffMonthlyFeeSummary는 총청구액/순수수강료/특강기간을 구분한다. 상세 최신값은 해당 명단 행에 반영한다. 새 스키마·운영 DDL·쓰기 함수 변경 없음.

## 2026-10-19: 선생님 수업 화면 구성
- StaffHomeClient는 현재·다음 수업/남은 수업/접힌 완료 목록을 나누고 각 수업의 준비·관리 도구를 접는다.
- SessionInProgressClient는 단일 출결 요약, 접힌 보조 관리, 실제 사진·메모 입력, 종료 바를 유지한다. 출석 명단은 하나의 컨테이너이며 데이터·액션·고정 메뉴 구조는 불변이다.

## 2026-10-19: 학부모 홈 정보 배치
- MyPageClient에서 자녀 선택·다음 수업·오늘 셔틀·통합 요청 메뉴·실제 청구·알림을 우선 배치한다. 셔틀 배정/수강·출결·수납/결석·보강/피드백 상세는 기본 접기이며 해시 진입이 상위 접기를 연다.
- page.tsx·layout·하단 탐색·API·조회·저장 구조는 변경하지 않았다.

## 2026-10-19: 관리자 화면 구성
- AdminDashboardClient는 요청·오늘 수업을 우선 렌더링하고 운영 현황·관리 도구를 접는다. AdminShellClient는 주요 6메뉴·보조 2그룹으로 기존 주소를 유지한다. API·저장 구조 변경 없음.

- `/admin/finance/monthly-register` 및 동명 관리자 API는 학생·월 단일 봉투에 반별 금액/기간/근거를 JSON으로 보존한다. 월 셔틀비는 봉투당 하나이며 기존 Payment/Enrollment에는 쓰지 않는다.
- `MonthlyEnrollmentRegister`와 `MonthlyEnrollmentRegisterRevision`은 현재 버전과 전체 변경 스냅샷을 분리한다. 학생 행 잠금·장부 버전 비교·감사 동일 거래로 중복/덮어쓰기를 차단한다.
- 공용 순수 모델과 서비스·API·화면을 분리하고 관리자 DB 역할 인증, 같은 사이트 요청, 실제 128KiB 상한, READ ONLY 조회 및 no-store를 적용한다. 저장 설정은 기본 off다.
- SQL 구조 파일과 실제 UI/API/서비스/격리 PostgreSQL 연결 검증을 갖췄다. `tests/helpers/monthly-register-api-db-harness.mjs`가 실제 DB 역할 검사와 합성 인증 응답을 연결한다. 전체 운영 스키마·Supabase 로그인·배포는 별도다. 운영 준비·남은 범위: `docs/monthly-register-operations.md`.

## 2026-09-04 월별·반별 장부 점검
- `/admin/finance/monthly-ledger`는 관리자 전용 읽기 화면이며 수납/청구 화면에서 연결된다.
- `/api/admin/finance/monthly-ledger?month=YYYY-MM`는 관리자 인증 뒤 RepeatableRead + READ ONLY 거래로 현재 수강/지정월 Payment만 읽는다. 각각 5,000건 초과면 부분 합계를 반환하지 않는다. 개인정보 응답은 no-store, 연락처/생년월일/결제키는 SELECT하지 않는다.
- `billing/monthly-class-ledger.ts`는 무입출력 계산 모델이며 미지정 반·과거 청구를 보존하고 취소/미확정/이상 금액을 분리한다. 영구 월 원장 쓰기·청구 생성·알림은 없는 점검 단계다.

## 2026-09-04 입학 점검 및 문의 입구
- `/admin/registration-readiness`는 관리자 인증 후 최근 승인 100건의 반 배정 및 외부 완료 근거를 읽기 전용으로 표시한다. `/admin/apply`에서 연결한다.
- `kakao-guest-entry.ts`는 공개 체험·수강신청 안내만 제공하며 기존 학생 데이터 접수는 인증 후 처리한다.
- 수강변경 적용 크론의 결과는 HELD Operations 원장으로 연결한다. `finalize-change-sync.ts`는 휴원/퇴원의 삼중 검증 후 원 신청 확정을 같은 거래로 수행하며, 반 변경 전용 어댑터는 후속 대상이다.

## 2026-08-29 Codex 공용 운영 인수인계 구조
- 저장소 루트 `AGENTS.md`는 모든 Codex가 먼저 읽는 고정 작업·승인·보안 규칙이다.
- `.agents/skills/stiz-monthly-billing/`은 개인 PC에 종속되지 않는 시트·Rallyz·사이트 3중 동기화 절차다.
- `.Codex/HANDOFF.md`는 실행기·예약·승인 대기·재개 지점, `scratchpad.md`는 개발 작업, `knowledge/`는 장기 지식을 맡는다.
- `docs/codex-handoff-setup.md`는 새 운영 PC 준비와 단일 `ACTIVE` 실행기 교대 절차를 설명한다.

## 2026-08-31 유니폼 본사 주문 연동 구조
- 공개 신청 경로는 `/apply/uniform`이며, 형제·자매 학생 여러 명을 한 신청서로 접수한다.
- `src/app/actions/uniform.ts`가 공개 접수와 관리자 재전송 서버 액션을 담당한다.
- `src/lib/uniform-partner.ts`는 STIZ 본사 주문 payload, 정규 JSON, HMAC-SHA256 서명, 서버간 POST를 담당한다.
- `src/lib/uniform-order-service.ts`는 `UniformOrder`·`UniformOrderItem` 저장, 중복 제출 방지, 전송 상태, 재시도 대기를 관리한다.
- 관리자 경로 `/admin/uniform`은 Google Sheets 원본이 아니라 DB 원장과 본사 접수 상태를 보여준다.
- `scripts/uniform-order-db-preflight.mjs`는 Vercel 빌드와 릴리스 검사에서 유니폼 주문 테이블, 고유키, RLS, anon/authenticated 직접 권한 차단을 읽기 전용으로 확인한다.

## 2026-07-11 관리자 초기 payload 메모
- `src/lib/adminReadPayloads.ts`는 수강생/반/체험 CRM의 캐시된 읽기 payload를 제공하며, API route와 서버 페이지가 같은 캐시 키와 태그를 공유한다.
- `/admin/students`, `/admin/classes`, `/admin/trial`은 페이지 서버 렌더링에서 초기 데이터를 받아 클라이언트 컴포넌트에 넘기고, 초기 데이터가 있을 때 첫 `useEffect` API 재호출을 건너뛴다.
- 저장/삭제/상태 변경 이후에는 기존 API 재조회와 Server Action의 `revalidateTag`가 함께 동작해 화면 갱신과 캐시 무효화를 유지한다.

## 2026-07-11 관리자 대시보드 속도 메모
- `/api/admin/dashboard`는 관리자 권한 확인 후 15초 `unstable_cache`로 동일한 읽기 결과를 짧게 재사용한다.
- `/api/admin/dashboard/system`은 5분 서버 캐시를 쓰며, `/admin` 첫 진입에서는 자동 호출하지 않고 시스템 상태 카드의 확인 버튼으로만 조회한다.
- 관리자 공통 알림은 첫 렌더/idle 자동 조회와 120초 폴링을 하지 않고, 알림 버튼을 열 때만 `/api/admin/notifications`를 호출한다.

## 2026-07-11 관리자 공통 읽기 캐시 메모
- `/api/admin/schedule`은 외부 Google Sheets를 직접 fetch하지 않고, 동기화 작업이 저장해 둔 `SheetSlotCache` 슬롯을 읽는다.
- 학생 선택 목록, 코치 선택 목록, 학원 설정, 신규 체험 카운트처럼 여러 관리자 화면에서 반복 호출되는 API는 권한 확인 후 짧은 private/server cache를 사용한다.
- 관리자 클라이언트에서 같은 API를 부를 때 `cache: "no-store"`를 남발하지 않는다. 문 앞에서 신분 확인은 매번 하되, 안쪽 서류 묶음은 몇 초 재사용하는 구조다.

## 2026-07-11 시간표 동기화 메모
- Google Sheets 시간표는 자동 cron으로 매번 맞추지 않고, 관리자 시간표의 “지금 동기화” 버튼을 눌렀을 때만 외부 시트를 읽어 `SheetSlotCache`에 저장한다.
- 공개 `/schedule`, `/simulator`, 관리자 `/admin/schedule`은 모두 Google Sheets를 직접 기다리지 않고 DB에 저장된 캐시만 읽는다.
- `/api/cron/sync-schedule`은 예비 엔드포인트로 남겨 두되, `vercel.json` cron 등록은 제거해 기본 운영을 수동 동기화로 둔다.

## 2026-07-11 수납/통계 속도 메모
- `/api/admin/finance`는 관리자 권한 확인 후 월별 수납 목록/요약을 30초 캐시한다.
- `/api/admin/stats`는 운영 통계 묶음을 60초 캐시한다.
- 수납 생성/상태 변경/삭제/월별 청구서 생성/미납 알림 후에는 `admin-finance`, `admin-stats` 태그를 즉시 무효화한다.
- 월별 수납 조건은 `EXTRACT(YEAR/MONTH FROM dueDate)` 대신 `dueDate >= 월 시작 AND dueDate < 다음 달 시작` 범위 조건을 쓴다.

# Architecture

## 2026-10-19: 저장·전달 결과 확인 계층
- `parent-staff-status.ts`는 학생·수신자별 채널 결과를 요약한다. 부모 셔틀 GET은 소유 자녀만, 교사 공지 작업 조회는 작성자·담당 반만 허용한다. 기존 Notice ID·NotificationDelivery를 재사용한다.
- 기사 `driverStatusRead/driverStatusClient`는 기존 정규·특강 저장 경로를 유지한 POST→GET 대조를 제공한다. `driverGpsController`는 위치 수집과 전송·중단 응답을 분리한다.
- `admin-delivery-status.ts`는 기존 내부 결석·셔틀 장부의 안정 사건·수신자 키로 채널을 묶는다. 일반 문의는 별도 관리자 재조회 액션이며 실제 출결·배차 변경을 수행하지 않는다.

## 스태프/기사 모바일 역할 구조 (2026-07-21)
- `Role.DRIVER`는 셔틀 기사 전용 스태프 역할이다. 로그인 후 기본 이동 경로는 `/staff/shuttle`이며, 코치/강사는 기존 `/staff` 수업 홈을 유지한다.
- 스태프 초대는 코치/강사(`INSTRUCTOR`)와 셔틀 기사(`DRIVER`) 모두 개인 초대 링크와 휴대폰 OTP 기반 가입 흐름을 사용한다.
- `/staff` 레이아웃은 로그인한 DB 역할을 기준으로 하단 메뉴를 다르게 보여준다. 기사에게는 셔틀 메뉴만, 관리자/부관리자에게는 수업 메뉴와 셔틀 메뉴를 함께 보여준다.
- `ShuttleRoutePlan.driverUserId`가 `User(role=DRIVER)`와 연결된다. 관리자 셔틀 화면에서 노선 생성/초안 수정 시 담당 기사를 배정하고, 확정 전 차량·기사·학생 배정을 모두 확인한다.
- `/staff/shuttle`은 로그인한 기사 본인에게 배정된 확정 노선의 정류장 순서, 학생 목록, 지도 열기 링크를 보여준다. 탑승/하차 체크와 학부모 알림은 다음 단계에서 붙인다.

## 교사용 앱 배포 링크 (2026-07-15)
- 선생님에게 공유하는 공용 주소는 `/staff/install`이며 공개 설치 화면 `/teacher-app`을 rewrite로 렌더링한다.
- Android는 `beforeinstallprompt`가 제공될 때 사용자 버튼 한 번으로 시스템 설치창을 열고, iPhone/iPad는 Safari의 홈 화면 추가 절차를 안내한다.
- 신규 선생님의 개인 초대 링크는 가입만 담당하고, 가입 완료 뒤 토큰 없는 공용 설치 링크로 이동한다.
- 설치 후 시작 주소는 `/staff`이고 미인증 사용자는 PWA 범위 안의 `/staff/login`을 거친다.
- 설치 안내와 내부 구현 주소는 no-store·noindex이며 카메라와 마이크 권한을 허용하지 않는다.

## 교사용 설치 앱 진입 구조 (2026-07-15)
- 공식 진입점은 `/staff`, 전용 로그인 주소는 `/staff/login`이다.
- `/staff/login`은 공용 로그인 구현을 재사용하되 주소는 PWA 범위 안에 유지한다.
- 초대 가입을 마친 선생님과 공개 헤더의 선생님 계정은 교사용 진입 흐름으로 연결된다.
- `manifest-staff.json`은 `/staff` 범위의 독립 설치 앱을 정의하고 오늘 수업·학생·청구 바로가기를 제공한다.
- 교사용 화면과 API는 개인정보 보호를 위해 서비스 워커에 저장하지 않고 네트워크에서만 읽는다.
- 카메라와 마이크 권한은 `/staff` 및 `/api/staff`에만 허용하며 다른 화면에서는 차단한다.

## 프로젝트 성격
STIZ 농구교실 다산점의 홈페이지와 학원관리 플랫폼이다. 일반 쇼핑몰의 상품/장바구니/주문 구조가 아니라, 수업 신청과 학원 운영을 중심으로 구성되어 있다.

## 기술 스택
- Next.js 16 App Router
- React 19
- TypeScript
- Prisma 5
- Supabase PostgreSQL/Auth/Storage
- Tailwind CSS 4
- Vercel 배포와 Cron

## 주요 영역
- 공개 홈페이지: `/`, `/about`, `/programs`, `/schedule`, `/annual`, `/gallery`, `/notices`, `/faq`, `/apply`
- 학부모 영역: `/mypage`, `/mypage/reports`, `/mypage/skills`
- 관리자 영역: 사이트 콘텐츠, 학원 운영, 학생/출결/결제/SMS/스태프 관리
- 스태프 빠른 업로드: `/staff/quick-post`

## 관리자 레이아웃
- 관리자 공통 레이아웃은 `/admin/layout.tsx`에서 제어한다.
- 데스크톱은 왼쪽 고정 사이드바와 `md:ml-64` 본문 구조를 사용한다.
- 모바일은 상단 헤더의 메뉴 버튼으로 슬라이드 사이드바를 열고, 본문은 전체 화면 폭을 사용한다.
- 관리자 공통 셸은 운영 화면에서 DB 구조 변경이나 인덱스 생성 작업을 자동 실행하지 않는다. 인덱스/DDL은 배포 전 마이그레이션이나 별도 관리 작업으로 처리한다.
- 관리자 인증 확인은 Supabase `getClaims()`를 먼저 사용하고, 관리자/스태프 role 조회는 짧은 서버 메모리 캐시로 반복 DB 조회를 줄인다.
- 관리자 공통 셸은 알림을 클릭할 때만 조회하고, 체험 신청 배지를 위한 `trial-count` 자동 조회는 하지 않는다.
- `/admin` 첫 진입의 사이드바 기본 탭은 사이트이며, 사이트 운영 점검 봇은 대시보드 카드에서 수동으로 `POST /api/admin/site-ops-bot`를 호출하거나 Vercel Cron이 매일 KST 새벽 2시에 `GET /api/cron/site-ops-bot`를 호출한다.
- 사이트 운영 점검 봇은 `src/lib/siteOpsBot.ts`에서 DB 연결, 기본 설정, 공개 콘텐츠, 시간표, 신청 링크, 백업 저장소, 인스타 자동 게시 설정/대기열을 확인한다. 안전한 누락 항목은 자동 조치하고, 수동 확인이 필요한 항목은 `Notification`의 `SITE_OPS` 타입으로 관리자/부관리자에게 남긴다.
- 관리자 대시보드 `/admin`은 서버 렌더에서 통계 DB 조회를 직접 기다리지 않고 `/api/admin/dashboard`와 `/api/admin/dashboard/system`을 클라이언트에서 호출해 채운다.
- 학생 관리 `/admin/students`는 서버 렌더에서 학생/반 목록을 기다리지 않고 `/api/admin/students`를 클라이언트에서 호출해 채우며, 학생 목록 API는 Enrollment를 CTE로 한 번에 집계해 학생별 반복 subquery를 피한다. API 응답은 60초 서버 캐시를 쓰고 학생/수강 변경 시 태그를 무효화한다.
- 학생 상세 `/admin/students/[id]`는 현재 수강/출결/수납과 별도로 최신 완료 수강생 이관 배치의 `StudentRegistrationLedger`를 월별로 집계해 개인별 수강/결제/셔틀 히스토리를 보여준다.
- 운영 통계 `/admin/stats`도 서버 렌더에서 7개 집계를 기다리지 않고 `/api/admin/stats`를 클라이언트에서 호출해 채운다.
- 체험수업 CRM `/admin/trial`은 서버 렌더에서 리드/통계를 기다리지 않고 `/api/admin/trial`을 클라이언트에서 호출해 채운다.
- 스태프 관리 `/admin/staff`는 서버 렌더에서 스태프/코치/초대 목록을 기다리지 않고 `/api/admin/staff`를 클라이언트에서 호출해 채운다.
- 대기자 관리 `/admin/waitlist`는 서버 렌더에서 대기자/정원/반 목록을 기다리지 않고 `/api/admin/waitlist`를 클라이언트에서 호출해 채운다.
- 수강 신청 관리 `/admin/apply`는 서버 렌더에서 신청/통계/반 목록을 기다리지 않고 `/api/admin/apply`를 클라이언트에서 호출하며, 안내 설정은 설정 탭 진입 시 `/api/admin/apply/settings`로 별도 조회한다.
- 수납 관리 `/admin/finance`는 서버 렌더에서 결제 목록/요약을 기다리지 않고 `/api/admin/finance`를 클라이언트에서 호출해 채운다.
- 보강 관리 `/admin/makeup`은 서버 렌더에서 보강 예약/반 목록을 기다리지 않고 `/api/admin/makeup`을 클라이언트에서 호출해 채운다.
- 수업 리포트 목록 `/admin/attendance/report`는 서버 렌더에서 최근 수업 리포트 목록을 기다리지 않고 `/api/admin/attendance/report`를 클라이언트에서 호출해 채운다.
- 시간표 관리 `/admin/schedule`은 서버 렌더에서 설정/시간표 override/코치/직접 슬롯/프로그램/외부 Google Sheets를 기다리지 않고, `/api/admin/schedule`이 `SheetSlotCache`에 동기화된 슬롯을 읽어 클라이언트에서 채운다.
- 청구 템플릿 `/admin/finance/billing`은 서버 렌더에서 청구 템플릿/프로그램 목록을 기다리지 않고 `/api/admin/finance/billing`을 클라이언트에서 호출해 채운다.
- 프로그램/코치/FAQ/연간일정/SMS 템플릿/청구 템플릿 관리자 읽기 API는 권한 확인 후 60초 서버 캐시를 사용하고, 관련 저장/삭제/순서변경 액션에서 태그 캐시를 즉시 무효화한다.
- 반/체험/수강신청/대기자/보강 관리자 읽기 API도 권한 확인 후 30~60초 서버 캐시를 사용하고, 관련 저장 액션에서 태그 캐시를 즉시 무효화한다.
- 스킬 트래킹 `/admin/skills`는 서버 렌더에서 스킬 카테고리 목록을 기다리지 않고 `/api/admin/skills`를 클라이언트에서 호출해 채운다.
- 반 관리 `/admin/classes`는 서버 렌더에서 프로그램/반 목록을 기다리지 않고 `/api/admin/classes`를 클라이언트에서 호출해 채운다.
- 코치 관리 `/admin/coaches`는 서버 렌더에서 코치 목록을 기다리지 않고 `/api/admin/coaches`를 클라이언트에서 호출해 채운다.
- 연간일정 관리 `/admin/annual`은 서버 렌더에서 일정/ICS 설정을 기다리지 않고 `/api/admin/annual`을 클라이언트에서 호출해 채운다.
- 후기 관리 `/admin/testimonials`는 서버 렌더에서 후기/네이버 링크를 기다리지 않고 `/api/admin/testimonials`를 클라이언트에서 호출해 채운다.
- FAQ 관리 `/admin/faq`는 서버 렌더에서 FAQ 목록을 기다리지 않고 `/api/admin/faq`를 클라이언트에서 호출해 채운다.
- 출석 관리 `/admin/attendance`는 서버 렌더에서 반 목록을 기다리지 않고 `/api/admin/attendance`를 클라이언트에서 호출해 채우며, 같은 API가 선택 반/날짜 출석 조회도 처리한다.
- 공지 관리 `/admin/notices`는 서버 렌더에서 공지/반 목록을 기다리지 않고 `/api/admin/notices`를 클라이언트에서 호출해 채운다.
- 프로그램 관리 `/admin/programs`는 서버 렌더에서 프로그램 목록을 기다리지 않고 `/api/admin/programs`를 클라이언트에서 호출해 채운다.
- 요청 관리 `/admin/requests`는 서버 렌더에서 학부모 요청 목록을 기다리지 않고 `/api/admin/requests`를 클라이언트에서 호출해 채운다.
- 갤러리 관리 `/admin/gallery`는 서버 렌더에서 갤러리/반/인스타 설정/소셜 초안을 기다리지 않고 `/api/admin/gallery`를 클라이언트에서 호출해 채운다.
- 피드백 관리 `/admin/feedback`은 서버 렌더에서 피드백 목록을 기다리지 않고 `/api/admin/feedback`을 클라이언트에서 호출해 채운다.
- SMS 템플릿 `/admin/sms/templates`는 서버 렌더에서 템플릿 조회/보장 작업을 기다리지 않고 `/api/admin/sms/templates`를 클라이언트에서 호출해 채운다.
- 학원 설정 `/admin/settings`는 서버 렌더에서 학원 설정 조회를 기다리지 않고 `/api/admin/settings`를 클라이언트에서 호출해 채운다.
- 개인정보처리방침 `/admin/privacy`는 서버 렌더에서 개인정보 설정 조회를 기다리지 않고 `/api/admin/settings`를 클라이언트에서 호출해 채운다.
- 이용약관 `/admin/terms`는 서버 렌더에서 이용약관 설정 조회를 기다리지 않고 `/api/admin/settings`를 클라이언트에서 호출해 채운다.
- 리포트 상세 편집 `/admin/attendance/report/[sessionId]`는 서버 렌더에서 리포트/코치 조회를 기다리지 않고 `/api/admin/attendance/report/[sessionId]`를 클라이언트에서 호출해 채운다.

## 주요 데이터 모델
- 사용자/권한: `User`, `StaffInvitation`, `Role`
- 학생/보호자: `Student`, `Guardian`, `Enrollment`
- 수업 운영: `Program`, `Class`, `Session`, `Attendance`, `StudentSessionNote`
- 홈페이지 콘텐츠: `AcademySettings`, `Coach`, `AnnualEvent`, `GalleryPost`, `Notice`, `Faq`, `Testimonial`
- 인스타 자동화 초안: `SocialPostDraft` raw SQL 테이블

## 홈페이지-관리자 연결
- 메인 홈과 `/gallery`는 `GalleryPost` 공개 데이터를 기준으로 표시한다.
- 공개 사진 관리는 `/admin/gallery`에서 `GalleryPost` 게시물로 통일한다.
- `AcademySettings.galleryImagesJSON`은 호환 필드로 남아 있지만, 관리자 설정 화면에서는 더 이상 편집하지 않는다.
- 공개 페이지 상단 바와 푸터 운영시간은 `AcademySettings.operatingHours`를 사용한다.
- 개인정보처리방침은 `AcademySettings.privacyPolicy`에 저장하고 `/admin/privacy`에서 관리한다.
- Instagram/YouTube/네이버 플레이스/카카오 채널 링크는 `AcademySettings` 설정값을 사용한다.

## 이미지 업로드
- 주요 이미지 업로드 화면은 `/api/upload` 전 `compressImageForUpload`를 거친다.
- 브라우저 `canvas`로 사진 긴 변을 줄이고 JPG 품질을 단계적으로 낮춰 저장소에 들어가는 원본 용량을 줄인다.
- GIF는 움직임 보존을 위해 재압축하지 않고 5MB 이하만 허용한다.
- 적용 영역은 선생님 빠른 업로드, 관리자 갤러리, 공지 본문/첨부, 코치 사진, 수업 로그, 페이지 빌더 이미지다.

## 인스타그램 연동
- Instagram API 토큰은 DB에 저장하지 않고 서버 환경변수 `INSTAGRAM_ACCESS_TOKEN` 또는 `META_ACCESS_TOKEN`로 읽는다.
- Instagram Business Account ID와 자동 업로드 ON/OFF는 관리자 설정에서 관리한다.
- 기존 인스타 게시물 가져오기는 `/api/cron/instagram-gallery` Vercel cron으로 하루 1회 실행한다.
- `GalleryPost`는 `source`, `externalId`, `externalUrl`, `instagramMediaId`, `instagramPermalink`, `instagramPublishedAt`, `instagramPublishError`로 가져오기/게시 상태를 기록한다.

## 선생님 인스타 자동화
- `/staff/quick-post`에서 선생님이 휴대폰 사진을 올리고 수업 메모를 입력한다.
- 브라우저에서 사진을 먼저 압축한 뒤 `/api/upload`로 업로드한다.
- `generateSocialCaptionDraft`가 Gemini로 제목/본문/해시태그를 생성하고, API 키가 없으면 안전한 기본 문구를 만든다.
- 초안은 `SocialPostDraft`에 `READY` 상태로 저장된다.
- 선생님은 본인이 만든 초안을 인스타 피드 미리보기에서 수정한 뒤 승인 과정 없이 바로 게시할 수 있다.
- 바로 게시 시 홈페이지 `GalleryPost`가 생성/갱신되고, 인스타그램 게시도 함께 시도한다.
- `/admin/gallery`는 관리자/부관리자가 대기 또는 실패 초안을 확인하고 재게시/반려하는 보조 관리 화면으로 남긴다.
- 사진 1장은 단일 게시, 사진 2~10장은 캐러셀 게시로 처리한다.

## 공지사항 소셜 캠페인
- `/admin/notices`에서 공지사항별 소셜 발행 모달을 열 수 있다.
- 공지 본문 이미지와 첨부 이미지를 모아 인스타 피드, 인스타 스토리, 페이스북 광고 소재 초안으로 전환한다.
- 공지사항 홍보는 공개 갤러리 게시물이 아니므로 `GalleryPost`를 만들지 않는다.
- 발행/준비 기록은 `SocialCampaignPost` raw SQL 테이블에 저장한다.
- 페이스북 광고는 현재 Marketing API 직접 생성이 아니라 광고관리자에 붙여 넣을 문구와 링크를 준비하는 방식이다.

## 현재 확인 상태
- `npx.cmd tsc --noEmit` 통과.
- 전체 lint는 기존 `any`, 임시 JS 스크립트 `require()`, React 19 lint 규칙 위반 때문에 별도 정리 작업이 필요하다.
- 개발 서버 기본 포트는 4000이다.
# 방학특강 구조 (2026-07-20)

- 공개 진입점은 `/seasonal`, 상세와 신청은 `/seasonal/[slug]` 하위에 둔다.
- 운영 진입점은 `/admin/seasonal`이며 시즌·반·신청 항목 단위로 관리한다.
- 특강 모집 데이터는 `SpecialProgram*` 모델에 보존하고 확정 후 기존 수업·출석·결제 구조와 연결한다.
- 신청 가격은 서버 계산 스냅샷으로 보존하며, 정원은 행 잠금과 직렬 트랜잭션으로 보호한다.
- 특강 셔틀 노선 운영 진입점은 `/admin/shuttle`이며 `ShuttleVehicle`, `ShuttleRoutePlan`, `ShuttleRouteStop`, `ShuttleRoutePassenger`, `ShuttleAuditLog`로 차량·정류장·탑승자·확정 이력을 관리한다.

## 셔틀 기사 앱 탑승 체크 (2026-07-21)

- ShuttleRoutePassenger는 실시간 운행 상태를 rideStatus로 보관한다. 값은 PENDING, BOARDED, DROPPED_OFF, NO_SHOW만 사용한다.
- 기사 모바일 앱 /staff/shuttle은 배정된 확정 노선의 승객별 탑승/하차 버튼을 제공하고, /api/staff/shuttle PATCH로 즉시 저장한다.
- 관리자 셔틀 화면 /admin/shuttle은 각 승객 배지에 현재 운행 상태를 함께 표시한다.

## 방학특강 날짜별 출석 슬롯과 신청 요일 (2026-07-25)

- **분류**: architecture
- **발견자**: developer
- **내용**: `SpecialProgramEnrollmentDate`(날짜별 출석 슬롯)는 학생이 신청 시 고른 `SpecialProgramApplication.selectedWeekdays`에 해당하는 날짜에만 생성된다. 따라서 같은 반이라도 날짜별 명단 인원이 서로 다른 것이 정상이며, "반 전체 승인 인원"은 `sd."offeringId"` 기준 + `e.status <> 'CANCELLED'` + `e.kind='REGULAR'` + 신청항목 `status='APPROVED'`의 DISTINCT `applicationItemId`로 센다(`src/lib/seasonal/attendance.ts`의 `countApprovedStudents`). 관리자 화면은 "반 전체 N명 중 이 날 M명"을 함께 보여줘 누락 오해를 막는다. 날짜 요일 계산은 `src/lib/seasonal/planning.ts`의 `weekdayInSeoul`(Asia/Seoul)을 재사용한다.
- **참조횟수**: 0

## 방학특강 "정원"의 진짜 기준 = 코트(형제 반) × 요일 (2026-07-25)

- **분류**: architecture
- **발견자**: developer
- **내용**: `SpecialProgramOffering.capacity`는 그 반 하나의 인원 상한이 아니다. 승인 검사 `ensureSpecialProgramOperationalCapacity`(`src/app/api/admin/seasonal/route.ts:551~598`)가 쓰는 실제 의미는 **"`linkedClassId`로 묶인 같은 시즌 형제 반(주2회·주3회·주5회 등)을 모두 합쳐, 한 요일에 코트에 들어올 수 있는 최대 인원"**이다. 판정 기준은 `item.status='APPROVED'` DISTINCT 항목 수 + `COALESCE(cardinality(app."selectedWeekdays"),0)=0 OR <요일> = ANY(app."selectedWeekdays")`(요일 미선택 = 전 요일 등원). 반면 `countApprovedStudents`의 "반 전체 N명"은 **반 1개 · 전체 기간** 기준이라 축이 다르며, 그래서 "반 전체 13명 / 정원 12" 같은 모순 표시가 나왔다. 같은 기준의 요일별 점유 집계는 `src/lib/seasonal/attendance.ts`의 `getCourtOccupancyByWeekday()`(7요일 VALUES × LEFT JOIN 단일 쿼리, N+1 없음)로 제공하며 board/roster 응답의 `courtOccupied`/`courtCapacity`로 내려간다. 실측(2026 여름): 초등 고학년 그룹 월 15 / 화 11 / 수 13 / 목 11 / 금 10 (정원 12) — 월·수는 이미 초과 상태.
- **참조횟수**: 0
# 정규 셔틀 월별 운영 원장 (2026-08-26)

- `RegularShuttleStop.serviceMonth`가 구글 차량 시트의 월별 스냅샷을 보존한다. 새 가져오기는 전체 테이블이 아니라 해당 월만 교체한다.
- `RegularDispatchRoute`는 `serviceMonth + dayOfWeek + direction` 단위로 노선을 저장해 월 변경 시 과거 배차를 덮어쓰지 않는다.
- `/admin/shuttle/regular`에서 확인 월과 비교 월을 선택하고 학생별 추가·제외·시간/정류장 변경을 확인한다.
- 정규 자동 배차 엔진은 기존 방학특강 `RouteSection`과 배차 코어를 재사용하되 `serviceMonth`를 명시적으로 전달한다.
# 2026-08-27: 수강 변경 실시간 3중 동기화 구조

- 운영 사이트에서 일어난 `Enrollment` 변경은 기존 `OperationsRequest` → `OperationsCommand` → `OperationsSyncAttempt` 원장을 그대로 사용한다. 새 평행 장부를 만들지 않는다.
- `enrollStudent`와 `updateEnrollmentStatus`는 수강 변경과 `src/lib/operations-events`의 원장 INSERT를 같은 DB 트랜잭션에서 처리한다. 원본 `WEBSITE` 시도는 `SUCCEEDED`, `SHEET`와 `RALLYZ`는 `PENDING`으로 시작한다. 동일 상태 재저장은 DB 시간도 바꾸지 않는다.
- `src/app/api/operations-events`는 시트·외부 변경을 HMAC 서명, 5분 재생 방지, 64KB 제한, `source + eventId` 멱등 키로 접수한다. 실제 달력 날짜와 적용 월, 학생 ID, 종류별 필수 값을 검증하고 모호하거나 아직 어댑터가 없는 변경은 `HELD`로 둔다.
- 현재 기존 시트 어댑터 계약으로 자동 실행 가능한 사이트 변경은 `PAUSE`와 `WITHDRAW`다. `RESUME`, `CLASS_ADD`, `CLASS_CHANGE`, 셔틀·연락처·청구는 원장에 즉시 잡히지만 전용 어댑터 전까지 확인보류한다.
- 수강 삭제 UI는 제거하고 서버의 기존 `deleteEnrollment` 호출도 실제 DELETE 대신 `WITHDRAWN` 상태변경으로 위임한다. 수강 이력을 보존해야 외부 시스템과 재대조할 수 있다.
- 다음 구현 단계는 시트 Apps Script가 서명 이벤트를 보내는 설치 코드, `PENDING` 시도를 즉시 소비하고 재시도하는 워커, 관리자 상태 화면이다. Rallyz는 공식 쓰기 API·웹훅이 확인되지 않아 로그인 브라우저 기반 감독형 반영을 유지하며, 연결 부재를 성공으로 처리하지 않는다.
- 청구 발행·취소·결제·환불·학부모 알림은 실시간 데이터 동기화 큐에서 실행하지 않는다. 해당 상태는 기존 `billingStatus`·`notificationStatus=HELD`를 유지하고 정확한 미리보기와 실행 시점 승인을 별도로 받는다.
- `/api/cron/operations-sync`는 현재 자동 쓰기 워커가 아니라 읽기 전용 분류기다. `src/lib/operationsSyncWorker.ts`가 PENDING/FAILED 시도를 시트 → Rallyz → 홈페이지 순서로 분류하고, 실제 외부 쓰기 함수는 호출하지 않는다.

# 2026-08-28: 운영 동기화 관리자 화면 폐기

- 관리자 메뉴의 `3중 동기화` 진입점과 혼합형 관리 화면은 폐기하고 `/admin/operations-sync`는 `/admin`으로 이동한다.
- 학부모 요청 링크 생성·복사·활성 링크 취소는 개별 학생 상세 화면에서 `studentId`로 정확히 관리한다.
- `OperationsRequest`, `OperationsCommand`, `OperationsSyncAttempt`, 감사 원장, 공개 `/request/[token]`, 실시간 이벤트와 Rallyz 출석 서버 기능은 다른 운영 기능이 계속 사용하므로 보존한다.
- 다음 접수 창구는 카카오채널을 우선 검토하되, 채널 입력은 기존 승인 원장에 DRAFT/HELD로 연결하고 자동 실행하지 않는다.

# 2026-09-02: 유니폼 주문은 디자인·이니셜까지 구조화한다

- 공개 `/apply/uniform` 신청서는 학생별 디자인, 이니셜, 등번호, 상·하의 사이즈를 필수 입력으로 받는다.
- `UniformOrderItem`은 `design`, `initials`, `backNumber`, `topSize`, `bottomSize`를 구조화 필드로 저장한다. 본사 전송 payload의 옵션도 같은 값을 사용한다.
- 중복 판단은 주문자 연락처와 학생 이름뿐 아니라 디자인, 이니셜, 등번호, 사이즈 조합까지 포함한다. 같은 이름의 다른 디자인 주문을 덮어쓰지 않기 위해서다.
- 본사 전송은 `STIZ_PARTNER_SECRET` HMAC 서명이 양쪽 서버에 모두 설정된 뒤에만 정상 실행한다. 주문 재전송은 기존 `partnerRequestId`를 재사용한다.
## 2026-09-04 카카오 관리자 보완 요청 재확인 구조
- 인증된 학부모가 다음 카카오 메시지를 보내면 `src/lib/kakao-parent-chatbot.ts`가 재확인 필요 명령을 찾아 24시간 일회용 링크를 발급한다.
- `/request/reconfirm/[token]`은 관리자 보완 내용을 읽기 전용으로 표시하고 `src/app/actions/kakao-parent-reconfirmation.ts`가 학생·보호자·접수·운영 요청·명령 관계와 payload 해시를 다시 검증한다.
- `ParentOperationsRequestLink.purpose`는 `GENERAL`과 `KAKAO_RECONFIRMATION`을 DB 제약으로 구분해 링크 경로 혼용을 차단한다.
- 학부모 확정은 `parentConfirmed`와 감사로그만 갱신하며 시트·Rallyz·사이트 실행, 청구, 알림은 수행하지 않는다.
# 2026-10-19: 학원 역할별 공통 시각 경계
- `src/components/academy/AcademyTheme.tsx`: 서버·클라이언트에서 사용할 수 있는 순수 wrapper. `academy-app`과 `data-academy-role`로 관리자/학부모/교사/기사 범위를 구분한다.
- `src/app/academy-theme.css`: 라벤더 팔레트·고딕 글꼴·카드·버튼·상태와 420px 이하 기사 학생 행. RootLayout에서 가져오지만 선택자는 업무 영역에 한정한다.
- `src/lib/academyTheme.ts`: 학원 경로 판별과 PWA 테마 색상. ThemeProvider·ThemeColorUpdater가 같은 경계를 사용한다. 기존 `/shuttle/run`·`/shuttle/regular`도 포함한다.

## 2026-10-19 기사 화면 시안 실제 적용
- 실제 세 기사 링크는 UnifiedDriverRunPage→UnifiedDriverClient 하나를 공유한다. DriverWorkspace.module.css로 역할별 범위를 좁혔고 DriverGpsIndicator는 기존 GpsShareBar를 상세창에 재사용한다.
- driverUpcoming 순수 계산과 useDriverUpcoming은 기기의 로컬 날짜·시각으로 당일 다음 예정만15초/focus/visibility마다 표시한다. API/탑승/GPS 동작과 시계 표시는 분리한다.
- docs/driver-lavender-implementation.md에 기존 기능 대조와 검증 증거·한계를 기록했다. 사용자 후속 승인으로 저장·재조회 불일치도 해결했다.

## 2026-10-19 정규 순서·시각 저장 재조회
- regular-order API는 driverOrderPlan의 기존 기사 조립 재사용·원본 대조 후 명단과 확정 배차를 Serializable 거래로 함께 변경·재조회한다. getRegularShuttleRiders는 선택적 거래 DB를 받아 기존 SQL을 동일 거래에서 사용한다.
- UnifiedDriverClient는 편집 원본을 고정하고 이동 시 시각 칸도 이동한다. 확인된 저장 후 router.refresh하며 새 서버 자료에 이전 임시값을 씌우지 않는다. 적용 범위는 기존 월·요일 공통이며 docs/driver-order-persistence.md에 검증과 한계를 기록했다.

## 2026-10-19 전체 페이지 검증과 사진 경계
- 전체117페이지(관리자56·학부모/선생19·공개공통42)를 docs/all-pages-verification.md 원장으로 관리한다. 정적·실제 빌드·익명 HTTP·역할 fixture·브라우저·실기기 증거를 구분한다.
- 학부모 사진 리포트는 기존 sessionPhotoEntries 변환기를 사용하고 ReportPhoto Client에 이미지 실패 처리를 한정한다. 서버의 부모·자녀·발행 상태 조회와 비공개 사진 프록시는 보존한다.
- 기사3개 단일토큰 경로만 geolocation=(self), 일반 차단 규칙과 중복되지 않게 구성한다. 설정/정책/학부모 요청의 저장·오류 표시는 기존 서버 계약을 보존하면서 보완했다.
- Apply 신청 메뉴는 모바일 탭 영역만 가로 스크롤하고 기존5메뉴를 보존한다. 전체117 경로·공개120조합·격리DB 보호228조합과 재검사, 실제 Next 읽기 Action을 통한 출석금액/청구창을 구분해 기록했다. 실제 운영 인증/기기/발송 검증과 합산하지 않는다.

## 2026-10-19: 공통 화면 전환 자격
- account-views는 서버가 검증한 자격으로 고정된 관리자/선생님/학부모 주소 목록을 만드는 순수 모듈이다. account-view-access는 직접 Auth 연결과 본인 자녀 존재를 조회하며 인증 실패 시 빈 메뉴로 축소한다.
- AccountViewSwitcher는 관리자 프로필·선생님 메뉴·학부모 헤더·공개 계정 버튼이 공유한다. API account-role의 기존 role을 보존하고 views만 추가하며 ID·자녀 정보는 공개하지 않는다. 각 화면의 실제 권한 가드는 그대로 적용된다.
- 최신 초기 화면 경고 수정은 Next16.2.12의 정식 내장 React 복원 코드로 처리한다. 별도 React19.2.3과 기존 UI 데이터 흐름은 유지한다.

## 2026-10-20: 목록 필터 공통 UI
- `src/components/academy/CompactListFilters.tsx`가 검색·주요 동작·필터 펼침·선택 요약을 배치한다. 조건 값과 조회·초기화 함수는 기존 체험/수강신청·원생·특강 화면이 소유한다.
- 업무/보기/시즌 같은 대상 선택과 목록 조건을 구분하고 API·조건 계산은 옮기지 않는다. 상세 docs/admin-compact-filters.md.

## 2026-10-20: 수강신청의 명시적 보호자 선택
- approval-parent.ts가 후보·직접 Auth 연결·명시 선택·재검토 트랜잭션을 담당하고 admin.ts는 관리자 가드·조회 시간 제한·재검증을 연결한다. ApplyAdminModals는 기존 parentUserId를 잠그고 신규 선택값을 명시 전달한다. 스키마·대표 role 변경은 없다. 상세 docs/enrollment-parent-link.md.

## 2026-10-20: 화면 안내와 배차 저장 상태
- application-display-format.ts는 체험/수강신청 화면의 전화번호·수업명 표시를 공유한다. user-facing-error.ts는 내부 장애와 공개할 업무 안내를 분리한다.
- 공용 RouteSection은 정규/특강의 범위와 저장 메타데이터를 유지하고, 실제 표시 노선을 정규 상단 시간표에 전달한다. saved API는 관리자 인증 후 저장 확인용 조회와 이전 저장 시각 비교를 연결한다.
- 신규 DB 테이블·migration 없이 기존 저장 노선의 updatedAt와 특강 시즌 기간을 사용한다. 운영 반영과 앱 출시는 별도다.

## 2026-10-20: 관리자 청구 검토표와 단일 보상
- finance/prepare와 billing/workbench 계층은 기간별 반 청구의 조회·수정·확정·발행을 연결한다. API는 관리자·동일출처를 확인하고 저장 설정 기본 차단, 새 SQL은 운영 미적용이다.
- 기존 결석·보강 예약/취소·회수 경로도 같은 보상 잠금을 사용한다. 이월 잔액은 분수와 사용 근거를 보존하며 Payment/Invoice와 함께 반영한다. 원기간·일정·사용 청구가 바뀌면 확인보류한다.
- 공식 일정은 공용 로더에서 거래 밖에 한 번 읽어 불변 자료로 전달하고 원본 지문에 포함한다. 실제 자료 미리보기의 일정 조회 실패는 부분 일정을 비워 금액 계산을 막는다. 상세 docs/billing-workbench-upgrade.md.
