# 프로젝트 구조 지식
<!-- 담당: planner-architect, developer | 최대 30항목 -->
<!-- 프로젝트의 폴더 구조, 파일 역할, 핵심 패턴을 기록 -->
<!-- 2026-11-10 정리: 48항목 → 주제별 19묶음. 원래 항목은 묶음 안 하위 항목(원래 날짜·제목)으로 내용 그대로 보존. 새 항목은 맞는 묶음에 하위 항목으로 넣는다 -->

### [2026-11-14] 수업 피드 = «볼 수 있는가» 판정 하나(src/lib/feed) — 사진·영상·소식·홈 카드 공용
- **분류**: architecture
- **발견자**: developer
- **내용**: 학부모 공개 = 완료+발행 수업(`feedVisibleSessionSql`) × 참여한 내 아이(`feedParticipantSql` = 출결 기록 또는 그 반 ACTIVE 수강·개시일 ≤ 수업일). 서버 판정은 `feed/server.ts` 의 `loadParentViewableSession`/`parentCanViewSession` 하나(사진 보기 라우트·영상 라우트·소식 상세가 호출, 목록·홈 카드는 같은 SQL 조각). 사진 공개 동의·«나온 학생» 태그는 보지 않는다(원장 결정, 동의 표는 보존·공개 게시 검사는 `PUBLIC_POST_CONSENT_GATE_ENABLED=false` 스위치). 상세·홈은 `listViewableSessionPhotos`(사진 원장 SocialPostDraft 에 실제로 있는 이 수업 사진만)로 넘겨 403/404 헛요청이 없다. Session.date(무tz) 수업일은 `sessionKstDateSql`(두 번 변환) — 옛 «전날 15:00» 행도 같은 날. 선생님 쪽: 한 줄(Session.content)은 `saveSessionFeedLine`(PLANNED~COMPLETED·당일 자정), 사진·영상 시간은 `canManageSessionMedia`(=영상 규칙). 테스트 tests/feed-rules.test.mjs·parent-report-render.test.mjs.
- **참조횟수**: 0

### [2026-11-14] 수업 영상 = 브라우저→저장소 직접 업로드 + 예약 행 + 유튜브 이동 cron
- **분류**: architecture
- **발견자**: developer
- **내용**: 영상은 Vercel 함수(본문 4.5MB 한계)를 거치지 않는다 — `POST …/videos/upload-url` 이 권한·시간·형식·크기 확인 후 `SessionVideo` «예약 행»(registeredAt NULL)+서명 업로드 주소 발급 → 브라우저 XHR PUT(진행률) → `POST …/videos` 가 저장소 `info()` 로 크기·형식 재확인 후 등록. 규칙은 `lib/sessionVideo/rules.ts`(순수, 테스트 session-video-rules), 서버 공용 `server.ts`(오늘 = SQL `NOW() AT TIME ZONE` 한 번, 보호자 = 출결 또는 ACTIVE 수강 + childAccessSql), cron `/api/cron/youtube-upload`(15분, 예약 3시간 만료·사본 삭제·UPLOADING 20분 복구·유튜브 삭제·하루 KST 5건 `YouTubeConnection.quotaUsed` 선점 UPDATE). 유튜브 토큰은 `lib/youtube/tokenCrypto.ts` AES-GCM, 백업에서 가림(archiveCore SECRET_COLUMNS_BY_TABLE). 재생 = UPLOADED+unlisted 만 youtube-nocookie, 나머지 10분 서명 주소.
### [2026-11-14] 학부모 정규 셔틀 = 셔틀 명단(RegularShuttleStop) 기준 한 모듈 · «아이 기록» 아이 정보 칸
- **분류**: architecture
- **발견자**: developer
- **내용**: 순수 `src/lib/shuttle/childShuttleRules.ts`(요일×수업시간 묶음·명단 순서 첫 행·시각 정리는 regularRosterEtaLogic.hhmm · 7일 운행 판정 순서 = 수강 상태(첫 수업 전·퇴원·휴원) → 휴무(연간일정 수업일 아님, classDatesForCalendarMonth+getMonthlyClassDates) → 결석(RegularAbsence REPORTED·CONFIRMED) → «오늘만»(ShuttleDayException, appliesToDirection·describeException) · `rosterOverviewItems` = 홈·수업 탭 항목 «HH:MM 승차/하차») + 조회 `childShuttleQuery.loadChildRegularShuttle(db, {studentId,…})`(명단 달 = 그 달 이하 최신, 모든 SQL studentId=$1, 전화·좌표·메모 미조회). `getParentShuttleOverview` 가 내 자녀(childAccessWhere)마다 이걸로 정규 항목을 만들고(옛 노선 승객과 같은 날·방향이면 승객 쪽), `{includeRoster:false}` 로 끌 수 있다. 반 목록은 `parent/childClassesQuery.loadChildClasses`(수업 탭과 같은 LATERAL·classStatusChip). 아이 정보 규칙 `parent/childProfileRules.ts`(숨길 칸 PROFILE_HIDDEN_COLUMNS — 테스트가 조회 SQL 에 없는지 본다, 남의 전화는 안 내림). 테스트 tests/parent-child-profile-shuttle.
- **참조횟수**: 0

### [2026-11-14] 학부모 «아이 기록»(/mypage/record) = 순수 규칙 + 첫 SQL 권한 재확인 조회
- **분류**: architecture
- **발견자**: developer
- **내용**: 규칙 `src/lib/parent/childRecordRules.ts`(청구 달=year/month 없으면 납기일 달·환불/취소 제외 합계·월 묶음 펼침·출석률 (출석+지각)÷(출석+지각+결석−보강 대체)·분모 0=null·타임라인) + 조회 `childRecordQuery.ts`(`getChildRecord(parent, student, db=prisma)` 첫 SQL `s.id=$2 AND childAccessSql AND notMerged`, 0행이면 다른 조회·getStudentTenure 안 돔, 섹션별 실패 null, 금액·영수증은 payerAccess). 보강 대체 판정 = ABSENT + 같은 반·KST 날짜 RegularAbsence(취소 아님) + MakeupCredit `REGULAR:{반}:{날짜}` USED. 화면은 홈 소속(PARENT_TABS 홈 also — isParentTabActive 홈도 also 를 본다). 시험은 db 를 가짜로 바꿔 끼워 IDOR 경로를 실행한다(tests/parent-child-record-rules). 아이콘은 UI 통일 가드(127개 상한) 때문에 글자(▾·영수증)로.
- **참조횟수**: 0

### [2026-11-14] 비회원 결제 링크 /pay/<토큰> = 결제 장부의 «소유자» 갈래 하나 추가
- **분류**: architecture
- **발견자**: developer
- **내용**: 결제 시작·승인(`createCheckoutSession`·`confirmTossPayment`)의 owner 가 `PaymentOwnerIdentity | GuestInvoiceOwner`. 비회원은 API(`/api/pay/checkout`·`confirm`)가 토큰을 먼저 확인(`guestPayLinkService.resolveGuestPayLink`)하고 «토큰의 청구서 id»만 넘긴다(본문 invoiceId 무시). 승인 SQL 은 그 청구서의 한 장짜리 주문(묶음 제외·거래 parentId=청구서 parentId)만 찾고 금액 비교·`claimTossConfirmInTx` 잠금은 그대로. 청구서 한 장 SQL 은 `loadParentInvoiceRow` 공용(로그인·비회원). 토큰은 해시만 저장(`PaymentInvoiceAccessToken`)이라 재발급만 가능 — 이전 링크는 폐기하지 않는다. 납부·취소·환불은 쓰는 순간 청구 상태로 판정(`judgeGuestPayLink`). 새 «토큰 주소»는 next.config 전용 머리글 + 공통 규칙 제외 정규식 + `trackingExclusion.TOKEN_PATH_PREFIXES`(픽셀) 세 곳을 같이 고친다(가드 테스트가 마지막 것을 잡는다).
### [2026-11-13] 앱 간편로그인(a1) = 시스템 브라우저 + 1회용 code 복귀 + 서버 스위치
- **분류**: architecture
- **발견자**: developer
- **내용**: 웹 `src/lib/native-auth/*`(policy=스위치·복귀 주소, service=start/browser/finish/failBrowser/consume/cancel, store=`NativeAuthFlow` raw SQL) + `/auth/native/{start,browser,callback,consume,cancel,return}`. 켜짐 = `NATIVE_AUTH_ENABLED=true` + 32바이트 `NATIVE_AUTH_ENCRYPTION_KEY`(`nativeAuthEnabled`, `/api/auth/providers` 의 `nativeApp`). 복귀 주소 운영=`kr.co.upturnlabs.stizdasan://auth/return`, 개발=`stiz-academy(-android)-dev`(개발 서버+개발 스위치일 때만). 복귀 URL 엔 flow·code·state(또는 실패 시 error=no_account/cancelled/failed)만 — 이름 목록은 서버 `NATIVE_BROWSER_FAILURES`·Android `NativeAuthPolicy.FAILURES`·iOS `failures` 세 곳 같게(테스트 고정). Android: `NativeAuthController`(링크 가로채기) → `NativeAuthBrowser`(맞춤 탭, 라이브러리 없이 extra) → `NativeAuthReturnActivity`(release/debug 매니페스트, CLEAR_TOP 으로 탭 닫고 onNewIntent). iOS: `NativeAuthCoordinator`(ASWebAuthenticationSession, Info.plist 등록 불필요). 앱은 기능 든 빌드만 UA 끝에 ` STIZNativeLogin/1` → 웹 `storeAppSocialLogin`(storeApp.ts) 이 버튼/«비밀번호 만들기(/login/forgot)» 안내를 고른다. 아이폰은 Apple 켜져 있을 때만 버튼(4.8). 앱이 가로채는 링크는 정확히 `?intent=login` 하나 — 다른 쿼리를 붙이면 «준비 중»으로 막힌다. 테스트 `tests/native-app-login-production.test.mjs`.
### [2026-11-14] 스토어 앱 알림(FCM) = 기존 발송 함수 2개에 앱 토큰을 «더한다» · 웹이 쿠키로 등록
- **분류**: architecture
- **발견자**: developer
- **내용**: 모든 푸시는 `sendPushToUser`·`sendPushToAllParents`(pushNotification.ts)를 지난다 → 여기서 웹푸시 구독 + `NativePushToken`(FCM, `lib/push/fcm.ts` JWT 직접 서명)을 함께 보낸다. 재시도 id 는 웹=그대로, 앱=`native:<id>`. 키(`FCM_SERVICE_ACCOUNT_JSON`) 없으면 앱 토큰 조회 자체를 안 한다. 앱은 웹 화면에 창구(안드로이드 `StizPushTransport`·iOS `stizPush`)만 열고, 등록은 웹(`NativePushRegistrar`)이 로그인 쿠키로 `/api/push/native`. 로그아웃은 쿠키 `stiz_np`(줄 id)로 이 기기 토큰만. 안드로이드는 google-services 플러그인 없이 build.gradle 이 json 을 읽어 BuildConfig(파일 없으면 알림만 꺼짐), iOS 는 `STIZ/Firebase/` 폴더 참조. 테스트에서 pushNotification.ts 를 불러오면 `@/lib/push/fcm`·`nativePushStore`·`nativePushPolicy` 대역이 필요하다. 상세: docs/native-push.md
- **참조횟수**: 0

### [2026-11-13] 학부모 아이디 규칙 한 곳(parent-username) · 앱 설치 짧은 주소 /install
- **분류**: architecture
- **발견자**: developer
- **내용**: ① 아이디 정규식·정규화·로그인 메일 매핑(`아이디@member.stiz.kr`)·문구는 `src/lib/parent-username.ts`(import 없는 순수 모듈) 한 곳. 신규 가입(parent-signup-verification, 예전 import 위해 re-export)과 기존 학부모 계정 활성화(parent-account-claim)가 같이 쓴다 — 두 서버 모듈이 서로 import 하면 순환이라 따로 뺐다. 활성화는 User 에 `email`=매핑 메일 + `username` 을 함께 적고, 서버 액션은 결과의 `loginEmail` 로 바로 로그인. 예전 이메일 활성화 계정은 로그인 화면이 «@» 든 값을 그대로 써서 하위호환. 이 모듈을 import 하는 서버 파일을 data: URL 로 올리는 테스트는 `"@/lib/parent-username"` 도 바꿔 끼워야 한다(tests/parent-signup-existing-claim). ② 스토어 링크는 `src/lib/app-install-links.ts` 한 곳(PLAY_STORE_URL, `IOS_APP_STORE_ID` 빈 값 = 아이폰 «곧 출시»). `/install` 페이지가 `detectInstallEnvironment` 의 platform 으로 스토어에 바로 redirect. ⚠️ `/app` 은 next.config redirect → `/mypage/install`(홈 화면 바로가기) 짧은 주소라 별개.
- **참조횟수**: 0

### [2026-11-13] 대타 선생님 지정(f4) — ClassSubstitute(날짜·반) + 출석부 경로만 opt-in
- **분류**: architecture
- **발견자**: developer
- **내용**: 표 `ClassSubstitute`(date TEXT "YYYY-MM-DD"·classId·substituteUserId, 유니크(date,classId), RLS). 판정은 `requireStaffClassAccess(classId, ctx, { substituteDate })` 한 곳 — **substituteDate 를 넘긴 경로만** 대타를 본다(수업 시작=date·계획=input.date·requireStaffSessionAccess=기록 날짜·출석부 상세/명단·학생 정보 시트·사진 보기). 공지·연락처·청구는 넘기지 않아 대타에게 안 열린다(테스트로 고정). 홈 목록은 `getSubstituteClassIds(access, dateKey)` 를 합치고 `substitute: true` 행은 «대타» 배지·수업 공지 숨김. 날짜 규칙=`src/lib/staff/classSubstitute.ts`(순수). 관리자 UI=스태프 관리 아래 `ClassSubstitutePanel`(액션 `class-substitute-admin.ts`, requireAdmin+선생님 역할 SQL 재확인). 새 출석부 경로를 만들면 substituteDate 를 같이 넘길 것 — 빠뜨리면 «화면은 보이는데 저장 막힘». 보안 검수 반영: 대타는 **판정 날짜 == 대타 날짜 == 오늘(KST)** 일 때만(`substituteAllowedNow`, 자정에 닫힘·지난 기록 ID 재사용 차단), 판정 시점에 `SUBSTITUTE_TEACHER_SQL` 로 선생님 역할 재확인, 담당(코치) 확인 뒤에만 대타 조회·조회 오류=거부, 그날 특강 회차가 연결된 반은 지정 거부(명단이 특강 기준으로 바뀌어서).
- **참조횟수**: 0

### [2026-11-13] 선생님 출석부 — 체험 아이(trial: 키)·결석 학부모 알림(매분 훑기)·수강료는 원장만
- **분류**: architecture
- **발견자**: developer
- **내용**: ① 체험 아이는 `getStaffSessionStudents` 정규 명단 뒤에 `trial:true`·키 `trial:<TrialLead.id>`(`trialRosterKey`) — 저장은 `saveTrialAttendance` 가 `TrialLead.staffAttendanceStatus` 에만(정규 Attendance·보강권·청구와 분리), 조건은 `trialOnClassDateSql` 하나를 조회·저장이 공유. 출석·지각이면 단계 SCHEDULED→ATTENDED(`trialLeadStatusAfterStaffMark`). 명단 소비처(staff-monthly-fees 등)는 `!s.trial` 로 거른다. ② 결석 알림은 저장 때 보내지 않고 push-outbox 크론이 `sweepAbsenceParentNotices` 로 «결석으로 바뀐 지 3분 지난(Attendance.updatedAt, UTC 칸) 오늘 정규 수강생 · RegularAbsence 없음» 만 골라 `deliverParentNotification`(앱 알림+웹푸시, 문자 없음). 어느 경로로 찍혀도 Attendance 기준이라 bulk 도 자동 포함. ③ 출석부 수강료는 `canSeeStaffFees`(ADMIN·VICE_ADMIN) — 화면 `showFees` + 서버 `getStaffSessionMonthlyFees`(빈 목록)·`getStaffAttendanceBilling`(거부). 강제 `tests/staff-attendance-trial-absence-fees.test.mjs`.
- **참조횟수**: 0
### [2026-11-13] 출시 전 안전장치 — 관리자 화면 가드·cron 실패 알림·스토어 앱 우회 한 곳
- **분류**: architecture
- **발견자**: developer
- **내용**: ① `src/app/admin/**/page.tsx` 는 화면마다 `await requireAdmin()`(레이아웃만 믿지 않음), `adminReadPayloads` export 는 `adminOnly(unstable_cache(...))`(쿠키라 캐시 «바깥»에서 확인) — 강제 `tests/admin-page-auth-guard.test.mjs`. ② cron 은 `async function handleGet` + `export const GET = withCronAlert("이름", handleGet)`(예외·5xx → 원장 슬랙, 같은 cron 1시간 1번: 메모리+데이터 캐시 키) — 강제 `tests/cron-alert.test.mjs`. 라우트 실행 테스트는 `@/lib/cron/withCronAlert` 를 `(_n,h)=>h` 로 가짜. ③ 스토어 앱이 못 하는 일은 `storeAppLacks(cap)`(@/lib/storeApp) 한 곳 · 화면은 `useStoreAppLacks` 훅 · 앱 새 버전이 `/store-app?caps=push,links,...` 로 보내면 자동 해제. 바깥 링크는 `<a data-outside-link>`(영역은 `data-outside-links`) + 루트의 `OutsideLinkListener` 가 «주소 복사 + 안내». 우리 사이트 주소는 통과(`outsideLinkRules`).
### [2026-11-13] 청구서 안내·미납 안내 = 발송 대기열(예약 → 매분 cron → 성공한 건만 sentAt)
- **분류**: architecture
- **발견자**: developer
- **내용**: `sendInvoiceLinksForMonth`·`sendUnpaidReminders`(admin.ts)는 직접 문자를 보내지 않는다. 규칙·계산은 `src/lib/billing/noticeQueue.ts`(prisma import 없음, db·tx 인자 → `tests/billing-notice-queue.test.mjs` 가 가짜 DB 로 실행). 흐름: 계획(planInvoiceNotices/planUnpaidNotices — 알림톡 id 없으면 같은 본문+링크를 문자, 번호 없음=APP_ONLY, 학부모 미연결=unlinked 이름 표시) → 연결표 `BillingNoticeDelivery`(마이그레이션 20261113140000, noticeKey 부분 유일 = QUEUED/SENT/UNCERTAIN/APP_ONLY · FAILED 는 막지 않아 다시 누르면 이어 보냄) + `reserveManualMessageQueue`(items 에 `deliveryId`·`guard` — 호출부 id 로 NotificationDelivery 행을 만들고 dedupeKey 도 id 로 나눈다: 형제 청구서가 같은 번호) → cron `manual-message-dispatch` 가 묶음 발송, `claimManualMessageQueue` 가 guard 있으면 `checkBillingSendRule`(잠금+SmsTemplate·MessageAutomationRule·채널) 재확인해 꺼졌으면 FAILED → `finalizeMessageDeliveryBatch` 끝의 `applyBillingNoticeResults` 가 SENT 인 건만 청구서 sentAt·결제 notifiedAt(미납은 lastReminderAt·reminderCount)을 찍는다. 미납 대상 = 미납 + 마지막 미납 안내 3일 경과 + 예약 중/3일 안 안내 제외, 열쇠 `unpaid:<KST날짜>:<정렬 id>`. 화면 진행 상황 `getBillingNoticeProgress`(같은 noticeKey 최신 행만). ⚠️ 마이그레이션 적용 전에는 발송·진행 조회가 실패한다(표 없음) — 코드보다 먼저 적용.
- **참조횟수**: 0

### [2026-11-12] 스태프 계정 — 직원 기록·로그인 연결·초대로 전환·퇴사 처리
- **분류**: architecture
- **발견자**: developer
- **내용**: 직원 기록(User)과 로그인(Supabase Auth)의 연결 판정은 `src/lib/staff/staffAccountLink.ts` 한 곳(none=직접 추가 `@staff.local`·로그인 없음 / staffLogin=초대 가입 `@staff.stiz.kr`, 로그인 id=authUserId ?? User.id / other=학부모 등 일반 로그인). «이미 있는 직원 기록에 붙는 초대» = `StaffInvitation` SIGNUP + `targetUserId`(새 칸·마이그레이션 없음): 수락 시 새 User 를 만들지 않고 직접 추가 기록에 authUserId·email 을 붙이거나(코치 연결 승계), 퇴사로 학부모가 된 직원 전용 계정의 로그인을 다시 연다(ban 해제+역할 복구). 퇴사 처리(`retireStaffMember`)=한 거래(역할→PARENT·Coach 해제·UserRoleGrant 회수·대기 초대 취소·OperationsAuditLog STAFF_RETIRED) 뒤 직원 전용 로그인+자녀 없음이면 Supabase ban. 권한 판정 캐시(auth-guard getAppUserRole 5분)는 적중 때도 역할을 다시 읽어 다른 서버에서도 즉시 반영. 스태프 화면 덧붙임 조회는 `src/lib/staff/staffPanelData.ts`(추가 역할 직원·초대 문자 마지막 발송=NotificationDelivery eventType STAFF_INVITATION·담당 반=staff-class-access 와 같은 세 배정 표).
  - **[2026-11-12] 원장·부원장 로그인 연결**: 로그인 없는 ADMIN/VICE_ADMIN 기록은 `linkOwnerStaffLogin`(원장 전용·24시간·문자 자동 발송 없음)으로 같은 SIGNUP+targetUserId 초대를 만든다. 받는 역할 판정 = `inviteAuthFailure.invitationRoleAccepted`(의존성 0 모듈이라 역할 집합 복사본, 테스트가 staffAccountLink 와 비교) · 붙이기 허용 = `staffAccountLink.targetedSignupAllowed`(원장·부원장은 초대 역할 = 대상 지금 역할일 때만). 연결 성공 → OperationsAuditLog STAFF_LOGIN_LINKED + 본인 뺀 원장·부원장 알림 벨. 원장·부원장은 `effectiveRoles` 에서 teacher=true·전 반 접근이라 «선생님 역할» 추가 부여가 필요 없다. 역할 변경 UI = `RoleChangeModal`(선택칸 대신 버튼+창, 문구·목록은 `lib/staff/roleChange.ts`). 테스트 `tests/staff-owner-login-link.test.mjs`(서버 액션을 가짜 DB 로 실행).
- **참조횟수**: 0

### [2026-11-10] 알림 시스템 — 알림 구조·학부모 앱 알림 종류별 받기
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-10] 학부모 앱 알림 «종류별 받기» = 웹푸시 발송 함수 한 곳에서 거른다**
    모든 웹푸시는 `src/lib/pushNotification.ts` 의 `sendPushToUser`/`sendPushToAllParents` 를 지나고 payload.tag = 알림 종류(Notification.type·eventType). 그래서 거르기는 거기 한 곳 — `pushCategoryOf(tag)`(src/lib/mypage/parentSettings.ts, ATTENDANCE*/PAYMENT*/NOTICE*/SHUTTLE*) → `ParentNotificationPreference`(학부모당 1줄, 줄 없으면 전부 받기). 끈 사람은 `NO_SUBSCRIPTION`+`PUSH_OPTED_OUT`(대기열은 SKIPPED). 표 조회 실패 = «보낸다»(운영 적용 전에도 알림 안 끊김). 종 목록(Notification)은 거르지 않는다 — 끄는 건 휴대폰 울림만. 새 알림 종류를 «끌 수 있게» 하려면 pushCategoryOf 만 고친다.
  - **[2026-03-29] 알림 시스템 아키텍처**
    알림 시스템은 2계층 구조. (1) DB 인앱 알림: Notification 테이블에 INSERT -> 사용자가 /mypage 접속 시 조회. (2) 웹 Push: PushSubscription 테이블에 저장된 구독으로 web-push 라이브러리가 브라우저 푸시 발송. createNotificationRecord(admin.ts:1080)가 두 계층을 동시 처리. 관리자 알림 패턴: SELECT id FROM "User" WHERE role='ADMIN' -> for loop으로 각 관리자에게 createNotificationRecord 호출 (createParentRequest:1188에 구현됨). sendPushToUser(pushNotification.ts)는 VAPID 키로 서명, 구독 만료(410) 시 자동 삭제. Coach 모델에 userId 없어 코치에게 직접 알림 불가.
- **참조횟수**: 0

### [2026-11-10] 정규 수업·출결 — 같은 반·같은 날 하나·상태/개시일 분리·기간 결석·정규 보강권
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-10] 정규 보강권 = 출처 둘(결석 신고·출결) · 키 하나 `REGULAR:{classId}:{YYYY-MM-DD}`**
    신고 즉시 발급(`makeup/absence-report-credit.ts`, 호출부 tx 안)과 출결 발급(`credit-service.syncCreditForRegularSession`)이 같은 sourceKey 를 쓴다 — 세션 id 가 키에 없어 신고 시점에도 키가 정해지고 ("studentId","sourceKey") 유니크로 한 장. 두 INSERT 모두 `ON CONFLICT DO UPDATE … WHERE status='REVOKED' AND makeupSessionId IS NULL` 로 «회수된 같은 결석»만 되살린다. 신고 취소 = `decideCreditOnAbsenceCancel` 표(학부모: 미사용 회수·예약은 확인 후 예약 취소+회수·사용 완료/지난 예약은 막음 / 관리자: AVAILABLE 만 회수 / 출결 ABSENT 면 유지). 키 형식을 바꾸면 parent-timeline·parent-regular-absence 의 SQL 문자열 조립도 같이 바꿀 것.
  - **[2026-11-09] 수강 «상태»와 «개시일»의 역할 분리 — 공용 판정 commencement.ts 한 곳**
    원장 기준(11-09) — Enrollment ACTIVE 면 승인(등록)일부터 «수강 중/재원생». 판정은 `src/lib/enrollment/commencement.ts` 의 `isCurrentEnrollment`(TS)·`currentEnrollmentSql(alias)`(SQL) 한 곳(학생 상태 queries.ts current_status·인원 집계 adminReadPayloads·대관 재원생 listRentalMemberStudents·관리자/학부모 화면). `enrollmentDisplayStatus` 는 이제 status 그대로(SCHEDULED 없음), 개시일 미래 안내는 `enrollmentStartsLater`/payload `startsLater` 로만. 개시일(startsOn)을 쓰는 곳은 ① 청구 시수(billing/workbench-service) ② 출석부 회차 명단(staff-session-queries·staff-class-people·staff-sessions·SessionLogModal `enrollmentHasStarted`) ③ 셔틀 월 배차(driverAssign·shuttle-progress-query) ④ 다음 수업 안내(mypage/summary computeNextClass) 뿐 — 상태·인원 판정에 다시 쓰지 말 것(가드: tests/enrollment-current-rule.test.mjs). 반 줄 편집(반 이동·잘못 등록 삭제)은 `lib/enrollment/admin-enrollment-edit.ts`(순수 판정+연결 기록 수)·`actions/enrollment-admin-edit.ts`.
  - **[2026-11-09] 관리자 «기간 결석» = 기간 행(RegularAbsencePeriod) + 날짜별 RegularAbsence(periodId)**
    부상·질병은 휴원 대신 기간 결석. 수업일 계산은 순수 `src/lib/regular/absence-period-plan.ts`(연간 일정은 `getMonthlyClassDates` 를 함수 인자로 받음 — 그 파일이 queries 를 import 해서), SQL 은 db 인자 연결부 `absence-period-service.ts`(전역 잠금 `lockCompensation`), prisma·캐시는 `absence-period-runner.ts`. 기간 행 note 머리말 `기간 결석 · ` + reportedByUserId NULL 로 알림 재조정이 거른다(복귀·취소 때 기사·코치 «결석 취소» 알림 방지). 복귀 미정은 coveredUntil 을 KST 다음 달 말일까지, 매일 크론이 늘림. 연간 일정에 없는 달은 추측 안 하고 멈춤.
  - **[2026-11-08] 정규 수업 기록 «같은 반·같은 날 = 하나» = regularSession.ts 한 곳 · 보강 온 아이 출석 = makeup-attendance.ts**
    정규 Session 자연키는 `regularSessionKey(반id, YYYY-MM-DD)` 하나. 관리자 출결(saveAttendance)·수업일지(saveSessionLog)·랠리즈 반영은 `findOrCreateRegularSession(tx, …)`, 코치 «수업 시작»·«예정 내용»은 `adoptRegularSessionKey(tx, …)`+`regularSessionKey`(모두 트랜잭션 안·키별 advisory 잠금). 키 없는 옛 기록은 «입양»(키를 붙임)해 둘로 갈라지지 않는다. Session 을 새로 만드는 경로를 추가하면 반드시 이 파일을 거친다(테스트 `regular-session-single-record` 가 admin.ts 의 키 없는 INSERT 를 막음). 보강: 코치 출석부 명단은 `makeupOnClassDateSql`(makeupDate timestamptz 에 시간대 한 번)로 이 반·이 날 BOOKED/ATTENDED 예약 아이를 «보강»으로 붙이고, 출결 저장도 같은 조건으로 판정 → `applyMakeupAttendanceInTx`(lockCompensation·FOR UPDATE·조건부 UPDATE) 뒤 기존 `syncCreditForMakeupSession`(ATTENDED→USED·BOOKED→RESERVED). 출석·지각=참석(같은 날 한 건만), 결석=보강권 안 씀·참석이었으면 되돌림. 보강 아이는 `syncCreditForRegularSession`(결석 보강권 발급)을 타지 않는다.
- **참조횟수**: 0

### [2026-11-10] 체험 — 체험↔수강 신청서 연결·체험비 온라인 결제
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-10] 체험비 온라인 결제 = 결제 링크 토큰 + 별도 표(TrialFeePayment), 토스 호출·면세·가상계좌 판정은 청구 것 재사용**
    체험 신청자는 원생·로그인이 없어 PaymentTransaction(청구·청구서·학생 id 필수)을 못 쓴다 → `TrialFeePayment`(마이그레이션 20261110150000, 신청당 DONE 1건·WAITING 1건 부분 유일 인덱스, FK ON DELETE SET NULL). 권한 = 신청 직후 발급하는 결제 링크 토큰(32바이트, `TrialLead.paymentTokenHash` 해시만 저장, 원문은 신청 완료 응답에만) → `/apply/trial/pay/[token]`. 순수 규칙 `src/lib/trial-fee/trialFeeRules.ts`, 장부 `trialFeeLedger.ts`(db 인자, 가짜 DB 테스트), 실행부 `trialFeePaymentService.ts`(payment-ledger 의 getVerifiedTossPayment·encodeTossSecret·makeUuidFromSeed·readTossErrorMessage 를 export 해 재사용). 토스 웹훅은 같은 주소에서 주문번호 `TRIAL-` 이면 `recordTrialFeeTossWebhook` 으로 갈라진다. `trialFeeConfirmed=true` 쓰기는 여전히 `trial-fee-confirmation.ts` 한 곳(가드 테스트) — 온라인 확정·환불 반영 함수도 거기 있다. 설정 `AcademySettings.trialFeeAmount·trialOnlinePaymentEnabled`(기본 꺼짐 = 예전 계좌 안내). 체험·등록 안내 초안 `guideMessages.ts`(코치 = 슬롯 키→Coach.phone, 기사 = DRIVER 역할 User.phone) — 자동 발송 스위치 2개 기본 false + 문자 규칙 isActive=false(원장 승인 전 미리보기만). 원생 등록 액션은 «문자 없음» 테스트가 있어 등록 안내를 거기에 연결하지 않았다.
  - **[2026-10-23] 체험(TrialLead) ↔ 수강 신청서 연결은 판정 모듈 + 연결부 한 곳에서**
    연결 판정은 순수 모듈 `src/lib/enrollment/trialLeadMatch.ts`(`decideTrialLeadMatch` → AUTO/SUGGEST/NONE, 한글 음절 편집거리), DB 읽기·저장은 `src/lib/enrollment/trialLeadLinkService.ts` 한 곳(`linkTrialLeadToApplication` = 조건부 UPDATE 한 트랜잭션, 승인된 신청서면 체험 CONVERTED, ApplicationContactLog UPDATED 2줄, 문자 없음). 비교 시점 3곳: 신청 제출(`submitEnrollApplication`, accessCode 없을 때 AUTO 만), 체험 이름·번호 수정(`updateTrialLead` → `autoLinkApplicationsForTrialLead`), 관리자 신청 목록 후보+[연결](`getEnrollTrialLinkSuggestions`/`linkEnrollApplicationToTrialLead`). 새 연결 경로를 만들면 SQL 을 또 쓰지 말고 이 두 파일을 쓴다. 테스트 `tests/enrollment-trial-lead-match.test.mjs`.
- **참조횟수**: 0

### [2026-11-10] 휴원 수강료 처리(이월·환불·없음)
- **분류**: architecture
- **발견자**: developer
- **신청함 연결(통합 11-10)**: 신청함 행에는 미리보기가 없어 «변경» 탭 상세 칸을 열 때 `getPauseTuitionPreview`(관리자 서버 액션)로 받는다. 규칙·문구는 `src/app/admin/inbox/PauseSettlementBox.tsx` 에 한 벌 더 있고(수강 변경 화면을 쪼개면 문구 고정 테스트가 깨져서), `tests/inbox-consult-pause-wiring.test.mjs` 가 두 화면 문구가 같은지 비교한다 — 한쪽 문구를 바꾸면 양쪽을 같은 커밋에서. 승인 후 남은 일(사람 환불·토스 재시도·이월 직접 차감)은 신청함에서 처리하지 않고 «변경» 탭 위 경고 줄 → 수강 변경 화면(`?status=ALL`)으로 보낸다.
- **원래 제목**: [2026-11-10] 휴원 수강료 처리(이월·환불·없음) = 순수 계산(pause-settlement-plan) + db 인자 실행부(pause-settlement) + 표 2개
- **내용**: 금액 = 그 청구 금액 ÷ 그 수강월 그 반 수업 수(getMonthlyClassDates) × 빠지는 수업(휴원 시작 ≤ d < 복귀일), 청구마다 한 번 반올림 — 결석 이월(workbench-absence)과 같은 기준. 승인(`decideEnrollmentChangeRequest` settlement?)과 처리는 한 트랜잭션(전역 STIZ_BILLING_WORKBENCH 잠금 + 신청별 advisory + 신청·청구 FOR UPDATE + 미리보기 지문 대조), 미납 감액은 조건부 UPDATE(0원=CANCELED). 토스 온라인 환불은 커밋 뒤 `partialRefundTossPaymentByAdmin`(줄 REQUESTED → 재조회 cancels[] 표식 `STIZ-PR:<줄 id>`·고정 멱등 키로만 DONE), POS·무통장·랠리즈·현금은 사람 할 일(TODO → «직접 처리함»). 이월은 `carryRemaining` 을 매일 크론(/api/cron/enrollment-changes)이 carryAfterYm 뒤 미납 청구에서 차감. 기록 = `EnrollmentChangeSettlement`(신청당 1행)·`…Line`(마이그레이션 20261110180000). 학부모 알림 한 줄은 notify 가 처리 기록을 읽어 붙인다. 휴원 시작일 최소값 = `earliestPauseStart`(changeRequestRules, import 없음 — today·nowHm 인자).
- **참조횟수**: 0

### [2026-11-09] 학부모 앱 구조 — 탭 4개·앱 범위(/mypage)
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: [2026-11-09] 학부모 앱 = 탭 4개(홈·일정·청구·소식) 한 목록 + 앱 범위(/mypage) 안 상세
- **내용**: 메뉴는 `src/app/mypage/MyPageBottomNav.tsx` 의 `PARENT_TABS` 하나(휴대폰 아래 탭·PC 헤더 `variant="top"` 공용), 소속 하위 화면은 `also`(일정 = regular-absence·makeup·seasonal·shuttle·enrollment-change, 소식 = news). 일정 = `/mypage/history`(11-09 개편: «확인하는 곳» — 한 달 달력(`?month=YYYY-MM`·`?child=`, 서버 렌더) + 행사·휴무 + 수강 반 + 셔틀 배정. 계산은 순수 `src/lib/mypage/parentSchedule.ts`, 수업일은 `getMonthlyClassDates`(/annual·청구와 같은 함수)를 앞·이번·다음 수강월로 불러 이 달만. **수납·신청 줄 없음** — 수납=청구 탭, 신청=홈 빠른 실행, 수강 변경 신청=«⋯» 메뉴. `HistoryClient` 삭제), 청구 = `/mypage/payments`, 소식 = `/mypage/reports`(공지는 3개월 이내·3개+«더보기», 리포트·피드백·사진, 칩은 같은 화면 앵커). 홈 = 납부 합계 한 줄(`PAYMENT_HOME_HREF` — 묶음 결제 때 이 주소만 교체) + 처리할 일 + 빠른 실행 4, 접힌 칸(details) 없음. 셔틀 배정 상세는 `ParentShuttleDetail`. 설치 앱 scope=/mypage 라 공지 상세는 `/mypage/news/[id]`(전체 공지·우리 아이 반 공지만, 아니면 404) — 공개 `/notices/[id]` 로 링크하지 말 것. 로그아웃은 `ParentMoreMenu`(⋯) 안.
- **참조횟수**: 0

### [2026-11-09] 문자·알림톡 발송 — 학부모 공지 대량 큐·안내 문자 승인 발송·대관 알림톡·학부모 알림톡 금고
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-12] 수강료 청구 알림톡 = 별도 금고 BILLING_ALIMTALK_TEMPLATES(버튼 있는 틀)**
    청구서 발행(원장 승인)·미납(초안) 2종. 버튼 있는 틀은 `body`=알림톡 등록 문구, `smsBody`=본문+«청구서 확인하기: 링크». 발송부 `alimtalk.text`·`alimtalk.buttons`(선택)로 알림톡엔 text, 문자 대체엔 body 가 간다(`sendParentSmsWithResult` 5번째 인자 prepared). env id 가 비면 «지금 동작 그대로»(청구서=앱 알림만, 미납=옛 DB 문자) — 9종처럼 문자 본문을 바꾸지 않는다. 발송 잠금(BILLING_PARENT_SEND_ENABLED) 뒤. 테스트 tests/billing-alimtalk-templates.test.mjs(가짜 fetch 로 발송부 실행).
  - **[2026-11-09] 학부모 공지 = 대량 큐의 «받는 사람마다 다른 본문» 항목(알림톡·브랜드 메시지·문자)**
    대량 발송 큐 `reserveManualMessageQueue` 에 선택 인자 `items`(사람별 body + kakao{ALIMTALK|BMS_FREE})·`requestedChannel` 을 더했다. items 가 있으면 payload 에 `perItem:true` 가 실려 크론 `manual-message-dispatch` 가 `sendPerMessageBulkDetailed`(솔라피 send-many 에 메시지별 type ATA/BMS_FREE/SMS)로 보낸다 — 없으면 예전 «공통 본문» 경로 그대로(BATCH_BODY_MISMATCH 검사 유지). 카카오가 명시 거절하면 같은 내용을 문자로 1회, 응답 불확실은 재시도 금지. 장부 channel 칸은 DB CHECK 때문에 BMS 를 못 넣어 SMS 로 두고 종류는 messageType=BMS. 공지 틀은 `NOTICE_ALIMTALK_TEMPLATES`(자동 트리거 9종과 분리), 순수 규칙 `src/lib/messaging/parent-notice.ts`, 서버 `src/app/actions/parent-notice.ts`(미리보기→승인 재계산, OperationsAuditLog PARENT_NOTICE_*).
  - **[2026-11-09] 학부모 알림톡 = 공용 금고 parent-alimtalk-templates.ts (대관 패턴 일반화)**
    알림톡으로 바꾼 학부모 트리거는 `src/lib/messaging/parent-alimtalk-templates.ts` 의 `PARENT_ALIMTALK_TEMPLATES`(#{한글변수} 틀 + 호출부 키 연결 + 기본값)가 정본이다. 문자 본문 = 알림톡 본문. `notification.ts resolveParentMessage` 가 `sendParentSms`·`sendParentSmsWithResult`(체험·셔틀)와 `seasonal/notifications.ts`(특강, `dispatchReservedSmsDelivery({alimtalk})`)에서 금고 틀을 쓰고, 빈 변수면 옛 DB 문구로 «문자만» 보낸다. DB `SmsTemplate` 은 isActive 스위치 + 대체 문구 + 화면 표시용(/admin/sms 문구 화면은 금고 트리거 본문 수정 잠금). 템플릿 id = env `ALIMTALK_TPL_*`(alimtalk-config.ts). 가드 `tests/parent-alimtalk-templates.test.mjs`: 코드의 `*_PARENT`/`*_APPLICANT` 문자열은 금고 또는 `SMS_ONLY_PARENT_TRIGGERS` 에만 — 새 학부모 문자를 만들면 둘 중 하나에 넣어야 테스트가 통과한다. 머리말 상수 `PARENT_MESSAGE_PREFIX`(«[스티즈농구교실]»). 심사 문서 `docs/kakao-alimtalk-parent-templates.md` 는 테스트가 글자 대조.
  - **[2026-11-08] 대관 신청자 문자 = 알림톡 틀 하나(틀+변수 → 문자 본문·알림톡 variables 동시 생성)**
    `gym-rental-rules.ts` 의 `RENTAL_APPLICANT_TEMPLATES`(#{변수} 틀) + `buildRentalApplicantMessage` 가 본문과 variables 를 같은 맵에서 만든다(알림톡은 등록 문구와 한 글자라도 다르면 실패). 발송은 `sendTrackedSms({ alimtalk })` → notification.ts 가 `sendMessageDetailed` 에 그대로 전달(장부 유지, 다른 호출은 alimtalk 없음 = 기존 문자). 템플릿 id 는 env `RENTAL_ALIMTALK_*`, 실제 알림톡 시도는 /admin/sms 규칙 채널이 알림톡 + 외부 알림톡 채널 켜짐 + SOLAPI_KAKAO_PF_ID 일 때만. 심사 문서 `docs/kakao-alimtalk-rental-templates.md` 는 테스트가 틀과 글자 대조. 재원생 무료 = 로그인한 PARENT 계정(getVerifiedParentState 통과)의 «내 자녀»(`childAccessSql("s","$1")` — 가족 공유·본인 연결 포함) 중 재원(병합 제외+시작된 ACTIVE 수강+끝난 반 제외) 학생만(`listRentalMemberStudents`). 이름·번호 대조는 쓰지 않는다(맞히기 공격). 공개 /rental 은 정적 유지, 로그인 여부는 액션 `getRentalMemberContext` 로 묻는다.
  - **[2026-11-07] 고객 안내 문자 = 공용 «미리보기 → 원장 승인 → 1건 발송» 한 벌**
    문구는 `src/lib/customer-notice/templates.ts`(import 없는 순수 함수), 서버는 `src/app/actions/customer-notice.ts` 의 prepareCustomerNotice/sendCustomerNotice, 화면은 `src/components/admin/CustomerNoticeSender.tsx`(kind 별 props). 승인 기록은 OperationsAuditLog(CUSTOMER_NOTICE_PREVIEW/CLAIMED/RESULT, 번호·문구는 해시만), 발송은 관리자 수동 문자와 같은 장부(MessageDeliveryBatch·NotificationDelivery, trigger MANUAL_MESSAGE, eventType=kind). 새 안내를 늘릴 때는 kind 하나 + resolveNotice 분기 + 문구 함수만 추가한다. 카카오채널 주소는 `kakaoChannelLinks(settings.kakaoChannelUrl)` 로만 만든다.
- **참조횟수**: 0

### [2026-11-09] 셔틀 기사님·배차 화면 — 운행 화면 통합·새 학생 배정·정규배차 시간순·하나의 운행표·정본=명단
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-13] 기사님 운행 링크 스위치·링크 새로 만들기 (f5)**
    토큰 = `ShuttleRunLink.token`(정규 ROLLING/REGULAR·특강 ROLLING/ALL·특강 날짜별, 32자 16진수). 스위치 `AcademySettings.driverRunLinkEnabled`(기본 true, 마이그레이션 20261113220000). 판정 한 곳 `src/lib/shuttle/driverLinkAccess.ts`: 토큰 API 는 토큰 확인 **다음에** `driverLinkBlocked()`(꺼짐 + 셔틀 권한 로그인 아님 → 410 `DRIVER_LINK_DISABLED`), 화면은 `UnifiedDriverRunPage` 가 명단 읽기 전 확인(`viaAccount` 는 권한 확인한 `/staff/run` 만). 로그인 계정 화면도 같은 토큰으로 API 를 부르므로 «로그인 셔틀 권한이면 통과»가 필수 — 빼면 링크를 끄는 순간 계정 운행표의 탑승 체크가 깨진다. 재발급 `rotateDriverRunLinks` = 앱 세션 삭제(외래키 ON UPDATE 없음) → 옛 위치 공유 끔 → 모든 행 토큰 교체(한 트랜잭션). 예외 = `/api/driver/mobile/session`(위치 쓰기 전용·안드로이드 앱이 쿠키 없이 Bearer 로 부름 → 걸면 로그인 기사님 위치 전송이 멈춤, 옛 열쇠 차단은 재발급이 담당). 새 토큰 API 를 만들면 `driverLinkBlocked()` 를 넣어야 한다(가드: tests/driver-link-toggle.test.mjs 가 `src/app/api` 를 훑는다).
  - **[2026-11-14] 기사님 운행표 잠금 = 학부모 셔틀과 같은 규칙(regularRunDayRules)** (참조횟수 0, developer)
    휴원·퇴원·첫 수업 전·휴무 줄은 명단에서 빼지 않고 회색 뱃지 + 탑승·미탑승 disabled. 순수 `src/lib/shuttle/regularRunDayRules.ts`(childShuttleRules 의 enrollmentStateOn·matchRosterClass + parentSchedule.classDatesForCalendarMonth 재사용) → 서버 재료 `regularRunDay.ts`(명단 학생 반 일괄 조회 · loadAnnualPlanEvents) → `getRegularDriverDay`(섹션 + holiday) → 줄 `blockedLabel`(attachRiderBlocks). 진행률·«정차 안 해도 됨»에서 잠긴 줄 제외(riderBoardingView.blocked). 저장 API 2곳(토큰·직원)은 `boardingRejectedForBlock` 로 409(null 되돌리기만 허용, 토큰 쪽은 명단 확인 실패 시 종전대로 저장). 관리자 운행표는 같은 blockOf 로 뱃지만 + 요일 탭 아래 «이 달 휴무». 휴무 필드는 `title`(«reason» 은 결석 사유 가드 테스트가 막는 단어). 모르면(일정 확정 전·반 못 찾음·학생 id 없음) 잠그지 않는다. 테스트 tests/driver-paused-holiday.test.mjs.
  - **[2026-11-09] 정규 셔틀 «하나의 운행표» — 명단 정본·관리자=기사님 같은 부품**
    운행 정본은 `RegularShuttleStop`(명단) 하나. 기사님(`regularDriverRoute.ts`)·관리자(`admin/shuttle/regular-dispatch/RegularRunEditor.tsx`)가 같은 순수 조립 `buildRegularRunRows`(lib/shuttle/regularRunRows.ts)와 같은 카드 틀 `RunBoard`(mode driver|admin)·같은 CSS(DriverWorkspace)를 쓴다. 저장 노선(`RegularDispatchRoute`)은 읽지 않음(테이블은 남김, 흡수 SQL 은 PM). 관리자 편집은 모두 `/api/admin/shuttle/regular-roster`(reorder 묶음별·editStop·editStudent·DELETE 범위), 반 이동 재배정은 배정 보드(`/api/staff/shuttle/assign` reassign:true). 바뀌면 서버가 기사님께 «노선 확인하기»(`/staff/run?date=&focus=BOARD|ALIGHT`) 알림. 관리자 화면에 자체 묶음·자동 제안을 다시 만들지 말 것(가드: tests/regular-roster-driver-view.test.mjs). **11-09 2차**: 화면 묶음(블록 머리 «16:00~17:00 수업 · 등원»)은 RunBoard 안에서 순수 `lib/shuttle/runBlocks.ts`(groupRunBlocks = 이어지는 같은 groupKey 만 자름·순서 불변, 끊기면 «이어서»)로 — 기사님·관리자 공통이고 정렬은 건드리지 않는다. 관리자 편집 카드는 한 줄(styles.stop 2칸 격자 안 씀)·끌기는 떠다니는 카드+삽입선(`data-drop-line`)+놓을 때 한 번 onDropOn+FLIP 애니메이션, PC(≥1024) 오른쪽 sticky 지도 = `RouteMapCanvas` 재사용(블록 머리로 묶음 선택, 마커 번호 = 카드 순번). 가드: tests/shuttle-run-blocks.test.mjs.
  - **[2026-11-09] 정규 셔틀 정본 = 명단 — 저장 노선 읽기 지점 0 (통합 6단계)**
    학부모 확정 시각(lib/shuttle/regularRosterEta)·안내 문자/배차 진행(enrollment/shuttle-progress: buildStudentRouteNotice·studentRosterFingerprint)·신청 검토 지문(routes=[] 고정)·결석/셔틀 기사 알림(operational-staff-notification: 그날 명단에 학생 있으면 기사 역할 전원)·월 복사·기사님 순서 저장 API 가 모두 RegularShuttleStop 만 읽는다. RegularDispatchRoute 는 /api/admin/regular/dispatch/saved(부르는 화면 없음)와 regularDispatchRoute.ts 저장 함수에만 남음(테이블 삭제는 별도 결정). 명단 달 고르기는 «그 달 이하 최신 달»(SQL max ≤ 월 = pickServiceMonthFor).
  - **[2026-11-05] 기사님 「새 학생 배정」 = 순수 판정(driverAssignLogic)+연결부(driverAssign)+addRosterStudentAs**
    `/staff/shuttle/assign` 은 승인 셔틀 신청(APPROVED+shuttleNeeded)+ACTIVE 수강(개시일 ≤ 그 달)의 「남은 칸(요일×등·하원)」을 관리자 학생 추가와 같은 함수(enrolledClassSlots·findRouteCell·suggestPlacement·resolveCellPlacement)로 계산한다. 쓰기는 `regularRosterEdit.addRosterStudentAs(actorId, raw, { via, guard })` 하나 — ⚠️ 이 함수는 권한 확인을 하지 않으므로 호출부가 현재 DB 역할을 먼저 확인한다(원장 = addRosterStudent 의 requireAdmin, 기사 = driverAssign.authorizeAssign). guard 는 달 잠금 안에서 「그 칸이 아직 비었는지」 마지막 확인. 감사 기록은 ShuttleAuditLog REGULAR_ROSTER_ADD(actorId=기사 userId, afterJSON.via="DRIVER_ASSIGN").
  - **[2026-11-05] 정규배차 시간순 화면 = 두 RouteSection(방향별 상태·저장) + display:contents + CSS order**
    `/admin/shuttle/regular-dispatch` 는 등원·하원 RouteSection 을 `timeOrdered` 로 한 flex 목록에 넣는다. 섹션 겉 상자·카드 그리드는 `contents` 로 풀리고 회차 카드마다 `order = runTimelineOrder()`(`lib/regular/regularDispatchOrder.ts`: **실제 출발 시각 departTime(손 수정 반영)** → 없으면 등원 classStart−30분·하원 classEnd → tripLabel → 맨 뒤, 「수업시간 확인 필요」 회차는 맨 뒤, 같은 시각이면 등원 먼저. ⚠ 처음엔 수업 시작/종료를 기준으로 써서 17시 수업 등원(16:35 출발)이 16시 수업 하원(17:05 출발) 뒤로 갔다 — 운영에서 원장이 지적, «시간순» = 차가 움직이는 순서). 저장 바(-2/-1)·지도(1e7)도 order 로 배치. 상태를 끌어올리지 않고 섞지만 **탭 이동 순서는 DOM(등원 전부 → 하원 전부)**. 방학특강(DispatchClient)은 prop 을 안 줘 DOM 그대로 — `timeOrdered` 분기 밖을 고치면 방학특강도 바뀐다.
  - **[2026-11-05] 신규 셔틀 학생 배정 = 정규배차 패널 + 공용 한 칸 배정(AssignLegView) 하나**
    관리자 「신규 셔틀 신청」 탭은 폐지(`/admin/shuttle/intake` → `/admin/shuttle/regular-dispatch?month=` redirect). 정규배차 요일 탭 아래 `NewStudentDispatchPanel`(목록 기준 = `getDriverAssignBoard`, 기사 검토 배지·요청 = 기존 `/api/admin/shuttle/intake`)이 칩 → 모달로 `AssignLegView` 를 띄운다. 기사님 `/staff/shuttle/assign` 도 같은 `src/components/shuttle/assign/AssignLegView.tsx` 를 쓴다 — **한 칸 배정 UI를 고칠 땐 이 파일 하나**(사본 금지, 테스트가 `function AssignView(` 부재 확인). 넣기 API 는 둘 다 `/api/staff/shuttle/assign`(관리자도 requireStaff·authorizeAssign 통과), 감사 via 는 관리자 역할 + body.source="ADMIN_DISPATCH" 일 때만 ADMIN_DISPATCH. 넣은 뒤 RouteSection 은 `refreshKey`(월×1000+횟수)로 다시 읽되 저장 안 한 편집(dirty)이 있으면 덮지 않는다. 기사 검토 화면(ShuttleIntakeClient driver 모드)은 그대로.
  - **[2026-08-06] 기사님 운행 화면은 통합 1개 — 라우트 3개는 껍데기, 저장 경로만 2벌 유지**
    `/shuttle/run/[token]`·`/shuttle/regular/[token]`·`/driver/[token]` 3개 라우트는 전부 `components/shuttle/UnifiedDriverRunPage.tsx`(서버) 한 곳으로 위임한다(각 라우트는 token+date 파싱 10줄). 화면은 그날 방학특강+정규를 **출발 시각 오름차순 한 목록**으로 그린다(행 = 정차 1개). 병합·정렬은 의존성 없는 순수 모듈 `lib/shuttle/unifiedDriverRunLogic.ts`, 서버 조회 조립은 `lib/shuttle/unifiedDriverRun.ts`. **화면만 합치고 저장은 절대 합치지 않았다** — 행마다 `kind`를 들고 다니며 특강 행은 `/api/shuttle/boarding`(direction+shuttleRequestId), 정규 행은 `/api/shuttle/regular-boarding`(rowId)로 **기존 파라미터 그대로** 간다. 화면 상태 키만 접두사(`S:PICKUP:`/`S:DROPOFF:`/`R:`)로 합치고 저장 시 원래 키로 되돌린다. 운영 DB에는 `ShuttleRunLink` 가 ROLLING/ALL(특강) 1건뿐이고 ROLLING/REGULAR(정규)는 **없다** → 기사님은 특강 링크 하나만 쓴다. 그래서 두 저장 API의 토큰 판정을 `lib/shuttle/driverToken.ts`(`isAnyDriverRunToken`)로 넓혔다(판정 함수 자체는 기존 `resolveRunToken`/`isRegularRunToken` 재사용, 저장 키·테이블·파라미터 무변경).
- **참조횟수**: 0

### [2026-11-09] 셔틀 명단·판정 규칙 — 식별키 두 벌·중간 삽입·명단 점검·운행 반 판정·정류장 추천·명단 편집 알림
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-09] 셔틀 운행 반 판정 = classRunsShuttle 한 곳(청구·배차 칸·신청 검토·진행 표시)**
    `src/lib/billing/workbench-pricing.ts` 의 `classRunsShuttle({dayOfWeek, runsShuttle})` = Program.runsShuttle=true + 평일(월~금). 청구 셔틀비(regularShuttlePlan)·신규 배차 남은 칸(`src/lib/shuttle/driverAssign.ts` loadStudents)·셔틀 신청 검토(`shuttle-review-query.ts` context)·배차 진행(`shuttle-progress-query.ts`)이 같이 쓴다. 수강 조회 SQL 에 `p."runsShuttle"` 를 꼭 같이 읽을 것(빠지면 미운행으로 봐 칸이 사라짐). 아직 안 쓰는 곳: 관리자 명단 «학생 추가» 칩(regularRosterEdit getRosterStudentContext)·명단 수강 점검(getRosterEnrollmentCheck). workbench-pricing 은 테스트가 data URL 로 읽어 import 를 둘 수 없다 — 판정을 다른 파일로 옮기지 말 것.
  - **[2026-11-09] 셔틀 «기존 정류장 추천» = stopNameMatch.pickNearbyStop 한 곳(장소명 출입구 일치 우선)**
    반경(300m) 안 기존 정류장 추천은 `src/lib/shuttle/stopNameMatch.ts` 의 `pickNearbyStop` 하나로 정한다 — ① 장소명에 출입구 단어(정문·후문·맘스테이션…)가 있으면 같은 단지(앞부분 이름 유사)+같은 출입구 정류장을 거리 무관 1순위 ② 아니면 가장 가까운 곳. 쓰는 곳: `regularRosterPlacementLogic.suggestPlacement` ②(관리자 학생 추가) · `driverAssignLogic.planLeg`(기사님 새 학생 배정 + 관리자 정규 배차 신규 배차 칸, 다른 요일 정류장 포함). 정확히 같은 이름 합류(①)는 기존 normalizeStopName 그대로 먼저. 셔틀 신청 검토(shuttle-review)는 정류장 추천이 없다.
  - **[2026-11-09] 정규 셔틀 명단 편집 → 기사님 알림 · 반 이동 재배정 · 위치 반영 (통합 2단계)**
    명단 쓰기 함수(`regularRosterEdit.ts` add/remove/move/editStop/reorder/editStudentRoster)는 트랜잭션 안에서 `notices` 에 담고 **커밋 뒤** `flushNotices` → `regularRosterNotify.notifyDriversOfRosterChange`(DRIVER 역할 전원·바꾼 본인 제외, `deliverOperationalNotification` 인앱+푸시, 실패는 삼킴). 문구·링크(`/staff/run?date=<그 달 다음 운행일>&focus=BOARD|ALIGHT`)·10분 묶음 키는 순수 `regularRosterNotifyLogic`. 옛 `notifyOperationalStaff includeDriver` 는 저장 노선에서 기사를 찾아 쓰지 않는다. 반 이동 판정은 순수 `regularReassignLogic.planStudentReassign`(옛 칸+새 칸 둘 다 있을 때만) → 보드 `driverAssignLogic.buildAssignBoard`(명단 학생 hasApplication=false 도 재배정만) → 저장 `reassign:true` → `addRosterStudentAs({replaceRowIds})` 한 트랜잭션(옛 행은 서버가 다시 계산). 학생 상세 위치 저장(`service.updateStudentShuttleLocation`)은 장소명 필수 + 같은 tx 에서 `applyLocationToRosterInTx`(이번 달부터, 300m 이름 일치 정류장 합류·아니면 새 위치, 행 id 유지 UPDATE).
  - **[2026-11-08] 셔틀 명단 점검·카카오 셔틀 신청 할 일 = 순수 판정 + 기존 표 상태값(새 표 없음, 자동 삭제 없음)**
    ① 명단 수강 점검 `src/lib/shuttle/regularRosterEnrollmentCheckLogic.ts`(다니는 반 없음·수업 없는 요일·한쪽만) — 서버 `getRosterEnrollmentCheck` 는 그 달 명단 학생의 지금 Enrollment(ACTIVE/PAUSED)와 자동 생성 달 여부만 읽고 판정은 화면에서. 월 넘김 확인 = 수동 복사 전 confirm(`rosterCopyWarningText`) + 자동 생성 달 «확인했어요» = `ShuttleAuditLog` action `REGULAR_ROSTER_MONTH_REVIEWED`(자동 생성 기록 `REGULAR_ROSTER_AUTO_MONTH` 와 짝). ② 카카오 정규 셔틀 신청(START) 할 일 `src/lib/kakaoShuttleRosterTask.ts` — 완료 = `KakaoParentIntake.structuredJson.rosterTask.doneAt` + 결정 전 상태면 APPLIED(이관 APPROVED 는 유지) + 감사 `SHUTTLE_ROSTER_DONE`. 명단 추가는 기존 `/admin/shuttle/regular?month=&studentId=` 딥링크(«신청 학생 선택해 명단 추가») 재사용.
  - **[2026-10-03] 셔틀 명단 중간 삽입은 「다음 정차 첫 행 앞」 + 요일 전체 sortOrder 밀기**
    기사님 화면(groupSheetStops)은 같은 정류장 이름 행을 **처음 나온 행 위치**에 한 정차로 묶는다. 그래서 정차 k 와 k+1 사이에 새 정차를 넣을 때 「k 의 마지막 행 뒤」 기준이면 같은 정류장이 흩어진 칸(A,B,A)에서 B 뒤로 밀린다 → 「k+1 의 첫 행 앞(BEFORE)」으로 넣는다. sortOrder 는 요일 안 번호(다른 수업·방향·PIVOT/RETURN 과 섞임)라 `그 달·요일 sortOrder ≥ 기준 +1` 후 기준 번호를 새 행에 준다 → 다른 행 상대 순서 불변. 칸 안에 번호가 겹친 학생 행(A(5)·B(5))이 있으면 먼저 화면 순서(sortOrder, 겹치면 id 바이트 순 — 명단 조회 ORDER BY "id" COLLATE "C")대로 벌린 뒤 넣는다. 합류(JOIN)는 번호를 밀지 않고 칸 맨 뒤 + 대상 행의 stopName 글자·좌표·시각 복사(같은 이름은 첫 위치로 묶이므로 결과 동일). 순수 계획 `planRosterInsert`·추천 `regularRosterPlacementLogic.ts`, 실행 테스트가 buildFallbackClasses 로 다시 그려 검증한다.
  - **[2026-08-06] 정규 셔틀은 "식별키가 두 벌"이다 — 배차 노선 studentId ↔ 탑승체크 시트행 id**
    정규 셔틀 데이터는 같은 사람을 **서로 다른 키 두 개**로 부른다. (1) 저장 배차 노선(`RegularDispatchRoute.payload.vehicles[].stops[].students[].requestId`)의 값은 **studentId** 다 — `shuttleRoster.ts` 의 `COALESCE(Student.id, 'stop:'||RegularShuttleStop.id)`. (2) 기사님 탑승 체크(`ShuttleBoarding`, direction='REGULAR')의 `shuttleRequestId` 는 **시트 정차행 id(RegularShuttleStop.id)** 다. 그래서 저장 노선을 기사님 화면에 그대로 뿌리면 과거 체크가 전부 미체크로 보인다. 되돌림 매핑은 `getRegularShuttleRiders` 가 함께 돌려주는 `stopRowId`(2026-08-06 추가) 로 만든다. 주의: 한 학생이 같은 요일·방향에 시트 행을 **여러 개** 가질 수 있다(실측 8건 — 하원인데 '승차'로 적힌 행 등). 따라서 매핑은 1:1 이 아니라 studentId → rowId **큐**이고, 정류장 이름이 일치하는 행을 먼저 소비한다. 기사님 화면 조립은 `src/lib/shuttle/regularDriverRoute.ts`(서버) + `regularDriverRouteLogic.ts`(순수) 한 곳에서만 한다.
- **참조횟수**: 0

### [2026-11-09] 학부모 결제·환불 — 가상계좌·묶음 결제·한 번에 결제 화면·선택 항목 환불
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-13] 토스 «승인됐는데 장부 미반영» 방지 = 승인 원본 선기록 + 멱등 반영 1곳 + 10분 점검 cron (점검표 c5)**
    장부 반영 입구는 `finalizeVerifiedTossPayment` 하나(학부모 승인·재시도·웹훅·가상계좌·점검 공용, FOR UPDATE + «DONE+PAID+PAID 면 아무것도 안 씀»). 승인 경로: claim 뒤 `paymentKey` 선기록 → confirm fetch 30초 제한(끊김=조회 후 retryable, 예외 없음) → DONE 이면 rawResponse 에 승인 원본 선기록 → `finalizeApprovedTossPayment`(반영 예외 = retryable «승인됐고 반영 확인 중»). 재시도는 `readStoredTossApproval` 로 토스 재호출 없이 반영. 점검 `reconcileTossPayments`(`/api/cron/toss-payment-reconcile` */10) = TOSS·IN_PROGRESS·10분~7일 거래를 **주문 번호로** 재조회 → 순수 판정 `tossReconcileRule.ts`(반영/입금대기/닫기/경고/대기). 반영 전 청구가 다른 결제로 PAID 면 덮어쓰지 않고 `ALREADY_PAID_OTHER`. 경고는 `recordTossLedgerReview`(단건 PAYMENT_SINGLE_REVIEW·묶음 PAYMENT_BUNDLE_REVIEW, 같은 사유 1회 DM). 테스트 `tests/toss-ledger-reconcile.test.mjs`(상태 가진 가짜 DB·트랜잭션 직렬화+되돌림). POS 는 기존 웹훅+10분 스윕(repairLedgerPaid)이 같은 역할.
  - **[2026-11-09] 학부모 «묶음 결제» = 토스 주문 1건(PaymentTransaction) + 항목 N건(PaymentTransactionItem)**
    미납 청구 여러 건(형제 포함, 대표 보호자 s.parentId=본인만)을 토스 결제 한 번으로. 거래 칸은 그대로(대표 청구 = 1번 항목의 paymentId·invoiceId, amount = 합계), 묶인 청구는 `PaymentTransactionItem`(마이그레이션 20261109150000, **코드보다 먼저 적용** — 단건 경로도 이 표를 읽는다). 규칙 순수 `src/lib/payments/checkoutBundle.ts`(자격·10건/100만 원·정렬=POS sortChargeItems·주문 이름·STIZ-B- 번호·확정/취소 판정), 장부 `bundleLedger.ts`(prisma import 없음, db 인자 → 가짜 DB 실행 테스트). finalizeVerifiedTossPayment·applyVerifiedTossFullCancel 은 `hasBundleItems` 면 묶음 갈래(거래+청구·청구서 FOR UPDATE 청구 id 순 → 조건부 UPDATE, 0행이면 BUNDLE_LEDGER_CONFLICT 던져 전부 되돌림). 카드 묶음 반영 실패 = PAYMENT_BUNDLE_REVIEW+원장 DM(돈은 나감), 무통장은 기존 VIRTUAL_ACCOUNT_REVIEW 흐름. 이중 납부 연결점: 청구서/청구로 거래를 찾는 새 SQL 은 반드시 `txCoversInvoiceSql`·`txCoversPaymentSql`(getVirtualAccountState·closeOpenVirtualAccount·queries.ts 마이페이지/관리자 수납 lateral), 무통장 판정 청구 상태는 `TX_PAYMENT_STATUS_SQL`(묶인 청구 중 하나라도 PAID 면 PAID). 승인 직전 `checkBeforeTossConfirm`(묶음 전부 미납 + 랠리즈 사본 차단 D4 — 단건도). API `/api/mypage/payments/checkout`(GET 후보·POST 시작)·`/confirm`(POST 승인·GET 주문 요약), 묶음 입금 알림 = `/api/mypage/payment-request` action submit-bundle. 테스트 `tests/payment-bundle-checkout.test.mjs` 는 payment-ledger.ts 를 가짜 prisma·가짜 fetch 로 실제 실행한다(FAKE_MODULES 로더).
  - **[2026-11-09] 학부모 «한 번에 결제» 화면 = /mypage/payments/checkout·done(앱 범위 안), 홈·청구 탭 같은 목록**
    후보는 서버 페이지가 `getBundleCheckoutCandidates` 로 바로 읽고, 결제 시작·검사는 POST `/api/mypage/payments/checkout`(토스 창 인자, `taxFreeAmount` 는 서버 합계를 그대로). 완료는 `/mypage/payments/done` 이 `/api/mypage/payments/confirm` POST(토스 복귀)·GET(새로고침). 홈 «납부할 청구» 합계·계좌는 `getParentPaymentRequests`(청구 탭과 같은 목록, 행에 `virtualAccount`)로 센다 — `getMyPageData` 는 자녀별 최근 5건이라 쓰지 않는다. 묶음 계좌는 VA 금액 ≠ 청구 금액으로 알아본다. 공지 대상 반(`Notice.targetClassIds`)은 관리자=쉼표·선생님=JSON 배열 두 모양이라 `src/lib/noticeTargets.ts` 로만 읽는다.
  - **[2026-11-09] 관리자 «선택 항목 환불» = 순수 판정(bulkRefund.ts) + 갈래별 기존 환불 함수**
    서버 액션 `src/app/actions/payment-bulk-refund.ts` 가 DB 로 다시 읽은 행을 `planBulkRefund` 에 넣어 갈래를 나눈다(막을 것 하나라도 있으면 전부 미실행). TOSS=`refundTossPaymentByAdmin`(payment-ledger: 재조회→감사→취소 API 전액→재조회 FULL 일 때만 applyVerifiedTossFullCancel, 가상계좌 DONE 은 환불 계좌 필요라 차단), TOSS_POS=`requestChargeCancelByAdmin`(비동기, 결과 REQUESTED), 그 밖(MANUAL)=`refundPaidPaymentInTx`, CAFE24_BRIDGE 차단. 묶음(토스 항목·POS 항목)은 전부 골라야 하고 부분 취소는 지원 안 함. ⚡ 한 건 «환불»도 같은 runRefund→refundSelectedPayments([id]) 로 통일(PM 결정), updatePaymentStatus·bulkUpdatePaymentStatus 는 REFUNDED 를 거부한다 — 새 환불 경로를 만들 때도 이 액션만 부른다.
  - **[2026-11-08] 무통장입금(가상계좌) = 거래(PaymentTransaction) 상태만 «입금 대기», 청구 상태는 새로 안 만듦**
    승인 응답 WAITING_FOR_DEPOSIT → `PaymentTransaction.status='WAITING_FOR_DEPOSIT'`·method «가상계좌»·rawResponse 에 `virtualAccountIssue`(은행·계좌·예금주·기한·금액)+`depositSecretHash`(SHA-256, 원문 secret 저장 안 함). 청구(Payment)·청구서는 미납 그대로. 판정은 순수 `src/lib/payments/virtualAccount.ts`(decideVirtualAccountWebhook: PAY·ALREADY_DONE·RELEASE·REJECT·IGNORE·DELEGATE), secret 해시·비교는 서버 전용 `virtualAccountSecret.ts`(학부모 화면이 import 하면 번들에 node:crypto). 웹훅은 secret 대조→토스 재조회→finalizeVerifiedTossPayment(paidAt 인자, paidDate 무tz=`$::timestamptz AT TIME ZONE 'UTC'`). 학부모 화면용 조회는 `rawResponse->'virtualAccountIssue'` 만 SELECT(마이페이지 2경로는 queries.ts `PARENT_VIRTUAL_ACCOUNT_LATERAL` 공용). ⚠️ DEPOSIT_CALLBACK createdAt 은 시간대 없는 KST → `parseTossTimestamp`. 해제·납부 반영은 웹훅·학부모/원장 «계좌 닫기»(closeOpenVirtualAccount: 토스 취소→재조회)·매일 점검 cron(`/api/cron/virtual-account-sweep`)이 `releaseVirtualAccountTx`·`payVerifiedVirtualAccount` 한 곳을 같이 쓴다. 웹훅 원문은 `stripWebhookSecrets` 로 가려 저장(지문은 원문으로 먼저).
- **참조횟수**: 0

### [2026-11-09] 관리자 원생 등록 = 3단계 창 + 서버 액션 하나
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: [2026-11-09] 관리자 원생 등록 = 3단계 창 + 서버 액션 하나(트랜잭션 하나)
- **내용**: 목록 «원생 등록»·체험 ⚡«원생 등록»이 같은 `src/app/admin/students/StudentRegisterModal.tsx` → `src/app/actions/student-register.ts`(`registerStudent`·`previewStudentRegistration`·`getStudentRegisterOptions`). 입력 검증은 창·서버 공용 `src/lib/students/student-register-rules.ts`(반 필수/«반은 나중에 배정», 주 보호자 휴대폰 필수, 지점은 반 장소에서 자동·원본 문장 형식 저장, 개인정보 확인 → agreementsJSON.adminRegister). 신청서 승인과 공유: 정원 경고 `lib/enrollment/class-capacity.ts`, 셔틀 위치 저장 SQL `lib/students/student-shuttle-location-upsert.ts`(승인 동작은 tests/student-register.test.mjs 의 vm 실행으로 고정). 수강료 표시는 `lib/billing/regular-tuition-preview.ts`(청구 모듈과 무관, 프로그램 화면 2곳도 여기서 상수 사용). 인라인 폼은 «수정» 전용. 문자 발송 없음. **11-09 실사용 후**: 반 줄 대상 학년 = `ScheduleSlot.gradeRange → CustomClassSlot.gradeRange → Program.targetAge`(하위 질의, 스키마 변경 없음) · 셔틀 장소명 필수 규칙 한 곳 `src/lib/shuttle/placeNameRule.ts`(지도 창 `requirePlaceName` 옵션 — 원생 등록·학부모 링크 `/shuttle/location/[token]` 만 켬, 서버 `validateRegularLocation`·`validateStudentRegisterInput` 도 거부, 저장 SQL 의 주소 대체는 옛 데이터용 유지) · 유니폼은 입력 없음 — `UniformOrder.parentPhoneDigits ∈ 입력 보호자 번호` + `UniformOrderItem.studentName`(띄어쓰기 무시) 일치 주문을 `decideUniformFromOrders`(취소 제외, 업체 전송=«주문»/접수만=«신청») 로 등록 시점에만 채움(주문→학생 자동 갱신 연결은 없음) · 사진 동의 = 체크박스 하나, 방법 `REGISTER_MEDIA_CONSENT_METHOD`=IN_PERSON.
- **참조횟수**: 0

### [2026-11-08] 토스 POS 현장 결제 — 순수 규칙+실행부·플러그인 패키지·매칭·취소·묶음
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-08] 현장 결제 매칭 = 방식 무관·분할 결제 합계, 결제 목록은 «알림용»과 «매칭용» 두 함수**
    payment-notice.mjs 의 extractNoticePayments(카드·BARCODE, 슬랙 확인 DM 용)와 extractChargePayments(APPROVED 전부, 현장 결제 매칭용)는 같은 내부 함수 한 벌이다. decideChargeMatch 는 승인 결제 합계·면세 합계로 판정하고 주문 진행 중(isOrderCompleted=false) 합계 부족이면 SKIP(waiting, 그 결제들의 DM 도 미룸)·완료 뒤 부족이면 HOLD. 분할이면 대표 결제(가장 먼저 승인)만 PosChargeRequest.tossPaymentId(유일), 나머지는 note+PaymentAuditLog(POS_CHARGE_PAYMENTS), 이중 매칭은 CLAIM_PAY_SQL 의 «같은 tossOrderId 다른 요청 PAID» NOT EXISTS 로 막는다. Payment.method 는 posMethodOf(CARD·CASH·EASY_PAY·BANK_TRANSFER·ETC, 분할 «CARD+CASH»), 표시는 posMethodLabel(«현장 · 카드+현금»). adminDisplayText.ts 는 테스트가 import 없이 단독 실행하므로 다른 모듈을 import 하지 말고 이름만 맞춘다(테스트가 비교).
  - **[2026-11-08] 토스 POS 결제 취소 = 사이트 요청(cancelState) → 플러그인 cancel.ts → 토스 웹훅 재조회로만 환불**
    관리자 ⚡ «결제 취소»(PAID·paidProvider TOSS_POS)는 PosChargeRequest.cancelState=REQUESTED 만 남긴다(청구서 id 로만 요청을 찾아 IDOR 차단). 플러그인 롱폴링 응답 `cancels[]` → `/cancel/claim`(SENT, 결제 ID 는 서버가 감사기록 POS_CHARGE_PAYMENTS→note→대표결제 순으로 계산) → payment.cancel → `/cancel/report`(기록만, FAILED 면 사이트 «POS 에서 직접 취소»). 환불은 matchChargeRequestsForOrder ①의 settleCancelForRow 가 재조회 주문으로 decideChargeCancel(FULL/PARTIAL/NONE) → FULL 이면 한 트랜잭션에서 MARK_REFUND_SQL + payment-ledger refundPaidPaymentInTx. POS 직접 취소도 같은 길. chargeRequestService 는 Payment 를 직접 UPDATE 하지 않는다(테스트가 막음). 같은 함수의 retryLater=true(분할 대기·납부 기록 복구 대기)면 웹훅을 processedAt 비운 채 두어 10분 스윕이 다시 본다. 마이그레이션 20261108120000 은 코드 배포보다 먼저 적용해야 한다(VIEW_SQL·MATCH_SELECT 가 새 칸을 읽음).
  - **[2026-11-08] 현장 결제 묶음 = 요청 1건 + PosChargeRequestItem N건, 대표 청구는 요청.paymentId 그대로**
    같은 학생 미납 여러 건을 POS 결제 한 번으로(원장 결정). 요청 표는 그대로(합계·면세 합계·대표 청구 = 1번 항목)라 단건 코드·인덱스가 그대로 돈다. 묶인 청구는 `PosChargeRequestItem`(마이그레이션 20261108180000, 코드보다 먼저 적용). 같은 청구가 두 열린 요청에 못 들어가게 항목 `"open"`+부분 유일 인덱스, 요청 상태가 열린 상태를 벗어나면 트리거가 닫는다(상태 UPDATE 가 어디서 오든). 서비스의 SQL 은 조각 `ITEMS_OF_R`(항목 없는 옛 요청 = 대표 청구 1건)·`ALL_ITEMS_UNPAID_SQL`(전부 미납·금액 그대로·합계=요청 금액)·`hasPaymentSql(n)`(대표이거나 항목) 을 끼워 쓴다 — 청구 id 로 요청을 찾는 새 SQL 은 반드시 hasPaymentSql. 묶음 납부는 `markPaymentsPaidTogether`(payment-ledger, 한 트랜잭션·건마다 조건부 UPDATE·하나라도 0행이면 전부 되돌림), 단건은 예전 markPaymentPaid — 둘 다 writeLedgerPaid 한 곳에서만. 환불·감사 기록은 묶인 청구마다. 유일 위반 이름 정규식은 `PosChargeRequest(?:Item)?_` (Item 표 인덱스를 놓쳐 동시 생성 처리가 깨질 뻔함 — 테스트로 고정).
  - **[2026-11-07] 토스 POS «현장 결제» = 순수 규칙(charge-request.mjs) + 실행부(chargeRequestService.ts) + 플러그인 API(토큰)**
    관리자 수납 ⚡ «현장 결제»(MONTHLY·SHUTTLE 미납, 원장만) → `PosChargeRequest`(번호 S-dddd, 금액·면세 DB 스냅샷, 30분, 열린 요청 부분 유일 인덱스). 웹훅 `processPosWebhookEvent` 가 재조회한 주문으로 `matchChargeRequestsForOrder` 를 먼저 부르고, 자동 납부(조건부 UPDATE 선점 → markPaymentPaid CARD·TOSS_POS)한 결제만 PosPaymentNotice 에서 뺀다 — 그 밖은 기존 슬랙 확인 흐름(D1). 판정(금액·만료·여러 결제·부분취소·중복)은 순수 `decideChargeMatch` 한 곳. 플러그인 API `/api/pos-plugin/**` 는 `handlePluginRequest`(Bearer 토큰 SHA-256·timingSafeEqual·분당 제한) 경유만, 납부 경로 없음. 토큰 화면 `/admin/pos-plugin`. 계약 = docs/toss-pos-plugin-plan.md 8장.
      - **[2026-11-10 추가] 번호 없는 POS 결제 자동 납부**: 원장 결정 «POS 처리 확인되면 끝». 알림 분류 AUTO_CANDIDATE 면 `autoConfirmNotice`(paymentNoticeService)가 DM 뒤 바로 반영. 납부 쓰기는 버튼·자동 공통 `lib/pos/paymentNoticePay.ts` 한 곳(`NOTICE_PAY_RECHECK_SQL` 조각을 두 선점 SQL 이 공유, markPaymentPaid 1곳 — 테스트가 막음). 자동 전용 `NOTICE_AUTO_EXTRA_SQL` = 직원 수납 확인 PENDING·현장 결제 요청 PENDING/SENT/HELD/PAID·랠리즈 사본이면 보류(버튼 남김). 직원 현금·계좌 확인(StaffPaymentConfirmationRequest)은 POS 근거가 없어 승인 그대로. 납부는 `markPaymentsPaidTogether`(1건, 조건부) — 0행이면 CONFLICT(선점 해제·이중 수납 경고). 자동 납부인데 DM 이 없으면 `sendAutoResultNotice`(slackTs=SENDING 선점, 스윕 재시도). 납부 반영 뒤 POS 취소는 `warnCancelledNoticePayments` 가 DM+알림 벨 1회(중복 방지 = advisory lock + 감사 action POS_NOTICE_CANCELLED_WHILE_PAID), 청구는 되돌리지 않음.
      - **[2026-11-12 추가] POS 자동 매칭 엔진**: 단건 자동(AUTO_CANDIDATE)이 아닌 번호 없는 POS 결제를 `lib/pos/auto-match.mjs`(순수 판정) + `autoMatchService.ts`(실행)로 여러 반·형제(«루나루희», 같은 보호자)·이름만(«도경», 명단 전체에서 유일)·메모 없음(반·금액 배정이 학원 전체 한 가지)까지 맞춘다. 배정(품목×수량 ↔ 적용월 MONTHLY 미납, 반 이름 일치, 합계=결제액)이 정확히 한 가지일 때만. 웹훅은 DM 전에 시도(성공=결과 DM만), 크론 `/api/cron/pos-auto-match` 매시간 7일 안 열린 알림 재시도(1회 10건·200만원). 쓰기 = advisory lock(toss-pos:<결제ID>) 안에서 다시 판정 → 조건부 UPDATE(0행이면 전부 롤백) → 감사 PAYMENT_MARK_PAID(metadata.idempotencyKey toss-pos:<결제ID>:<청구ID>, build-pos-site-sync 와 같은 키) → 알림 CONFIRMED. providerPaymentKey 가 이미 이 결제면 건너뜀. 테스트 tests/pos-auto-match.test.mjs.
  - **[2026-11-07] 토스 POS 플러그인 = apps/toss-pos-plugin 독립 패키지(사이트 빌드 밖)**
    자체 package.json·tsconfig·node_modules. 루트 `tsconfig.json` exclude·`eslint.config.mjs` ignore 에 `apps/toss-pos-plugin` 이 빠지면 루트 `**/*.ts` 포함 때문에 next build(Vercel)가 깨진다. 핵심 로직은 `src/core/*`(SDK 를 import 하지 않고 pos-types.ts 최소 모양을 인자로 받음 → node --test 가짜 SDK), 실제 SDK 와 맞는지는 `tests/sdk-compat.typecheck.ts` 가 tsc 로 확인. 서버 API 주소·응답 해석은 `src/core/contract.ts` 한 곳(camel/snake 둘 다 읽음). SDK 0.0.31 은 **주문 전체 메모를 넣는 함수가 없어** `STIZ:S-xxxx` 를 항목 메모+item.code 에 넣는다 → 서버 웹훅 매칭은 lineItems[].memo·item.code 도 봐야 한다. 요청 제한은 http 포함 60초 100·30분 200번. 운영 매장 배포 = 라이브 검수(월·목)+VAN 대리점 활성화, 개발 배포는 테스트 단말기 5대.
- **참조횟수**: 0

### [2026-11-13] 백업 = 설정 파일(복원) + 업무 자료 gzip 짝 파일(보관용, 자동 복원 안 함)
- **분류**: architecture
- **발견자**: developer
- **내용**: 규칙은 `src/lib/backup/archiveCore.ts` 한 곳(순수), DB 연결은 `lib/backup/archive.ts`. 같은 시각에 `stiz-backup-<시각>.json`(설정 7표, 복원 3경로가 읽는 유일한 파일, `_meta.archiveFile` 에 짝 경로) + `stiz-archive-<시각>.json.gz`(업무 자료). 담을 표 = information_schema public 표 전체 − `ARCHIVE_EXCLUDED_TABLES`(캐시·시트 가져오기 원본/오류·OTP 로그·짧은 인증 세션·푸시 키, 이유 필수) − 설정 7표 → **새 표·스키마에 없는 DB 표도 자동 포함**. 비밀 칸은 이름 규칙(…Hash·…Token·secret 등, JSON 속 키까지) + 표별 지정(`SECRET_COLUMNS_BY_TABLE`, 예 EnrollmentShortLink.code). 키셋 페이지는 `"id"::text`(uuid 표 대비) 5000줄씩, 페이지마다 gzip 조각으로 바로 압축(gzip 멤버 이어붙이기 = 하나로 풀림). 45MB 넘으면 큰 표부터 SIZE_LIMIT. 실패는 설정 저장 후 500 ARCHIVE_INCOMPLETE(슬랙). 함수 300초(vercel.json 개별 지정+route maxDuration). 클라우드 목록은 files(복원용)/archives 로 분리 — «최신 자동백업 복원»이 files[0] 을 쓰기 때문. 업무 자료는 `GET cloud-backups?archive=` 1분 서명 주소(원장·이름 규칙). 검사 `tests/backup-archive.test.mjs`.
- **참조횟수**: 0

### [2026-11-13] 대시보드 카드·통계 탭 = 순수 규칙 + 새 조회 경로(옛 queries.ts 통계 함수는 손대지 않음)
- **분류**: architecture
- **발견자**: developer
- **내용**: 판정(학년=생년월일·KST 3월 학년도, 성별 정규화, 지점 «적힌 값→반 장소→미지정», 유니폼 9종→5묶음, rate 분모 0→null)은 `src/lib/stats/statsRules.ts` 한 곳(순수·테스트 `tests/admin-stats-rules.test.mjs`). 조회는 `statsQueries.ts` — 원생은 `loadStudentStatRows` 1명 1줄(재원 = ACTIVE 1개 이상)을 읽어 TS 로 묶고, 지점 필터는 그 결과의 id 배열을 `= ANY($n::text[])` 로 넘긴다(지점 규칙을 SQL 로 다시 쓰지 않기 위해). 시간대 없는 칼럼(Session.date·Payment.paidDate/dueDate·Enrollment.createdAt/updatedAt·Student.birthDate)은 AT TIME ZONE 두 번. 캐시 = adminReadPayloads `getCachedAdminDashboardSummary`·`getCachedAdminStatsTab(tab,branch,period)`(60초, 태그 admin-stats, 열쇠에 KST 달 포함). 유입경로 라벨은 `lib/stats/sourceLabels.ts`(신청 화면과 공유). 퇴원 시각은 Enrollment 에 전용 칼럼이 없어 WITHDRAWN 줄의 updatedAt 으로 센다(근사).
- **참조횟수**: 0

### [2026-11-08] 청구 준비 제안값 = 순수 workbench-pricing
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: [2026-11-08] 청구 준비 제안값(주N회 요금·셔틀비·형제할인) = 순수 workbench-pricing + readWorkbench 사전 판정
- **내용**: 청구 준비 행은 «학생×반»이라 주2회 학생은 행 2개다. `readWorkbench` 가 먼저 행마다 청구 대상(excluded)을 정하고(scopeOf), 청구 대상 반만 `src/lib/billing/workbench-pricing.ts` 에 넘긴다 — planWeeklyTuition(**11-09 원장 결정**: N = 학생 청구 대상 반 전체 주 횟수(프로그램 무관), 각 반 = 그 반 프로그램의 주N회 요금 ÷ N, 절사로 남는 원은 학생 첫 행, 그 프로그램 주N회 칸이 비면 그 반만 주1회 요금+경고 · 대회준비반(상수 `COMPETITION_PROGRAM_NAMES`)은 주말 대회준비반 반이 있으면 대회준비반 반 전부+일반 반 1개 = 300,000 고정(첫 대회준비반 행), 초과 일반 반은 일반 규칙+경고, 평일 대회준비반만이면 묶음 미적용+경고), planShuttleFee(그달 `RegularShuttleStop` 의 studentId 연결 행만, 셔틀 운행 평일 반 주 횟수 → 1만/1.5만/2만·직접입력 최대값·Sun-8 면제·**무료 거점**(상수 `FREE_SHUTTLE_HUB_STOPS`: 승차 1호점 앞 버스정류장/하차 새봄중학교 앞 버스정류장) — 명단 정류장이 전부 거점이면 0, 섞이면 제안+경고), siblingDiscountStudents(같은 parentId 청구 대상 자녀 2명↑, 상수 `REGULAR_SIBLING_DISCOUNT_TARGET` ALL/SECOND_AND_LATER)+siblingDiscountAmount(수강료 10% 절사, 셔틀 제외). 적용은 확정 월 장부 없는 행만, 저장 초안 payload 가 항상 이긴다. 셔틀비는 학생의 «첫 발행 대상 행» 1개에만, 다른 반 초안에 셔틀비 저장·이번 달 기존 청구가 있으면 제안 안 함. 셔틀 명단은 sourceVersion 해시에 포함. 셔틀비 규칙의 다른 사본: ProgramFormPanel/ProgramsAdminClient/programs/page 의 autoShuttle 표, studentBilling.ts 의 Sun-8 — 바꾸면 같이 바꾼다.
- **참조횟수**: 0

### [2026-11-07] 카카오 채널 — 학부모 인증·정책 답변(Gemini)·보강 신청·결석/셔틀 대화
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-11-07] 카카오 결석·셔틀 대화 = kakao-flow-store(공용 상태) + 흐름별 파일, 웹과 같은 저장 함수**
    보강 흐름 방식을 결석(`kakao-absence-flow`·status ABSENCE_FLOW)·셔틀(`kakao-shuttle-flow`·SHUTTLE_FLOW, 당일/당일취소/정규 3모드)로 확장. 상태 SQL(활성 30분·단계 선점 advance·close·submit)은 `kakao-flow-store.createFlowStore` 한 곳, 새 흐름을 열 때 `KAKAO_OPEN_FLOW_CLOSE_SQL`(초안+모든 흐름)을 닫는다 — 보강 흐름도 같은 목록. 챗봇 순서: 재확인 → 보강 → 결석 → 셔틀 → 초안 → 메뉴 → 분류(RENTAL 카드) → 정책 → 접수. 정규 셔틀은 흐름 행을 그대로 SUBMITTED 로 바꿔 관리자 접수함이 effectiveDate·shuttleIntent·details 를 미리 채운다. 테스트: `tests/kakao-care-flows.test.mjs`(가짜 DB 실행). 챗봇을 올리는 다른 테스트(policy-qa·connect-flow)는 흐름 모듈 3개를 null 스텁으로 끼운다 — 새 흐름을 추가하면 그 두 곳에도 스텁 추가.
  - **[2026-10-17] 카카오 보강 신청·취소 = 대화 상태는 KakaoParentIntake 한 행(status MAKEUP_FLOW), 규칙은 parent-makeup 그대로**
    `src/lib/kakao-makeup-flow.ts` 가 `handleLinkedMessage` 에서 재확인 링크 바로 뒤·작성 중 접수 앞에 불린다(무관한 말이면 null). 상태는 스키마 변경 없이 `KakaoParentIntake`(kind MAKEUP, status `MAKEUP_FLOW`, structuredJson 에 단계·서버가 만든 목록)에 두고 `updatedAt` 30분이 지나면 무시한다. 끝나면 APPLIED, 그만두면 CANCELED. 학부모는 번호만 보내고(id 는 상태에서만 꺼냄), 단계 이동은 `"structuredJson"->>'step'` 조건 UPDATE 로 한 번만 진행된다. 예약·취소는 웹과 같은 `bookMakeup`/`cancelMakeupBooking` 을 직접 부르고, 그 직전에 보호자 소유·후보 유효를 다시 조회한다. 바로가기 문장은 모두 '보강'을 품어 상태가 만료돼도 처음부터 다시 시작된다. 단 메뉴 버튼 「결석·보강」은 MAKEUP 으로 분류되므로 반드시 제외해야 한다(제외하지 않으면 하위 메뉴가 사라진다). 챗봇에 import 를 늘렸으므로 테스트 2곳(connect-flow·policy-qa)의 손 치환 목록에 대역을 넣었다.
  - **[2026-10-09] 카카오 정책 답변(Gemini) — 순수 엔진 + 연결부 + 챗봇 연결점(hook) 3층**
    판단 로직은 `src/lib/kakao-policy-qa.ts`(순수: 질문 판별·주입 방어 프롬프트·`[ESCALATE]` 해석·시간 제한·`runPolicyFlow` 동기/콜백 분기)에 두고, DB·Gemini·콜백 전송·after() 는 `kakao-policy-qa-service.ts` 가 주입한다 → 테스트는 가짜 Gemini 로 흐름 전체를 실행한다. 학부모 챗봇은 `handleLinkedMessage(..., policyHook)` 연결점만 받고, hook 이 null 이면(킬 스위치 꺼짐·DB 미준비·키 없음) 기존 접수 흐름 그대로. 못 답하면 escalate = 기존 `createIntakeReply`(+안내 한 줄). 게스트는 라우트에서 인증 판별 뒤·기본 카드 앞. Gemini 모델·키는 `src/lib/gemini-client.ts` 한 곳(웹 `/api/chat` 도 사용). SDK 0.24.1 타입엔 thinkingConfig 가 없지만 generationConfig 는 본문에 그대로 실려 형 변환으로 넘긴다. 챗봇 파일에 import 를 늘리면 `tests/kakao-parent-connect-flow.test.mjs` 의 손 치환 목록에도 넣어야 한다(안 넣으면 ERR_INVALID_URL).
  - **[2026-10-08] 카카오 학부모 인증·기존 빈 계정 활성화 흐름**
    ① 카카오 연결 화면은 `src/app/kakao-connect/page.tsx`(마이페이지 레이아웃 밖)에서 그리고 주소 `/mypage/kakao-connect` 는 next.config rewrite + 미들웨어 예외(`isMyPageKakaoConnect`)로 유지한다 — `/mypage/layout.tsx` 가 `requireVerifiedParent` 실패 시 먼저 튕겨 내서 상황별 안내를 못 보여 줬다. 판정은 `getVerifiedParentState()`(auth-guard, 상태 반환) → `requireVerifiedParent` 는 그 결과로 throw. ② 회원가입은 빈 계정(PARENT+합성 이메일+authUserId 없음) 번호를 신규처럼 문자 발송하고, **OTP 통과 뒤** `resolveVerifiedSignupPhone` 이 NEW/REGISTERED/여러 개(학원 문의)/간편로그인 연결/비밀번호 활성화로 나눈다. 비밀번호 활성화는 `issueVerifiedSelfParentClaim`(VERIFIED·30분·proof 10분, 특강 72시간 링크는 안 건드림) + httpOnly 증표 쿠키 → `/account/activate` 가 ACCOUNT 단계부터. ③ 카카오 인증 링크 토큰 = HMAC(비밀키, 봇·사용자키해시·만료ms) — 원문 비저장인 채로 유효 링크를 다시 보여 줄 수 있다. ④ 스킬 응답은 `buildKakaoSkillResponse`(textCard)만 — thumbnail 없는 basicCard 는 오픈빌더가 미발송(2461), 가드 `tests/kakao-skill-response-format.test.mjs`.
- **참조횟수**: 0

### [2026-11-07] 체육관 대관 = 순수 규칙 + DB 연결부 + 알림 + EXCLUDE
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: [2026-11-07] 체육관 대관 = 순수 규칙(gym-rental-rules) + DB 연결부(db 인자) + 알림 + EXCLUDE 제약
- **내용**: 공개 `/rental`(로그인 없음) → 관리자 `/admin/rental`(사이드바 «요청·신청함»). 요금·1시간 칸·상태 전이·문자 문구는 `src/lib/rental/gym-rental-rules.ts` 한 곳(화면 실시간 표시와 서버 저장 직전 재계산이 같은 함수). DB 는 `gym-rental-service.ts`(prisma import 없음, db 인자 → 가짜 DB 테스트). 가능 칸 = 09~22시 중 Class(dayOfWeek Mon~Sun)·SpecialProgramSessionDate(취소 제외)·승인된 대관과 안 겹치고 아직 시작 안 한 칸. 연간일정 휴무일은 열지 않음(보수적). 이중 확정 방지 = 승인 시 FOR UPDATE + 날짜 advisory lock + **EXCLUDE USING gist(tstzrange(startAt,endAt)) WHERE status IN 승인 이후 4종** — 코드 `RENTAL_HOLDING_STATUSES` 와 같은 집합인지 테스트가 비교. 알림 `gym-rental-notify.ts`: 원장 = 규칙 RENTAL_NEW_ADMIN(끄면 문자·슬랙·앱 알림 모두 멈춤 → 운영 시험 때 이걸로 막음), 신청자 승인·확정 = env `RENTAL_APPLICANT_SMS_ENABLED=1`, 접수 = 전용 env `RENTAL_APPLICANT_RECEIVED_SMS_ENABLED=1`(남의 번호 악용 방지), 둘 다 규칙도 켜야 함(꺼진 채 배포). 원장 문자는 10분 창 키로 한 통(슬랙 건별). 공개 신청은 tx+advisory lock 안에서 연락처·IP(x-forwarded-for 첫 값 sha256) 한도 확인 후 저장. 승인 때 loadRentalSlots 로 수업·특강 재확인. 반 판정은 이름 `[` 시작 제외+ACTIVE 수강생 있는 반만. 계좌는 서버 전용 `gym-rental-notify.ts`(server-only)에만 — 규칙 모듈은 브라우저 번들에 실리므로 금지, 테스트가 클라이언트 import 그래프를 검사.
  **[2026-11-08 분 단위 전환]** 1시간 칸 → `buildRentalDay`(시작 10분 간격 후보·막힌 구간·maxMinutes) + `isRentalRangeAvailable`(서버 검증 기준). 평일 09:00·주말 10:00(`rentalOpenMinute`)~22:00, 이용 30분 단위 60~360분. 저장 = `startMinute`/`endMinute`(그날 KST 0시부터 분, 마이그레이션 20261108210000, nullable → 읽기는 COALESCE(startHour*60)) + 기존 startHour(내림)/endHour(올림) 계속 채움, 겹침 진짜 기준은 startAt/endAt. 요금 = 30분 단가 기준(RENTAL_FEE.extraHalfHour 등, 시간당 값은 ×2) — 정수 시간이면 옛 금액과 같음(테스트). 시간 표시는 `formatRentalTime`/`rentalTimeText` 하나(«20:40~22:10 (1시간 30분)»). 공개 화면 달력은 `buildRentalCalendar`·`shiftYm`.
- **참조횟수**: 0

### [2026-11-05] 총 재원기간·3년 재원 유니폼 무료 링크
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: [2026-11-05] 총 재원기간·3년 재원 유니폼 무료 링크 구조
- **내용**: 재원기간 = 옛 시트 기준값(`Student.tenureBaselineMonths/Through/FirstMonth`) + 기준월 «뒤» 사이트 수강 달(수강료 year-month ∪ 출석 PRESENT 세션 KST 달). 계산은 순수 `lib/student-tenure.ts`, 조회는 `lib/student-tenure-query.ts`(getStudentActivity 무변경, 실패 시 null=표시 안 함). 무료 유니폼은 `UniformFreeGrant`(토큰 32자 base64url, ISSUED→USED|REVOKED, 만료는 expiresAt) — 규칙 `lib/uniform-free-grant-rules.ts`, 발급·조회·신청 `lib/uniform-free-grant.ts`(prisma 를 import 하지 않고 db 인자로 받아 가짜 DB 로 동작 테스트). 신청은 `FOR UPDATE OF g` 잠금 후 주문을 **NEEDS_REVIEW** 로 저장 → 크론(PENDING·RETRY_WAIT 만)·즉시 발송 모두 안 탐, 원장이 /admin/uniform «재전송»(dispatchUniformOrderById 는 SENT·DUPLICATE 외 모두 보냄)으로 본사 발송. 무료 표시는 주문 메모 앞머리 `[3년 재원 무료 증정]`(관리자 배지 판정). 디자인·사이즈·검증은 `lib/uniform-options.ts` 공용.
- **참조횟수**: 0

### [2026-08-08] PWA 설치 화면 = installReadiness 순수 모듈
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: 2026-08-08 PWA 설치 화면의 "무엇을 보여줄까"는 installReadiness 순수 모듈 한 곳에서
- **내용**: 설치 화면은 학부모 `/app`(→`/mypage/install`, `app/parent-app/ParentAppInstallClient.tsx`)과 선생님 `/staff/install`(`app/teacher-app/StaffAppInstallClient.tsx`) 두 개다. 두 화면의 판단 로직은 전부 순수 모듈로 뺀다 — 기기/브라우저 판별은 `lib/pwa/installEnvironment.ts`, **화면 표시 판단(대기/설치버튼/수동안내/인앱탈출)은 `lib/pwa/installReadiness.ts`**(`resolveInstallScreenView`·`shouldWaitForInstallPrompt`·`INSTALL_PROMPT_WAIT_MS=1500`). 이유: 크롬은 `beforeinstallprompt` 를 마운트 후 1~2초 뒤에 쏘는데, 그 전에 "이미 설치돼 있으면 설치 버튼이 나타나지 않습니다" 수동 안내가 먼저 보여 사용자가 설치 불가로 오해하고 이탈했다. 그래서 안드로이드/PC 만 1.5초 대기 창을 두고 그동안 안내를 감춘다. **iOS·인앱 브라우저·이미 설치됨은 대기하지 않는다**(애플은 이 이벤트를 아예 안 보내므로 기다리면 순손해). 대기 창은 표시를 미루는 것일 뿐 `prompt()` 자동 호출은 금지(user activation 밖에서 부르면 이벤트가 무효화됨). 회귀 테스트가 잠근 소스 표현이 있다 — `tests/pwa-install-environment.test.mjs` 는 두 화면에 `deviceState !== "checking" && !inAppBrowser` 문자열이 그대로 있길 요구하므로, 조건을 `view.showManualGuide` 로 갈아치우지 말고 **AND 로 덧붙인다**. 대기 로직 테스트는 `tests/pwa-install-wait-window.test.mjs`(TS 를 transpileModule 로 실행 검증).
- **참조횟수**: 0

### [2026-07-06] 리치 텍스트 에디터(TipTap)
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: 2026-07-06 리치 텍스트 에디터 구조 (TipTap)
- **내용**: 리치 에디터는 `src/components/RichTextEditor.tsx`(TipTap 3.20, "use client") 하나. 등록 확장 = StarterKit/TextStyle/Color/Underline/TextAlign. `src/components/extensions/FontSize.ts`는 구현됐으나 미등록. prop: value(HTML string)/onChange/name(hidden input)/placeholder. 출력은 editor.getHTML(). **사용처는 설정 페이지 단 1곳**(admin/settings/AdminSettingsClient.tsx의 소개글/이념/시설 3곳, value+onChange 바인딩). **공지사항은 이 에디터 미사용** — NoticesAdminClient는 순수 textarea+plain text 저장, notices/[id]/page.tsx는 toNoticeHtml(전부 escape+URL만 <a>)로 렌더+whitespace-pre-wrap. 이미지는 본문이 아니라 attachmentsJSON으로 하단 별도 <img> 노출. StarterKit 3.20에는 blockquote·bullet/ordered-list·horizontal-rule·link·dropcursor·gapcursor·underline이 이미 내장(별도 패키지 불필요). 표(extension-table)·유튜브(extension-youtube)만 미설치. 이미지 업로드는 공용 `/api/upload`(버킷 uploads, folder 파라미터, 5MB·이미지타입, 로그인 인증, 반환 {url}) 재사용. sanitize.ts(sanitize-html)는 table/list/blockquote/hr 이미 허용, iframe만 미허용.
- **참조횟수**: 0

### [2026-03-26] 관리자 페이지 데이터 로딩 패턴
- **분류**: architecture
- **발견자**: developer
- **원래 제목**: 2026-03-26 관리자 페이지 데이터 로딩 패턴 분석
- **내용**: admin 15개 페이지 전체가 revalidate:30 ISR 사용 (force-dynamic 0개). 서버 컴포넌트에서 queries.ts(react.cache) 함수로 데이터 조회 후 *Client.tsx에 props 전달하는 패턴 통일. 대시보드만 Suspense 스트리밍 적용. 대부분 페이지에서 Promise.all 병렬 쿼리 완료. 남은 병목: (1) 대시보드 getDashboardExtendedStats 이중 호출, (2) getClassWithStudents/getStudentActivity 직렬 쿼리, (3) schedule 페이지 Google Sheets 직렬 대기.
- **참조횟수**: 0

### [2026-03-22] 공개 홈페이지 기반 — 시간표 파이프라인·공개 페이지 패턴·학년 체계
- **분류**: architecture
- **발견자**: developer
- **내용**: (묶음 — 아래 하위 항목이 원래 항목, 최신순)
  - **[2026-03-22] 시간표 데이터 파이프라인**
    시간표 데이터는 3단계로 조합된다. (1) Google Sheets CSV -> SheetClassSlot[] (SheetSlotCache DB 캐시 or 직접 fetch), (2) ClassSlotOverride 테이블로 라벨/코치/시간/정원 오버라이드, (3) CustomClassSlot 테이블로 시트에 없는 커스텀 슬롯 추가. 최종 결과는 MergedSlot[] 배열. schedule/page.tsx에서 이 조합 로직이 구현되어 있고, ScheduleClient.tsx에서 MergedSlot 타입이 export된다.
  - **[2026-03-22] 공개 페이지 공통 패턴**
    공개 페이지는 (1) PublicPageLayout 래퍼, (2) 히어로 섹션 (gradient + 장식도형 + AnimateOnScroll), (3) 본문 섹션, (4) CTABanner 하단 CTA 구조를 따른다. ISR 캐싱 적용 (공개=300초, 관리자=30초). 서버 컴포넌트에서 queries.ts 함수로 데이터 조회 후 클라이언트 컴포넌트에 props로 전달하는 패턴.
  - **[2026-03-22] 학년 체계 (GRADE_ORDER)**
    googleSheetsSchedule.ts에 GRADE_ORDER 배열이 정의됨: ["6세","7세","초1"~"초6","중1"~"중3","고1"~"고3","성인"]. MergedSlot.gradeRange는 "초4~중1" 형태의 문자열. formatGradeRange() 함수로 생성. 학년 범위 판별 시 GRADE_ORDER 인덱스 비교 방식 사용.
- **참조횟수**: 0

### [2026-11-14] 학부모 청구 = 월 카드 + 세부 시트 (공용 부품 한 벌)
- **분류**: architecture
- **발견자**: developer
- **내용**: 학부모 청구가 보이는 화면(청구 탭 `/mypage/payments`, 아이 기록 `/mypage/record` 청구 이력)은 `src/lib/payments/monthBills.ts`(순수 규칙: 청구 달 = year/month 먼저·없으면 납기 KST 달, 상태 한 단어, 환불 제외 합계, 할인 해석) + `components/parent/billing/MonthBillCard`·`BillDetailSheet` 를 같이 쓴다. 결제 버튼은 화면이 `renderItemActions` 로 넘긴다(청구 탭의 기존 결제하기·입금했어요 핸들러 그대로). **Payment 에는 할인 칸이 없다** — amount = 할인 뒤 낼 금액, 할인은 description 글 안에만(작업대 «· 수강료 N · 할인 N · 기간조정 · 이월 · 셔틀», 옛 장부 «(할인 N, …)» 등). 해석값으로 계산한 금액이 amount 와 같을 때만 보인다. 새 청구 글 형식을 만들면 parseBillBreakdown 과 tests/parent-month-bills 를 같이 고칠 것(사유는 작업대 payload 에도 저장 안 됨).
- **참조횟수**: 0

### [2026-11-14] 질병·부상 결석 «이월 검토» = 검토 줄 1개 + 기존 이월 규칙 재사용
- **분류**: architecture
- **발견자**: developer
- **내용**: 사유가 질병·부상(`ILLNESS_INJURY`)인 정규 결석은 보강권을 바로 주지 않고 `RegularAbsenceCarryReview`(결석 1건당 1줄: PENDING→APPROVED/MAKEUP/CLOSED) 로 «검토 대기»에 둔다. 증빙 사진은 `RegularAbsenceEvidence` + 비공개 버킷 `absence-evidence`(권한 확인 API 가 대신 내려 줌 — 올린 학부모 본인·관리자만). 파일: 순수 규칙 `src/lib/regular/illnessCarryRules.ts`(7일·3장·90일·상태 글자) · 트랜잭션 쓰기 `illness-carry-tx.ts`(prisma import 없음 — 열기/닫기/보강권 전환/출결 보류 판정) · 원장 처리 `illness-carry-admin.ts` · cron `illness-carry-cron.ts`(기존 `/api/cron/makeup-credits` KST 00:30 에 붙음) · 사진 권한 `illness-evidence-access.ts`. ★ [이월 승인]은 새 계산이 아니라 `resolveWorkbenchAbsence`(CARRY)를 «같은 트랜잭션»에서 그대로 부른다(결석 확정 → readWorkbench 로 sourceVersion → resolve). 그 함수가 끝에서 검토 줄을 APPROVED/MAKEUP 으로 맞추므로 청구 준비 화면에서 정산해도 신청함과 어긋나지 않는다. 승인 예약은 없다 — 조건(결석일 지남·원래 달 청구 발행)이 맞을 때만 버튼이 켜진다. 신청함 종류 `ILLNESS_CARRY`(어댑터 = RegularAbsence + 검토 줄, 기간 결석·출석부 표시 행 포함, 결석일 전은 WAITING=진행 중). 출결 경로는 «사유 저장 → 보강권 맞춤» 순서이고 `syncCreditForRegularSession` 이 `isIllnessCreditHeld` 로 자동 발급을 멈춘다. 두 표가 없으면(마이그레이션 전) 전부 예전 방식(즉시 보강권)으로 동작한다 — `illnessReviewReady` 한 곳에서 판정. 사유 글(reasonText)은 건강 정보라 목록·알림·로그에 싣지 않고 관리자 상세 action 만 읽는다. 테스트: `tests/illness-carry.test.mjs` + absence-change·billing-workbench·list-stage8b 에 추가분.
- **참조횟수**: 0

### [2026-11-14] 관리자 수업 피드 = 커서 페이지 API + 공용 리포트 편집 부품
- **분류**: architecture
- **발견자**: developer
- **내용**: /admin/attendance/feed 는 첫 20개만 서버에서 그리고 다음은 GET /api/admin/feed(?cursor·필터, ?sessionId=카드 하나). 커서 = «수업일~시작 시각~id» 세 값 모두 내림차순이라 SQL 행 비교 (a,b,c) < ($1,$2,$3) 하나로 자른다(adminFeedRules.encode/decodeAdminFeedCursor). 필터는 전부 SQL(담당 선생님은 CROSS JOIN LATERAL 로 classCoachNameSql 한 번 계산). 리포트 편집 본문은 src/components/admin/SessionReportEditor.tsx 한 벌 — /admin/attendance/report/[sessionId] 화면과 피드 패널(SessionReportEditorLoader, compact)이 같이 쓴다. 관리자 영상 재생 = SessionVideoList endpoint 에 /api/staff/sessions/{id}/videos(관리자 = 전체 반).
- **참조횟수**: 0

### [2026-11-14] 선생님 «완료한 수업 다시 보기» = 수정 기간 판정 하나 + 완료 본문 부품
- **분류**: architecture
- **발견자**: developer
- **내용**: 선생님이 수업 기록을 고칠 수 있는 기간은 `staffSessionEditWindow`(몸통 `src/lib/sessionVideo/rules.ts`, 창구 `src/lib/staff/sessionEditWindow.ts` 가 다시 내보냄) 한 곳 — 수업일 포함 `STAFF_SESSION_EDIT_DAYS`(7)일, 원장·부원장(`canAccessAllClasses` → `unlimited`)은 제한 없음, 시작 전 수업의 한 줄만 «당일»(feed/rules.canEditFeedLine). 사진·영상 API 6곳·`saveSessionFeedLine`(UPDATE 조건 `staffSessionEditWindowSql`)·`saveSessionMemo`·`saveStaffAttendance`·`publishStaffSessionReport` 가 모두 이 함수로 막는다. 몸통을 sessionVideo/rules 에 둔 이유 = 학부모 화면 테스트 3개가 feed/rules 를 «kst + sessionVideo/rules»만으로 싣기 때문(새 의존 금지). 화면은 `CompletedSessionPanel`(LessonWorkspacePanels — 홈의 완료 줄 + 수업 주소 `/staff/sessions/[id]`, `embedded` 로 머리 유무) + 출결 정정 명단 `CompletedAttendanceRoster`(따로 둔 이유: LessonWorkspacePanels 에 `saveStaffAttendance` 를 들이지 않는다는 테스트). 완료 뒤 출결 정정 = 정규 수강생·특강 좌석만(보강·체험·전체 출석·질병 표시·미확인 되돌리기 거부), `previewStaffAttendanceCorrection`(바꾸지 않음) → 확인 1회 → 기존 저장 경로. 완료 뒤 수정(출결·한 줄·메모·발행)은 `OperationsAuditLog` action `STAFF_SESSION_REVIEW_EDIT`(본문 없이 항목·전/후), 학부모 출석 알림 없음, 결석 알림 스윕은 그 기록의 attendanceId 를 건너뜀. 발행 알림은 «처음 발행»(publishedAt 이 비어 있던 수업)만. 지난 수업 목록 `/staff/sessions` = `getStaffPastSessions`(최근 14일·완료·«열 수 있는 수업»만 — 지난 날 대타 수업은 권한이 자정에 닫혀 목록에도 없음).
- **참조횟수**: 0
