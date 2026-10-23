# 프로젝트 구조 지식
<!-- 담당: planner-architect, developer | 최대 30항목 -->
<!-- 프로젝트의 폴더 구조, 파일 역할, 핵심 패턴을 기록 -->

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

### 2026-10-23 체험(TrialLead) ↔ 수강 신청서 연결은 판정 모듈 + 연결부 한 곳에서
- **분류**: architecture
- **발견자**: developer
- **내용**: 연결 판정은 순수 모듈 `src/lib/enrollment/trialLeadMatch.ts`(`decideTrialLeadMatch` → AUTO/SUGGEST/NONE, 한글 음절 편집거리), DB 읽기·저장은 `src/lib/enrollment/trialLeadLinkService.ts` 한 곳(`linkTrialLeadToApplication` = 조건부 UPDATE 한 트랜잭션, 승인된 신청서면 체험 CONVERTED, ApplicationContactLog UPDATED 2줄, 문자 없음). 비교 시점 3곳: 신청 제출(`submitEnrollApplication`, accessCode 없을 때 AUTO 만), 체험 이름·번호 수정(`updateTrialLead` → `autoLinkApplicationsForTrialLead`), 관리자 신청 목록 후보+[연결](`getEnrollTrialLinkSuggestions`/`linkEnrollApplicationToTrialLead`). 새 연결 경로를 만들면 SQL 을 또 쓰지 말고 이 두 파일을 쓴다. 테스트 `tests/enrollment-trial-lead-match.test.mjs`.
- **참조횟수**: 0
