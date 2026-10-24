# 기술 결정 이력
<!-- 담당: planner-architect | 최대 30항목 -->
<!-- "왜 A 대신 B를 선택했는지" 기술 결정의 배경과 이유를 기록 -->

### 2026-10-06 청구·수강 운영 원본: 청구·납부 안내 = 랠리즈, 구글 시트 원장 은퇴(원장 확정)
- **분류**: decision
- **발견자**: pm
- **내용**: (1) 학부모 청구·납부 안내는 **랠리즈 전담**(B안). 사이트 「링크 발송」「미납 알림」·수동 청구 「학부모 알림」은 `BILLING_PARENT_SEND_ENABLED==="1"` 일 때만(기본 잠금, `src/lib/billing/parentSendGuard.ts`). 잠금 전엔 버튼 한 번에 미납 90건이 랠리즈와 중복 발송될 상태였다. 토스 라이브 후 다시 연다. 사이트는 원장용 내부 알림만(`admin-daily-digest`, KST 08:30, 앱+푸시, 문자 없음). (2) 2026-10 부터 시트 원장 은퇴: 운영 동기화 SHEET 칸은 SKIPPED(`STIZ_SHEET_SYNC_RETIRED` 미설정=은퇴, "0"=옛 3칸), 완료 판정은 SHEET 만 SKIPPED 허용·랠리즈/웹은 SUCCEEDED+verifiedAt 필수(TS·SQL 두 벌을 같은 테스트로 묶음). 시트 쓰기 코드는 되돌림용으로 보존. (3) 사이트 장부의 진실 원천은 랠리즈 — 미납 대조는 랠리즈 납부 API 로 학생·월 합계를 맞춰 정리(10-05·10-06 121건), 금액 차이는 랠리즈 청구 금액으로 정정. (4) 승인된 휴원·퇴원은 적용일에 사이트 자동 반영, 랠리즈는 「확인 필요」로 남겨 사람이 「랠리즈 반영 확인」.
- **참조횟수**: 0

### 2026-07-06 공지 리치 에디터 강화: 공유 TipTap 강화 + plain/HTML 혼재 렌더 + 유튜브 iframe 화이트리스트
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 공지를 리치 에디터화. 핵심 결정: (1) 리스트/인용/구분선/링크는 StarterKit 3.20에 이미 내장이라 **새 패키지 없이 툴바 버튼만** 추가, 표·유튜브만 @tiptap/extension-table·extension-youtube 신규 설치. (2) 이미지 정렬(좌/중/우)+드래그 크기조절은 서드파티(3.x 호환 불확실) 대신 **커스텀 ResizableImage NodeView**로 구현, 드래그 핸들은 이미 설치된 re-resizable 재활용. (3) 이미지 업로드는 신규 스토리지 없이 기존 `/api/upload`(버킷 uploads, folder=notices) 재사용 — 툴바/드래그드롭/붙여넣기 3경로. (4) 공지 content가 plain text→HTML로 바뀌므로 렌더는 **HTML 태그 유무로 판별**(HTML이면 sanitizeHtml, 아니면 기존 toNoticeHtml) → 기존 plain 공지 하위호환. (5) 유튜브 iframe은 sanitize-html allowedIframeHostnames로 **youtube 도메인만 화이트리스트**(임의 iframe XSS 차단). (6) RichTextEditor는 설정 페이지와 공유 — 강화 시 소개글 에디터도 함께 강화됨(회귀 확인). 하단 이미지 첨부(attachmentsJSON)는 본문 삽입과 공존 유지(기존 UX 보존). 위험 낮은 순 7단계(패키지/툴바→업로드→이미지정렬크기→표/유튜브→sanitize+렌더스타일→공지적용→붙여넣기정제).
- **참조횟수**: 0

### 2026-07-06 서버 HTML 새니타이저: isomorphic-dompurify → sanitize-html 교체
- **분류**: decision
- **발견자**: developer
- **내용**: isomorphic-dompurify는 서버에서 jsdom을 끌어오는데, jsdom 전이 의존(@exodus/bytes)이 ESM 전용이라 Vercel 서버리스(Next 16 Turbopack)가 require()로 로딩하다 ERR_REQUIRE_ESM → 해당 라우트 500(공지 상세) + 정적 페이지 ISR 재검증 실패(/,/about,/apply). 대안 검토: (A) next.config serverExternalPackages에 추가 — 변경 최소지만 Vercel 런타임에서만 재현되는 에러라 **로컬 빌드로 검증 불가**(raw Node에선 정상). (B) jsdom 비의존 라이브러리 sanitize-html(htmlparser2 기반 순수 JS)로 교체 — jsdom을 트리에서 완전 제거하여 근본 해결, 로컬 빌드로 검증 가능. **B 채택.** 정화 대상이 관리자 TipTap 리치텍스트라 허용목록을 넓게(서식/색상/정렬/이미지/링크 보존) 잡고 script·이벤트핸들러·javascript: 링크만 제거. sanitize.ts 래퍼로 흡수해 호출부(about/apply/landing) 3곳은 무변경. isomorphic-dompurify·@types/dompurify 제거(42패키지, jsdom 포함).
- **참조횟수**: 0

### 2026-04-06 체험/수강신청 구글폼 전환: AcademySettings DB 플래그 방식
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 자체 폼(Next.js)과 구글폼(외부 링크) 사이를 관리자가 코드 배포 없이 전환할 수 있도록 AcademySettings에 useBuiltInTrialForm/useBuiltInEnrollForm boolean 컬럼 2개 추가. 환경변수 대신 DB 설정을 선택한 이유: (1) 관리자가 /admin/apply에서 즉시 토글 가능, (2) 체험/수강을 독립적으로 전환 가능, (3) 기존 AcademySettings 패턴 재사용. 자체 폼 코드는 삭제하지 않고 보존 — 플래그가 true로 돌아오면 즉시 복귀. 구글폼 전환 시 비활성화: SMS 알림, 대시보드 배지, CRM 자동연동, 수강신청 목록. 기존 trialFormUrl/enrollFormUrl 필드에 구글폼 URL이 이미 저장 가능.
- **참조횟수**: 0

### 2026-03-29 SMS 템플릿 관리: DB 기반 동적 메시지 + 변수 치환 방식
- **분류**: decision
- **발견자**: planner-architect
- **내용**: SMS 메시지가 코드에 하드코딩되어 관리자가 수정 불가한 문제 해결. SmsTemplate 모델(trigger+target+body+isActive)로 DB에 저장하고, renderSmsTemplate(trigger, variables)로 {{변수}} 치환 후 발송. 트리거 10개: 관리자용 2개(TRIAL_NEW_ADMIN, ENROLL_NEW_ADMIN), 코치용 2개(TRIAL_NEW_COACH, ENROLL_NEW_COACH), 학부모용 6개(TRIAL_CONFIRM, TRIAL_SCHEDULED, ENROLL_CONFIRM, ENROLL_APPROVED, INVOICE, UNPAID). trigger를 unique로 설정하여 코드에서 트리거명으로 직접 조회. 템플릿이 비활성이면 SMS 스킵. 기존 lib/sms.ts(솔라피 연동)는 그대로 유지, 위에 lib/smsTemplate.ts 계층 추가.
- **참조횟수**: 0

### 2026-03-29 신청 알림 시스템: 기존 인프라 활용 + ADMIN 우선 전략
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 체험/수강 신청 시 관리자 알림 시스템 설계. 기존 알림 인프라(Notification 모델 + PushSubscription + sendPushToUser + createNotificationRecord)가 완성되어 있어 추가 구현 최소화 가능. 핵심 결정: (1) 알림 채널은 대시보드+웹Push만(비용 0원, 인프라 완성), 카카오/SMS는 Phase 2로 유보, (2) 알림 대상은 ADMIN만 — Coach 모델에 userId가 없어 선생님 알림 불가, Coach-User 연결은 별도 작업, (3) createNotificationRecord를 admin.ts에서 lib/notification.ts로 분리하여 public.ts에서도 사용 가능하게, (4) 유니폼 신청은 구글폼이라 알림 트리거 불가(자체화 필요).
- **참조횟수**: 0

### 2026-03-29 스프레드시트 수강생 이관: 데이터 구조 분석 및 이관 전략
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 구글 스프레드시트(gid=672309223)에 38개 컬럼, 1,152행의 수강생 데이터 확인. 핵심 발견: (1) "결제방법" 컬럼이 결제수단(랠리즈/카드/현금)과 원생상태(휴원/퇴원/이월)를 혼합 -> 이관 시 분리 필요, (2) 현재 DB에 "지점(branch)" 개념이 완전히 누락 -> Student.branchName 문자열 추가 권장 (2개 지점뿐이라 테이블까지는 불필요), (3) 수업선택이 "N교시" 형태 -> 지점+요일+교시 조합으로 Class 매핑표 필요, (4) 같은 학생이 월별 여러 행에 등장 -> 이름+생년월일로 고유 식별 필수. Payment.method, Enrollment.status 확장(WITHDRAWN/PAUSED), Student에 branchName/uniformStatus/referralSource 필드 추가 필요.
- **참조횟수**: 0

### 2026-03-29 학부모 후기 동적화: Faq 패턴 복제 방식 채택
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 학부모 후기를 DB로 전환할 때, 기존 Faq 모델/CRUD 패턴을 그대로 복제하는 방식 채택. 이유: (1) Faq와 구조가 거의 동일 (텍스트 + 순서 + 공개여부), (2) 검증된 패턴이라 버그 위험 최소, (3) 관리자 UI도 FaqAdminClient를 참고하면 빠르게 구현 가능. 네이버 플레이스 URL은 AcademySettings 대신 /admin/testimonials 페이지에서 관리하기로 결정 (후기와 같은 맥락에서 설정하는 것이 직관적).
- **참조횟수**: 0

### 2026-03-29 보안 분석: Server Action 인증 체크 필수화 결정
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 보안 분석 결과, admin.ts의 40개+ Server Action에 인증 체크가 전혀 없음을 발견. Server Action은 HTTP POST 엔드포인트로 노출되므로 인증 없이 누구나 호출 가능. `requireAdmin()` 헬퍼를 만들어 모든 관리자 함수에 적용하기로 결정. 또한 src/middleware.ts가 아예 없어서 미들웨어 보호가 동작하지 않으므로 파일 생성 필수. 회원가입 시 role을 클라이언트에서 보내는 취약점도 서버 측 고정으로 수정 예정.
- **참조횟수**: 0

### 2026-03-22 수업 시뮬레이터: API 없이 클라이언트 필터링 방식 채택
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 시뮬레이터용 별도 API 엔드포인트를 만들지 않고, 서버 컴포넌트에서 기존 queries.ts 함수로 전체 슬롯 데이터를 조회한 뒤 클라이언트에서 필터링하는 방식을 선택. 이유: (1) 슬롯 데이터량이 적어 전체 전달해도 부담 없음, (2) 필터 변경 시 서버 왕복 없이 즉각 반응, (3) schedule/page.tsx와 동일한 패턴이라 유지보수 용이, (4) 새 DB 쿼리 불필요.
- **참조횟수**: 0

### 2026-03-22 수업 시뮬레이터: 독립 페이지(/simulator) 방식 채택
- **분류**: decision
- **발견자**: planner-architect
- **내용**: /schedule 페이지에 탭으로 추가하는 대신 독립 페이지로 분리. 이유: (1) 위저드 형태의 단계별 UI가 필요하여 시간표와 혼재 시 복잡해짐, (2) SEO와 공유 가능한 URL 확보, (3) 기존 시간표 페이지에 영향 없음, (4) 나중에 챗봇에서 /simulator로 바로 연결 가능.
- **참조횟수**: 0

### 2026-03-26 관리자 페이지 캐싱: force-dynamic 전면 폐지 -> revalidate:30 통일
- **분류**: decision
- **발견자**: planner-architect
- **내용**: CLAUDE.md에는 "/admin/schedule은 revalidate:30, 나머지 /admin/*은 force-dynamic"으로 기술되어 있으나, 실제 코드 분석 결과 전체 15개 admin 페이지가 이미 revalidate:30으로 통일되어 있음. force-dynamic 사용 페이지 0개. Server Action 호출 시 revalidatePath로 즉시 무효화되므로 실시간성도 보장됨. CLAUDE.md 업데이트 필요.
- **참조횟수**: 0

### 2026-03-26 입학 가이드 투어 v1: 직접 구현 방식 채택 -> 5회 실패로 폐기
- **분류**: decision
- **발견자**: planner-architect
- **내용**: v1에서 직접 구현(CSS box-shadow, z-index, 4-div 오버레이)을 시도했으나 5회 연속 실패. 근본 원인: (1) 하이라이트 대상이 너무 큰 섹션(히어로 1920x600px 등), (2) CSS hack으로는 부모 stacking context를 안정적으로 뚫을 수 없음, (3) 슬라이드쇼식 "다음" 버튼 방식은 게임 튜토리얼이 아님. 이 결정은 v2에서 번복됨.
- **참조횟수**: 1

### 2026-03-26 입학 가이드 투어 v2: driver.js 라이브러리 채택 (직접 구현 폐기)
- **분류**: decision
- **발견자**: planner-architect
- **내용**: v1의 5회 실패 후 driver.js(MIT, ~5KB gzipped) 채택. 선택 이유: (1) SVG cutout 방식으로 작은 요소도 정확히 하이라이트 (CSS hack 불필요), (2) pointer-events 자동 처리로 하이라이트된 요소 클릭 가능, (3) onNextClick/onHighlightStarted 콜백으로 "직접 클릭" 방식 구현 가능, (4) vanilla JS라 React 래핑 불필요, (5) 번들 크기 최소. 페이지 간 이동은 URL 파라미터(?tour=phase)로 자체 처리. shepherd.js(AGPL 라이센스)와 react-joyride(React 19 미호환) 제외.
- **참조횟수**: 0

### 2026-03-26 입학 가이드 투어: driver.js + sticky 헤더 위치 버그
- **분류**: decision
- **발견자**: planner-architect
- **내용**: driver.js가 sticky top-0 헤더 내부의 nav 링크를 하이라이트할 때, scrollIntoView 로직이 불필요하게 작동하여 popover 위치가 어긋남. 해결: nav 링크 스텝에 scrollIntoView:false 옵션 적용. 또한 Next.js Link에 DOM addEventListener로 click 리스너를 붙이면 React 합성 이벤트와 실행 순서 충돌 발생. 해결: href 속성 직접 교체 방식으로 전환.
- **참조횟수**: 0

### 2026-03-26 구글 캘린더 양방향 동기화: Service Account + DB 이중 저장 방식
- **분류**: decision
- **발견자**: planner-architect
- **내용**: Phase 1은 "DB를 주 저장소로 유지하면서 구글 캘린더에 best-effort 푸시" 방식. 구글 캘린더를 단일 진실 소스로 전환하는 것은 Phase 2로 유보. 인증은 Service Account(서버-to-서버). googleapis 패키지 사용 (Service Account JWT 서명을 직접 구현하는 것보다 안전). INSERT 시 ID는 crypto.randomUUID()로 미리 생성하여 RETURNING 없이 처리. 구글 API 실패 시 DB 저장만 유지(graceful fallback). 환경변수: GOOGLE_SERVICE_ACCOUNT_KEY(JSON 문자열), GOOGLE_CALENDAR_ID.
- **참조횟수**: 1

### 2026-03-29 체험/수강 신청 자체화: 구글폼 탈피 전략
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 현재 체험/수강 신청은 구글폼 iframe 임베드 방식. TrialLead 모델은 이미 존재하나 관리자 수동 등록만 가능. 자체 폼 전환 시 (1) TrialLead에 필드 확장(birthDate, grade, basketballExp, preferredDay, preferredSlot, hopeNote), (2) 수강 신청 전용 EnrollmentApplication 모델 신규 생성(체험 데이터 자동 채움 + 수강 추가 필드), (3) 공개 /apply/trial, /apply/enroll 폼 페이지 -> Server Action으로 DB 직접 저장, (4) 기존 /admin/trial CRM에 공개 폼 연동, (5) /admin/apply를 구글폼 URL 관리에서 수강 신청 목록 관리로 전환. TrialLead->EnrollmentApplication->Student 3단계 파이프라인 구축.
- **참조횟수**: 0

### 2026-03-29 체험-수강 연속 경험: 심층 검토 11건 보완사항
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 기본 설계 검토 결과 11건의 누락 사항 발견. 핵심 3건: (1) convertTrialToStudent가 Student만 생성하고 Enrollment/Guardian/Payment를 생성하지 않아 전환 프로세스가 끊김 -> convertAndEnroll로 확장 필요, (2) 체험 없이 직접 수강하는 경로(형제/지인추천)가 설계에 빠짐 -> EnrollmentApplication.trialLeadId를 optional로 해결, (3) ParentRequest type에 반변경(CLASS_CHANGE)/휴원(PAUSE)/퇴원(WITHDRAW)이 없어 학부모 셀프서비스 불가. 추가로 스팸방지(honeypot+rate limit), 중복감지(parentPhone 검색), 관리자 알림(대시보드 카운트), 결제안내(paymentGuideText) 등 보완 제안. PM 결정 대기: 미납시 수강상태 정책, 체험일정 선택방식, 알림 연동 범위.
- **참조횟수**: 0

### 2026-03-26 입학 가이드 투어: 기존 시뮬레이터 공존 방식
- **분류**: decision
- **발견자**: planner-architect
- **내용**: 가이드 투어와 기존 /simulator 페이지는 공존. 시뮬레이터는 독립 기능으로 유지하고, 가이드 투어에서 시뮬레이터를 "도착지 중 하나"로 활용. 시뮬레이터를 대체하지 않는 이유: (1) 시뮬레이터는 직접 검색/필터링이 가능한 도구형 페이지, (2) 가이드 투어는 정보 안내 목적, (3) SEO와 챗봇에서 /simulator 직접 링크가 이미 사용 중.
- **참조횟수**: 0

### 2026-08-09 공식 홈페이지 앱을 PWA 설치 대상에서 제외 (앱은 역할별 3개만)

**배경**: 공식 앱(scope `/`)이 깔린 기기에서는 선생님·학부모 앱을 설치할 수 없다
(errors.md 의 scope 충돌 참고). 서브도메인 분리는 도메인·인증 쿠키 작업이 커서
현 단계에 과하다.

**결정**: `public/manifest.json` 의 `display` 를 `browser` 로 바꿔 설치 대상에서
뺀다. 홈페이지는 웹으로 쓰고, 앱은 **선생님·학부모·기사 3개**만 둔다.
학원 홍보 페이지를 앱으로 설치할 학부모는 사실상 없어 잃는 것이 없다.

**부수 정리**: `/mypage` 가 공용 manifest 를 내려주고 있어 `manifest-parent.json`
을 명시했다(교사용 `/staff` 에는 원래 있던 선언). 앱의 시작 주소가 공용 manifest
를 내려주면 앱 신원이 흔들린다.
