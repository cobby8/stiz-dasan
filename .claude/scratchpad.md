# 작업 스크래치패드

## 현재 작업
- **상태(2026-10-05)**: Phase 2-A 자동화 배포(보강권 버그·특강 자동 퇴원·휴원/퇴원 예약 자동 적용). 랠리즈 10월 청구 정리·오래된 미납 94건 납부 처리 완료.
- **미푸시 커밋 0개** — main 29080efa 배포.
- **현재 담당**: pm
- **마지막 세션**: 2026-10-05
- **테스트 기준선 갱신(2026-10-05)**: **1813건 중 실패 1건**(`.claude/worktrees/` 옛 사본 때문 — pos 매칭 로직 단일성 테스트, 배포 무관)

## UI 전수 점검 — 남은 일 (다음 세션 이어서)
조사 보고서 6종은 세션 임시 폴더에 있어 **사라질 수 있음**. 핵심만 여기 옮겨 둔다.

- **기능/UI 제거 — 주요 항목은 처리 완료**(2026-08-06). 남은 것:
  · `상태 직접 변경` 셀렉트(4버튼과 중복이나 **PENDING 되돌리기는 셀렉트에만 있음** — 제거 시 기능 손실. 되돌리기를 쓰는지 확인 필요)
  · 이관 화면의 CSV 붙여넣기 경로(구글시트 직접 가져오기가 상위호환인 레거시 이중 경로)
  · 공지 → 소셜 발행의 "페이스북 광고 소재" 섹션(광고를 실제로 집행하는지)
  · 갤러리 "인스타 가져오기"(등록 경로가 3중)
  · 설정 화면 `AppliesTo` 파란 뱃지 9곳(실무에 쓰이는지 시각 소음인지)
  · 시설 사진·프로그램 이미지의 URL 수기 입력(다른 이미지는 전부 파일 업로드인데 여기만 URL)
- ✅ (해소 2026-10-02) 정규 셔틀 시트 방식 → 「셔틀 명단」 탭에서 앱이 RegularShuttleStop 을 직접 편집. 기사 화면·결석 매칭은 같은 테이블을 그대로 읽는다. 시트 가져오기 API 는 410 으로 종료.
- 리포트 편집 화면 vs `SessionLogModal` — 같은 Session 레코드를 편집하는 화면이 둘(확인 필요)
- **남은 판단거리 (작은 것)**
  · 설정 화면 "외부 신청 링크"(구글폼 주소) 칸이 이제 공개 사이트에 무영향 — 칸 제거 or 점검 항목 정리
  · `lib/siteOpsBot.ts` 의 체험/수강 신청 점검이 항상 ok 가 됨 — 단순화 or 삭제
  · 스킬 "평가자" 자유 입력 → 로그인 사용자 자동 기입(서버 `skills/page.tsx` 2줄 + prop 1개 필요)
- **테스트가 문구·코드 존재를 단정해 못 건드린 것** (지우려면 테스트 동반 수정 필요):
  · ~~`ShuttleRouteAdminClient.tsx`~~ — 2026-10-02 3단계 정리에서 삭제, 그 화면을 읽던 tests 7개는 서버·API 단정만 남김
  · 신청관리 문구 2건, 방학특강 문구 2건
- ⚠️ **다중 에이전트 동시 작업 중 `git stash` 금지.** 이번에 한 에이전트가 baseline 측정용으로 실행해 다른 4개의 미저장 변경 46파일을 함께 치웠고 pop이 충돌했다. baseline이 필요하면 `git show HEAD:<파일>`로 개별 조회할 것.

## ⚠️ 배포 메커니즘(중요)
- Vercel 빌드는 `prisma generate && next build`뿐 — **`migrate deploy` 자동 실행 안 됨**. 스키마 변경은 **멱등 SQL을 운영 Supabase(ref gpjdtkumqxzfgkixjamp)에 직접 적용**(Supabase MCP apply_migration). 마이그레이션 폴더는 기록용.
- 운영 배포 = `git push origin HEAD:main` fast-forward.
- 테스트는 `node --test tests/*.test.mjs` **+ 가드 `node --experimental-strip-types --test src/lib/*.test.ts`**(=`npm test`). ⚠️ 2026-10-25 실측: `tests/` 만 돌려 **학생 병합 필터 가드(src/lib/studentVisibility.test.ts)를 놓쳤다** — 회원 탈퇴 배포 후 release:preflight 가 실패하던 상태였다. **`npx vitest`는 이 프로젝트에 없음**(설정도 없어 worktree까지 긁어 전부 오탐).
- 현재 테스트 기준선: **858건 중 실패 9건**(체험신청 폼·셔틀 좌석/주소·청구 안내 등 기존 실패). 신규 실패 판정은 이 집합과 비교할 것.

## 진행 현황
| 항목 | 상태 |
|------|------|
| 관리자·선생님 UI 전수조사(6영역 병렬) | 완료 — 문구 140·기능 46·보존 144·확인필요 61 |
| 선생님 화면 문구 정리 + 설치배너 제거 | 완료·커밋 |
| 관리자 문구 106건 정리 | 완료·커밋 |
| 도달 불가 라우트·미사용 심볼 제거 | 완료·커밋 |
| 수강신청 "수정" 버튼 복구(진입점 유실) | 완료·커밋 |
| 원생목록 7월 하드코딩 수정 | 완료·커밋 |
| 보강 잔여석 실제 계산 + 정원 초과 차단 | 완료·커밋 |
| 수업 리포트 사진 깨짐 수정 | 완료·커밋 |
| UI 기능/UI 제거 46건 | 대기(원장 확인 필요 항목 다수) |
| 셔틀 확정 명단 4~5단계(변동 감지·재발 방지 가드) | 대기 |
| 4b 시즌 격리 / 4c 추가 확정 / 4d 변동 배지 | 대기 |
| 정규반 형제할인 자동화 | 대기(시트 수동 10% 이중적용 위험 확인 필요) |
| 미푸시 커밋 | **13개** |

## 미해결 리뷰 수정 사항 (이월)
| 번호 | 파일 | 심각도 | 내용 |
|------|------|--------|------|
| R-1 | api/admin/trial-count/route.ts | 필수 | 인증 가드 추가 |
| R-2 | actions/public.ts | 권장 | source/referralSource 서버 화이트리스트 검증 |
| R-3 | actions/public.ts:353 | 권장 | shuttleNeeded: `\|\|` → `??` 변경 |
| R-7② | lib/seasonal/shuttleRoster.ts:166~176 | 권장 | 다음 시즌 신청자가 목록·확정 버튼에서 사라짐(시즌 스코프 전체 합산) |
| R-8② | admin/seasonal/shuttle/ShuttleRosterClient.tsx | 권장 | 제외 되돌리기가 세션 한정(새로고침 시 복구 UI 소멸) |
| M-1 | actions/admin.ts `bookMakeupSession` | 참고 | 정원 검증이 "조회 후 INSERT"라 극단적 동시 요청에선 이론상 1건 초과 가능(DB 제약 아님) |

---

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-05 | developer(claude/enroll-shuttle-place-name): 수강신청 셔틀 「타는 곳/내리는 곳 이름」 — 지도 핀 뒤 주소 자동 채움 제거(장소명만 미리 채움), 이름 비었거나 주소와 같으면 화면·서버 모두 거절(순수 규칙 lib/enrollment/shuttle-place-name.ts), 이전 신청의 주소=이름은 빈칸, 저장 라벨은 학부모 입력 우선. tsc 0, 신청·셔틀 테스트 534 통과(새 6건 포함) | 검수 대기 |
| 11-05 | developer(claude/tenure-uniform-free, 미커밋): ① 총 재원기간 — Student.tenure* 3칸 + 순수 계산 student-tenure.ts(기준월 뒤 사이트 수강 달만 더함) + 조회 student-tenure-query.ts(실패 시 null) → 학생 상세 기본정보 한 줄. ② 3년 재원 유니폼 무료 링크 — UniformFreeGrant 표(마이그레이션 20261105120000), /apply/uniform/free/[token](noindex), 신청은 FOR UPDATE 잠금·NEEDS_REVIEW 저장(본사 자동발송 없음, 원장 «재전송»), 관리자 «무료 증정» 배지. tsc 0, 새 테스트 22건 통과, 전체 2936 중 실패 3 = 기존 건(A-15·P-11·관리자 오류원문 StudentDetailClient:1292) | 검수 대기 |
| 11-05 | tester: 기사님 새 학생 배정 + 셔틀 진행 상태 전환(미커밋분) 검증 — tsc 0, 셔틀 .ts 113-0, 관련 .mjs 636 중 633(실패 3 = 유니폼 기존 건), npm test 2914 중 2911(같은 3건, 새 실패 0). 실례 7건(최윤호·박윤우×2·김태은·김현호·박보겸 4칸·이성빈 2칸) 기대값 일치, POST 거절 403/404/404/409 테스트로 확인. 참고: 학생 id 없는 이름+전화 행은 진행 상태=배차 대기·기사님 목록=빠짐으로 갈림 | 통과 |
| 11-05 | developer: 기사님 「새 학생 배정」(/staff/shuttle/assign) — 승인 셔틀 신청+ACTIVE 수강의 남은 칸(요일×등·하원)을 한 칸씩 명단에 넣기. driverAssign(Logic).ts·API(GET/POST, DB 역할 재확인·자격 재검사·잠금 안 guard)·화면, addRosterStudent 본문을 addRosterStudentAs 로 분리(감사 via=DRIVER_ASSIGN). tsc 통과·테스트 15건+관련 110건 통과 | 검수 대기 |
| 11-05 | developer: 셔틀 진행 상태 「명단=기사님 화면」 기준 전환 — 저장노선 0건 칸 ASSIGNED(배차 완료)·전부 휴원 PAUSED, 반=학생 현재 수강, 시작시각 대조, 좌표 차이 분기 삭제, 명단 완비 시 위치 미요구. shuttle-progress(.ts/-query.ts)·EnrollmentShuttleProgressView·ApplyAdminClient 필터·테스트 45건. tsc 통과 | 구현 완료(미커밋) |
| 10-30 | reviewer: 목록 개편 출결·리포트·반 관리(694c42ad·3785e20e·4b462753) 검수 — 통과(필수 수정 없음). API/액션 인자 동일, dirty 저장 후 해제, 날짜 묶음 KST 경계 실행 확인(UTC 환경), 테스트 28-0·tsc 0. 권장: 출결 학생 조회 늦은 응답 무시·필터 중 빈 문구 | 통과 |
| 2026-10-30 | **목록 개편 3단계(developer, claude/list-redesign-p3)** — 청구·수납 목록(FinanceClient.tsx 만): 표 `admin-list-table`(글자 왼쪽·금액/납부기한/납부일 `admin-cell-num`), 원생 아래 반·유형 아래 수단/승인번호/영수증·상태 아래 알림을 칸 분리/패널로(칸: 선택·원생·반md·유형·금액·납부기한·납부일md·수단lg·상태·관리). 상태 칩 5종(paymentStatusFilter 공유·재클릭 ""=초기화와 같음), select 옛 `CANCELLED`(실제 값 CANCELED 와 불일치해 0건) 교정+미납/연체/환불 항목 추가. «목록·상태별» 전환(머리줄 건수+합계, 금액 더하기만). 행 클릭 ListDetailPanel(설명·청구번호·승인번호·영수증 등 전체, 작업 버튼=buildRowActions 같은 목록·같은 권한). 행 작업 배열은 함수로 옮김(내용 동일). 가드 테스트 1건. tsc 0·eslint 0·테스트 2544-0 | 검수 대기 |
| 10-30 | reviewer: 원생 관리 목록 개편 2단계(360694c7) 검수 — 승인(필수 수정 없음·tsc/목록 테스트 통과) | 통과 |
| 2026-10-30 | **목록 개편 2단계(developer, claude/list-redesign-p2)** — 원생 관리: 표 `admin-list-table`(글자 왼쪽·관리 가운데), 상단 상태 숫자→StatusCountChips(filterStatus 공유·켜진 칩 재클릭=기본값 ACTIVE=초기화와 같은 상수 DEFAULT_STATUS_FILTER), 보기 전환→ListViewToggle+useRememberedListView(기존 키 유지), 행·반별 카드 행 클릭→ListDetailPanel(요약+상세 페이지 열기·수강등록·수정), 이름 링크·⚡ 전파 차단, 활성인데 반 없으면 «반 없음»(warning-soft), 반별 카드 truncate 제거. 신청 목록 «체험 연결» sm 미만 아이콘만. 가드 테스트 2건 추가. tsc 0·eslint 0·테스트 2543-0 | 검수 대기 |
| 2026-10-30 | **목록 개편 1단계(developer, claude/list-redesign-p1)** — 공용 부품 `src/components/admin/list/`(ListDetailPanel=AdminModal layout="side" 래퍼·StatusCountChips·ListViewToggle+useRememberedListView) + globals.css opt-in `admin-list-table`(글자 왼쪽·`admin-cell-num` 오른쪽+tabular-nums·table-layout auto·nowrap). 수강신청 목록 칸 분리(상태|학생|학년(만나이)|학교md|보호자lg|연락처md|접수일|희망 수업 «화4»|수강 시작월lg|셔틀md «이용/미이용»|빠른 처리)·체험후보 [체험 연결] 같은 줄로. 체험 목록 정렬·truncate 제거·담당교사/학교 md 이상. 두 화면 상태 칩(filter 공유)·«목록|상태별» 묶음(rowgroup 머리줄). 상세 모달 2개 껍데기만 패널로(+상단 닫기). 옛 UI 문자열 테스트 5단언 교정 + tests/admin-list-standard.test.mjs(6) 신설. tsc 0·eslint 신규 0·테스트 2541-0 | 검수 대기 |
| 2026-10-25 | **남은 과제 정리** — 셔틀 API 로그인·직원 확인 실패를 500→401(앞단 문지기가 비로그인은 307로 먼저 막음, 401은 로그인한 비직원). 직원 역할 승인·반려·회수 시 신청자에게 앱 알림+푸시(받는 사람은 UPDATE RETURNING). src/lib 기존 실패 4건은 **코드 아닌 낡은 테스트**(7-27 좌석 기준 명단 전환 미반영) → 교정. 이성빈: 10-23 수강신청서로 셔틀 신청, 승인 때 위치 저장, **노선 미배정**. 검수 통과, 테스트 2467-0 | 완료·배포 974f46f |
