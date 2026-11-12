# 에러 및 함정 모음
<!-- 담당: debugger, tester | 최대 30항목 -->
<!-- 이 프로젝트에서 반복되는 에러 패턴, 함정, 주의사항을 기록 -->

### [2026-11-05] 셔틀 명단 「합류」를 칸 맨 뒤 번호로 넣으면 다른 반·PIVOT 뒤로 간다
- **분류**: error
- **발견자**: developer
- **내용**: RegularShuttleStop.sortOrder 는 **요일 전체가 한 줄**(여러 반·PIVOT/RETURN 이 섞임)이다. 칸 안 화면(같은 이름 첫 위치로 묶는 그리기)만 보면 맨 뒤에 넣어도 합류로 보여 테스트가 통과했지만, 실제 운행 순서상 학원 경유 뒤로 들어갔다(목 19:20 유승한내들 23 → 29). 해결: `planRosterInsert` JOIN = 그 이름이 칸에서 처음 나온 묶음의 마지막 행 +1 번호, 요일 전체 그 번호 이상 +1(BEFORE 와 같은 밀기). 테스트는 «칸 그림»뿐 아니라 **요일 전체 sortOrder** 를 단언해야 잡힌다.
- **참조횟수**: 0

### [2026-10-24] 같은 규칙의 두 입력 경로(학부모/관리자) 중 한쪽만 고치면, DB 제약이 UPDATE 를 통째로 거부한다
- **분류**: error
- **발견자**: pm (원장 제보 — 이성빈 수강신청 셔틀 건을 확인하다 발견)
- **내용**: 수강신청의 셔틀 정보는 **라벨(`shuttlePickup`·`shuttleDropoff`·`shuttleTime`)과 좌표 18개 컬럼**이 한 묶음이고, DB 제약 `EnrollmentApplication_shuttle_location_complete_check` 가 **"셔틀 미이용(`shuttleNeeded=false`)이면 좌표가 전부 NULL"** 을 강제한다. 학부모 신청 경로(`actions/public.ts`)는 셔틀을 끌 때 좌표·동의를 함께 비웠지만, **관리자 수정 경로(`updateEnrollApplication`)는 `ENROLL_APPLICATION_COLUMNS` 에 좌표가 없어 라벨만 비웠다.** 그래서 관리자가 "셔틀 필요" 체크를 끄면 제약 위반으로 **UPDATE 가 통째로 실패**하고 화면에는 `수강 신청 수정 실패` 만 떴다 — 원인을 알 수 없고, **관리자가 셔틀 신청을 취소할 방법이 아예 없었다.** 더 나쁜 점: 승인 액션에도 같은 상태를 막는 검사와 안내(`신청서를 다시 저장해주세요`)가 있는데, **수정 저장이 먼저 실패하므로 그 안내대로 해도 절대 풀리지 않는 막힌 길**이었다(안내가 가리키는 해결책이 존재하지 않음).
- **탐지 방법**: ① DB 제약이 **여러 컬럼을 한 묶음으로** 묶고 있으면(`ROW(...) IS NULL`, `CHECK` 복합 조건), 그 컬럼들을 쓰는 **모든 쓰기 경로**를 `grep -rn "<대표컬럼명>" src/app/actions/` 로 뽑아 **빠진 경로가 없는지 대조**한다. ② 화면이 서버 액션의 허용 컬럼 목록(allowlist)을 거치는 구조면, **그 목록과 제약이 보는 컬럼 집합을 비교**한다 — 목록에 없는 컬럼은 영원히 못 바뀐다. ③ 증상이 "저장 실패"인데 메시지가 일반적이면 DB 제약 위반을 의심하고 `prisma/migrations/*/migration.sql` 의 `CHECK` 를 먼저 본다.
- **예방법**: **제약이 묶은 컬럼은 코드에서도 상수 한 덩어리로 묶는다**(`SHUTTLE_LOCATION_COLUMNS`). 그리고 그 상수가 제약의 `ROW(...)` 와 같은 집합인지 **테스트로 못박는다** — 마이그레이션 SQL 에서 컬럼명을 뽑아 집합 비교하면 한쪽만 고쳐도 즉시 깨진다(눈으로는 18개 중 1개 빠진 것을 못 찾는다). 새 입력 경로를 추가할 때는 **기존 경로의 "끄기/비우기" 처리를 그대로 복사했는지** 확인한다.
- **같은 계열 2회째**: 아래 2026-07-26 항목(읽기만 게이트웨이로 옮기고 쓰기는 누락)과 **동일한 뿌리** — 하나의 규칙을 다루는 경로가 둘 이상인데 한쪽만 고쳤다. 이 프로젝트에서 반복되는 유형이므로, 경로가 둘이면 **양쪽을 같은 커밋에서** 손댄다.
- **참조횟수**: 0

### [2026-07-26] 읽기만 게이트웨이로 옮기고 쓰기는 원본에 남겨 두면 "조용한 no-op"이 된다
- **분류**: error
- **발견자**: tester
- **내용**: 셔틀 대상자 **조회**는 `getConfirmedShuttleRoster` 게이트웨이(확정본 우선)로 일원화했는데, **저장**은 화면마다 제각각 원본 테이블(`SpecialProgramShuttleRequest`)에 남아 있었다. 확정 전에는 조회=원본이라 아무 문제가 없어 테스트도 통과한다. **확정 버튼을 누르는 순간** 조회가 확정본으로 바뀌면서, 원본에 쓰는 화면은 "저장했습니다" 토스트를 띄우고 목록을 새로고침해도 값이 그대로다 — 에러도 로그도 없이 조용히 무시된다(가장 늦게 발견되는 종류의 사고). 실제 사례: `/admin/seasonal/shuttle`은 확정본 저장 경로를 추가해 해결했으나, 같은 데이터를 다루는 `/admin/shuttle`(노선 편성)의 "위치 확정"(`updateShuttleRequestLocation`)은 누락돼 확정 후 핀 편집이 먹지 않는다.
- **탐지 방법**: `grep -rln "<원본테이블명>" src/` 로 나온 파일과 게이트웨이 소비처 목록을 **대조**한다. 원본 테이블에 UPDATE를 하는 파일이 게이트웨이 소비처 목록에도 있으면 = 그 화면은 "확정본을 읽고 원본에 쓴다" = 확정 후 깨진다.
- **예방법**: 읽기 게이트웨이를 만들 때 **쓰기 게이트웨이를 같은 커밋에서 함께** 만든다. 폴백 구조(확정 전=원본/확정 후=확정본)를 도입하면 **모든 쓰기 경로도 같은 분기를 타야** 한다. 분기를 못 넣으면 최소한 확정 후 409로 거절해 "조용히 무시" 대신 "명시적 실패"로 만든다.
- **참조횟수**: 0

### [2026-03-26] CSS box-shadow 스포트라이트 + 오버레이 배경 겹침 버그
- **분류**: error
- **발견자**: debugger
- **내용**: box-shadow로 스포트라이트 구멍을 뚫는 패턴에서, 오버레이 배경(rgba)과 box-shadow(rgba)가 동시에 적용되면 구멍이 보이지 않는다. 오버레이 배경이 구멍 위를 덮어버리기 때문. 해결: 스포트라이트(rect)가 활성화된 상태에서는 오버레이 배경을 transparent로 설정하고, box-shadow만으로 어둡게 처리한다. rect가 없는 초기 상태에서만 오버레이 배경색을 사용한다.
- **참조횟수**: 1

### [2026-03-26] CSS 기반 하이라이트의 근본적 한계 (5회 실패 종합)
- **분류**: error
- **발견자**: planner-architect
- **내용**: CSS만으로 특정 DOM 요소를 하이라이트하는 모든 방식이 실패한 종합 기록. (1) box-shadow 9999px 방식: 오버레이 배경과 겹침. (2) 대상 z-index 올리기: 부모 stacking context(sticky header, overflow:hidden 등)에 갇혀서 z-index가 무시됨. (3) 4-div 오버레이(상/하/좌/우 div로 구멍 생성): 대상이 뷰포트보다 크면 구멍이 전체를 차지. (4) 하이라이트 링(테두리만 표시): 시각적으로 "하이라이트" 느낌이 약함. 결론: 웹에서 안정적인 요소 하이라이트는 SVG mask/clipPath 방식(driver.js 등)이 유일하게 신뢰할 수 있음.
- **참조횟수**: 0

### [2026-03-29] Next.js 16 middleware.ts와 proxy.ts 충돌
- **분류**: error
- **발견자**: debugger
- **내용**: Next.js 16에서는 `middleware` 파일 컨벤션이 deprecated되고 `proxy`로 대체되었다. `src/middleware.ts`와 `src/proxy.ts`가 동시에 존재하면 개발서버 시작 시 `Unhandled Rejection: Both middleware file and proxy file are detected` 에러가 발생한다. 해결: `middleware.ts`를 삭제하고 `proxy.ts`만 사용한다. 새 matcher가 필요하면 `proxy.ts`의 config.matcher에 추가한다.
- **참조횟수**: 0

### [2026-07-06] isomorphic-dompurify(jsdom)가 Vercel 서버런타임에서 500 (ERR_REQUIRE_ESM)
- **분류**: error
- **발견자**: debugger
- **내용**: `@/lib/sanitize`의 `sanitizeHtml`은 `isomorphic-dompurify`를 쓰는데, 이 라이브러리는 서버에서 `jsdom`을 끌어온다. jsdom의 전이 의존성 `html-encoding-sniffer → @exodus/bytes/encoding-lite.js`가 ESM 전용 모듈이라, Vercel 서버리스(Next 16 Turbopack)가 이를 `require()`할 때 `Error [ERR_REQUIRE_ESM]`로 터진다. 에러는 **모듈 평가(import) 시점**에 발생하므로, `sanitize`를 import한 서버 컴포넌트 라우트의 서버 청크 로딩 자체가 실패 → 공지 내용과 무관하게 그 라우트 전체가 500. 커밋 dadb81e가 `/notices/[id]`에 `toNoticeHtml`(내부에서 sanitizeHtml 호출)을 추가하면서 이 동적 라우트가 매 요청 500이 됨(이전엔 sanitize를 안 써서 정상). 참고로 정적 라우트(/, /about, /apply)도 같은 에러를 내지만 빌드 프리렌더 캐시로 사용자에겐 잠재화되어 있었고, 동적 라우트 `/notices/[id]`만 사용자에게 500 노출.
- **해결(즉시)**: `src/lib/noticeContent.ts`의 `toNoticeHtml`은 이미 모든 사용자 텍스트를 `escapeHtml`로 이스케이프하고 화이트리스트 `<a>` 태그만 삽입하므로 출력이 이미 안전하다. 마지막 `return sanitizeHtml(out)`을 `return out`으로 바꾸고 sanitize import를 제거하면 jsdom 의존이 사라져 500 해소.
- **해결(근본)**: 사이트 전역에서 서버측 sanitize가 깨진 상태(ISR 재검증 실패로 stale 누적). isomorphic-dompurify를 jsdom 비의존 새니타이저로 교체하거나 서버 번들 설정을 조정하는 별도 작업 필요.
- **참조횟수**: 0

### [2026-07-26] T맵 경유지최적화가 항상 400(9401)으로 실패 → 노선이 늘 '직선 추정'
- **분류**: error
- **발견자**: pm
- **내용**: `src/lib/shuttle/tmap.ts`의 `optimizeWaypointOrderWithTmap`이 T맵 routeOptimization API를 호출하는데 두 가지 필수 조건을 어겨 **항상 400(code 9401 "필수 파라메터가 없습니다")**를 받고, `planRun`의 try/catch가 이를 삼켜 조용히 LOCAL(직선 추정) 폴백. 그래서 유효한 `TMAP_APP_KEY`가 있어도 "T맵 최적경로"가 절대 활성화되지 않았다. 실측 진단(실 키로 API 직접 호출): ①`startTime`(yyyyMMddHHmm)이 **필수** — 빼면 400, 넣으면 200. ②`viaPointId "0"`을 T맵이 **값 없음으로 취급** — 호출부(shuttle-optimize)가 `String(i)`로 0부터 매기면 첫 경유지가 "0"이라 항상 400. `carType`은 불필요(넣어도 무관), `searchOption`도 무관. 기본 자동차경로/POI API는 같은 키로 200이라 키·권한 문제 아님.
- **해결**: tmap.ts에서 (1) 요청 본문에 `startTime: tmapStartTime()`(현재 시각 Asia/Seoul) 추가, (2) 호출부 id를 그대로 보내지 말고 내부 안전 id(`wp0`,`wp1`…)로 바꿔 전송한 뒤 응답 순서를 원래 id로 되돌린다(originalBySafe 맵). 호출부 계약(id 넣고 순서 받기)은 그대로. 회귀 테스트 `tmap-route-optimization.test.mjs`에 startTime 형식·viaPointId≠"0" 단언 추가.
- **참조횟수**: 0

### [2026-08-09] scope 없는 manifest 하나가 같은 도메인의 다른 PWA 설치를 전부 막는다

**증상**: 갤럭시 크롬에서 `/mypage/install` 을 열면 설치 버튼 대신 "앱이 이미
설치되어 있습니다" 가 뜬다. 학부모 앱을 지워도 그대로. "앱 열기" 를 누르면 홈이
아니라 **설치 안내 화면이 앱 창으로** 열리고, 주소창·뒤로가기가 없어 갇힌다.

**원인**: `public/manifest.json` 에 `scope` 가 없었다. 없으면 기본값이 start_url
기준 `/` 라서, 공식 앱이 **사이트 전체를 자기 영역으로** 잡는다. 크롬은 현재
주소를 품는 설치된 앱을 찾으면(FindAppWithUrlInScope) manifest 의 `id` 가 달라도
"이미 설치됨" 으로 답한다. 즉 공식 앱이 깔린 기기에서는 `/staff`·`/mypage` 앱을
설치할 수 없다.

**확인법**: 공식 앱을 지우고 새로고침 → 설치 버튼이 즉시 나타나면 이 원인이다.

**해결**: 공식 앱을 설치 대상에서 제외(`display: "browser"`) + `scope` 명시.
같은 도메인에 역할별 PWA 를 둘 이상 두려면 **넓은 scope 앱을 만들지 않는다.**

**교훈**: manifest 의 빠진 필드는 "없음" 이 아니라 **기본값이 들어간다.** scope 는
비워두면 가장 넓은 값이 되어 조용히 다른 앱을 잡아먹는다.

### [2026-08-09] start_url 끝 슬래시 하나로 PWA 가 시작하자마자 제 영역을 벗어난다

**증상**: 기사님 앱을 설치하면 홈 화면 아이콘이 404 를 열었다.

**원인 두 겹**:
1. `start_url: "/driver/"` 인데 `/driver` 페이지 자체가 없었다(토큰 주소
   `/driver/[token]` 만 존재). manifest 의 start_url 은 **반드시 실제로 열리는
   주소**여야 한다.
2. 페이지를 만든 뒤에도 함정이 남는다. Next 는 기본값(`trailingSlash: false`)에서
   `/driver/` → `/driver` 로 **308 되돌린다**. 그런데 scope 는 `/driver/` 라
   최종 주소가 영역 밖이 된다. 앱이 시작하자마자 브라우저로 튕길 수 있다.

**해결**: start_url·scope 를 **둘 다 끝 슬래시 없이** `/driver` 로 맞춘다.
`/driver/[token]` 은 문자열 prefix 로 `/driver` 안에 들어간다.

**확인법**: `curl -o /dev/null -w "%{http_code} %{redirect_url}" <start_url>`
로 **리다이렉트가 없는지** 본다. 200 이 아니면 앱 아이콘이 그 화면을 연다.

**교훈**: start_url 은 "설정값"이 아니라 **매번 실행되는 주소**다. 눈으로 열어보고
리다이렉트까지 확인해야 한다. scope 도 비워두면 기본값이 들어간다(같은 날
공식 앱 scope 사고와 같은 형태).

### [2026-11-09] 문자(SMS/LMS) 본문에 이모지·꺾쇠 따옴표(«»)를 넣으면 받는 폰에서 깨진다
- **분류**: error
- **발견자**: developer
- **내용**: 통신사 문자는 EUC-KR 완성형 글자만 온전히 간다. 🏀 같은 이모지와 « » 는 완성형에 없어 «?»로 깨지거나 거절된다(▶ · ※ ■ ‘ ’ 《 》 는 된다). 원장 승인 문구라도 문자로 나가면 바꿔야 한다 — 학부모 가입 안내에서 🏀 삭제·«» → ‘’. 검사: `tests/parent-signup-guide.test.mjs` 가 `TextDecoder("euc-kr")` 로 2바이트 글자표를 만들어 본문 글자를 대조한다(새 문자 문구도 같은 방식으로 검사할 것). 알림톡·화면 글은 해당 없음.
- **참조횟수**: 0

### [2026-11-09] 워크트리·Temp 폴더에서 TSX 를 직접 렌더하면 «Objects are not valid as a React child» — react 사본 두 개
- **분류**: error
- **발견자**: tester
- **내용**: 워크트리엔 node_modules 가 없어(정션 금지) 메인 저장소 react 19 를 절대 경로로 끌어오는데, Temp 아래 가짜 모듈(next/link 대역 등)에 남은 `import "react"` 는 위로 올라가 `C:\Users\cobby\node_modules\react`(옛 버전)를 집는다. 두 버전 요소가 섞여 렌더가 깨진다. 렌더 검증용 파일은 «가짜 모듈까지» 같은 변환기로 bare import 를 메인 저장소 경로(createRequire(메인 package.json).resolve)로 바꿔 쓸 것. 기준 구현: 테스트 scratchpad 의 render/build.mjs.
- **참조횟수**: 0

### [2026-11-09] 신청 화면에서 결과 문구가 버튼과 멀면 «눌러도 반응 없음», refresh 전에 버튼이 살아나면 두 번째 누름이 오류
- **분류**: error
- **발견자**: debugger
- **내용**: 학부모 수강 변경(휴원) «신청하기»가 «동작 안 함»으로 신고됨. ① 오류(role=alert)는 화면 맨 위·접수 완료는 맨 아래라, 휴대폰에서 내려 버튼을 누른 사람에게 둘 다 안 보였다. 아이폰 날짜 고르기는 `min` 을 무시해 휴원 시작일 이전 복귀일이 골라지고, 그 거절 문구가 화면 밖에 떴다. ② `startTransition(async)` 안에서 `await` 뒤 부른 `router.refresh()` 는 끝날 때까지 기다려 주지 않아 pending 이 먼저 풀리고 «신청하기»가 다시 살아난다 → 다시 누르면 «이미 검토 중인 신청» 400. 해결: 결과 문구를 누른 버튼 바로 위로(notice 묶음), 접수 성공한 수강 등록은 새 내역이 올 때까지 잠금(`submittedFor`)+«신청 내역 다시 불러오기», 휴원 복귀일은 보내기 전에 시작일과 비교. 검사: `tests/enrollment-change-submit-feedback.test.mjs`(가짜 react 훅으로 컴포넌트 함수를 직접 불러 onClick 을 누른다 — react-dom 없이 상호작용 검사). 셔틀·결석·보강 신청 화면도 오류가 맨 위에 있어 같은 신고가 날 수 있다.
### [2026-11-10] «신청했는데 안 됐다» — 성공 로그가 없어도 pg_stat_statements 로 서버가 어느 단계까지 갔는지 판정한다
- **분류**: error
- **발견자**: debugger
- **내용**: 원장 «김루빈 휴원 신청했는데 복귀 버튼 안 보여». 신청 행·원장 알림 0건, Vercel 은 성공 요청을 안 남겨 확인 불가였다. 운영 DB `pg_stat_statements`(BEGIN READ ONLY)로 판정: 상수는 `$n` 으로 바뀌어 저장되므로 SQL 머리 글자로 찾고(`regexp_replace(query,'\s+',' ','g') ILIKE …`), PG17 의 `stats_since` = 그 쿼리 첫 실행 시각, `rows < calls` 면 일부가 0행. 결과: 소유 확인 2회·2행 통과 → 다음 쿼리(PENDING 중복 확인)·INSERT 0회 = 그 사이 순수 입력 검사에서 400(휴원은 복귀 예정일 ≤ 시작일뿐). 당시 화면은 오류가 맨 위라 «접수된 줄» 알았다(11-09 수정 전). 주의: ACTIVE/PAUSED 처럼 상수만 다른 쿼리는 같은 항목으로 합쳐지고, 마지막 실행 시각은 없다. `pg_stat_statements_info.dealloc` 이 0 이 아니면 1~2회짜리 항목이 밀려났을 수 있어 «앞뒤 쿼리 짝»으로 교차 확인. 화면 조회 쿼리 버전별 항목(배포마다 글자가 바뀜)으로 «어느 배포 화면을 몇 번 열었나»도 보인다.
- **참조횟수**: 0

### [2026-11-09] Tailwind `touch-none` 이 테마 CSS 에 져서 휴대폰 끌기가 바로 취소됨
- **분류**: error
- **발견자**: developer
- **내용**: `academy-theme.css` 의 `.academy-app :is(button, a) { touch-action: manipulation }` 은 레이어 밖 규칙이라 `@layer utilities` 안의 Tailwind `touch-none` 을 이긴다. 관리자 운행표 손잡이(⠿, button)가 휴대폰에서 손가락을 움직이자마자 pointercancel 로 끌기가 끊겼다(마우스는 정상이라 PC 에선 안 보임). 해결: 손잡이에 인라인 `style={{ touchAction: "none" }}`. 버튼·링크에 touch-action/기타 속성을 Tailwind 로 걸 때 테마의 `:is(button, a)` 규칙과 겹치는지 먼저 본다. 확인법: Playwright `hasTouch` + CDP `Input.dispatchTouchEvent` 로 pointer 이벤트 순서 기록(scratchpad shuttle-blocks/drag-e2e.mjs). 같은 뿌리(11-09 학생 상세 2차): `globals.css` 의 층 밖 `.material-symbols-outlined { display:inline-flex }` 가 아이콘에 직접 건 `hidden` 을 이겨 휴대폰에서 아이콘이 안 숨는다 → 아이콘을 `<span className="hidden sm:inline-flex">` 로 감싼다. 또 휴대폰 화면 캡처는 뷰포트 메타가 없으면 980px 로 그려진다 — 정적 HTML 로 찍을 땐 `<meta name=viewport content=width=device-width>` 를 넣는다.
- **내용**: `academy-theme.css` 의 `.academy-app :is(button, a) { touch-action: manipulation }` 은 레이어 밖 규칙이라 `@layer utilities` 안의 Tailwind `touch-none` 을 이긴다. 관리자 운행표 손잡이(⠿, button)가 휴대폰에서 손가락을 움직이자마자 pointercancel 로 끌기가 끊겼다(마우스는 정상이라 PC 에선 안 보임). 해결: 손잡이에 인라인 `style={{ touchAction: "none" }}`. 버튼·링크에 touch-action/기타 속성을 Tailwind 로 걸 때 테마의 `:is(button, a)` 규칙과 겹치는지 먼저 본다. 확인법: Playwright `hasTouch` + CDP `Input.dispatchTouchEvent` 로 pointer 이벤트 순서 기록(scratchpad shuttle-blocks/drag-e2e.mjs). ⚠️ 검사용 HTML 에 `<meta name="viewport" content="width=device-width, initial-scale=1">` 이 없으면 `isMobile` 이 980px 폭을 축소해 그려 CDP 터치 좌표가 엉뚱한 요소(탑승 버튼)에 떨어진다 — «터치 끌기가 안 된다»로 오판하기 쉽다(2026-11-09).
- **참조횟수**: 0

### [2026-11-10] 학부모 화면이 actions/admin.ts 의 함수를 불러 «관리자 권한이 필요합니다»로 실패
- **분류**: error
- **발견자**: developer
- **내용**: 학부모 홈 알림 «읽음»·«모두 읽음»이 `markNotificationRead`/`markAllNotificationsRead`(admin.ts, `requireAdmin()`)를 불러 운영에서 학부모 전원 실패. tsc·빌드는 통과해 신호가 없다. 학부모 쓰기는 별도 파일(`actions/parent-*.ts`)에 `requireVerifiedParent()` + **대상 사용자 id 는 세션 값(appUserId)** 으로 만든다(화면이 userId 를 넘기지 않게). 수정: `actions/parent-notifications.ts`, 가드 `tests/parent-notifications-action.test.mjs`(홈이 admin 읽음 함수를 import 하면 실패).
- **참조횟수**: 0

### [2026-11-12] 역할을 바꿔도 코치 프로필 연결(Coach.userId)이 남아 «해제할 길 없는 연결»이 됨
- **분류**: error
- **발견자**: developer
- **내용**: `updateUserRole` 이 User.role 만 바꿔서, 코치/강사 → 셔틀 기사·학부모로 바꾸면 Coach.userId 가 그대로 남았다. 기사 줄엔 코치 연결 칸이 없고 학부모는 스태프 목록에서 빠져 화면에서 못 풀고, 그 코치 프로필은 다른 사람 선택칸에서 [연결됨]으로 막혔다. 수정: 같은 거래에서 코치 연결을 쓰지 않는 역할이면 연결 해제(승인된 선생님 추가역할 ACTIVE 면 유지) + 화면은 연결이 남은 사람에게 선택칸을 보여 해제 가능. **교훈**: 상태(역할)를 바꾸는 작업은 «그 상태에 매달린 연결»도 같은 거래에서 정리할지 본다. 가드 `tests/staff-roster.test.mjs`.
- **참조횟수**: 0
