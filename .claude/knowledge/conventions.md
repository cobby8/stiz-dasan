# 코딩 규칙 및 스타일
<!-- 담당: developer, reviewer | 최대 30항목 -->
<!-- 이 프로젝트만의 코드 스타일, 네이밍 규칙, 패턴을 기록 -->

### [2026-08-08] 인앱 브라우저(카카오톡 등)에서는 PWA 설치가 원천 불가 — 판별은 순수 모듈 한 곳에서
- **분류**: convention
- **발견자**: developer
- **내용**: 학부모가 카카오톡·문자 링크를 누르면 **인앱 브라우저**로 열려 홈 화면 추가가 아예 불가능하다. 판별 로직은 `src/lib/pwa/installEnvironment.ts`(의존성 0, 순수 함수) 한 곳에만 두고 `/app`·`/staff/install` 두 화면이 공유한다 — 화면이 UA 정규식을 각자 들고 있으면 한쪽만 고쳐지는 사고가 난다(테스트가 `iphone|ipad|ipod` 재등장을 금지). 판별 원칙은 **확실한 표식만**(KAKAOTALK / NAVER(inapp / Instagram / FBAN·FBAV / Line/ / 안드로이드 `; wv)` / iOS인데 UA에 Safari 토큰 없음) — 오탐이 미탐보다 나쁘다. 함정: **라인 iOS UA에는 `Safari` 토큰이 있어** 인앱 판정을 먼저 하지 않으면 ios-safari 로 오판한다(`isIosSafari` 는 `inAppBrowser === null` 을 반드시 포함). 탈출 경로는 카카오톡만 스킴이 있다(`kakaotalk://web/openExternal?url=<encodeURIComponent>`), 나머지는 ⋯메뉴 안내 + **주소 복사**(clipboard 실패 시 주소를 화면에 노출해 길게 눌러 복사)를 최후 수단으로 항상 붙인다. UA 판별은 문자열 매칭 테스트로 못 잡으므로 `tests/pwa-install-environment.test.mjs` 처럼 **typescript.transpileModule 로 실제 실행**해 실제 UA 문자열로 단언한다.
- **참조횟수**: 0

### [2026-08-08] 브라우저가 "한 번만" 쏘는 이벤트는 useEffect로 못 잡는다 — head 인라인 스크립트로 선점
- **분류**: convention
- **내용**: `beforeinstallprompt`(PWA 설치)처럼 **페이지 로드 직후 한 번만 발생하고 재발화하지 않는** 이벤트는, React 하이드레이션 → `useEffect` 순서가 그보다 늦어 **조용히 유실**된다(설치 버튼이 영영 안 뜸). 해결 패턴: `src/app/layout.tsx` `<head>`에 인라인 스크립트를 넣어 React보다 먼저 리스너를 달고 `window.__stizInstallPrompt` 에 보관 + `stiz:installprompt` / `stiz:installed` 커스텀 이벤트로 알린다. 화면 컴포넌트는 마운트 시 **① 전역 보관값 먼저 확인 → ② 커스텀 이벤트 구독 → ③ 원본 이벤트 직접 구독(늦게 오는 경우 대비)** 3중으로 받는다. 스크립트는 `__stizInstallPromptReady` 가드로 중복 등록을 막고 전체를 try/catch로 감싼다(레이아웃은 사이트 전체에 영향). 이 프로젝트엔 CSP 가 없어 인라인 스크립트가 허용된다. 회귀 방지: 전역 변수명·이벤트명이 어긋나면 조용히 다시 버튼이 사라지므로, `tests/pwa-install-prompt-capture.test.mjs` 에서 layout.tsx 의 스크립트 원문을 정규식으로 추출해 **가짜 window(EventTarget)에 실제 실행**시켜 동작을 단언한다(문자열 매칭만으로는 동작을 못 잡는다).
- **참조횟수**: 0

### [2026-08-08] 기기 판별(UA)과 기능 가용성은 절대 같은 상태로 합치지 않는다
- **분류**: convention
- **내용**: 설치 화면이 `beforeinstallprompt` 를 받자마자 `setDeviceState("android")` 를 실행해, **PC 크롬에서도 안드로이드 안내가 나오고** 반대로 PC는 설치 버튼을 못 받는 버그가 있었다. 원인은 "기기가 무엇인가"(UA로 판별, 안내 문구용)와 "지금 설치할 수 있는가"(프롬프트 존재 여부, 버튼 노출용)를 한 변수에 욱여넣은 것. **두 상태를 분리하고 버튼은 `installPrompt` 만 보고, 문구는 `deviceState` 만 본다.** 또 브라우저는 **이미 설치돼 있으면 `beforeinstallprompt` 를 아예 쏘지 않으므로**, 프롬프트가 없는 안드로이드/PC 문구에는 "이미 설치돼 있으면 설치 버튼이 나타나지 않습니다" 한 줄을 붙여 "고장났다"는 오해를 막는다. iOS 는 프로그램적 설치 API 자체가 없어 공유→홈 화면에 추가 3단계 안내가 유일한 경로다(제거 금지).
- **참조횟수**: 0

### [2026-08-05] 컴포넌트 파일 삭제 전에는 src/ 가 아니라 tests/ 를 grep 해야 한다
- **분류**: convention
- **발견자**: developer
- **내용**: 이 프로젝트의 회귀 테스트(`tests/*.test.mjs`, node --test)는 소스 파일을 `readFile("src/app/...")` 로 읽어 정규식 검사한다. 그래서 컴포넌트가 **import 참조 0건이어도** 테스트가 파일 경로를 문자열로 붙들고 있어, 삭제하는 순간 ENOENT 로 테스트 파일 전체가 죽는다. 실측: `ShuttleRouteAdminClient.tsx` 는 src/ 참조 0건이었지만 tests/ 7개 파일이 읽고 있었고, `EditApplicationModal` 도 `assert.match(applyModals, /function EditApplicationModal/)` 로 존재를 강제받고 있었다(신규 실패 9건 발생 → 원복). **죽은 코드 삭제 시 검색 범위는 `grep -rn "<심볼>" src/ tests/ scripts/` 로 잡는다.** 또 `npx vitest` 는 이 프로젝트 의존성이 아니라 실행하면 324개 전부 "no test suite" 로 오탐하니, 테스트는 `node --test tests/*.test.mjs` 로 돌린다.
- **참조횟수**: 0

### [2026-08-05] 라우트 파일을 지우면 .next/types/validator.ts 가 낡아 tsc 가 깨진다
- **분류**: convention
- **발견자**: developer
- **내용**: `src/app/**/page.tsx` 를 삭제하면 `npx tsc --noEmit` 이 `.next/types/validator.ts(...): Cannot find module '../../src/app/.../page.js'` 로 실패한다. 소스 문제가 아니라 **이전 빌드가 남긴 생성 타입이 낡은 것**이다. `npx next build` 로 재생성하면 사라진다. 즉 라우트 삭제 작업의 검증 순서는 tsc → build 가 아니라 **build → tsc** 다.
- **참조횟수**: 0

### [2026-03-22] 공개 페이지 서버 컴포넌트 데이터 조회 패턴
- **분류**: convention
- **발견자**: reviewer
- **내용**: 공개 페이지(schedule, simulator 등)는 Promise.all로 5개 쿼리(getAcademySettings, getSheetSlotCache, getClassSlotOverrides, getCustomClassSlots, getPrograms)를 병렬 실행 후, overrideMap + sheetMerged + customMerged 순서로 MergedSlot[]을 조합한다. revalidate=300 (5분 ISR).
- **참조횟수**: 0

### [2026-03-22] 관리자 페이지 Suspense 분리 패턴
- **분류**: convention
- **발견자**: reviewer
- **내용**: admin 대시보드는 빠른 쿼리(DB 카운트 등)와 느린 쿼리(Supabase Storage, 경영통계 등)를 Suspense 경계로 분리한다. 느린 섹션은 별도 async 서버 컴포넌트로 만들어 스켈레톤 fallback을 제공한다.
- **참조횟수**: 0

### [2026-03-22] 클라이언트 필터링 useMemo 패턴
- **분류**: convention
- **발견자**: reviewer
- **내용**: 서버에서 전체 데이터를 받아 클라이언트에서 필터링할 때는 useMemo로 감싸서 의존성 배열(선택된 필터값들)이 변경될 때만 재계산한다. (SimulatorClient, ScheduleClient 참고)
- **참조횟수**: 0

### [2026-03-26] lucide-react 아이콘 사용 잔존 (conventions 위반)
- **분류**: convention
- **발견자**: planner-architect
- **내용**: CLAUDE.md에서 "Material Symbols Outlined 아이콘 사용, lucide-react 등 타 라이브러리 금지"로 규정되어 있으나, gallery/GalleryPublicClient.tsx (X, ChevronLeft, ChevronRight, Image, Play, Calendar)와 notices/page.tsx (Pin, Paperclip)에서 lucide-react를 여전히 사용 중. 교체 필요.
- **참조횟수**: 0

### [2026-03-28] 네비게이션 메뉴 4카테고리 구조
- **분류**: convention
- **발견자**: pm (사용자 지시)
- **내용**: 헤더 메뉴는 4개 상위 항목으로 구성. (1) 학원 소개 — /about 직접 링크, 드롭다운 없음. (2) 수업 안내 ▾ — 프로그램, 시간표, 연간일정. (3) 소식/안내 ▾ — 공지, 갤러리, FAQ(/faq), 이용약관(/terms). (4) 수업찾기 — /simulator 직접 링크. CTA 버튼은 "신청하기"(/apply).
- **참조횟수**: 0

### [2026-03-27] 체험수업 비용 표기 규칙
- **분류**: convention
- **발견자**: pm (사용자 지시)
- **내용**: 체험수업은 무료가 아니라 **1회 1만원의 체험비**가 있다. "무료 체험", "체험수업은 무료" 등의 표현은 절대 사용하지 않는다. 올바른 표현: "체험비 1만원", "체험수업 1회 1만원". FAQ, 배지, 투어 안내, 관리자 플레이스홀더 등 모든 곳에서 동일 적용.
- **참조횟수**: 0

### [2026-07-26] 확정(스냅샷) 데이터의 상태 판단은 데이터 자체로 한다
- **분류**: convention
- **발견자**: developer
- **내용**: 방학특강 셔틀 확정 명단처럼 "확정 전=원본 폴백 / 확정 후=스냅샷"인 구조에서는, 화면·API가 별도 확정 플래그를 들고 다니지 않는다. 행마다 `origin: "CONFIRMED"|"FALLBACK"` 과 `rosterId`를 실어 보내고, 화면은 `rows.some(r => r.origin === "CONFIRMED")`로 판단하며, 저장도 `rosterId ? {rosterId,patch} : {requestId,patch}`로 행 단위로 갈린다. 플래그를 따로 두면 명단과 플래그가 다른 출처에서 와서 어긋나는 순간이 반드시 생긴다. 또한 게이트웨이(`src/lib/seasonal/shuttleRoster.ts`)의 "명단을 읽는 export 함수는 get* 딱 2개"는 회귀 테스트로 고정돼 있으므로, 부가 메타 조회는 `get`으로 시작하지 않는 이름(`shuttleRosterConfirmationInfo`)을 쓴다.
- **참조횟수**: 0

### [2026-07-26] 상태 전이(확정·마감·잠금)의 갈림길은 서버가 판단한다
- **분류**: convention
- **발견자**: reviewer
- **내용**: "확정 전 → 원본 수정 / 확정 후 → 스냅샷 수정"처럼 상태에 따라 쓰기 대상이 바뀌는 API는, **클라이언트가 보낸 키(rosterId 유무 등)만 보고 갈라서는 안 된다.** 클라이언트 상태는 항상 낡을 수 있다(탭을 열어둔 채 다른 사람이 확정). 서버가 현재 상태를 직접 확인하고, 낡은 요청은 **성공시키지 말고 409로 거절**해야 한다("명단이 확정되었습니다. 새로고침 후 다시 시도해주세요"). 조용히 옛 경로로 저장하면 사용자는 "저장됨"을 보고 실제로는 아무 데도 반영되지 않는다 — 가장 알아채기 어려운 사고 유형이다. 같은 이유로 `UPDATE … WHERE id=$1`의 영향 행 수(`changed`)가 0이면 ok로 응답하지 않는다.
- **참조횟수**: 0

### [2026-07-26] 소스 문자열 매칭 테스트의 한계선
- **분류**: convention
- **발견자**: reviewer
- **내용**: 이 프로젝트의 회귀 테스트는 대부분 소스 파일을 읽어 정규식으로 검사한다(DB·로그인 벽 때문). 이 방식이 **유효한 대상**은 "이 문자열이 있으면 안 된다"류의 구조 불변식이다(예: 확정본 편집 구역에 원본 테이블 이름 미등장, 모든 `UPDATE`가 같은 테이블, CSV 파일명, 안전장치 토글 존재). **무효한 대상**은 실제 동작이다 — SQL 파라미터 번호 어긋남, SET 절 중복 컬럼, 분기 조건의 논리 오류는 문자열로 절대 잡히지 않는다. 동작을 지켜야 하면 순수 함수로 분리해 export 하고 "입력 → 생성된 SQL/args" 를 단언한다. 또한 `row.rosterId ? { … } : { … }` 같은 **표현식 원문을 통째로 고정**하거나 애초에 존재한 적 없는 문자열의 부재를 단언하는 검사는 리팩터링만 방해하므로 쓰지 않는다.
- **참조횟수**: 0

### [2026-03-29] Server Action 인증 가드 패턴
- **분류**: convention
- **발견자**: reviewer
- **내용**: 모든 관리자 전용 Server Action 함수는 첫 줄에 `await requireAdmin()`을 호출한다. 인증 가드 파일(auth-guard.ts)은 `"use server"` 지시자 없이 순수 서버 유틸리티로 유지한다. 학부모도 사용할 함수(알림 읽음, 요청 접수 등)는 향후 `requireAuth()`로 변경 필요.
- **참조횟수**: 0

### [2026-08-06] 에이전트를 병렬로 돌릴 때 git stash 를 쓰면 남의 작업이 사라진다
- **분류**: convention
- **발견자**: pm
- **내용**: `git stash` 는 **워킹트리 전체**를 대상으로 한다. 여러 에이전트가 동시에 서로 다른 파일을 고치는 중에 한 에이전트가 "테스트 기준선을 재려고" stash 를 실행하면, **다른 에이전트의 미저장 변경까지 전부 치워진다.** 실측(2026-08-06): 문구 정리 5개 병렬 작업 중 한 에이전트의 `git stash push -- src/` 가 46개 파일을 치웠고, 그 사이 다른 에이전트가 같은 파일을 새로 써서 `git stash pop` 이 충돌로 실패했다. 파일 단위 수동 복원으로 유실 0건에 그쳤지만 복구에 많은 시간이 들었다. **기준선이 필요하면 stash 대신 `git show HEAD:<파일>` 로 개별 조회한다.** PM 은 병렬 위임 프롬프트에 stash 금지를 명시하고, 커밋 직전 `git status` 로 예상 파일 수를 대조한다. 또 작업이 끝난 뒤 `git stash list` 를 확인해 남은 stash 를 정리한다 — 남겨 두면 나중에 pop 했을 때 최신 작업을 옛 버전으로 덮어쓴다.
- **참조횟수**: 0

### [2026-08-06] 확정본을 화면에 쓸 때는 "폴백"과 "미반영분"을 항상 같이 붙인다
- **분류**: convention
- **발견자**: developer
- **내용**: 저장된 확정 노선/명단을 화면 소스로 승격할 때, 두 가지를 반드시 함께 만든다. (1) **폴백**: 저장본이 없거나 비어 있으면 종전 소스로 되돌아가고, 화면에 `임시 순서 · 확정 전` 같은 짧은 표시를 단다. 저장본을 무조건 쓰면 아직 저장 안 한 요일에 화면이 통째로 빈다. (2) **미반영분 노출**: 원본에는 있는데 확정본에 없는 대상은 지우지 말고 `⚠️ 노선에 없는 승객` 같은 별도 섹션으로 뒤에 붙인다. 이 프로젝트의 과거 사고는 전부 "조용히 사라짐/조용히 어긋남"이었다. 판정 로직(`pickRegularRouteSource` 등)은 순수 함수로 떼어 `tests/*.test.mjs` 로 못박는다 — DB 없이 회귀를 잡을 수 있는 유일한 지점이다.
- **참조횟수**: 0

### [2026-08-08] 브라우저 안내 문구는 "실제 메뉴 이름 그대로" + 판별은 좁은 토큰부터
- **분류**: convention
- **발견자**: developer
- **내용**: PWA 설치 안내처럼 사용자가 브라우저 메뉴를 직접 찾아야 하는 안내는, 비슷한 말로 바꾸면 그 항목을 못 찾고 그대로 이탈한다. 실측(2026-08-08): "브라우저 메뉴에서 '앱 설치'" 라고 안내했으나 갤럭시 기본 브라우저인 **삼성 인터넷의 실제 메뉴는 "우측 하단 ≡ → 현재 페이지 추가 → 홈 화면"** 이라 학부모가 포기했다. 안내 문구는 브라우저별로 갈라 **메뉴에 적힌 문자열 그대로** 쓴다. 또한 UA 판별은 **좁은 토큰을 먼저** 본다 — 삼성 인터넷 UA 에는 `SamsungBrowser` `Chrome` `Safari` 토큰이 전부 들어 있어(`... SamsungBrowser/21.0 Chrome/110... Mobile Safari/537.36`), Chrome 을 먼저 보면 크롬으로 오판한다. 판별과 문구 생성은 `src/lib/pwa/installEnvironment.ts` 같은 **의존성 없는 순수 모듈**에 두고 실제 UA 문자열로 실행 검증한다(소스 문자열 매칭으론 정규식 순서 오류를 못 잡는다). 화면(클라이언트 컴포넌트)이 메뉴 이름을 직접 들고 있으면 한쪽 화면만 고쳐지므로, 공용 컴포넌트로 빼고 "화면 소스에 메뉴 이름이 없어야 한다"를 테스트로 못박는다.
- **참조횟수**: 0

### [2026-08-08] 설치 안내 화면은 "설치 전용" — 앱 진입 버튼을 섞지 않는다, prompt() 자동 호출 금지
- **분류**: convention
- **발견자**: developer
- **내용**: PWA 설치 안내 화면(`/app`·`/staff/install`)에 "마이페이지 열기"·"선생님 앱 열기" 같은 진입 버튼을 함께 두면, 사용자가 설치 대신 그 버튼을 눌러 버려 설치율이 오르지 않는다. 설치 화면의 주 행동은 **설치 버튼 하나뿐**이어야 하고 스크롤 없이 첫 화면에 보여야 한다(기능 소개 타일·가입 안내 카드 등 부가 섹션 제거). 다만 `설치하지 않아도 웹에서 바로 사용할 수 있습니다.` 한 줄은 설치 불가 사용자의 유일한 대안이라 반드시 남긴다. 또한 **`beforeinstallprompt` 의 `prompt()` 는 사용자 제스처(user activation) 안에서만 호출 가능**하다 — "클릭 없이 자동 설치"를 만들려고 로드 직후 호출하면 크롬·삼성 인터넷 모두 차단하고 그 프롬프트가 무효화돼 이후 버튼을 눌러도 설치가 안 된다. 목표는 "완전 자동"이 아니라 **"탭 한 번"** 으로 줄이는 것. 프롬프트가 없으면 기기별 수동 단계를 대신 보여준다.
- **참조횟수**: 0

### [2026-08-08] 안드로이드 탈출·설치는 intent:// 로 크롬을 지정한다 (iOS는 렌더 금지)
- **분류**: convention
- **발견자**: developer
- **내용**: 안드로이드에서 (1) 카카오톡 등 **인앱 브라우저**는 홈 화면 추가가 막히고, (2) **삼성 인터넷**으로 설치한 WebAPK 는 Google Play 프로텍트가 "안전하지 않은 앱"으로 차단한다(브라우저가 만드는 파일이라 우리가 못 고침). 둘 다 **크롬으로 열면 해결**된다 — 크롬은 구글 서버에서 WebAPK 를 받아온다. 형식: `intent://<host><path><search>#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=<encodeURIComponent(원래 https 주소)>;end`. **`S.browser_fallback_url` 은 필수** — 크롬이 없는 기기에서 인텐트가 실패하면 빈 화면이 된다. 생성 함수(`buildChromeIntentUrl`)는 순수 함수로 두고 **https 가 아니면 `null`** 을 반환해 잘못된 인텐트를 만들지 않는다(개발 http·`javascript:` 방어). **intent 스킴은 iOS 에서 동작하지 않으므로 버튼 자체를 렌더하지 않는다**(`shouldOfferChromeIntent(platform)` 로 게이트) — 눌러도 아무 일 없는 버튼이 더 나쁘다. iOS 는 기존 `kakaotalk://web/openExternal` 경로 유지. 인텐트가 막히는 기기가 있으므로 메뉴 안내·주소 복사는 **보조로 항상 남긴다**. 🚫 보안 경고를 "무시하고 설치하라"는 안내는 절대 넣지 않는다(진짜 악성 앱도 그렇게 설치하게 된다).
- **참조횟수**: 0

### [2026-08-08] 크롬 메뉴 이름은 버전마다 다르다 — UA로 가르지 말고 두 이름을 나란히 적는다
- **분류**: convention
- **발견자**: developer
- **내용**: 실기기 확인(2026-08-08, 갤럭시 크롬): ⋮ 메뉴 항목이 **"설치 및 바로가기 만들기"** 였는데 안내는 "‘앱 설치’ 또는 ‘홈 화면에 추가’" 라서 학부모가 그 항목을 못 찾았다(삼성 인터넷 때와 동일한 유형의 사고, 2회째). 크롬 **버전 경계가 불확실**해 UA 로 갈라 문구를 고르면 오히려 틀린 안내가 나간다. 해결은 **두 표기를 나란히** 적는 것: `‘설치 및 바로가기 만들기’·‘앱 설치’`. 단계 라벨에는 길이 상한(24자) 테스트가 걸려 있으므로 "또는" 대신 가운뎃점(`·`)으로 붙여 길이를 줄인다. 문구 변경 시 `tests/pwa-install-environment.test.mjs` 에 두 이름이 모두 포함되는지 단언을 함께 추가한다.
- **참조횟수**: 0

### [2026-08-09] 앱 아이콘에 글자를 넣지 않는다 — 색과 그림으로 구분한다

홈 화면 아이콘은 50px 안팎으로 그려진다. 512px 캔버스에 넣은 글자는 그 크기에서
뭉개져 못 읽는다. 게다가 앱 이름은 아이콘 바로 밑에 이미 표시되므로 중복이다.

역할 구분은 **배경색 + 우하단 배지**로 한다(선생님=남색·클립보드, 학부모=연두·가족,
기사=주황·버스). 색은 손톱만 한 크기에서도 구분되고 배지가 색을 보조한다.
배지 그림은 단순한 실루엣만 쓴다 — 호루라기처럼 디테일이 있으면 줄었을 때
돋보기처럼 보인다.

**maskable 아이콘은 일반 아이콘과 다른 파일이어야 한다.** 안드로이드가 바깥을
원·둥근사각으로 깎으므로 (1) 모서리를 둥글리지 말고 꽉 채우고 (2) 내용은 가운데
80% 안에 모은다. 두 파일 내용이 같으면 깎일 때 가장자리부터 잘려 나간다.
검증은 눈으로 한다 — 원형 크롭을 씌워보고 실제 60px 크기로도 확인한다.

로고는 **손으로 다시 그리지 않는다.** 기존 아이콘에서 채널값을 알파로 삼아 뽑는다
(0/255로 딱 자르면 확대할 때 가장자리가 계단처럼 깨진다).
생성 스크립트: `scripts/make-role-icons.py`

### [2026-08-09] 관리자 화면을 새로 만들면 사이드바 등록을 테스트로 못박는다
- **분류**: convention
- **발견자**: pm
- **내용**: 화면·서버 액션·권한까지 다 만들고 **사이드바 NavItem 만 빠지면 URL 을 직접 치지 않는 한 아무도 못 쓴다.** 빌드·tsc·테스트가 전부 통과해서 아무 신호가 없다. 실측 2회 — ①2026-08-05 `/admin/payment-confirmations`(현장 수납 승인)가 경로 배열에만 있고 NavItem 이 없어 돈 처리가 방치 ②2026-08-09 `/admin/payment-requests`·`/admin/enrollment-changes` 의 메뉴 추가분이 다른 세션의 디자인 커밋에 딸려 들어갔고, 그 커밋을 revert 하자 **메뉴만 조용히 함께 사라졌다**(화면은 멀쩡히 남아 더 못 알아챈다). 그래서 관리자 화면을 추가하면 그 기능의 테스트에 "관리자 메뉴에서 도달할 수 있다"를 넣는다 — `AdminShellClient.tsx` 를 읽어 `href="/admin/<경로>"` 존재 + 해당 경로 문자열이 **3회 이상**(NavItem 1 + `OPS_PATHS` + `MORE_OPS_PATHS`) 등장하는지 본다. 경로 배열 두 곳을 함께 세는 이유: NavItem 만 있으면 메뉴는 보이는데 눌렀을 때 상위 탭이 안 켜져 화면이 어긋난다. 🚫 이 단언을 "화면 파일이 존재한다"로 대체하지 말 것 — 사라지는 것은 언제나 링크 쪽이다.
- **참조횟수**: 0

### [2026-08-12] 날짜·시간은 @/lib/datetime/kst 한 곳에서만 — 가드 테스트로 강제
- **분류**: convention
- **발견자**: pm
- **내용**: **Vercel 은 UTC, 개발 PC 는 KST** 라 시간대 버그는 **로컬에서 멀쩡하고 배포하면 틀린다.** tsc·build·테스트가 다 통과해서 사람이 못 잡는다. 실측 함정 셋 — ①`new Date().toISOString().slice(0,10)` 을 "오늘"로 쓰면 **KST 00:00~09:00 에 어제**가 나온다(새벽에 전날 출석부가 열림) ②`new Date(ymd+"T00:00:00+09:00").getUTCDay()` 는 전날 15시가 되어 **요일이 하루 밀린다** — 2026-08-12 실측으로 방학특강 보강에서 **금요일 반의 추천 날짜가 토요일로 나가고 있었다**. ⚠️ 무서운 점은 **`T12:00` 은 우연히 맞는다**는 것: 똑같이 생긴 코드가 시각 리터럴 하나로 갈려서 옆 파일을 보고 따라 쓰면 그대로 터진다 ③서버 코드의 `getDay()/getHours()` 는 서버 시간대를 따라 9시간 어긋난다(`src/lib/adminReadPayloads.ts` 의 대시보드 "오늘 수업"이 새벽에 전날 요일로 조회되고 있었다). → 달력 값은 **`src/lib/datetime/kst.ts`** (`todayKst`·`toKstYmd`·`kstDow`·`kstAt`·`addDaysKst`·`diffDaysKst`·`isKstYmd`) 한 곳에서만 만들고, 파일마다 새로 만들지 않는다(같은 헬퍼가 5곳에 복사돼 있었다). DB 판정은 SQL 의 `AT TIME ZONE 'Asia/Seoul'`. 날짜 문자열은 `"YYYY-MM-DD"` 로 들고 다니고 Date 객체는 계산에만 쓴다. **강제 수단은 `tests/kst-datetime-guard.test.mjs`** — 금지 패턴 4종을 주석·문자열을 걷어낸 뒤 검사하고 위반 위치를 file:line 으로 찍는다(일부러 위반 파일을 넣어 실제로 잡히는 것까지 확인). ALLOW 목록은 "괜찮다"가 아니라 **아직 못 갚은 빚**이며 늘리면 테스트가 깨진다. 순수 모듈끼리 조립할 수 있도록 `tests/_ts-module.mjs` 가 `@/` import 를 따라간다 — 의존성 0 제약 때문에 헬퍼가 복사되던 것이 원인이었다.
- **참조횟수**: 0

### [2026-09-18] 외부 정산 대사 스크립트는 "읽기 전용 3중 방어 + 애매하면 보류"로 만든다
- **분류**: convention
- **발견자**: developer
- **내용**: 돈을 맞추는 스크립트(`scripts/tossplace-reconcile.mjs` + 순수 로직 `scripts/lib/tossplace-match.mjs`)의 기준. ①**쓰기 불가 3중 방어** — `BEGIN READ ONLY` + 항상 ROLLBACK / 실행 전후 `SELECT count(*), max("updatedAt")` 를 리포트에 "쓰기 없음 증빙"으로 기록 / 외부 API 클라이언트는 GET·허용 경로 외 요청을 **보내기 전에** 예외(`assertReadOnlyTossRequest`). ②**추측 금지** — 주문번호 일치 → 같은 날·같은 금액 1:1 까지만 자동 매칭하고, ±3일 근접·같은 날 금액 상이·건수 불일치는 전부 `HELD(확인 필요)` 로 빼서 후보만 보여준다. 잘못 묶인 1건은 아무도 못 찾지만 보류된 1건은 눈에 띈다. ③**자체 검산** — `전체 차이 == Σ(짝 못 찾은 상대쪽) − Σ(짝 못 찾은 이쪽)` 을 항상 계산해 리포트에 찍는다(집계 구멍 감지). ④**계산 로직은 I/O 없는 순수 모듈로 분리**해 `node --test` 가 실제로 실행하게 한다. ⑤개인정보가 든 리포트는 `outputs/reconcile/` 로 빼고 .gitignore 에 넣는다. 실측 사실: **PgBouncer(DATABASE_URL) 경유여도 `pg` 의 파라미터 바인딩 쿼리가 트랜잭션 안에서는 정상 동작**한다(그래도 실패 시 정규식 검증 리터럴로 폴백 유지). 토스플레이스 Open API 응답 시각은 **UTC(Z) 표기**로 실측 확인(2026-09-18), 사이트 `Payment.paidDate` 는 tz 없는 UTC 라 KST 변환을 **두 번** 걸어야 한다. ⑥**사람이 손으로 적은 메모가 날짜·금액보다 강한 단서다** — 토스POS 주문의 `lineItems[].memo`/`order.memo` 에 `토4 이시윤 9월` 형태로 원생 이름이 적혀 있어, 매칭 순서를 `주문번호 → 메모 이름 → 날짜·금액` 으로 둔다. 단 성 생략 표기(`대건`→김대건)는 **후보가 정확히 1명일 때만** 인정하고, 동명이인(`시우`→3명)·한 결제 다(多)원생(형제 합산)·금액 불일치는 전부 보류한다. 명단에 없는 이름은 조용히 버리지 말고 전용 섹션으로 드러낸다(퇴원·오타·타지점 신호).
- **참조횟수**: 0

### [2026-09-29] CLI 와 웹앱이 같은 계산을 쓰면 모듈은 `src/lib/**` 에 `.mjs` 한 벌로 둔다
- **분류**: convention
- **발견자**: developer
- **내용**: 돈을 맞추는 계산(`src/lib/pos/tossplace-match.mjs`)을 CLI(`scripts/`)와 Next 앱이 **둘 다** 써야 할 때, 파일을 복사하면 한쪽만 고쳐져 "어제까지 맞던 금액"이 조용히 갈린다. 해결: 순수 ESM `.mjs` 를 `src/lib/` 아래 두고 **CLI 는 상대경로로, 앱은 `.mjs` 확장자를 붙여** 그대로 import 한다(Next·Turbopack 모두 그대로 번들하고, `tsconfig.include` 는 `.mjs` 를 타입검사 대상에 넣지 않아 tsc 도 조용하다. 단 `allowJs` 는 켜져 있어야 앱 쪽 import 가 풀린다). 네트워크 클라이언트처럼 **타입이 필요한 공유 코드는 `.ts` 로 두고 CLI 가 `import ... from "../src/lib/pos/tossplaceClient.ts"`** 로 부른다 — node 22.18+/25.x 가 타입만 걷어내고 실행한다. ⚠️ 이때 그 `.ts` 는 **타입만 지우면 되는 문법(erasable syntax)** 만 써야 한다(enum·namespace·파라미터 프로퍼티를 쓰면 CLI 가 죽는다). 사본이 다시 생기는 것은 `tests/*.test.mjs` 에서 **저장소를 걸어 같은 파일명이 1개인지** 단언해 막는다. ⚠️ 순수 JS 모듈을 TS 에서 호출하면 `students = []` 같은 기본값이 `never[]` 로 추론돼 tsc 가 막는다 — 호출부마다 캐스팅하지 말고 **모듈 상단에서 느슨한 시그니처 상수 하나**(`const reconcile = buildReconciliation as (...) => any`)로 받는다.
- **참조횟수**: 0

### [2026-09-29] prisma 를 import 하는 서비스도 "가짜 prisma"를 끼워 실제로 실행해 검증한다
- **분류**: convention
- **발견자**: developer
- **내용**: `tests/_ts-module.mjs` 는 순수 모듈 전용이라 `@/lib/prisma` 를 쓰는 파일에는 못 쓴다. 그렇다고 소스 문자열 검사만 하면 "키가 없을 때 예외를 던지는가 / 기록이 정확히 한 줄인가" 같은 **동작**은 절대 못 잡는다. 방법: 테스트에서 `ts.transpileModule` 로 서비스 파일을 올린 뒤 import 스펙(`"@/lib/prisma"`·`"./tossplaceClient"`)만 **가짜 모듈 data URL 로 치환**해 실행한다. 가짜 prisma 는 `$queryRawUnsafe`/`$executeRawUnsafe` 호출을 `globalThis` 배열에 기록해, 테스트가 **"쓰기는 1회, INSERT 대상은 이 표 하나"** 를 직접 세도록 한다. 환경변수는 `withEnv()` 로 잠깐 바꿨다가 `finally` 에서 반드시 되돌린다(다른 테스트가 같은 프로세스에서 돈다). 돈을 다루는 코드는 여기에 더해 **소스 계약**(`UPDATE "Payment"`·`DELETE FROM "Student"` 부재를 `doesNotMatch` 로)을 함께 단정한다 — 실행 검증은 "지금 경로"만, 소스 검증은 "앞으로 생길 경로"까지 막는다.
- **참조횟수**: 0

### [2026-09-30] 외부 버튼(슬랙 등)으로 돈을 쓸 때는 "선점 UPDATE 한 문장 = 재확인"으로 막는다
- **분류**: convention
- **발견자**: developer
- **내용**: `markPaymentPaid` 는 트랜잭션 없이 여러 문장을 쓴다. 그래서 "읽고 확인 → 납부" 로 짜면 두 번 클릭·두 알림 동시 클릭에 뚫린다. 방법(`src/lib/pos/paymentNoticeActions.ts`): ①알림 행을 `UPDATE … SET status='CONFIRMED', "siteMarkedPaid"=true WHERE <상태 조건> AND EXISTS(<미납·같은 금액>) AND (SELECT count(*) …)=1 AND NOT EXISTS(<PAID 같은 금액>) RETURNING` **한 문장**으로 선점(행 잠금 덕에 두 번째 클릭은 0행) ②다른 알림과의 경합은 **부분 유일 인덱스**(`sitePaymentId WHERE siteMarkedPaid`)가 예외로 막음 ③선점 성공 뒤에만 `markPaymentPaid` ④실패 시 청구서가 실제로 PAID 인지 보고 아니면 선점을 되돌림. 슬랙은 3초 안에 답해야 하므로 라우트는 `after()` 로 먼저 200 을 준다. 서명 검증은 `req.text()` 원문 → `v0:ts:body` HMAC, secret 없으면 거부.
- **참조횟수**: 0

### [2026-10-02] 모달 안에서 지도(LocationPickerModal)를 띄울 때는 입력 모달을 내리고 상태는 상위에 둔다
- **분류**: convention
- **발견자**: developer
- **내용**: `AdminModal` 과 `LocationPickerModal` 은 둘 다 document 에 Esc·Tab 처리를 건다. 겹쳐 띄우면 Esc 한 번에 둘 다 닫히고 Tab 이 서로 포커스를 뺏는다. 방법(`admin/shuttle/regular/RegularShuttleClient.tsx`): 폼 입력값을 상위 `dialog` 상태에 두고 `{dialog && !picker && <AdminModal/>}` / `{picker && <LocationPickerModal/>}` 로 번갈아 띄운다. 또 렌더 함수 안에서 `function StopFields(){}` 를 정의해 `<StopFields/>` 로 쓰면 렌더마다 새 컴포넌트라 **글자 칠 때마다 입력 포커스가 풀린다** — `stopFields()` 처럼 함수 호출로 쓴다.
- **참조횟수**: 0

### [2026-10-02] 운영 화면의 «관리자 미리보기»는 운영 화면과 같은 순수 함수로 그린다 + 가드 테스트
- **분류**: convention
- **발견자**: developer
- **내용**: 원장이 고치는 화면(셔틀 명단 「기사님 화면」 보기)과 실제 운영 화면(기사님 `/driver/[token]`)이 각자 묶음 로직을 가지면 한쪽만 고쳐져 «관리자가 본 순서 ≠ 기사님이 보는 순서»가 된다(옛 `RegularRouteSection.groupStops` 가 그 사본). 방법: 고르기·정렬·묶음을 순수 모듈(`regularDriverRouteLogic.ts` 의 `selectDriverDayRows`·`buildFallbackClasses`)에 두고 양쪽이 import, 날짜별 요소(결석)는 `() => false` 로 주입. `tests/regular-roster-driver-view.test.mjs` 가 import·자체 group 함수 금지·저장→재조립 왕복을 단정한다. 순서 저장은 «그 칸이 쓰던 sortOrder 번호만 돌려 쓰기»(슬롯 재배정)라 다른 칸 순서가 안 바뀐다.
- **참조횟수**: 0

### [2026-10-03] 보호자(Guardian)는 학생 상세 「보호자」 카드로 편집 — 전화는 숫자만, 계정(User) 전화와 분리
- **분류**: convention
- **발견자**: developer
- **내용**: 편집 경로 = `src/app/actions/guardians.ts`(requireAdmin, 수정·삭제는 `id AND "studentId"` 두 조건) + 순수 로직 `src/lib/guardians/guardianLogic.ts`. Guardian.phone 은 숫자만 저장(계절학기 승인이 `COALESCE(phone,'') = 숫자` 로 글자 비교함). 주 보호자는 학생당 1명(지정은 `SET "isPrimary" = (id = $1)` 한 문장), 주 보호자를 바꿔도 Student.parentId→User.phone(로그인·알림톡)은 건드리지 않는다. ⚠️ 엑셀 업로드 덮어쓰기는 Guardian 을 전부 지우고 보호자2·3만 다시 넣는다 — 카드로 추가한 보호자가 사라질 수 있다.
- **참조횟수**: 0
