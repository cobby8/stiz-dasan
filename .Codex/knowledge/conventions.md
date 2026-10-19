# Conventions

## 2026-10-19: 학원 역할 화면의 보조 영역 접기
- 관리자·학부모·교사 화면에서 반복된 원칙: 실제 당면 업무와 오류/납부/미확인 안내를 우선 두고, 통계·기록·보조 도구는 native details로 접는다. 펼치기만으로 저장·발송·운영 도구를 실행하지 않는다.
- 입력·업로드 컴포넌트는 단순 접기 때문에 언마운트하지 않는다. 보존한 앵커가 접힌 내용으로 향하면 상위 영역을 먼저 연다. 기존 목적지와 실행 전 확인을 유지한다.

## 저장·전달 결과 표현 (2026-10-19)
- 학부모·교사·기사·관리자 모두 저장/업무 반영/사이트 알림 등록/푸시 접수/사람 확인을 구분한다. 사람 확인 기록이 없으면 읽음·업무 확인으로 승격하지 않는다.
- 응답 유실은 재조회로 확인하고, 조회 실패는 빈 기록·실패 확정으로 대체하지 않는다. 같은 작업 재시도와 새 작업 생성을 구분한다.

### [2026-07-26] `AcademySettings`에 컬럼을 추가할 때는 반드시 TEXT로 맞춘다
- **분류**: convention
- **발견자**: developer
- **내용**: `AcademySettings`는 Prisma 스키마가 정본이 아니다. `src/app/actions/admin.ts`의 `rawUpsertAcademySettings`가 저장 중 `column "X" of relation` 에러를 만나면 **그 컬럼을 스스로 만들어 버리는데**, `BOOLEAN_SETTINGS_COLUMNS` 집합에 없는 이름은 무조건 `TEXT`가 된다. 게다가 `ensureAcademySettingsColumns()`는 export만 되어 있고 **어디서도 호출되지 않으므로**(2026-07-26 실측) 실제 컬럼 생성은 이 fallback 경로가 담당한다. 그래서 새 설정 컬럼에 `DOUBLE PRECISION`·`INTEGER` 같은 타입을 쓰면 **먼저 DDL을 돌린 환경과 fallback으로 만들어진 환경의 컬럼 타입이 갈린다**(Prisma client가 Float로 읽으려다 터짐). 좌표처럼 숫자여야 하는 값도 TEXT로 저장하고 읽는 쪽에서 `Number()` + 유한값·범위 검증을 한다. 빈 문자열을 `Number()`에 그냥 넣으면 **0이 되어 아프리카 앞바다 좌표가 되므로** 반드시 빈 값을 먼저 null 처리한다. 컬럼을 추가하면 4곳을 같이 고쳐야 한다: ① `prisma/sql/*.sql` 멱등 DDL(`ADD COLUMN IF NOT EXISTS`) ② `prisma/schema.prisma` ③ `src/lib/queries.ts`의 `fetchAcademySettings` 매핑(`SELECT *`지만 반환 객체가 화이트리스트라 여기 안 적으면 값이 사라진다. 소문자 fallback도 함께) ④ `admin.ts`의 `ALLOWED_SETTINGS_COLUMNS`(여기 없으면 저장이 조용히 무시된다). 참조 구현: `prisma/sql/add_academy_shuttle_location.sql`, `src/lib/shuttle/academyLocation.ts`.
- **참조횟수**: 0

### [2026-07-26] 운영 기준값은 환경변수 단독으로 두지 않는다 — DB 정본 + env fallback
- **분류**: architecture
- **발견자**: developer
- **내용**: 학원 좌표는 `SHUTTLE_ACADEMY_LATITUDE/_LONGITUDE/_NAME` 환경변수만 정본이었다. 환경변수는 배포 환경마다 따로 넣어야 해서 **한 곳만 빠지면 반별 자동배치가 409(`ACADEMY_COORDINATES_REQUIRED`)로 죽고, 원장이 스스로 고칠 방법이 전혀 없다**(재배포가 필요하다). 원장이 값을 바꿀 수 있어야 하는 운영 기준값은 **DB를 정본으로 두고 환경변수는 fallback으로만** 남긴다. 이 순서여야 ① 기존 배포가 그대로 동작하고 ② 새 환경은 DB만 채우면 되고 ③ 관리자 화면에서 교정이 가능하다. 우선순위 판단은 DB·env 접근에서 분리한 순수 모듈에 넣어 회귀 테스트로 고정한다(`resolveAcademyShuttleLocation`). ⚠️ 좌표 유효성 검사 범위를 "남양주 다산동"처럼 좁게 못 박지 말 것 — 학원이 이전하면 정상 값이 거부된다. 대한민국 경계(위도 33~39, 경도 124~132) 정도로 두면 **위경도를 바꿔 넣은 실수와 0/해외 좌표**라는 진짜 사고만 걸러진다.
- **참조횟수**: 0

### [2026-07-26] 좌표를 새로 넣을 때는 반드시 독립된 두 출처로 교차검증한다
- **분류**: convention
- **발견자**: developer
- **내용**: 틀린 좌표를 넣으면 T맵 경로 추천이 통째로 엉뚱한 곳으로 가는데, **화면 어디에도 에러가 뜨지 않는다**(그냥 이상한 순서로 배차된다). 그래서 좌표는 절대 추측하지 않고 최소 두 출처를 대조한다. 2026-07-26 학원 좌표 확정 절차: 카카오맵 장소검색(`스티즈농구교실 다산2호점` place 1661652155)과 네이버 지역검색이 **같은 도로명주소**(경기 남양주시 다산중앙로20번길 10-32)를 반환하는지 먼저 확인 → 네이버 `mapx/mapy`(1271563116 / 376145054 = 127.1563116 / 37.6145054)를 정본 채택 → 기존 환경변수 값과 거리 계산으로 대조(6.6m, 동일 건물). 이 "두 좌표가 20m 이내"를 테스트로 고정해 두면 나중에 누가 한쪽만 고쳐도 잡힌다(`academyLocation.test.ts`). 지도에서 직접 찍어야 할 때는 이미 만들어져 있는 `src/components/maps/LocationPickerModal.tsx`(카카오 기반 주소검색·핀·현재위치)를 재사용한다. 무거우니 `next/dynamic`으로 모달 열 때만 로드한다.
- **참조횟수**: 0

### [2026-07-26] 학생을 조회하면 무조건 병합 필터(`mergedIntoStudentId IS NULL`)를 건다
- **분류**: convention
- **발견자**: developer
- **내용**: 중복 학생 정리는 하드 DELETE를 하지 않는다. 흡수된 `Student` 행은 그대로 남고 `mergedIntoStudentId`에 대표 학생 id만 찍힌다(`src/lib/studentMerge/engine.ts` 7단계). 그래서 조건을 빠뜨린 화면에만 **조용히 같은 아이가 두 번** 나온다. 공용 헬퍼는 `src/lib/studentVisibility.ts`의 `notMergedStudent(alias)`(INNER JOIN/FROM용) · `notMergedStudentOptional(alias)`(LEFT JOIN용) · `NOT_MERGED_STUDENT`(Prisma where 조각) 3종이고, tagged template(`$queryRaw`)에서는 같은 문구를 그대로 적어 grep이 걸리게 한다. ⚠️ **LEFT JOIN 자리에서 `s."mergedIntoStudentId" IS NULL`을 WHERE에 그냥 넣으면 학생이 안 붙은 행까지 통째로 사라진다**(실측: 3행 → 1행). 반드시 `(s.id IS NULL OR ...)` 형태나 ON 절을 쓴다. 특히 조심할 것은 **UNIQUE 충돌로 못 옮기고 흡수된 쪽에 남는 행**(`Enrollment(classId)`·`Attendance(sessionId)`·`StudentSessionNote(sessionId)`·`StudentShuttleLocation(kind)`·`ShuttleRoutePassenger`·`Waitlist(classId)`)이다. 나머지 자식 행은 대표에게 옮겨지므로 유령이 생기지 않는다. **일부러 안 거는 곳**: 병합 엔진 자체, 청구/수납 목록(돈을 숨기는 쪽이 더 위험 — 실측으로 흡수 예정 학생에게 7월 미납 90,000원이 붙어 있었다), id를 이미 아는 단건 상세·알림, 권한·동의 게이트, `cleanup-duplicates`의 고아 학부모 판정(흡수된 학생도 세야 FK가 안 깨진다). 빠뜨림 방지는 사람 기억이 아니라 `src/lib/studentVisibility.test.ts`의 소스 전수 가드가 맡는다 — 필터 없는 학생 조회가 새로 늘면 테스트가 실패하고, 예외는 사유와 함께 목록에 등록해야 한다.
- **참조횟수**: 0

### [2026-07-26] 학부모 연락처 교정은 `User.phone` UPDATE가 아니라 `Student.parentId` 재연결로 한다
- **분류**: convention
- **발견자**: developer
- **내용**: 시트 오기로 학생에게 남의 전화번호가 붙은 경우, `User.phone`을 정답으로 바꾸고 싶어진다. 하지만 이 프로젝트의 `User`는 **여러 자녀가 매달린 공유 계정**이고(`기타(기본 보호자)` 임시계정 133개), 동시에 **로그인 주체**(`authUserId`, `phoneVerifiedAt`)이며, **형제 판정 키**(보호자 번호 합집합)이기도 하다. 실측에서 오기 번호 `01037753570`에는 김관우가, `01066281801`에는 이시윤이 함께 붙어 있어 그 계정의 phone을 고치면 **무관한 학생 2명의 소속·형제 판정이 동시에 틀어진다.** 그래서 교정은 항상 **"정답 번호를 이미 가진 기존 User로 `Student.parentId`를 옮기는" 방향**만 쓴다. 옮긴 뒤 그 계정 이름이 `기타(기본 보호자)`면 `StudentRegistrationLedger.parentName`의 실명으로 채운다(원장 데이터가 실명의 정본이다). 번호가 남는 고아 User는 자녀 0명이 되므로 지우지 않고 그냥 둔다. 참조 구현: `src/lib/studentMerge/engine.ts`의 `relinkParentUserId` / `fillParentName`.
- **참조횟수**: 0

### [2026-07-26] 학생 ID는 FK가 걸린 13곳 말고 15곳에 더 있다 — 이동 시 표를 보고 훑는다
- **분류**: architecture
- **발견자**: developer
- **내용**: `Student.id`를 참조하는 컬럼은 실측 28곳인데 **FK 제약이 걸린 것은 13곳뿐**이다. `PaymentInvoice` · `PaymentTransaction` · `Feedback` · `ParentRequest` · `Waitlist` · `MakeupSession` · `SkillRecord` · `NotificationDelivery` · `MediaRevocationJob` · `SpecialProgramEnrollmentDate` · `SpecialProgramMakeup` · `TrialLead.convertedStudentId` · `EnrollmentApplication.convertedStudentId` · `SpecialProgramApplication.convertedStudentId` 는 **FK 없이 문자열로만** 물려 있어, FK를 따라가는 정리 로직은 이들을 통째로 놓치고 유령 ID를 남긴다. 게다가 `SocialPostDraft.subjectStudentIdsJSON`은 JSON 배열 문자열이라 컬럼 UPDATE로는 못 고친다. 별도 예외 2가지: `StaffPaymentConfirmationRequest`는 `Payment(id,classId,studentId,amount)` 복합 FK가 `ON UPDATE CASCADE`라 Payment를 옮기면 **자동으로 따라오므로 직접 UPDATE 하면 오히려 FK가 깨진다.** UNIQUE에 studentId가 포함된 6개 테이블(`Enrollment(classId)` · `Attendance(sessionId)` · `StudentSessionNote(sessionId)` · `StudentShuttleLocation(kind)` · `ShuttleRoutePassenger(routePlanId,sessionId,locationKind)` · `Waitlist(classId)`)은 그냥 UPDATE 하면 충돌한다. 정본 목록: `src/lib/studentMerge/tables.ts`.
- **참조횟수**: 0

### [2026-07-26] 돈 계산 규칙은 `@/` 없는 순수 모듈로 떼어내 회귀 테스트한다
- **분류**: convention
- **발견자**: developer
- **내용**: 금액을 계산하는 로직을 `@/lib/...` 별칭을 쓰는 큰 파일 안에 두면 `node --experimental-strip-types --test`로 직접 실행할 수 없어 사실상 테스트가 안 된다(이 프로젝트에는 vitest가 없고 테스트는 전부 Node 내장 러너다). 그래서 **계산 규칙만 외부 의존성 0인 순수 모듈로 분리**하고, 호출부는 그 함수를 부르기만 한다. 참조 구현: `src/lib/studentBilling.ts` ← `src/lib/importStudents.ts`. 테스트 파일은 `import ... from "./모듈.ts"` 형태(런타임 확장자 필요)에 바로 윗줄 `// @ts-expect-error` 한 줄을 붙이고, **import를 여러 줄로 쪼개지 마라** — `@ts-expect-error`는 바로 다음 줄에만 걸려 `TS2578 Unused directive`가 난다.
- **참조횟수**: 0

### [2026-07-26] 시트 파싱에서 컬럼 자동 감지는 `else if` 체인 + 단일 변수로 만들지 않는다
- **분류**: convention
- **발견자**: developer
- **내용**: 헤더 이름으로 컬럼 인덱스를 찾을 때 `else if (h.includes("결제액") || h.includes("금액") || h.includes("수강료")) result.amount = i` 처럼 여러 후보를 한 변수에 대입하면, **헤더 순서에 따라 뒤 컬럼이 앞 컬럼을 조용히 덮어쓴다.** 실제로 청구 기준 금액이 시트 열 순서에 좌우되는 상태였다. 의미가 다른 칸(`수강료`/`셔틀비`/`이월`/`결제액`)은 **각각 별도 인덱스**로 잡고, 각 분기에서 `if (result.X === -1)`로 **처음 매칭된 컬럼만** 채택한다. 인덱스를 못 찾았을 때 `row[-1]`을 읽어 금액이 조용히 0이 되는 것도 막아야 한다(`readAmountColumn`처럼 -1을 명시적으로 null 처리). 참조 구현: `src/lib/importStudents.ts`의 `detectColumnIndices` / `readAmountColumn`.
- **참조횟수**: 0

### 2026-07-25 방학특강 출석 슬롯(SpecialProgramEnrollmentDate) 규칙
- **분류**: convention
- **발견자**: reviewer
- **내용**:
  - 정규 수강일(REGULAR) 슬롯 생성은 `INSERT ... ON CONFLICT ("applicationItemId","sessionDateId") DO NOTHING`만 쓴다. `DO UPDATE`를 쓰면 기존 `kind='MAKEUP'` 배정이 REGULAR로 덮여 사라진다(보강 생성 `makeup.ts`만 의도적으로 DO UPDATE를 쓴다).
  - 슬롯 생성은 승인 `prisma.$transaction` **밖**에서, 예외를 삼키는 Safe 래퍼로 호출한다. 슬롯 실패가 승인 롤백을 유발하면 안 된다.
  - 요일 매칭은 반드시 서울시간 기준(`weekdayInSeoul` 또는 SQL `EXTRACT(ISODOW FROM ... AT TIME ZONE 'Asia/Seoul')`)으로 한다.
  - `selectedWeekdays`가 비어 있으면 "전 날짜 대상"으로 본다. 프로젝트 전역 관례(`COALESCE(cardinality(...),0) = 0`)와 반드시 같은 의미를 유지한다.
  - 슬롯은 생성만 하고 지우지 않으므로, **명단/집계 조회에는 항상 `SpecialProgramApplicationItem.status = 'APPROVED'` 필터를 건다.** 이 필터가 빠지면 거절·취소된 학생이 출석부에 계속 남는다.
- **참조횟수**: 0

## 2026-07-22 관리자 테이블/액션 규칙
- 관리자 페이지의 일반 데이터 표는 `AdminShellClient` 본문에 걸린 `admin-table-scope` 전역 규칙을 기본으로 따른다. 표는 콤팩트 패딩, 가로/세로 중앙 정렬, sticky 헤더, 다크모드 표면을 공유한다.
- 행 안의 반복 작업 버튼은 가능한 한 `AdminQuickActionMenu`로 묶는다. 목록은 읽는 정보 중심으로 한 줄을 유지하고, 수정/삭제/상태처리/복사/발송 같은 작업은 번개 아이콘 메뉴에서 펼친다.
- 표 스크롤 박스 안에서 메뉴가 잘리지 않도록 퀵액션 메뉴는 `fixed` floating 방식으로 띄운다.

## 2026-07-16 관리자 긴 목록 규칙
- 관리자 긴 목록은 화면에서 `slice()`로만 자르지 않는다. 첫 요청부터 DB 쿼리에 `limit/offset`을 넣고, 통계가 필요하면 목록과 통계를 분리해서 가져온다.
- 기본 탭이 아닌 무거운 목록은 탭 진입 시 지연 로딩한다. 사용자가 보지 않는 데이터를 첫 화면 payload에 싣지 않는다.
- 부분 로딩 목록에서 필터 결과가 현재 묶음에 없더라도 서버에 다음 묶음이 남아 있으면 추가 탐색 버튼을 제공한다.

## 작업 원칙
- 코드나 파일 변경 전에는 변경 이유와 범위를 먼저 설명하고 사용자 승인을 받는다.
- 한 번에 하나의 작업 단위만 진행한다.
- 큰 작업은 작은 단계로 나눈다.
- 작업 후 지금 한 것과 다음에 할 것을 정리한다.

## 개발 원칙
- 기존 기능을 보존한다.
- 불필요한 리팩토링은 하지 않는다.
- 수업/운영 데이터가 연결된 기능은 DB 구조와 사용자 흐름을 먼저 확인한다.
- Prisma 기본 ORM 메서드로 임의 전환하지 않는다. PgBouncer 호환 이슈 때문에 `$queryRawUnsafe` 패턴이 의도적으로 쓰인다.
- 여러 장 이미지 업로드는 `uploadImagesWithProgress`를 사용해 압축, 병렬 업로드, 진행률 표시, 부분 실패 안내를 같은 방식으로 처리한다.
- 타임스탬프/랜덤값이 들어간 고유 파일명 업로드 이미지는 긴 immutable 캐시를 적용할 수 있다. 같은 URL의 내용이 바뀔 수 있는 파일에는 적용하지 않는다.
- 외부 API 게시처럼 오래 걸리거나 실패 가능성이 큰 작업은 내부 저장 성공과 분리해 먼저 사용자에게 성공을 보여주고, 외부 게시 상태는 별도 상태/재시도 UI로 관리한다.
- 인스타 자동 게시처럼 30초 제한에 걸릴 수 있는 외부 작업은 화면 Server Action에서 직접 기다리지 않고, 큐 상태와 cron 처리로 넘긴다.
- 홈 화면에 공지/갤러리 같은 보조 데이터를 추가할 때는 작은 limit와 공개 필터를 SQL에 넣고, 본문 전체 대신 목록에 필요한 필드만 UI에서 사용한다.
- 전역 레이아웃에서 여러 한국어 후보 폰트를 `next/font/google`로 등록하지 않는다. 빌드가 Google Fonts 네트워크에 의존하게 되므로, 후보 폰트는 CSS fallback 스택으로 두고 꼭 필요한 폰트만 로컬 self-host 자산으로 추가한다.
- Pretendard/Material Symbols처럼 외부 stylesheet가 필요한 경우 전역 head에 직접 넣지 않는다. Pretendard는 idle 시점에 삽입하고, Material Symbols는 실제 `.material-symbols-outlined`가 있는 페이지에서만 삽입한다.
- 설정처럼 여러 페이지가 반복해서 읽는 저변경 데이터는 요청 단위 `react.cache()`만 믿지 말고 `unstable_cache`와 태그 무효화를 함께 검토한다.
- 외부 추적 스크립트는 환경변수가 있을 때만 로드한다. 기본 ID fallback으로 모든 방문자에게 외부 스크립트를 강제하지 않는다.
- 모든 공개 페이지에 붙는 플로팅 도구는 버튼/런처만 초기 렌더에 남기고, 패널/투어/라이브러리 본체는 사용자 클릭 또는 지연 시점에 동적 로드한다.
- 공개 홈처럼 정적 섹션이 많은 화면은 파일 전체에 `use client`를 붙이지 않는다. 클릭/스크롤 상태가 필요한 작은 섬만 Client Component로 분리한다.
- 공개 갤러리처럼 목록 HTML은 서버에서 만들 수 있고 전체화면 뷰어만 상호작용이 필요한 경우, 목록은 서버 렌더링하고 뷰어 본체는 클릭 후 동적 로드한다.
- `sanitize-html`처럼 HTML 정리용 큰 라이브러리는 client component에서 import하지 않는다. 서버 컴포넌트에서 미리 정리한 HTML을 내려보내고, client component는 렌더링만 맡긴다.
- 관리자 목록 화면에서 리치 에디터, 업로드 파서, 큰 미리보기처럼 무거운 도구가 모달에서만 필요하면 정적 import 대신 `next/dynamic`으로 모달 렌더 시점에 로드한다.
- 공개 헤더/푸터처럼 모든 페이지에 붙는 공통 컴포넌트는 인증 확인, 외부 SDK, 큰 패널 같은 부가 기능을 직접 import하지 말고 작은 동적 컴포넌트로 분리한다.
- 공개 첫 화면 공통 컴포넌트의 단순 아이콘은 아이콘 폰트 요청을 만들지 않는 `FontFreeIcon`을 우선 사용하고, 별도 아이콘 라이브러리 import는 피한다.
- 관리자 shell처럼 모든 관리자 페이지에 붙는 공통 컴포넌트의 단순 아이콘도 `FontFreeIcon`을 우선 사용한다.
- 관리자와 선생님 화면이 공유하는 미리보기 컴포넌트의 단순 아이콘도 `FontFreeIcon`을 우선 사용한다.
- 최초 setup처럼 서버에서 계정 생성/인증 처리가 가능한 화면은 client component에 Supabase 브라우저 SDK를 직접 import하지 않는다.
- 서버 레이아웃에서 이미 인증/사용자 정보를 확인한 관리자 화면은 같은 정보를 클라이언트에서 Supabase로 다시 조회하지 않는다. 배지/알림 같은 보조 API는 첫 렌더 직후 동시 실행을 피하고 지연 시작한다.

## 디자인 원칙
- API와 데이터 패칭은 유지하고 UI 렌더링만 바꾸는 방식을 우선한다.
- 하드코딩 색상보다 기존 디자인 토큰과 CSS 변수 사용을 우선한다.
- 현재 프로젝트는 Material Symbols Outlined 아이콘 사용 규칙이 있으나, 첫 화면 공통 shell 아이콘은 속도상 `FontFreeIcon` 예외를 우선한다.
- 어두운 배경 위 메뉴/아이콘 hover는 순백 `bg-white` 대신 `bg-white/10` 같은 반투명 배경을 사용한다.
- 기본 테마가 다크모드일 때는 화면 CSS뿐 아니라 `meta[name="theme-color"]`, PWA manifest 색상도 다크모드 브랜드 강조색과 맞춘다.
- 브랜드 강조색은 라이트모드 주황, 다크모드 라임으로 관리한다. 새 UI에서 직접 색을 정해야 할 때는 가능하면 `--brand-accent`와 `--brand-accent-contrast`를 우선 사용한다.
- 새 칩/뱃지/상태 배너를 만들 때는 밝은 `bg-*-50/100`과 진한 `text-*-700`만 두지 말고 명시 `dark:*`를 함께 넣는다. 누락분은 전역 안전망이 보정하지만, 새 UI는 처음부터 다크모드 색을 같이 설계한다.
- 관리자 신청/체험 화면에서는 `slotKey`, 내부 ID, 원문 서버 오류처럼 개발·저장 구조가 드러나는 값 대신 요일·시간·반 이름, 운영용 확인 배지, 쉬운 오류 안내를 보여준다.
- 관리자 신청/체험처럼 반복 처리하는 목록은 이름·보호자·전화번호 검색과 운영 빠른 필터를 제공하고, 승인/반려/문자발송 결과는 브라우저 알림창보다 화면 안 피드백으로 보여준다.
- 관리자 신청/체험 목록에는 24시간 이상 대기, 중복 연락처, 후속 안내 필요처럼 놓치면 안 되는 건을 자동 우선순위 배지로 표시한다.
- 관리자 신청/체험처럼 보호자 연락이 반복되는 화면은 전화, 연락처 복사, 상담용 요약 복사를 목록에서 바로 제공하고, 상세 화면도 같은 액션을 유지한다.
- 관리자 신청/체험 상담 기록은 별도 이력 테이블에 쌓되, 목록 조회에는 전체 로그가 아니라 최신 연락 1건과 열린 재연락 1건만 붙인다. 읽기 경로에서 DDL 보장 작업을 실행하지 않는다.

### [2026-07-25] URL 쿼리로 활성 탭을 정하는 client component 규칙
- **분류**: convention
- **발견자**: developer
- **내용**: 관리자 탭 바처럼 `?tab=`, `?view=` 값으로 활성 상태를 정하는 client component는 `useEffect` + `useState` + `window.location.search` 조합을 쓰지 않는다. 이 조합은 `react-hooks/set-state-in-effect` lint 오류를 만들고, 첫 렌더에 값이 없어 활성 탭이 깜빡이며, deps가 `pathname`뿐이면 경로가 같고 쿼리만 바뀌는 이동을 감지하지 못한다. 대신 `useSearchParams()`를 쓰고 링크는 `next/link`의 `Link`를 유지해 클라이언트 사이드 네비게이션을 보존한다. `useSearchParams()`가 요구하는 Suspense 경계는 페이지 파일을 고치지 말고 컴포넌트 내부에서 처리한다 — 쿼리를 읽는 부분만 서브컴포넌트로 분리해 `<Suspense>`로 감싸고, fallback은 같은 UI를 경로만으로 판정해 렌더하면 레이아웃 흔들림이 없다. 참조 구현: `src/app/admin/seasonal/SeasonalSectionTabs.tsx`.
- **참조횟수**: 0

### [2026-07-25] 방학특강 좌석 조회는 항상 신청항목 상태로 거른다
- **분류**: convention
- **발견자**: developer
- **내용**: `SpecialProgramEnrollmentDate`(좌석) 행은 승인 시 자동 생성되지만, 나중에 신청항목이 거절/취소로 바뀌어도 삭제하는 경로가 없다(출결 기록 소실 위험 때문에 의도적으로 지우지 않는다). 따라서 좌석을 읽는 모든 쿼리는 `e.status <> 'CANCELLED'` 만으로 부족하고 `JOIN "SpecialProgramApplicationItem" it` 후 `AND it.status = 'APPROVED'` 를 함께 걸어야 한다. 그러지 않으면 명단 인원과 집계(`countApprovedStudents`)가 어긋나 "반 전체 12명인데 이 날 13명" 같은 모순이 생긴다. 신청항목 상태 값은 `PENDING/APPROVED/WAITLISTED/REJECTED/CANCELLED` 5가지뿐이고 학생 전환 여부는 별도 컬럼(`conversionStatus`)이라 전환 후에도 APPROVED가 유지되므로, 보강(`kind='MAKEUP'`) 좌석에도 같은 조건을 그대로 적용해도 안전하다. 참조 구현: `src/lib/seasonal/attendance.ts`의 `getDateRoster` / `countApprovedStudents`.
- **참조횟수**: 0

### [2026-07-25] 조기 반환으로 아무 일도 안 하는 자동 처리에는 경고 로그를 남긴다
- **분류**: convention
- **발견자**: developer
- **내용**: 승인 부수효과처럼 "실패해도 본 작업은 성공시켜야 하는" 자동 처리(`syncEnrollmentDatesForItem` 등)가 조건 미충족으로 조용히 반환하면, 운영자는 "승인은 됐는데 출석부가 비어 있다"를 끝내 알 수 없다. 이런 조기 반환 지점에는 `console.warn`으로 대상 ID와 사유, 판단 근거가 된 값(선택 요일·회차 수 등)을 함께 남긴다. 반환값과 흐름은 바꾸지 않는다.
- **참조횟수**: 0

### [2026-07-25] 섹션 공통 헤더는 훅 없는 순수 컴포넌트로 만든다
- **분류**: convention
- **내용**: 여러 페이지가 공유하는 상단 제목 블록(`src/app/admin/seasonal/SeasonalHeader.tsx` 등)은 상태·훅을 쓰지 않는 순수 프레젠테이션 컴포넌트로 만들고 `"use client"`를 **붙이지 않는다**. 그래야 서버 페이지(`attendance/page.tsx`, `shuttle/page.tsx`)와 client component(`SeasonalAdminClient.tsx`) 양쪽에서 그대로 import할 수 있다(클라이언트 그래프에 들어가면 자동으로 클라이언트 번들에 포함된다). 페이지마다 다른 우측 버튼은 `action?: ReactNode` 슬롯으로 주입하고, 컨테이너 폭은 바로 아래 탭 바와 같은 값(`mx-auto max-w-6xl px-4`)으로 맞춰 좌우 정렬이 어긋나지 않게 한다. 브랜드색은 항상 `var(--brand-accent)` / `var(--brand-accent-contrast)`를 쓴다(다크모드에서 오렌지→네온라임 자동 전환).
- **참조횟수**: 0

### [2026-07-26] 취소 가능한 신청 목록은 허용 목록이 아니라 제외 목록으로 거른다
- **분류**: convention
- **발견자**: developer
- **내용**: `SpecialProgramShuttleRequest.status` 같은 신청 상태 필드는 진행에 따라 값이 바뀐다(`REQUESTED` → 배정 시 `syncLegacyAssignment`가 `ASSIGNED`로 갱신). 게다가 이 필드는 **방향별이 아니라 신청 단위 1개**라서, 등원 노선에 배정된 순간 하원 기준으로는 여전히 미배정인데도 값이 `ASSIGNED`가 된다. 따라서 후보 목록을 `status: "REQUESTED"`나 `status: { in: [...] }` 같은 허용 목록으로 좁히면 정상 신청자가 통째로 사라진다(취소자가 보이는 것보다 훨씬 큰 사고). 항상 `status: { notIn: ["CANCELLED", "REJECTED"] }` 제외 방식을 쓴다. 상태 값 5종은 `PENDING/APPROVED/WAITLISTED/REJECTED/CANCELLED`이며 신규 값이 생겨도 제외 방식은 목록에서 빠뜨리지 않는다. 또한 셔틀 신청은 **신청서·수강항목이 APPROVED인데 셔틀만 취소**되는 경우가 실재하므로(2026-07-26 실측 2건) 신청서 상태만 보는 필터로는 부족하고 신청(request) 자체 상태를 반드시 함께 본다. 참조 구현: `src/lib/shuttle/service.ts`의 `CLOSED_SHUTTLE_STATUSES`, `src/lib/shuttle/parent.ts:103`.
- **참조횟수**: 0

### [2026-07-26] Timestamptz 시각은 ISO 문자열을 잘라 쓰지 말고 Asia/Seoul로 변환해 표시한다
- **분류**: convention
- **발견자**: developer
- **내용**: `ShuttleRouteStop.plannedAt` 같은 `@db.Timestamptz` 컬럼은 저장은 한국시간 기준(`plannedDate`가 `08:10`을 `+09:00`으로 해석)인데 API 응답은 **UTC ISO 문자열**로 나간다(`2026-08-02T23:10:00.000Z`). 이걸 `value.slice(11, 16)`으로 자르면 화면에 `23:10`이 뜨고, 관리자가 그 값을 다시 저장하면 KST 23:10으로 재해석돼 실제 시각이 9시간 밀린다. 시:분 표시는 반드시 `Intl.DateTimeFormat`에 `timeZone: "Asia/Seoul"`과 `hourCycle: "h23"`(자정을 `24:00`이 아닌 `00:00`으로 — `<input type="time">`이 24시를 못 받는다)을 지정해 변환한다. 브라우저 로컬 시간에 의존하는 `toLocaleTimeString`도 `timeZone`을 반드시 명시한다. 서버로 되돌려 보낼 때는 `HH:MM`(KST) 또는 원본 ISO 둘 다 안전하다 — `plannedDate`가 두 형식을 구분해 처리한다. 공용 유틸: `src/lib/shuttle/time.ts`(`koreaTimeHHMM` / `confirmedTimeLabel`), 회귀 테스트: `src/lib/shuttle/time.test.ts`.
- **참조횟수**: 0

### [2026-07-26] 학부모 "희망값"과 관리자 "확정값"은 화면에서 반드시 다르게 라벨링한다
- **분류**: convention
- **발견자**: developer
- **내용**: 셔틀은 `SpecialProgramShuttleRequest.pickupTime`(학부모가 적어 낸 희망시간, 자유 텍스트)과 `ShuttleRouteStop.plannedAt`(관리자가 편성한 확정시간, Timestamptz)이 컬럼 단계에서 이미 분리돼 있다. 컬럼만 나누고 화면에서 둘 다 "시간"이라 부르면 운영자·학부모·기사가 서로 다른 값을 같은 것으로 오해한다. 라벨 규칙: 학부모 입력 폼은 `희망 시간` + helper `참고용입니다. 실제 탑승시간은 배차 확정 후 안내됩니다.`, 관리자 편성 화면은 `희망 09:10 (참고)` / 입력칸은 `확정 시간`, 학부모 마이페이지·기사 앱은 `확정 시간`. `pickupTime` 값은 `"오전 9:10"`, `"9:30"`, `"오전 12:00"`(오입력)처럼 형식이 제각각이고 실측 20건 중 13건이 NULL이므로 **파싱해서 계산에 쓰지 말고 그대로 노출만** 한다(`preferredTimeLabel`).
- **참조횟수**: 0

### [2026-07-26] 셔틀 대상자 조회는 공용 상수·공용 SQL 조각을 쓴다
- **분류**: convention
- **발견자**: developer
- **내용**: 같은 "태울 학생 명단"을 세 화면이 각자 조회하면서 제외 조건이 전부 달랐다(실측: 노선 화면은 셔틀·신청서·수강항목 3단계만, 통합 명단은 `WHERE` 절 자체가 없음, 자동 배차는 명단을 그대로 받아 오염 전파). 같은 실수가 세 번 반복됐으므로 기준값과 SQL 조각을 `src/lib/seasonal/shuttleEligibility.ts` 한 곳에만 둔다. 제공 항목: `CLOSED_SHUTTLE_STATUSES`(=`["CANCELLED","REJECTED"]`, 셔틀신청·신청서·수강항목 공통), `CANCELLED_OFFERING_STATUS`, `isRidingShuttleStatus(status)`, `seasonalShuttleEligibilitySql({application,item,offering})`. **화면 파일에 `["CANCELLED","REJECTED"]`를 다시 적지 않는다.** 반드시 함께 지킬 것 3가지 — (1) 개설 취소된 반(`o.status <> 'CANCELLED'`)까지 걸러야 한다. 취소 반 학생이 마침 신청서도 취소라서 우연히 걸러지던 것을 필터가 있는 것으로 착각하기 쉽다. (2) 탑승 판정은 `status !== 'CANCELLED'`가 아니라 목록 기반이어야 한다 — `REJECTED`가 탑승으로 새어 자동 배차에 실린다. (3) `it`·`o`가 LEFT JOIN이면 `IS NULL OR` 가드를 반드시 함께 건다. 한편 셔틀 상태(`r.status`)는 **SQL에서 거르지 않는다** — 미탑승 행을 지우면 "역시 태워주세요" 연락이 왔을 때 되돌릴 UI가 사라진다. 화면 토글(기본 숨김)로 처리하고, 기사님용 CSV에는 탑승자만 담는다. 회귀 테스트: `tests/seasonal-shuttle-roster-filter.test.mjs`, `tests/shuttle-unassigned-cancelled-filter.test.mjs`.
- **참조횟수**: 0

### [2026-08-27] 일8 대표팀 정규 셔틀비 전액 면제
- **분류**: convention
- **발견자**: developer
- **내용**: 정규반 월 청구에서 청구 대상 상태의 `Sun-8` 슬롯을 하나라도 수강하면, 다른 평일 수업에서 셔틀을 이용하더라도 그 학생의 월 정규 셔틀비 전체를 0원으로 계산한다. 휴원·퇴원·이월인 `Sun-8` 행은 면제 근거로 사용하지 않는다. 판정은 시트 표시 문자열이 아니라 `extractSlotKeys`가 만든 정규 슬롯 키로 수행한다.
- **참조횟수**: 0

### [2026-09-02] 정규 무료셔틀은 시트 구분값으로 청구에서 제외
- **분류**: convention
- **발견자**: developer
- **내용**: `1호점 앞 버스정류장` 승차 학생은 정규 셔틀 명단에는 포함하지만 셔틀비를 받지 않는다. 장소 문자열만으로 자동 면제하면 오래된 차량표나 `미탑승` 행까지 잘못 면제할 수 있으므로, 차량표·수강 요일·시트가 직접 일치한 학생만 `셔틀비 구분=무료셔틀(1호점 앞 버스정류장)`으로 확정한다. 청구 계산은 이 명시적 구분값 또는 기존 `Sun-8` 면제 규칙을 사용한다. 세 시스템이 충돌하는 학생은 임의 변경하지 않고 확인보류한다.
- **참조횟수**: 0

### [2026-08-27] 월 청구 알림은 승인 후 필수 후속 단계로 관리한다
- **분류**: convention
- **발견자**: developer
- **내용**: 청구서 생성과 학부모 알림 발송은 계속 별도 승인 단계로 유지한다. 다만 사용자가 발송 미리보기를 승인한 실행에서는 0원 청구서와 운영 변경 원장에서 명시적으로 확인보류(`OperationsCommand.status='HELD'` 및 `notificationStatus='HELD'`)된 건만 제외하고 나머지 청구서 링크를 반드시 발송한다. 새 요청의 `notificationStatus` 기본값도 `HELD`이므로 이 값만 단독으로 사용하면 정상 요청까지 막히는 점에 주의한다.
- **참조횟수**: 0

## 검증 원칙
- 사이트에서 수강 상태를 바꿀 때는 `Enrollment` 변경과 `OperationsRequest/Command/SyncAttempt` 원장 적재를 같은 트랜잭션으로 처리한다. 같은 상태 재저장은 DB 시간도 바꾸지 않으며, 실제 DELETE 대신 `WITHDRAWN`으로 이력을 보존한다.
- 소규모 변경은 `tsc --noEmit` 통과를 기본 검증으로 삼는다.
- 기능 변경은 필요한 경우 화면 확인과 관련 테스트를 추가한다.
- 개발 서버 재시작 시 전체 `node.exe` 종료 금지, 포트 기준으로 해당 프로세스만 종료한다.
- 교사용 모바일 다이얼로그는 `useStaffDialog`로 Escape 닫기, 포커스 고정·복원, 중첩 카운터 기반 body 스크롤 잠금을 함께 적용한다. 큰 바텀시트는 실제 열릴 때 동적 로딩한다.
# 2026-10-19: 학원 업무 UI 공통 기준
- 4역할 학원 화면은 `AcademyTheme` 안에서 `--color-academy-*`와 `academy-hero/panel/button-*`를 사용한다. 임의 하드코딩 색상과 예시 운영 데이터를 제품에 넣지 않는다.
- 라이트 라벤더 기본을 유지하고 빨강/노랑/초록은 업무 상태에 사용한다. 브랜드 로고에는 필터·재색칠을 적용하지 않고 원본 비율을 보존한다.
- 테마 검증은 실제 Tailwind+React에 저장된 다크/시스템 선택, 공개 화면 복귀, 320px와 큰 글씨를 함께 확인한다. 가로 넘침뿐 아니라 한 글자씩 줄바꿈되는 읽기 문제도 확인한다.

## 같은 계정의 화면 전환
- 관리자·선생님·학부모 보기는 공통 서버 자격과 AccountViewSwitcher를 사용한다. 화면 전환을 User.role 변경이나 사용자 입력 metadata의 권한으로 취급하지 않는다.
- 자녀 자격은 직접 인증 연결과 본인 parentId로 확인한다. 메뉴 표시가 실제 화면/API 가드를 대신하지 않는다. 클라이언트에 계정·자녀 ID를 자격 목록으로 노출하지 않는다.
- 수업 화면을 떠날 때 기존 저장 확인을 유지하며 설치 앱 범위를 넘으면 브라우저 이동을 안내한다. 전환 버튼은 기존 자리에서 교체해 중복 버튼과 추가 행을 만들지 않는다.
