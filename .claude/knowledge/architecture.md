# 프로젝트 구조 지식
<!-- 담당: planner-architect, developer | 최대 30항목 -->
<!-- 프로젝트의 폴더 구조, 파일 역할, 핵심 패턴을 기록 -->

### 2026-11-09 학부모 공지 = 대량 큐의 «받는 사람마다 다른 본문» 항목(알림톡·브랜드 메시지·문자)
- **분류**: architecture
- **발견자**: developer
- **내용**: 대량 발송 큐 `reserveManualMessageQueue` 에 선택 인자 `items`(사람별 body + kakao{ALIMTALK|BMS_FREE})·`requestedChannel` 을 더했다. items 가 있으면 payload 에 `perItem:true` 가 실려 크론 `manual-message-dispatch` 가 `sendPerMessageBulkDetailed`(솔라피 send-many 에 메시지별 type ATA/BMS_FREE/SMS)로 보낸다 — 없으면 예전 «공통 본문» 경로 그대로(BATCH_BODY_MISMATCH 검사 유지). 카카오가 명시 거절하면 같은 내용을 문자로 1회, 응답 불확실은 재시도 금지. 장부 channel 칸은 DB CHECK 때문에 BMS 를 못 넣어 SMS 로 두고 종류는 messageType=BMS. 공지 틀은 `NOTICE_ALIMTALK_TEMPLATES`(자동 트리거 9종과 분리), 순수 규칙 `src/lib/messaging/parent-notice.ts`, 서버 `src/app/actions/parent-notice.ts`(미리보기→승인 재계산, OperationsAuditLog PARENT_NOTICE_*).
- **참조횟수**: 0

### 2026-10-08 카카오 학부모 인증·기존 빈 계정 활성화 흐름
- **분류**: architecture
- **발견자**: developer
- **내용**: ① 카카오 연결 화면은 `src/app/kakao-connect/page.tsx`(마이페이지 레이아웃 밖)에서 그리고 주소 `/mypage/kakao-connect` 는 next.config rewrite + 미들웨어 예외(`isMyPageKakaoConnect`)로 유지한다 — `/mypage/layout.tsx` 가 `requireVerifiedParent` 실패 시 먼저 튕겨 내서 상황별 안내를 못 보여 줬다. 판정은 `getVerifiedParentState()`(auth-guard, 상태 반환) → `requireVerifiedParent` 는 그 결과로 throw. ② 회원가입은 빈 계정(PARENT+합성 이메일+authUserId 없음) 번호를 신규처럼 문자 발송하고, **OTP 통과 뒤** `resolveVerifiedSignupPhone` 이 NEW/REGISTERED/여러 개(학원 문의)/간편로그인 연결/비밀번호 활성화로 나눈다. 비밀번호 활성화는 `issueVerifiedSelfParentClaim`(VERIFIED·30분·proof 10분, 특강 72시간 링크는 안 건드림) + httpOnly 증표 쿠키 → `/account/activate` 가 ACCOUNT 단계부터. ③ 카카오 인증 링크 토큰 = HMAC(비밀키, 봇·사용자키해시·만료ms) — 원문 비저장인 채로 유효 링크를 다시 보여 줄 수 있다. ④ 스킬 응답은 `buildKakaoSkillResponse`(textCard)만 — thumbnail 없는 basicCard 는 오픈빌더가 미발송(2461), 가드 `tests/kakao-skill-response-format.test.mjs`.
- **참조횟수**: 0

### 2026-03-22 시간표 데이터 파이프라인
- **분류**: architecture
- **발견자**: planner-architect
- **내용**: 시간표 데이터는 3단계로 조합된다. (1) Google Sheets CSV -> SheetClassSlot[] (SheetSlotCache DB 캐시 or 직접 fetch), (2) ClassSlotOverride 테이블로 라벨/코치/시간/정원 오버라이드, (3) CustomClassSlot 테이블로 시트에 없는 커스텀 슬롯 추가. 최종 결과는 MergedSlot[] 배열. schedule/page.tsx에서 이 조합 로직이 구현되어 있고, ScheduleClient.tsx에서 MergedSlot 타입이 export된다.
- **참조횟수**: 0

### 2026-03-22 공개 페이지 공통 패턴
- **분류**: architecture
- **발견자**: planner-architect
- **내용**: 공개 페이지는 (1) PublicPageLayout 래퍼, (2) 히어로 섹션 (gradient + 장식도형 + AnimateOnScroll), (3) 본문 섹션, (4) CTABanner 하단 CTA 구조를 따른다. ISR 캐싱 적용 (공개=300초, 관리자=30초). 서버 컴포넌트에서 queries.ts 함수로 데이터 조회 후 클라이언트 컴포넌트에 props로 전달하는 패턴.
- **참조횟수**: 0

### 2026-03-22 학년 체계 (GRADE_ORDER)
- **분류**: architecture
- **발견자**: planner-architect
- **내용**: googleSheetsSchedule.ts에 GRADE_ORDER 배열이 정의됨: ["6세","7세","초1"~"초6","중1"~"중3","고1"~"고3","성인"]. MergedSlot.gradeRange는 "초4~중1" 형태의 문자열. formatGradeRange() 함수로 생성. 학년 범위 판별 시 GRADE_ORDER 인덱스 비교 방식 사용.
- **참조횟수**: 0

### 2026-03-29 알림 시스템 아키텍처
- **분류**: architecture
- **발견자**: planner-architect
- **내용**: 알림 시스템은 2계층 구조. (1) DB 인앱 알림: Notification 테이블에 INSERT -> 사용자가 /mypage 접속 시 조회. (2) 웹 Push: PushSubscription 테이블에 저장된 구독으로 web-push 라이브러리가 브라우저 푸시 발송. createNotificationRecord(admin.ts:1080)가 두 계층을 동시 처리. 관리자 알림 패턴: SELECT id FROM "User" WHERE role='ADMIN' -> for loop으로 각 관리자에게 createNotificationRecord 호출 (createParentRequest:1188에 구현됨). sendPushToUser(pushNotification.ts)는 VAPID 키로 서명, 구독 만료(410) 시 자동 삭제. Coach 모델에 userId 없어 코치에게 직접 알림 불가.
- **참조횟수**: 0

### 2026-07-06 리치 텍스트 에디터 구조 (TipTap)
- **분류**: architecture
- **발견자**: planner-architect
- **내용**: 리치 에디터는 `src/components/RichTextEditor.tsx`(TipTap 3.20, "use client") 하나. 등록 확장 = StarterKit/TextStyle/Color/Underline/TextAlign. `src/components/extensions/FontSize.ts`는 구현됐으나 미등록. prop: value(HTML string)/onChange/name(hidden input)/placeholder. 출력은 editor.getHTML(). **사용처는 설정 페이지 단 1곳**(admin/settings/AdminSettingsClient.tsx의 소개글/이념/시설 3곳, value+onChange 바인딩). **공지사항은 이 에디터 미사용** — NoticesAdminClient는 순수 textarea+plain text 저장, notices/[id]/page.tsx는 toNoticeHtml(전부 escape+URL만 <a>)로 렌더+whitespace-pre-wrap. 이미지는 본문이 아니라 attachmentsJSON으로 하단 별도 <img> 노출. StarterKit 3.20에는 blockquote·bullet/ordered-list·horizontal-rule·link·dropcursor·gapcursor·underline이 이미 내장(별도 패키지 불필요). 표(extension-table)·유튜브(extension-youtube)만 미설치. 이미지 업로드는 공용 `/api/upload`(버킷 uploads, folder 파라미터, 5MB·이미지타입, 로그인 인증, 반환 {url}) 재사용. sanitize.ts(sanitize-html)는 table/list/blockquote/hr 이미 허용, iframe만 미허용.
- **참조횟수**: 0

### 2026-08-06 기사님 운행 화면은 통합 1개 — 라우트 3개는 껍데기, 저장 경로만 2벌 유지
- **분류**: architecture
- **발견자**: developer
- **내용**: `/shuttle/run/[token]`·`/shuttle/regular/[token]`·`/driver/[token]` 3개 라우트는 전부 `components/shuttle/UnifiedDriverRunPage.tsx`(서버) 한 곳으로 위임한다(각 라우트는 token+date 파싱 10줄). 화면은 그날 방학특강+정규를 **출발 시각 오름차순 한 목록**으로 그린다(행 = 정차 1개). 병합·정렬은 의존성 없는 순수 모듈 `lib/shuttle/unifiedDriverRunLogic.ts`, 서버 조회 조립은 `lib/shuttle/unifiedDriverRun.ts`. **화면만 합치고 저장은 절대 합치지 않았다** — 행마다 `kind`를 들고 다니며 특강 행은 `/api/shuttle/boarding`(direction+shuttleRequestId), 정규 행은 `/api/shuttle/regular-boarding`(rowId)로 **기존 파라미터 그대로** 간다. 화면 상태 키만 접두사(`S:PICKUP:`/`S:DROPOFF:`/`R:`)로 합치고 저장 시 원래 키로 되돌린다. 운영 DB에는 `ShuttleRunLink` 가 ROLLING/ALL(특강) 1건뿐이고 ROLLING/REGULAR(정규)는 **없다** → 기사님은 특강 링크 하나만 쓴다. 그래서 두 저장 API의 토큰 판정을 `lib/shuttle/driverToken.ts`(`isAnyDriverRunToken`)로 넓혔다(판정 함수 자체는 기존 `resolveRunToken`/`isRegularRunToken` 재사용, 저장 키·테이블·파라미터 무변경).
- **참조횟수**: 0

### 2026-03-26 관리자 페이지 데이터 로딩 패턴 분석
- **분류**: architecture
- **발견자**: planner-architect
- **내용**: admin 15개 페이지 전체가 revalidate:30 ISR 사용 (force-dynamic 0개). 서버 컴포넌트에서 queries.ts(react.cache) 함수로 데이터 조회 후 *Client.tsx에 props 전달하는 패턴 통일. 대시보드만 Suspense 스트리밍 적용. 대부분 페이지에서 Promise.all 병렬 쿼리 완료. 남은 병목: (1) 대시보드 getDashboardExtendedStats 이중 호출, (2) getClassWithStudents/getStudentActivity 직렬 쿼리, (3) schedule 페이지 Google Sheets 직렬 대기.
- **참조횟수**: 0

### 2026-08-06 정규 셔틀은 "식별키가 두 벌"이다 — 배차 노선 studentId ↔ 탑승체크 시트행 id
- **분류**: architecture
- **발견자**: developer
- **내용**: 정규 셔틀 데이터는 같은 사람을 **서로 다른 키 두 개**로 부른다. (1) 저장 배차 노선(`RegularDispatchRoute.payload.vehicles[].stops[].students[].requestId`)의 값은 **studentId** 다 — `shuttleRoster.ts` 의 `COALESCE(Student.id, 'stop:'||RegularShuttleStop.id)`. (2) 기사님 탑승 체크(`ShuttleBoarding`, direction='REGULAR')의 `shuttleRequestId` 는 **시트 정차행 id(RegularShuttleStop.id)** 다. 그래서 저장 노선을 기사님 화면에 그대로 뿌리면 과거 체크가 전부 미체크로 보인다. 되돌림 매핑은 `getRegularShuttleRiders` 가 함께 돌려주는 `stopRowId`(2026-08-06 추가) 로 만든다. 주의: 한 학생이 같은 요일·방향에 시트 행을 **여러 개** 가질 수 있다(실측 8건 — 하원인데 '승차'로 적힌 행 등). 따라서 매핑은 1:1 이 아니라 studentId → rowId **큐**이고, 정류장 이름이 일치하는 행을 먼저 소비한다. 기사님 화면 조립은 `src/lib/shuttle/regularDriverRoute.ts`(서버) + `regularDriverRouteLogic.ts`(순수) 한 곳에서만 한다.
- **참조횟수**: 0

### 2026-08-08 PWA 설치 화면의 "무엇을 보여줄까"는 installReadiness 순수 모듈 한 곳에서
- **분류**: architecture
- **발견자**: developer
- **내용**: 설치 화면은 학부모 `/app`(→`/mypage/install`, `app/parent-app/ParentAppInstallClient.tsx`)과 선생님 `/staff/install`(`app/teacher-app/StaffAppInstallClient.tsx`) 두 개다. 두 화면의 판단 로직은 전부 순수 모듈로 뺀다 — 기기/브라우저 판별은 `lib/pwa/installEnvironment.ts`, **화면 표시 판단(대기/설치버튼/수동안내/인앱탈출)은 `lib/pwa/installReadiness.ts`**(`resolveInstallScreenView`·`shouldWaitForInstallPrompt`·`INSTALL_PROMPT_WAIT_MS=1500`). 이유: 크롬은 `beforeinstallprompt` 를 마운트 후 1~2초 뒤에 쏘는데, 그 전에 "이미 설치돼 있으면 설치 버튼이 나타나지 않습니다" 수동 안내가 먼저 보여 사용자가 설치 불가로 오해하고 이탈했다. 그래서 안드로이드/PC 만 1.5초 대기 창을 두고 그동안 안내를 감춘다. **iOS·인앱 브라우저·이미 설치됨은 대기하지 않는다**(애플은 이 이벤트를 아예 안 보내므로 기다리면 순손해). 대기 창은 표시를 미루는 것일 뿐 `prompt()` 자동 호출은 금지(user activation 밖에서 부르면 이벤트가 무효화됨). 회귀 테스트가 잠근 소스 표현이 있다 — `tests/pwa-install-environment.test.mjs` 는 두 화면에 `deviceState !== "checking" && !inAppBrowser` 문자열이 그대로 있길 요구하므로, 조건을 `view.showManualGuide` 로 갈아치우지 말고 **AND 로 덧붙인다**. 대기 로직 테스트는 `tests/pwa-install-wait-window.test.mjs`(TS 를 transpileModule 로 실행 검증).
- **참조횟수**: 0

### 2026-10-03 셔틀 명단 중간 삽입은 「다음 정차 첫 행 앞」 + 요일 전체 sortOrder 밀기
- **분류**: architecture
- **발견자**: developer
- **내용**: 기사님 화면(groupSheetStops)은 같은 정류장 이름 행을 **처음 나온 행 위치**에 한 정차로 묶는다. 그래서 정차 k 와 k+1 사이에 새 정차를 넣을 때 「k 의 마지막 행 뒤」 기준이면 같은 정류장이 흩어진 칸(A,B,A)에서 B 뒤로 밀린다 → 「k+1 의 첫 행 앞(BEFORE)」으로 넣는다. sortOrder 는 요일 안 번호(다른 수업·방향·PIVOT/RETURN 과 섞임)라 `그 달·요일 sortOrder ≥ 기준 +1` 후 기준 번호를 새 행에 준다 → 다른 행 상대 순서 불변. 칸 안에 번호가 겹친 학생 행(A(5)·B(5))이 있으면 먼저 화면 순서(sortOrder, 겹치면 id 바이트 순 — 명단 조회 ORDER BY "id" COLLATE "C")대로 벌린 뒤 넣는다. 합류(JOIN)는 번호를 밀지 않고 칸 맨 뒤 + 대상 행의 stopName 글자·좌표·시각 복사(같은 이름은 첫 위치로 묶이므로 결과 동일). 순수 계획 `planRosterInsert`·추천 `regularRosterPlacementLogic.ts`, 실행 테스트가 buildFallbackClasses 로 다시 그려 검증한다.
- **참조횟수**: 0

### [2026-10-09] 카카오 정책 답변(Gemini) — 순수 엔진 + 연결부 + 챗봇 연결점(hook) 3층
- **분류**: architecture
- **발견자**: developer
- **내용**: 판단 로직은 `src/lib/kakao-policy-qa.ts`(순수: 질문 판별·주입 방어 프롬프트·`[ESCALATE]` 해석·시간 제한·`runPolicyFlow` 동기/콜백 분기)에 두고, DB·Gemini·콜백 전송·after() 는 `kakao-policy-qa-service.ts` 가 주입한다 → 테스트는 가짜 Gemini 로 흐름 전체를 실행한다. 학부모 챗봇은 `handleLinkedMessage(..., policyHook)` 연결점만 받고, hook 이 null 이면(킬 스위치 꺼짐·DB 미준비·키 없음) 기존 접수 흐름 그대로. 못 답하면 escalate = 기존 `createIntakeReply`(+안내 한 줄). 게스트는 라우트에서 인증 판별 뒤·기본 카드 앞. Gemini 모델·키는 `src/lib/gemini-client.ts` 한 곳(웹 `/api/chat` 도 사용). SDK 0.24.1 타입엔 thinkingConfig 가 없지만 generationConfig 는 본문에 그대로 실려 형 변환으로 넘긴다. 챗봇 파일에 import 를 늘리면 `tests/kakao-parent-connect-flow.test.mjs` 의 손 치환 목록에도 넣어야 한다(안 넣으면 ERR_INVALID_URL).
- **참조횟수**: 0

### [2026-10-17] 카카오 보강 신청·취소 = 대화 상태는 KakaoParentIntake 한 행(status MAKEUP_FLOW), 규칙은 parent-makeup 그대로
- **분류**: architecture
- **발견자**: developer
- **내용**: `src/lib/kakao-makeup-flow.ts` 가 `handleLinkedMessage` 에서 재확인 링크 바로 뒤·작성 중 접수 앞에 불린다(무관한 말이면 null). 상태는 스키마 변경 없이 `KakaoParentIntake`(kind MAKEUP, status `MAKEUP_FLOW`, structuredJson 에 단계·서버가 만든 목록)에 두고 `updatedAt` 30분이 지나면 무시한다. 끝나면 APPLIED, 그만두면 CANCELED. 학부모는 번호만 보내고(id 는 상태에서만 꺼냄), 단계 이동은 `"structuredJson"->>'step'` 조건 UPDATE 로 한 번만 진행된다. 예약·취소는 웹과 같은 `bookMakeup`/`cancelMakeupBooking` 을 직접 부르고, 그 직전에 보호자 소유·후보 유효를 다시 조회한다. 바로가기 문장은 모두 '보강'을 품어 상태가 만료돼도 처음부터 다시 시작된다. 단 메뉴 버튼 「결석·보강」은 MAKEUP 으로 분류되므로 반드시 제외해야 한다(제외하지 않으면 하위 메뉴가 사라진다). 챗봇에 import 를 늘렸으므로 테스트 2곳(connect-flow·policy-qa)의 손 치환 목록에 대역을 넣었다.

### 2026-10-23 체험(TrialLead) ↔ 수강 신청서 연결은 판정 모듈 + 연결부 한 곳에서
- **분류**: architecture
- **발견자**: developer
- **내용**: 연결 판정은 순수 모듈 `src/lib/enrollment/trialLeadMatch.ts`(`decideTrialLeadMatch` → AUTO/SUGGEST/NONE, 한글 음절 편집거리), DB 읽기·저장은 `src/lib/enrollment/trialLeadLinkService.ts` 한 곳(`linkTrialLeadToApplication` = 조건부 UPDATE 한 트랜잭션, 승인된 신청서면 체험 CONVERTED, ApplicationContactLog UPDATED 2줄, 문자 없음). 비교 시점 3곳: 신청 제출(`submitEnrollApplication`, accessCode 없을 때 AUTO 만), 체험 이름·번호 수정(`updateTrialLead` → `autoLinkApplicationsForTrialLead`), 관리자 신청 목록 후보+[연결](`getEnrollTrialLinkSuggestions`/`linkEnrollApplicationToTrialLead`). 새 연결 경로를 만들면 SQL 을 또 쓰지 말고 이 두 파일을 쓴다. 테스트 `tests/enrollment-trial-lead-match.test.mjs`.
- **참조횟수**: 0

### [2026-11-05] 기사님 「새 학생 배정」 = 순수 판정(driverAssignLogic)+연결부(driverAssign)+addRosterStudentAs
- **분류**: architecture
- **발견자**: developer
- **내용**: `/staff/shuttle/assign` 은 승인 셔틀 신청(APPROVED+shuttleNeeded)+ACTIVE 수강(개시일 ≤ 그 달)의 「남은 칸(요일×등·하원)」을 관리자 학생 추가와 같은 함수(enrolledClassSlots·findRouteCell·suggestPlacement·resolveCellPlacement)로 계산한다. 쓰기는 `regularRosterEdit.addRosterStudentAs(actorId, raw, { via, guard })` 하나 — ⚠️ 이 함수는 권한 확인을 하지 않으므로 호출부가 현재 DB 역할을 먼저 확인한다(원장 = addRosterStudent 의 requireAdmin, 기사 = driverAssign.authorizeAssign). guard 는 달 잠금 안에서 「그 칸이 아직 비었는지」 마지막 확인. 감사 기록은 ShuttleAuditLog REGULAR_ROSTER_ADD(actorId=기사 userId, afterJSON.via="DRIVER_ASSIGN").
- **참조횟수**: 0

### [2026-11-05] 총 재원기간·3년 재원 유니폼 무료 링크 구조
- **분류**: architecture
- **발견자**: developer
- **내용**: 재원기간 = 옛 시트 기준값(`Student.tenureBaselineMonths/Through/FirstMonth`) + 기준월 «뒤» 사이트 수강 달(수강료 year-month ∪ 출석 PRESENT 세션 KST 달). 계산은 순수 `lib/student-tenure.ts`, 조회는 `lib/student-tenure-query.ts`(getStudentActivity 무변경, 실패 시 null=표시 안 함). 무료 유니폼은 `UniformFreeGrant`(토큰 32자 base64url, ISSUED→USED|REVOKED, 만료는 expiresAt) — 규칙 `lib/uniform-free-grant-rules.ts`, 발급·조회·신청 `lib/uniform-free-grant.ts`(prisma 를 import 하지 않고 db 인자로 받아 가짜 DB 로 동작 테스트). 신청은 `FOR UPDATE OF g` 잠금 후 주문을 **NEEDS_REVIEW** 로 저장 → 크론(PENDING·RETRY_WAIT 만)·즉시 발송 모두 안 탐, 원장이 /admin/uniform «재전송»(dispatchUniformOrderById 는 SENT·DUPLICATE 외 모두 보냄)으로 본사 발송. 무료 표시는 주문 메모 앞머리 `[3년 재원 무료 증정]`(관리자 배지 판정). 디자인·사이즈·검증은 `lib/uniform-options.ts` 공용.
- **참조횟수**: 0

### [2026-11-05] 정규배차 시간순 화면 = 두 RouteSection(방향별 상태·저장) + display:contents + CSS order
- **분류**: architecture
- **발견자**: developer
- **내용**: `/admin/shuttle/regular-dispatch` 는 등원·하원 RouteSection 을 `timeOrdered` 로 한 flex 목록에 넣는다. 섹션 겉 상자·카드 그리드는 `contents` 로 풀리고 회차 카드마다 `order = runTimelineOrder()`(`lib/regular/regularDispatchOrder.ts`: **실제 출발 시각 departTime(손 수정 반영)** → 없으면 등원 classStart−30분·하원 classEnd → tripLabel → 맨 뒤, 「수업시간 확인 필요」 회차는 맨 뒤, 같은 시각이면 등원 먼저. ⚠ 처음엔 수업 시작/종료를 기준으로 써서 17시 수업 등원(16:35 출발)이 16시 수업 하원(17:05 출발) 뒤로 갔다 — 운영에서 원장이 지적, «시간순» = 차가 움직이는 순서). 저장 바(-2/-1)·지도(1e7)도 order 로 배치. 상태를 끌어올리지 않고 섞지만 **탭 이동 순서는 DOM(등원 전부 → 하원 전부)**. 방학특강(DispatchClient)은 prop 을 안 줘 DOM 그대로 — `timeOrdered` 분기 밖을 고치면 방학특강도 바뀐다.
- **참조횟수**: 0

### [2026-11-05] 신규 셔틀 학생 배정 = 정규배차 패널 + 공용 한 칸 배정(AssignLegView) 하나
- **분류**: architecture
- **발견자**: developer
- **내용**: 관리자 「신규 셔틀 신청」 탭은 폐지(`/admin/shuttle/intake` → `/admin/shuttle/regular-dispatch?month=` redirect). 정규배차 요일 탭 아래 `NewStudentDispatchPanel`(목록 기준 = `getDriverAssignBoard`, 기사 검토 배지·요청 = 기존 `/api/admin/shuttle/intake`)이 칩 → 모달로 `AssignLegView` 를 띄운다. 기사님 `/staff/shuttle/assign` 도 같은 `src/components/shuttle/assign/AssignLegView.tsx` 를 쓴다 — **한 칸 배정 UI를 고칠 땐 이 파일 하나**(사본 금지, 테스트가 `function AssignView(` 부재 확인). 넣기 API 는 둘 다 `/api/staff/shuttle/assign`(관리자도 requireStaff·authorizeAssign 통과), 감사 via 는 관리자 역할 + body.source="ADMIN_DISPATCH" 일 때만 ADMIN_DISPATCH. 넣은 뒤 RouteSection 은 `refreshKey`(월×1000+횟수)로 다시 읽되 저장 안 한 편집(dirty)이 있으면 덮지 않는다. 기사 검토 화면(ShuttleIntakeClient driver 모드)은 그대로.
- **참조횟수**: 0

### [2026-11-07] 카카오 결석·셔틀 대화 = kakao-flow-store(공용 상태) + 흐름별 파일, 웹과 같은 저장 함수
- **분류**: architecture
- **발견자**: developer
- **내용**: 보강 흐름 방식을 결석(`kakao-absence-flow`·status ABSENCE_FLOW)·셔틀(`kakao-shuttle-flow`·SHUTTLE_FLOW, 당일/당일취소/정규 3모드)로 확장. 상태 SQL(활성 30분·단계 선점 advance·close·submit)은 `kakao-flow-store.createFlowStore` 한 곳, 새 흐름을 열 때 `KAKAO_OPEN_FLOW_CLOSE_SQL`(초안+모든 흐름)을 닫는다 — 보강 흐름도 같은 목록. 챗봇 순서: 재확인 → 보강 → 결석 → 셔틀 → 초안 → 메뉴 → 분류(RENTAL 카드) → 정책 → 접수. 정규 셔틀은 흐름 행을 그대로 SUBMITTED 로 바꿔 관리자 접수함이 effectiveDate·shuttleIntent·details 를 미리 채운다. 테스트: `tests/kakao-care-flows.test.mjs`(가짜 DB 실행). 챗봇을 올리는 다른 테스트(policy-qa·connect-flow)는 흐름 모듈 3개를 null 스텁으로 끼운다 — 새 흐름을 추가하면 그 두 곳에도 스텁 추가.
- **참조횟수**: 0

### [2026-11-07] 체육관 대관 = 순수 규칙(gym-rental-rules) + DB 연결부(db 인자) + 알림 + EXCLUDE 제약
- **분류**: architecture
- **발견자**: developer
- **내용**: 공개 `/rental`(로그인 없음) → 관리자 `/admin/rental`(사이드바 «요청·신청함»). 요금·1시간 칸·상태 전이·문자 문구는 `src/lib/rental/gym-rental-rules.ts` 한 곳(화면 실시간 표시와 서버 저장 직전 재계산이 같은 함수). DB 는 `gym-rental-service.ts`(prisma import 없음, db 인자 → 가짜 DB 테스트). 가능 칸 = 09~22시 중 Class(dayOfWeek Mon~Sun)·SpecialProgramSessionDate(취소 제외)·승인된 대관과 안 겹치고 아직 시작 안 한 칸. 연간일정 휴무일은 열지 않음(보수적). 이중 확정 방지 = 승인 시 FOR UPDATE + 날짜 advisory lock + **EXCLUDE USING gist(tstzrange(startAt,endAt)) WHERE status IN 승인 이후 4종** — 코드 `RENTAL_HOLDING_STATUSES` 와 같은 집합인지 테스트가 비교. 알림 `gym-rental-notify.ts`: 원장 = 규칙 RENTAL_NEW_ADMIN(끄면 문자·슬랙·앱 알림 모두 멈춤 → 운영 시험 때 이걸로 막음), 신청자 승인·확정 = env `RENTAL_APPLICANT_SMS_ENABLED=1`, 접수 = 전용 env `RENTAL_APPLICANT_RECEIVED_SMS_ENABLED=1`(남의 번호 악용 방지), 둘 다 규칙도 켜야 함(꺼진 채 배포). 원장 문자는 10분 창 키로 한 통(슬랙 건별). 공개 신청은 tx+advisory lock 안에서 연락처·IP(x-forwarded-for 첫 값 sha256) 한도 확인 후 저장. 승인 때 loadRentalSlots 로 수업·특강 재확인. 반 판정은 이름 `[` 시작 제외+ACTIVE 수강생 있는 반만. 계좌는 서버 전용 `gym-rental-notify.ts`(server-only)에만 — 규칙 모듈은 브라우저 번들에 실리므로 금지, 테스트가 클라이언트 import 그래프를 검사.
  **[2026-11-08 분 단위 전환]** 1시간 칸 → `buildRentalDay`(시작 10분 간격 후보·막힌 구간·maxMinutes) + `isRentalRangeAvailable`(서버 검증 기준). 평일 09:00·주말 10:00(`rentalOpenMinute`)~22:00, 이용 30분 단위 60~360분. 저장 = `startMinute`/`endMinute`(그날 KST 0시부터 분, 마이그레이션 20261108210000, nullable → 읽기는 COALESCE(startHour*60)) + 기존 startHour(내림)/endHour(올림) 계속 채움, 겹침 진짜 기준은 startAt/endAt. 요금 = 30분 단가 기준(RENTAL_FEE.extraHalfHour 등, 시간당 값은 ×2) — 정수 시간이면 옛 금액과 같음(테스트). 시간 표시는 `formatRentalTime`/`rentalTimeText` 하나(«20:40~22:10 (1시간 30분)»). 공개 화면 달력은 `buildRentalCalendar`·`shiftYm`.
- **참조횟수**: 0

### [2026-11-07] 고객 안내 문자 = 공용 «미리보기 → 원장 승인 → 1건 발송» 한 벌
- **분류**: architecture
- **발견자**: developer
- **내용**: 문구는 `src/lib/customer-notice/templates.ts`(import 없는 순수 함수), 서버는 `src/app/actions/customer-notice.ts` 의 prepareCustomerNotice/sendCustomerNotice, 화면은 `src/components/admin/CustomerNoticeSender.tsx`(kind 별 props). 승인 기록은 OperationsAuditLog(CUSTOMER_NOTICE_PREVIEW/CLAIMED/RESULT, 번호·문구는 해시만), 발송은 관리자 수동 문자와 같은 장부(MessageDeliveryBatch·NotificationDelivery, trigger MANUAL_MESSAGE, eventType=kind). 새 안내를 늘릴 때는 kind 하나 + resolveNotice 분기 + 문구 함수만 추가한다. 카카오채널 주소는 `kakaoChannelLinks(settings.kakaoChannelUrl)` 로만 만든다.
- **참조횟수**: 0

### [2026-11-07] 토스 POS «현장 결제» = 순수 규칙(charge-request.mjs) + 실행부(chargeRequestService.ts) + 플러그인 API(토큰)
- **분류**: architecture
- **발견자**: developer
- **내용**: 관리자 수납 ⚡ «현장 결제»(MONTHLY·SHUTTLE 미납, 원장만) → `PosChargeRequest`(번호 S-dddd, 금액·면세 DB 스냅샷, 30분, 열린 요청 부분 유일 인덱스). 웹훅 `processPosWebhookEvent` 가 재조회한 주문으로 `matchChargeRequestsForOrder` 를 먼저 부르고, 자동 납부(조건부 UPDATE 선점 → markPaymentPaid CARD·TOSS_POS)한 결제만 PosPaymentNotice 에서 뺀다 — 그 밖은 기존 슬랙 확인 흐름(D1). 판정(금액·만료·여러 결제·부분취소·중복)은 순수 `decideChargeMatch` 한 곳. 플러그인 API `/api/pos-plugin/**` 는 `handlePluginRequest`(Bearer 토큰 SHA-256·timingSafeEqual·분당 제한) 경유만, 납부 경로 없음. 토큰 화면 `/admin/pos-plugin`. 계약 = docs/toss-pos-plugin-plan.md 8장.
### [2026-11-07] 토스 POS 플러그인 = apps/toss-pos-plugin 독립 패키지(사이트 빌드 밖)
- **분류**: architecture
- **발견자**: developer
- **내용**: 자체 package.json·tsconfig·node_modules. 루트 `tsconfig.json` exclude·`eslint.config.mjs` ignore 에 `apps/toss-pos-plugin` 이 빠지면 루트 `**/*.ts` 포함 때문에 next build(Vercel)가 깨진다. 핵심 로직은 `src/core/*`(SDK 를 import 하지 않고 pos-types.ts 최소 모양을 인자로 받음 → node --test 가짜 SDK), 실제 SDK 와 맞는지는 `tests/sdk-compat.typecheck.ts` 가 tsc 로 확인. 서버 API 주소·응답 해석은 `src/core/contract.ts` 한 곳(camel/snake 둘 다 읽음). SDK 0.0.31 은 **주문 전체 메모를 넣는 함수가 없어** `STIZ:S-xxxx` 를 항목 메모+item.code 에 넣는다 → 서버 웹훅 매칭은 lineItems[].memo·item.code 도 봐야 한다. 요청 제한은 http 포함 60초 100·30분 200번. 운영 매장 배포 = 라이브 검수(월·목)+VAN 대리점 활성화, 개발 배포는 테스트 단말기 5대.
- **참조횟수**: 0

### [2026-11-08] 현장 결제 매칭 = 방식 무관·분할 결제 합계, 결제 목록은 «알림용»과 «매칭용» 두 함수
- **분류**: architecture
- **발견자**: developer
- **내용**: payment-notice.mjs 의 extractNoticePayments(카드·BARCODE, 슬랙 확인 DM 용)와 extractChargePayments(APPROVED 전부, 현장 결제 매칭용)는 같은 내부 함수 한 벌이다. decideChargeMatch 는 승인 결제 합계·면세 합계로 판정하고 주문 진행 중(isOrderCompleted=false) 합계 부족이면 SKIP(waiting, 그 결제들의 DM 도 미룸)·완료 뒤 부족이면 HOLD. 분할이면 대표 결제(가장 먼저 승인)만 PosChargeRequest.tossPaymentId(유일), 나머지는 note+PaymentAuditLog(POS_CHARGE_PAYMENTS), 이중 매칭은 CLAIM_PAY_SQL 의 «같은 tossOrderId 다른 요청 PAID» NOT EXISTS 로 막는다. Payment.method 는 posMethodOf(CARD·CASH·EASY_PAY·BANK_TRANSFER·ETC, 분할 «CARD+CASH»), 표시는 posMethodLabel(«현장 · 카드+현금»). adminDisplayText.ts 는 테스트가 import 없이 단독 실행하므로 다른 모듈을 import 하지 말고 이름만 맞춘다(테스트가 비교).
- **참조횟수**: 0

### [2026-11-08] 토스 POS 결제 취소 = 사이트 요청(cancelState) → 플러그인 cancel.ts → 토스 웹훅 재조회로만 환불
- **분류**: architecture
- **발견자**: developer
- **내용**: 관리자 ⚡ «결제 취소»(PAID·paidProvider TOSS_POS)는 PosChargeRequest.cancelState=REQUESTED 만 남긴다(청구서 id 로만 요청을 찾아 IDOR 차단). 플러그인 롱폴링 응답 `cancels[]` → `/cancel/claim`(SENT, 결제 ID 는 서버가 감사기록 POS_CHARGE_PAYMENTS→note→대표결제 순으로 계산) → payment.cancel → `/cancel/report`(기록만, FAILED 면 사이트 «POS 에서 직접 취소»). 환불은 matchChargeRequestsForOrder ①의 settleCancelForRow 가 재조회 주문으로 decideChargeCancel(FULL/PARTIAL/NONE) → FULL 이면 한 트랜잭션에서 MARK_REFUND_SQL + payment-ledger refundPaidPaymentInTx. POS 직접 취소도 같은 길. chargeRequestService 는 Payment 를 직접 UPDATE 하지 않는다(테스트가 막음). 같은 함수의 retryLater=true(분할 대기·납부 기록 복구 대기)면 웹훅을 processedAt 비운 채 두어 10분 스윕이 다시 본다. 마이그레이션 20261108120000 은 코드 배포보다 먼저 적용해야 한다(VIEW_SQL·MATCH_SELECT 가 새 칸을 읽음).
### [2026-11-08] 현장 결제 묶음 = 요청 1건 + PosChargeRequestItem N건, 대표 청구는 요청.paymentId 그대로
- **분류**: architecture
- **발견자**: developer
- **내용**: 같은 학생 미납 여러 건을 POS 결제 한 번으로(원장 결정). 요청 표는 그대로(합계·면세 합계·대표 청구 = 1번 항목)라 단건 코드·인덱스가 그대로 돈다. 묶인 청구는 `PosChargeRequestItem`(마이그레이션 20261108180000, 코드보다 먼저 적용). 같은 청구가 두 열린 요청에 못 들어가게 항목 `"open"`+부분 유일 인덱스, 요청 상태가 열린 상태를 벗어나면 트리거가 닫는다(상태 UPDATE 가 어디서 오든). 서비스의 SQL 은 조각 `ITEMS_OF_R`(항목 없는 옛 요청 = 대표 청구 1건)·`ALL_ITEMS_UNPAID_SQL`(전부 미납·금액 그대로·합계=요청 금액)·`hasPaymentSql(n)`(대표이거나 항목) 을 끼워 쓴다 — 청구 id 로 요청을 찾는 새 SQL 은 반드시 hasPaymentSql. 묶음 납부는 `markPaymentsPaidTogether`(payment-ledger, 한 트랜잭션·건마다 조건부 UPDATE·하나라도 0행이면 전부 되돌림), 단건은 예전 markPaymentPaid — 둘 다 writeLedgerPaid 한 곳에서만. 환불·감사 기록은 묶인 청구마다. 유일 위반 이름 정규식은 `PosChargeRequest(?:Item)?_` (Item 표 인덱스를 놓쳐 동시 생성 처리가 깨질 뻔함 — 테스트로 고정).
- **참조횟수**: 0
### [2026-11-08] 무통장입금(가상계좌) = 거래(PaymentTransaction) 상태만 «입금 대기», 청구 상태는 새로 안 만듦
- **분류**: architecture
- **발견자**: developer
- **내용**: 승인 응답 WAITING_FOR_DEPOSIT → `PaymentTransaction.status='WAITING_FOR_DEPOSIT'`·method «가상계좌»·rawResponse 에 `virtualAccountIssue`(은행·계좌·예금주·기한·금액)+`depositSecretHash`(SHA-256, 원문 secret 저장 안 함). 청구(Payment)·청구서는 미납 그대로. 판정은 순수 `src/lib/payments/virtualAccount.ts`(decideVirtualAccountWebhook: PAY·ALREADY_DONE·RELEASE·REJECT·IGNORE·DELEGATE), secret 해시·비교는 서버 전용 `virtualAccountSecret.ts`(학부모 화면이 import 하면 번들에 node:crypto). 웹훅은 secret 대조→토스 재조회→finalizeVerifiedTossPayment(paidAt 인자, paidDate 무tz=`$::timestamptz AT TIME ZONE 'UTC'`). 학부모 화면용 조회는 `rawResponse->'virtualAccountIssue'` 만 SELECT(마이페이지 2경로는 queries.ts `PARENT_VIRTUAL_ACCOUNT_LATERAL` 공용). ⚠️ DEPOSIT_CALLBACK createdAt 은 시간대 없는 KST → `parseTossTimestamp`. 해제·납부 반영은 웹훅·학부모/원장 «계좌 닫기»(closeOpenVirtualAccount: 토스 취소→재조회)·매일 점검 cron(`/api/cron/virtual-account-sweep`)이 `releaseVirtualAccountTx`·`payVerifiedVirtualAccount` 한 곳을 같이 쓴다. 웹훅 원문은 `stripWebhookSecrets` 로 가려 저장(지문은 원문으로 먼저).
- **참조횟수**: 0

### [2026-11-08] 대관 신청자 문자 = 알림톡 틀 하나(틀+변수 → 문자 본문·알림톡 variables 동시 생성)
- **분류**: architecture
- **발견자**: developer
- **내용**: `gym-rental-rules.ts` 의 `RENTAL_APPLICANT_TEMPLATES`(#{변수} 틀) + `buildRentalApplicantMessage` 가 본문과 variables 를 같은 맵에서 만든다(알림톡은 등록 문구와 한 글자라도 다르면 실패). 발송은 `sendTrackedSms({ alimtalk })` → notification.ts 가 `sendMessageDetailed` 에 그대로 전달(장부 유지, 다른 호출은 alimtalk 없음 = 기존 문자). 템플릿 id 는 env `RENTAL_ALIMTALK_*`, 실제 알림톡 시도는 /admin/sms 규칙 채널이 알림톡 + 외부 알림톡 채널 켜짐 + SOLAPI_KAKAO_PF_ID 일 때만. 심사 문서 `docs/kakao-alimtalk-rental-templates.md` 는 테스트가 틀과 글자 대조. 재원생 무료 = 로그인한 PARENT 계정(getVerifiedParentState 통과)의 «내 자녀»(`childAccessSql("s","$1")` — 가족 공유·본인 연결 포함) 중 재원(병합 제외+시작된 ACTIVE 수강+끝난 반 제외) 학생만(`listRentalMemberStudents`). 이름·번호 대조는 쓰지 않는다(맞히기 공격). 공개 /rental 은 정적 유지, 로그인 여부는 액션 `getRentalMemberContext` 로 묻는다.
### [2026-11-09] 학부모 알림톡 = 공용 금고 parent-alimtalk-templates.ts (대관 패턴 일반화)
- **분류**: architecture
- **발견자**: developer
- **내용**: 알림톡으로 바꾼 학부모 트리거는 `src/lib/messaging/parent-alimtalk-templates.ts` 의 `PARENT_ALIMTALK_TEMPLATES`(#{한글변수} 틀 + 호출부 키 연결 + 기본값)가 정본이다. 문자 본문 = 알림톡 본문. `notification.ts resolveParentMessage` 가 `sendParentSms`·`sendParentSmsWithResult`(체험·셔틀)와 `seasonal/notifications.ts`(특강, `dispatchReservedSmsDelivery({alimtalk})`)에서 금고 틀을 쓰고, 빈 변수면 옛 DB 문구로 «문자만» 보낸다. DB `SmsTemplate` 은 isActive 스위치 + 대체 문구 + 화면 표시용(/admin/sms 문구 화면은 금고 트리거 본문 수정 잠금). 템플릿 id = env `ALIMTALK_TPL_*`(alimtalk-config.ts). 가드 `tests/parent-alimtalk-templates.test.mjs`: 코드의 `*_PARENT`/`*_APPLICANT` 문자열은 금고 또는 `SMS_ONLY_PARENT_TRIGGERS` 에만 — 새 학부모 문자를 만들면 둘 중 하나에 넣어야 테스트가 통과한다. 머리말 상수 `PARENT_MESSAGE_PREFIX`(«[스티즈농구교실]»). 심사 문서 `docs/kakao-alimtalk-parent-templates.md` 는 테스트가 글자 대조.
- **참조횟수**: 0
### [2026-11-08] 정규 수업 기록 «같은 반·같은 날 = 하나» = regularSession.ts 한 곳 · 보강 온 아이 출석 = makeup-attendance.ts
- **분류**: architecture
- **발견자**: developer
- **내용**: 정규 Session 자연키는 `regularSessionKey(반id, YYYY-MM-DD)` 하나. 관리자 출결(saveAttendance)·수업일지(saveSessionLog)·랠리즈 반영은 `findOrCreateRegularSession(tx, …)`, 코치 «수업 시작»·«예정 내용»은 `adoptRegularSessionKey(tx, …)`+`regularSessionKey`(모두 트랜잭션 안·키별 advisory 잠금). 키 없는 옛 기록은 «입양»(키를 붙임)해 둘로 갈라지지 않는다. Session 을 새로 만드는 경로를 추가하면 반드시 이 파일을 거친다(테스트 `regular-session-single-record` 가 admin.ts 의 키 없는 INSERT 를 막음). 보강: 코치 출석부 명단은 `makeupOnClassDateSql`(makeupDate timestamptz 에 시간대 한 번)로 이 반·이 날 BOOKED/ATTENDED 예약 아이를 «보강»으로 붙이고, 출결 저장도 같은 조건으로 판정 → `applyMakeupAttendanceInTx`(lockCompensation·FOR UPDATE·조건부 UPDATE) 뒤 기존 `syncCreditForMakeupSession`(ATTENDED→USED·BOOKED→RESERVED). 출석·지각=참석(같은 날 한 건만), 결석=보강권 안 씀·참석이었으면 되돌림. 보강 아이는 `syncCreditForRegularSession`(결석 보강권 발급)을 타지 않는다.
### [2026-11-08] 청구 준비 제안값(주N회 요금·셔틀비·형제할인) = 순수 workbench-pricing + readWorkbench 사전 판정
- **분류**: architecture
- **발견자**: developer
- **내용**: 청구 준비 행은 «학생×반»이라 주2회 학생은 행 2개다. `readWorkbench` 가 먼저 행마다 청구 대상(excluded)을 정하고(scopeOf), 청구 대상 반만 `src/lib/billing/workbench-pricing.ts` 에 넘긴다 — planWeeklyTuition(**11-09 원장 결정**: N = 학생 청구 대상 반 전체 주 횟수(프로그램 무관), 각 반 = 그 반 프로그램의 주N회 요금 ÷ N, 절사로 남는 원은 학생 첫 행, 그 프로그램 주N회 칸이 비면 그 반만 주1회 요금+경고 · 대회준비반(상수 `COMPETITION_PROGRAM_NAMES`)은 주말 대회준비반 반이 있으면 대회준비반 반 전부+일반 반 1개 = 300,000 고정(첫 대회준비반 행), 초과 일반 반은 일반 규칙+경고, 평일 대회준비반만이면 묶음 미적용+경고), planShuttleFee(그달 `RegularShuttleStop` 의 studentId 연결 행만, 셔틀 운행 평일 반 주 횟수 → 1만/1.5만/2만·직접입력 최대값·Sun-8 면제·**무료 거점**(상수 `FREE_SHUTTLE_HUB_STOPS`: 승차 1호점 앞 버스정류장/하차 새봄중학교 앞 버스정류장) — 명단 정류장이 전부 거점이면 0, 섞이면 제안+경고), siblingDiscountStudents(같은 parentId 청구 대상 자녀 2명↑, 상수 `REGULAR_SIBLING_DISCOUNT_TARGET` ALL/SECOND_AND_LATER)+siblingDiscountAmount(수강료 10% 절사, 셔틀 제외). 적용은 확정 월 장부 없는 행만, 저장 초안 payload 가 항상 이긴다. 셔틀비는 학생의 «첫 발행 대상 행» 1개에만, 다른 반 초안에 셔틀비 저장·이번 달 기존 청구가 있으면 제안 안 함. 셔틀 명단은 sourceVersion 해시에 포함. 셔틀비 규칙의 다른 사본: ProgramFormPanel/ProgramsAdminClient/programs/page 의 autoShuttle 표, studentBilling.ts 의 Sun-8 — 바꾸면 같이 바꾼다.
### [2026-11-08] 셔틀 명단 점검·카카오 셔틀 신청 할 일 = 순수 판정 + 기존 표 상태값(새 표 없음, 자동 삭제 없음)
- **분류**: architecture
- **발견자**: developer
- **내용**: ① 명단 수강 점검 `src/lib/shuttle/regularRosterEnrollmentCheckLogic.ts`(다니는 반 없음·수업 없는 요일·한쪽만) — 서버 `getRosterEnrollmentCheck` 는 그 달 명단 학생의 지금 Enrollment(ACTIVE/PAUSED)와 자동 생성 달 여부만 읽고 판정은 화면에서. 월 넘김 확인 = 수동 복사 전 confirm(`rosterCopyWarningText`) + 자동 생성 달 «확인했어요» = `ShuttleAuditLog` action `REGULAR_ROSTER_MONTH_REVIEWED`(자동 생성 기록 `REGULAR_ROSTER_AUTO_MONTH` 와 짝). ② 카카오 정규 셔틀 신청(START) 할 일 `src/lib/kakaoShuttleRosterTask.ts` — 완료 = `KakaoParentIntake.structuredJson.rosterTask.doneAt` + 결정 전 상태면 APPLIED(이관 APPROVED 는 유지) + 감사 `SHUTTLE_ROSTER_DONE`. 명단 추가는 기존 `/admin/shuttle/regular?month=&studentId=` 딥링크(«신청 학생 선택해 명단 추가») 재사용.
- **참조횟수**: 0

### [2026-11-09] 관리자 원생 등록 = 3단계 창 + 서버 액션 하나(트랜잭션 하나)
- **분류**: architecture
- **발견자**: developer
- **내용**: 목록 «원생 등록»·체험 ⚡«원생 등록»이 같은 `src/app/admin/students/StudentRegisterModal.tsx` → `src/app/actions/student-register.ts`(`registerStudent`·`previewStudentRegistration`·`getStudentRegisterOptions`). 입력 검증은 창·서버 공용 `src/lib/students/student-register-rules.ts`(반 필수/«반은 나중에 배정», 주 보호자 휴대폰 필수, 지점은 반 장소에서 자동·원본 문장 형식 저장, 개인정보 확인 → agreementsJSON.adminRegister). 신청서 승인과 공유: 정원 경고 `lib/enrollment/class-capacity.ts`, 셔틀 위치 저장 SQL `lib/students/student-shuttle-location-upsert.ts`(승인 동작은 tests/student-register.test.mjs 의 vm 실행으로 고정). 수강료 표시는 `lib/billing/regular-tuition-preview.ts`(청구 모듈과 무관, 프로그램 화면 2곳도 여기서 상수 사용). 인라인 폼은 «수정» 전용. 문자 발송 없음. **11-09 실사용 후**: 반 줄 대상 학년 = `ScheduleSlot.gradeRange → CustomClassSlot.gradeRange → Program.targetAge`(하위 질의, 스키마 변경 없음) · 셔틀 장소명 필수 규칙 한 곳 `src/lib/shuttle/placeNameRule.ts`(지도 창 `requirePlaceName` 옵션 — 원생 등록·학부모 링크 `/shuttle/location/[token]` 만 켬, 서버 `validateRegularLocation`·`validateStudentRegisterInput` 도 거부, 저장 SQL 의 주소 대체는 옛 데이터용 유지) · 유니폼은 입력 없음 — `UniformOrder.parentPhoneDigits ∈ 입력 보호자 번호` + `UniformOrderItem.studentName`(띄어쓰기 무시) 일치 주문을 `decideUniformFromOrders`(취소 제외, 업체 전송=«주문»/접수만=«신청») 로 등록 시점에만 채움(주문→학생 자동 갱신 연결은 없음) · 사진 동의 = 체크박스 하나, 방법 `REGISTER_MEDIA_CONSENT_METHOD`=IN_PERSON.
- **참조횟수**: 0

### [2026-11-09] 셔틀 운행 반 판정 = classRunsShuttle 한 곳(청구·배차 칸·신청 검토·진행 표시)
- **분류**: architecture
- **발견자**: developer
- **내용**: `src/lib/billing/workbench-pricing.ts` 의 `classRunsShuttle({dayOfWeek, runsShuttle})` = Program.runsShuttle=true + 평일(월~금). 청구 셔틀비(regularShuttlePlan)·신규 배차 남은 칸(`src/lib/shuttle/driverAssign.ts` loadStudents)·셔틀 신청 검토(`shuttle-review-query.ts` context)·배차 진행(`shuttle-progress-query.ts`)이 같이 쓴다. 수강 조회 SQL 에 `p."runsShuttle"` 를 꼭 같이 읽을 것(빠지면 미운행으로 봐 칸이 사라짐). 아직 안 쓰는 곳: 관리자 명단 «학생 추가» 칩(regularRosterEdit getRosterStudentContext)·명단 수강 점검(getRosterEnrollmentCheck). workbench-pricing 은 테스트가 data URL 로 읽어 import 를 둘 수 없다 — 판정을 다른 파일로 옮기지 말 것.
- **참조횟수**: 0

### [2026-11-09] 셔틀 «기존 정류장 추천» = stopNameMatch.pickNearbyStop 한 곳(장소명 출입구 일치 우선)
- **분류**: architecture
- **발견자**: developer
- **내용**: 반경(300m) 안 기존 정류장 추천은 `src/lib/shuttle/stopNameMatch.ts` 의 `pickNearbyStop` 하나로 정한다 — ① 장소명에 출입구 단어(정문·후문·맘스테이션…)가 있으면 같은 단지(앞부분 이름 유사)+같은 출입구 정류장을 거리 무관 1순위 ② 아니면 가장 가까운 곳. 쓰는 곳: `regularRosterPlacementLogic.suggestPlacement` ②(관리자 학생 추가) · `driverAssignLogic.planLeg`(기사님 새 학생 배정 + 관리자 정규 배차 신규 배차 칸, 다른 요일 정류장 포함). 정확히 같은 이름 합류(①)는 기존 normalizeStopName 그대로 먼저. 셔틀 신청 검토(shuttle-review)는 정류장 추천이 없다.
- **참조횟수**: 0

### [2026-11-09] 수강 «상태»와 «개시일»의 역할 분리 — 공용 판정 commencement.ts 한 곳
- **분류**: architecture
- **발견자**: developer
- **내용**: 원장 기준(11-09) — Enrollment ACTIVE 면 승인(등록)일부터 «수강 중/재원생». 판정은 `src/lib/enrollment/commencement.ts` 의 `isCurrentEnrollment`(TS)·`currentEnrollmentSql(alias)`(SQL) 한 곳(학생 상태 queries.ts current_status·인원 집계 adminReadPayloads·대관 재원생 listRentalMemberStudents·관리자/학부모 화면). `enrollmentDisplayStatus` 는 이제 status 그대로(SCHEDULED 없음), 개시일 미래 안내는 `enrollmentStartsLater`/payload `startsLater` 로만. 개시일(startsOn)을 쓰는 곳은 ① 청구 시수(billing/workbench-service) ② 출석부 회차 명단(staff-session-queries·staff-class-people·staff-sessions·SessionLogModal `enrollmentHasStarted`) ③ 셔틀 월 배차(driverAssign·shuttle-progress-query) ④ 다음 수업 안내(mypage/summary computeNextClass) 뿐 — 상태·인원 판정에 다시 쓰지 말 것(가드: tests/enrollment-current-rule.test.mjs). 반 줄 편집(반 이동·잘못 등록 삭제)은 `lib/enrollment/admin-enrollment-edit.ts`(순수 판정+연결 기록 수)·`actions/enrollment-admin-edit.ts`.
- **참조횟수**: 0

### [2026-11-09] 학부모 앱 = 탭 4개(홈·일정·청구·소식) 한 목록 + 앱 범위(/mypage) 안 상세
- **분류**: architecture
- **발견자**: developer
- **내용**: 메뉴는 `src/app/mypage/MyPageBottomNav.tsx` 의 `PARENT_TABS` 하나(휴대폰 아래 탭·PC 헤더 `variant="top"` 공용), 소속 하위 화면은 `also`(일정 = regular-absence·makeup·seasonal·shuttle·enrollment-change, 소식 = news). 일정 = `/mypage/history`(위 `ScheduleHub` + 아래 `HistoryClient embedded`), 청구 = `/mypage/payments`, 소식 = `/mypage/reports`(공지·리포트·피드백·사진, 칩은 같은 화면 앵커). 홈 = 납부 합계 한 줄(`PAYMENT_HOME_HREF` — 묶음 결제 때 이 주소만 교체) + 처리할 일 + 빠른 실행 4, 접힌 칸(details) 없음. 셔틀 배정 상세는 `ParentShuttleDetail`. 설치 앱 scope=/mypage 라 공지 상세는 `/mypage/news/[id]`(전체 공지·우리 아이 반 공지만, 아니면 404) — 공개 `/notices/[id]` 로 링크하지 말 것. 로그아웃은 `ParentMoreMenu`(⋯) 안.
- **참조횟수**: 0
