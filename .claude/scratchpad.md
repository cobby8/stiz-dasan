# 작업 스크래치패드

## 현재 작업
-| 11-08 | developer(claude/pos-auto-charge, 6c109f11·ca24cf4f·30a22721·65edfb4e): ① 현장 결제 매칭 = 방식 무관 APPROVED 전부(extractChargePayments, 알림 범위는 그대로)·분할 결제 합계/면세 합계 판정(진행 중 부족=SKIP+알림 미룸, 완료 후 부족=HOLD), 대표 결제만 유일 칸·나머지 note+감사 기록 POS_CHARGE_PAYMENTS, 같은 주문 다른 요청 PAID 면 선점 차단, Payment.method 실제 방식(CARD·CASH·EASY_PAY·BANK_TRANSFER·ETC·«CARD+CASH»)·수납 «현장 · 카드+현금», 월 대사도 현장 결제 주문은 방식 무관+분할 합계 매칭 ② 현장 결제·POS DM «랠리즈에 처리» 안내 제거 ③ 수납 납부일 하루 전 표시(toISOString→toKstYmd, page 이번 달 todayKst, R1 빚 22→21) ④ 결제 후 목록 미갱신(fetch no-store + 요청 PAID·청구서 미납 2분 이내는 창에 «기다리는 중»). tsc 0·npm test 3137-0. 건의: 웹훅 4초 타임아웃 뒤 함수 동결 시 «요청 PAID·청구서 미납» 잔존 가능(ALREADY_DONE 이 원장부를 다시 안 봄) | 검수 대기 |
 **상태(2026-10-05)**: Phase 2-A 자동화 배포(보강권 버그·특강 자동 퇴원·휴원/퇴원 예약 자동 적용). 랠리즈 10월 청구 정리·오래된 미납 94건 납부 처리 완료.
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
| 11-09 | developer(색상 통합·마무리): 6브랜치 합침(충돌 = 기준선 json·scratchpad·차트 3파일 — 차트 색은 chartColors 하나로), 노쇼 위험·결제요청 확인 중 정보·등록전환 정상, faint/line-input 대비 올림(+테스트 2쌍), 남은 관리자 5파일 103→0, 기준선 12,341→1,730. tsc 0·tests 3629-0·lib 164-0 | 완료 |
| 관리자·선생님 UI 전수조사(6영역 병렬) | 완료 — 문구 140·기능 46·보존 144·확인필요 61 |
| 선생님 화면 문구 정리 + 설치배너 제거 | 완료·커밋 |
| 관리자 문구 106건 정리 | 완료·커밋 |
| 도달 불가 라우트·미사용 심볼 제거 | 완료·커밋 |
| 수강신청 "수정" 버튼 복구(진입점 유실) | 완료·커밋 |
| 원생목록 7월 하드코딩 수정 | 완료·커밋 |
| 보강 잔여석 실제 계산 + 정원 초과 차단 | 완료·커밋 |
| 수업 리포트 사진 깨짐 수정 | 완료·커밋 |
| UI 기능/UI 제거 46건 | 대기(원장 확인 필요 항목 다수) |

## 미해결 리뷰 수정 사항 (이월)
| 번호 | 파일 | 심각도 | 내용 |
|------|------|--------|------|
| R-1 | api/admin/trial-count/route.ts | 필수 | 인증 가드 추가 |
| R-2 | actions/public.ts | 권장 | source/referralSource 서버 화이트리스트 검증 |
| R-3 | actions/public.ts:353 | 권장 | shuttleNeeded: `\|\|` → `??` 변경 |
| R-7② | lib/seasonal/shuttleRoster.ts:166~176 | 권장 | 다음 시즌 신청자가 목록·확정 버튼에서 사라짐(시즌 스코프 전체 합산) |
| R-8② | admin/seasonal/shuttle/ShuttleRosterClient.tsx | 권장 | 제외 되돌리기가 세션 한정(새로고침 시 복구 UI 소멸) |
| M-1 | actions/admin.ts `bookMakeupSession` | 참고 | 정원 검증이 "조회 후 INSERT"라 극단적 동시 요청에선 이론상 1건 초과 가능(DB 제약 아님) |
| P-1 | lib/pos/chargeRequestService.ts writeLedgerPaid·settleCancelForRow | 권장 | 납부 기록(markPaymentPaid 무조건 UPDATE) 직전에 POS 취소 웹훅이 끼면 요청 DONE·청구 PENDING→뒤이어 PAID 로 덮임(사이트 납부완료·실제는 취소). 기록 뒤 cancelState 재확인 → DONE 이면 refundPaidPaymentInTx, 또는 settle 에서 refunded=false·청구 미납이면 retryLater |
| P-2 | admin/finance/FinanceClient.tsx:955 «환불» | 권장 | TOSS_POS 건에도 그대로 → POS 는 안 취소되고 사이트만 REFUNDED. TOSS_POS 면 숨기거나 확인창에 «POS 결제는 취소되지 않음, 결제 취소를 쓰세요» 경고 |


- ⚠️ (11-08 POS 결제 취소 리뷰) 마이그레이션은 build 에 migrate deploy 가 없어 **배포 전 apply_migration 필수**(안 하면 현장 결제 전체 정지).

### 수정 요청 (tester · 11-09 재검수 8144e6c7 + e2b02a6d — 결과는 작업 로그)
| 요청자 | 파일 | 문제 | 상태 |
|------|------|------|------|
| tester | lib/enrollment/admin-change-request.ts NEEDS_CHECK_SQL | 반 이동 뒤 새 반 수강을 삭제하면 그 CLASS_ADD(이동 신청에 afterJson.enrollmentChangeRequestId 로 연결)의 RALLYZ 칸이 SKIPPED 가 되는데, NEEDS_CHECK 는 RALLYZ 를 `<> 'SUCCEEDED'` 로 세어 이동 신청이 «확인 필요»에 영구히 남음. 직원이 지우려면 «랠리즈 반영 확인»을 거짓으로 눌러야 함. 삭제 사유로 닫힌 명령(holdReason=DELETED_ENROLLMENT_CLOSE_REASON) 제외 등 | 대기(권장) |

---

## 구현 기록 (developer) — 색상 정리 1~3단계 (11-09 원장 결정: 주 버튼 검정·역할 공통·바탕 #f6f7f9·체험 신청만 주황·다크 나중)
| 단계·커밋 | 파일 | 변경 |
|---|---|---|
| 1 629d3355 | academy-theme.css · globals.css · public-sport.css · DriverWorkspace.module.css · tests/parent-child-links-ui | 토큰 값만(이름 유지). 상태색 :root(info·neutral 신설), 글자 3단계·입력선 #8a919c·faint 신설, 차콜 단계=회색 토큰, 홈페이지 주 버튼 검정·«체험 신청» 입구 주황(주소 선택자), 기사님 보라·파랑→중립·정보 |
| 2 a7ed1234 | tests/color-contrast · color-hardcode-guard · fixtures/color-hardcode-baseline.json | 대비(글자 4.5·선 3) + 하드코딩 색 파일별 기준선(늘면 실패, UPDATE_COLOR_BASELINE=1 로 낮춤) |
| 3 | src/lib/ui/statusTones.ts(신규) · StatusBadge · ui/Badge · StatusChoiceButton · academy-theme.css(보조 버튼·칩 입력선, academy-status 4px, academy-input 신설) · 상태 지도 16파일 · tests 7 | 상태→뜻 지도 한 곳(출결·결제·셔틀·신청), 배지 모서리 4px, 화면별 색 지도 → statusTones |
| 5 | staff/** 15 · driver 1 · components/shuttle 6(RunBoard·UnifiedDriverClient·DriverDateNav·RegularRouteSection·DriverRequestModal·UnifiedDriverRunPage) · components/staff 4 · DriverWorkspace.module.css · academy-theme.css · 기준선 | 선생님·기사님 하드코딩 색 630건 → 토큰·statusTones(dark: 삭제 포함). 등원·하원 색 구분 제거(글자·화살표), 순번·시각·제목 글자 주 색 → ink, 편집 중 정류장=정보, 보강·특강=정보, 기한 지난 미납=위험(리뷰 지적 1)·«미납 N건» 4px 배지(지적 2). academy-theme 의 `.academy-driver-stop:not(.bg-amber-50)…`·`.academy-driver-rider:not(.bg-red-50)` 덮어쓰기 삭제(결석 신고 승객 칸 연빨강이 원래 의도대로 보임). 관리자 전용 RegularStopGeocodePanel·ShuttleGeoEditor 는 미변경 |
| 통합·마무리 | 6브랜치 merge(1~3→4→5→6A→6B→7) · statusTones(NO_SHOW danger) · 결제요청 확인 중 info · 통계 등록전환 success · faint #636a75·line-input #848b96 · 남은 관리자 5파일 | 차트 색 두 벌(chartColors·colorValues) → chartColors 하나. 기준선 = 실제 값 91파일 1,730(관리자·학부모 0). 전후 PNG = 세션 scratchpad color-final\ |

💡 tester: tests 3629-0·tsc 0·studentVisibility 5-0. 전후 PNG = 세션 scratchpad color-before-after/before.png·after.png. 결제 화면은 상태 글자 색만(판정 무변경).
⚠️ reviewer: 입력선 #8a919c 는 연회색 바탕 위 2.96(카드 위는 3.2) — 값은 결정대로 두고 테스트에 기록. .academy-app 안 blue→ink 바꿔 끼우기는 그대로(마지막 단계). @theme brand-orange(«절대 변경 금지» 주석)·다크모드 값 무수정.

### 리뷰 결과 (reviewer · 색상 4~7·6A·6B·마무리, 99710062..4cde00e5)
📊 종합 판정: 수정 필요(필수 1건 — 고치면 통과). tsc 0 · tests 3629-0 · 기준선 1,730 = 실제 1,730(높게 남은 파일 0)
✅ 잘된 점: 색 외 변경 35파일 전부 의도된 것(차트 chartColors·OG/theme-color colorValues·지도 getComputedStyle(info 는 :root)·statusTones import·주석). 결제·청구·출결·셔틀·/programs 로직·금액·문구·URL 변경 0, payments/review 미변경. 공개 화면 dark: 개수 그대로, .academy-app 밖에 전용 토큰 새로 쓴 곳 0
🔴 필수 수정:
- components/seasonal/RouteSection.tsx:695·698·699·759 — 치환 때 `dark:…${tlBtn}` / `dark:…${timeOrdered ? …}` 의 `${` 까지 지워짐(813909ac). 695/698/699: 클래스 끝이 `disabled:opacity-50}` 가 되어 비활성 흐림·시간순 보기 min-h-11(터치 44px) 사라짐 → `disabled:opacity-50${tlBtn}` 로. 759: `${timeOrdered` 가 빠져 `? " w-full bg-white" : ""}` 가 글자 그대로 클래스가 됨(항상 w-full, 시간순 bg-white 없음) → `` border-[var(--color-academy-line)]${timeOrdered ? " w-full bg-white" : ""}` `` 로. 같은 유형 다른 파일 0(파일별 `${` 개수 비교)
🟡 권장: DispatchRouteMap.tsx:40 getComputedStyle 값이 빈 문자열일 때 대비 `|| "#1d4ed8"` 기본값 / RegularRouteSection 화살표 칸 `${"…"}` 은 상수 문자열로 단순화(동작 무관)

## 구현 기록 (developer) — 신청함 5·6단계 학부모 «수업» 탭 (11-10)
📝 탭 홈·수업·청구·소식(d5) · /mypage/classes 아이 칩→반 카드→신청 내역 타임라인(3개월)→하단 시트 · d8 취소 요청 · queries.ts KST
| 파일 | 변경 |
|---|---|
| src/app/mypage/classes/{page,ClassesClient,RequestTimeline}.tsx | 신규 — 반 카드·타임라인·시트([취소]/[취소 요청]/신청 화면) |
| src/lib/parent/{classCards,classes-overview}.ts · lib/mypage/requestPreset.ts | 신규 — 순수 계산 / 조회(childAccessSql+notMergedStudent) / ?studentId=&enrollmentId=&kind= 미리 고르기 |
| src/lib/requests/{parent-timeline-rules,parent-timeline}.ts | 신규 — 단계·버튼 규칙(catalog 이름 그대로) / 7종류 조회 |
| MyPageBottomNav·ParentMoreMenu·layout | 수업 탭(also: history·결석·보강·특강·셔틀·수강 변경), ⋯ 메뉴 수강 변경 제거 |
| enrollment-change·regular-absence·makeup·shuttle page+Client | 프리셋 받기(힌트만 — 목록은 서버가 거른 내 자녀) |
| parent-change-request.ts | 이력 includeOpen/withCancelRequest 옵션, requestScheduledChangeCancel(d8) |
| admin-change-request.ts·actions/enrollment-changes.ts·admin/enrollment-changes | 취소 요청 목록·승인(적용 전만 CANCELED)/거절, 화면 맨 위 «학부모 취소 요청 N건» |
| change-decision-notify.ts·parentChangeStatus.ts | CANCEL_APPROVED/REJECTED 앱 알림(받는 사람 = 취소 요청 보호자) |
| prisma/migrations/20261110130000_enrollment_change_cancel_request + schema.prisma | **운영 미적용** — 칸 5개+CHECK+부분 인덱스, 코드보다 먼저 apply_migration |
| queries.ts·kst.ts | getMonthDateRange·getDashboardExtendedStats → addMonthsYm(신규, 테스트) |
💡 tester: tests/parent-classes-tab·parent-request-timeline·enrollment-cancel-request·kst-datetime. 마이그레이션 전엔 관리자 취소 요청 목록 빈 목록·타임라인 칸 없이 재조회(화면은 열림). PNG: scratchpad\classes-tab\{before,after,after-sheet}-{390,1366}.png
⚠️ reviewer: d8 승인 UPDATE 조건(APPROVED·appliedAt NULL·effectiveFrom>KST 오늘·적용 명령 없음) vs 적용 크론(APPROVED FOR UPDATE) 경합, 방학특강 표는 전환된 studentId 만 자녀 권한으로 읽음(전화번호 매칭 아님 — 미전환 자녀 신청은 타임라인에 안 보임)

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-10 | developer(신청함 5·6단계 수업 탭): 탭 홈·수업·청구·소식 · 반 카드(상태 칩=buildClassStatusLine·다음 수업·출결 4칸·셔틀·버튼 프리셋) · 신청 내역 타임라인 7종류+하단 시트 · d8 취소 요청(대상 신청 칸 5개, 마이그레이션 20261110130000 운영 미적용) · queries.ts KST 2곳. tsc 0·전체 fail 0 | 구현·검증 완료(검수 대기, 미푸시) |
| 11-10 | developer(신청함 1단계 급한 불): 홈 반 상태 한 줄(휴원 예정·검토 중·휴원 중, getParentClassStatusLines) · 수강 변경 화면 «지난 결과» 3개월(거절 사유) · 결정/적용 시 신청 학부모 앱 알림(HELD 해제, change-decision-notify·EXTERNAL 장부·중복 키) · getMyPageData 이번 달 KST. 새 순수 모듈 parentChangeStatus.ts(다음 단계 수업 탭 재사용) | 구현·검증 완료(검수 대기) |
| 11-10 | developer(원장 점검: 정규 셔틀 운행표 묶음별 연필): 화면 위 [수정] 제거 → 묶음 머리 오른쪽 연필(36px 원·44px 터치, «16:00 등원 묶음 수정») · 누른 묶음만 편집 · 그 머리 줄 [취소][저장]+아래 한 줄 적용 범위(sticky) · 다른 묶음 연필 시 미저장 확인. RunBoard editingGroupKey/onEditBlock/renderEditActions/renderEditBar(기사님 미전달=변경 없음). tsc 0·tests 3765-0·shuttle 159-0·끌기 e2e 전부 통과 | 완료(커밋, 미푸시) |
| 11-10 | debugger(원장 «김루빈 휴원 신청했는데 복귀 버튼 안 보여»): 코드 결함 없음. 운영 pg_stat_statements(읽기 전용) 시각표 — 11-09 20:19 KST 화면 3회·20:20 신청 2회 서버 도착(본인 자녀 확인 2/2 통과) 뒤 중복 확인·INSERT 0회 = 입력 검사 400(휴원에서 가능한 건 복귀 예정일 ≤ 12-01 뿐). 당시 옛 화면은 오류가 맨 위라 원장은 접수된 줄 앎(20:38 수정 전). 11-10 00:36 화면 1회 = 신청 0건이라 검토 중 상자 없음, 다니는 반이라 «복귀» 없음(설계: 복귀는 휴원 시작 뒤). 학부모 계정이 저장한 신청은 운영 전체 0건(86건 전부 관리자). 재현 테스트 1건 추가(한 학생 두 반). tsc 0·전체 3765-0·studentVisibility 5-0. 앱 코드 무변경 | 완료(제안 3건 승인 대기) |
| 11-09 | developer(PM 결정 3건, 색상 3차 후속): 셔틀 명단 «확정하기»=주 버튼(검정) · 상태 버튼 위험 채움(StatusChoiceButton·TONE_SOLID_CLASS)=danger-fill+hover · 선생님 학생 시트·반 학생 시트 «학부모 전화»=보조 버튼. tsc 0·tests 3734-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(원장 «색 더 정리» 3차): 묶음 버튼 고른 칸=옅은 상태 바탕+진한 글자+안쪽 링(statusTones TONE_SELECTED_CLASS 신설, 학생 상세 수강 상태·결제 상태) · 전화 버튼 보조로 통일(학생 상세 머리·셔틀 명단 펼침·셔틀 학생 상세창·학부모 기사님 전화) · 명단 «확정하기»·«좌표 설정으로 이동»·«반 이동» 주황 채움→warning-soft+테두리 · «안전 복구»=인증 계정 삭제라 danger-fill 유지 · 기사님 결석 꼬리표 danger-fill. tsc 0·tests 3734-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(원장 «빨강 애매·퀵버튼 보기 싫다» 색상 2차): 위험색 역할 분리(danger-fill #dc2626·hover #b91c1c·line #fecaca, 글자 #b91c1c 유지) · ⚡ 버튼 중립(흰+입력선+검정 아이콘, 열림=옅은 주 색) · InlineConfirm 흰 바탕+왼쪽 위험 띠 한 줄 · 수납 환불 막대 «선택 해제» 첫 줄 고정 · 위험 아닌 빨강·초록 채움 12곳 정리+위험 확정 6곳 새 채움 · account-deletion 색 토큰화(가드 실패 해소). tsc 0·전체 3734-0. PNG scratchpad/color-fix2 | 완료 |
| 11-09 | 학생 상세 청구/수납(발행·수정·삭제): studentBillingRules 공용 판정, updateUnpaidPayment(원장), 작업대 차단=쓰기 스위치 기준, 결제·수정 경합 잠금+금액 재확인, 결제 진행 중=30분 내·기한 남은 가상계좌. reviewer 3회·security 1회, 전체 3701-0 | 완료 |
| 11-09 | 학부모 복귀 신청(RESUME, 휴원 중 반)·«휴원 신청 취소» 문구·접수 직후 검토 중 상자 즉시·휴원 예정 안내. 승인 복귀는 due-change-plan 자동 적용(PAUSED→ACTIVE). developer 구현·tsc·전체 3683-0. 검수 대기 | 검수 대기 |
| 11-09 | 수납 «선택 항목 환불»: 막대 모드(미납=납부·납부완료=환불·섞임=끔), 토스 온라인=취소API→재조회→applyVerifiedTossFullCancel, POS=requestChargeCancelByAdmin, 현금=refundPaidPaymentInTx, 묶음 일부 선택 차단. tsc·전체 3680-0. developer | 검수 대기 |
| 11-09 | developer(학생 상세 2차, 원장 «설명 정리·중복 제거·상세는 모달·휴대폰 확인»): 머리 «N개 반» 칩·요약 «수강 중» 칸 삭제(수강 반 제목 옆 한 곳), 요약 «최근 장부 요약» 카드 삭제(요약 칸 «수납» → 창), 학부모 전화 3곳→보호자 카드 1곳(«로그인» 배지·계정 줄), 장부 수납 목록→월별 히스토리 바로가기(납부일 히스토리로), «원장 N줄» 삭제. 창 5개: 기본 정보·이번 달 요약(변동 전체)·셔틀 상세(주소·좌표·확정·신청서 희망)·유니폼 입력·변동 기록 모두 보기 + 보호자 추가/수정 창. 설명 3줄→ⓘ. 머리 [전화]. 휴대폰은 탭 본문 먼저·요약 3칸 한 줄. 메모 → 개요. 문서 높이 1366 1252→994·390 2948→1860. tsc 0·tests 3666-0 | 완료(검수 대기) |
| 11-09 | developer(원장 «줄 표시 말고 카드가 실제로 밀리게»): RunBoard 끌기 삽입선→실시간 재배치(끄는 카드 transform 으로 따라옴·지나간 카드 180ms 밀림·놓으면 안착 후 flushSync 로 onDropOn 1회), 기사님 카드 끌기도 같은 엔진(HTML draggable·pointerenter 제거, 탑승 버튼 제외). 판정=끄는 방향 가장자리 vs 옆 카드 가운데. Esc/pointercancel 취소·움직임 줄이기·자동 스크롤·인라인 touch-action 유지. tsc 0·tests 3666-0·shuttle 159-0·브라우저 34항목 통과 | 완료(검수 대기) |
| 11-09 | 기간 결석(f7aa34a8): RegularAbsencePeriod+periodId(운영 적용), 학생 상세 수강·출결 카드, 크론 /api/cron/absence-periods. developer 구현·reviewer 2회 통과·tester 전체 3648-0·임시 PG 흐름 통과. 크론 연장은 사람이 취소한 날 안 되살림 | 완료 |
| 11-09 | developer(관리자 학생 상세 좌우 정리, 원장 «좌측 길다»): 좌측 = 연락처·보호자·셔틀·메모, 학부모 요청 링크는 개요 맨 아래로·개요 순서 수강 반→요약→유니폼. 보호자 계정 전화 회색 상자→한 줄+ⓘ, 보호자 버튼 줄 합침, 셔틀 승차/하차 한 줄 행·배지 삭제·«신청서 희망(9월) 15:45 · …» 한 줄, 요청 링크 설명 1줄, 메모 4→3줄. 9월 원인 = 기기 시계로 이번 달 찾고 없으면 최근 달을 «이번 달»로 표기 → todayKst+pickMonthSummary, 아니면 «최근 장부 요약/수납». 1366px 좌 1331→934·우 811→905. tsc 0·tests 3632-0 | 완료(검수 대기) |
| 11-09 | debugger(원장 «휴원 신청하기 동작 안 함»): 서버·API·휴원 판정은 정상(코드상). 화면 원인 — 오류는 맨 위·접수 완료는 맨 아래라 휴대폰에서 안 보임(아이폰 날짜 min 무시 → 시작일 이전 복귀일 거절 문구가 화면 밖), 접수 직후 refresh 전 «신청하기» 재활성 → 두 번째 누름 «이미 검토 중» 400. EnrollmentChangeClient: 결과 문구 버튼 바로 위·접수 후 잠금(submittedFor)·복귀일 사전 확인. 신규 tests/enrollment-change-submit-feedback.test.mjs(옛 코드 4-fail 재현). tsc 0·tests 3633-0·studentVisibility 5-0·KST 가드 통과. errors.md 기록 | 완료(커밋, 미푸시) |
| 11-09 | developer(원장 점검 «끌기 안 보임·수정 화면 공간 낭비·등원/하원 묶음 없어짐·PC 지도»): RunBoard 블록 머리(runBlocks.ts, 기사님·관리자 공통·순서 불변) · 관리자 편집 카드 한 줄(학생 칩·시각 칸 8.75rem) · 끌기 = 떠다니는 카드+삽입선+놓으면 FLIP 이동(▲▼ 포함), 손잡이 touch-action 인라인(테마 CSS 가 touch-none 을 이겨 휴대폰 끌기 취소되던 버그) · PC ≥1024 오른쪽 sticky 지도(RouteMapCanvas 재사용·블록 머리로 선택). 첫 화면 카드 3→6(관리자 1440). tsc 0·tests 3635-0·src/lib/shuttle 159-0·Edge 끌기 실측 11/11. PNG scratchpad\shuttle-blocks | 검수 대기 |
| 11-09 | reviewer(운행표 묶음·한 줄 편집·끌기·PC 지도 fa19353c): 기사님 화면 탑승·순서·길안내·다음 정류장 무변경(블록 머리만), «이어서»·삽입선→onDropOn 변환·같은 묶음 제한 정확, 리스너 누수 없음, 지도 모바일 미생성. 필수: RegularRunEditor.tsx:326 편집 칩 «반 이동» min-h-9(36px)→min-h-11. 권장: FLIP 기억값 남음(▲ 맨 위 등 무변경 시)·지도 시각 입력마다 setBounds·좁은 화면 머리 버튼 무동작·손잡이 키보드 안내·특강 묶음 머리 수업시간 없음. tsc 0·tests 3635-0 | 수정 필요(필수 1·권장 5) |
| 11-09 | reviewer(색상 4~7·마무리 99710062..4cde00e5, 스크립트로 색/비색 분류): 수정 필요 — RouteSection 4줄 `${` 유실(비활성 흐림·44px·시간순 칸 클래스 깨짐). 그 외 색 외 변경 전부 의도·로직 무변경·기준선 정확. tsc 0·tests 3629-0 | 수정 필요(필수 1·권장 2) |
| 11-09 | developer(색상 4단계 학부모 화면): mypage·account·payments·components/parent 23파일 하드코딩 색 797→0(기준선 12341→11544), dark: 삭제, 장식 아이콘·알림 분류 중립·셔틀 변경 목록 파랑 남용 정리·셔틀 상태 statusTones 뜻(접수 warning·준비 info)·«중요» danger→warning·별점 ink·주 색 글자→ink. payments/review/* 는 academy-app 밖+토스 심사 중이라 제외. tsc 0·tests 3629-0 | 완료 |
| 11-09 | developer(색상 정리 5단계 선생님·기사님): 하드코딩 색 630건 → 토큰·statusTones, dark: 삭제, 기준선 12,341→11,711, 리뷰 지적 2건(기한 지난 미납 위험·미납 배지 4px) 반영. tsc 0·tests 3629-0·shuttle 159-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(색상 정리 1~3단계, 원장 결정 5건): 토큰 값(주 버튼 검정·바탕 #f6f7f9·상태 다섯 갈래 info/neutral 신설·체험 신청만 주황·기사님 보라 제거) · 가드 2종(대비·하드코딩 기준선 12,612→12,341) · statusTones 한 곳+StatusBadge info·4px+ui/Badge 토큰+상태 지도 16파일. tsc 0·tests 3629-0·studentVisibility 5-0 | 완료(커밋 3, 미푸시) |
| 11-09 | reviewer: 결제 허용 재검수 HEAD bd9cbb9f(아이폰+안드로이드) — iOS R-1 해결 확인. 수정 필요 1: K-4 로 결제 중 아무 https 본문이 «STIZ» 제목 입력창(prompt)을 띄울 수 있음(비번 피싱) → 남의 주소는 prompt 거부·제목에 호스트 표시. 안드로이드 운행 제한·로그인 인계 우회 없음 확인. 고려: intent:// 안쪽 대상이 우리 앱 자신(/driver/ 딥링크)인 경우 거부·browser_fallback_url·결제 중 구글/supabase 로그인 차단(iOS 와 맞춤) | 수정 필요 |
| 11-09 | reviewer: 아이폰 토스 결제 허용(미커밋 3파일) 검수 — 수정 필요 1건: paymentActive 가 «이동 승인 시점»에 켜져, 토스 이동이 실패·취소되면 우리 사이트에 머문 채 결제 중 상태가 남음(그동안 탭 없는 https 이동·iframe 앱 호출 허용) → 페이지 확정 시점(didCommit/url 관찰)과 실패 시 다시 계산. 컴파일·테스트 기대값 이상 없음(추정, swiftc 없음). 고려: App Store 링크 바깥으로·iPad 데스크톱 모드 iframe 결제창·카드앱 복귀 스킴 | 수정 필요 |
| 2026-11-08 | **아이폰 TestFlight 첫 업로드** — App Store Connect 앱 「스티즈 농구교실」(6832261596) 생성, 배포 프로파일 「STIZ iOS App Store」 생성·Codemagic 등록, 스토어 작업 키를 실제 등록된 **bdr-asc-key**(업턴랩스 팀 키, 원장 결정)로 맞춤 — 코덱스의 지문 고정·금지 목록·구성 검사(validate-project.py) 3곳 함께 갱신(1차 빌드는 프로파일 없음, 2차는 구성 검사로 실패). 빌드 #3(최신 main+수정) IPA·업로드·애플 처리 완료, 내부 그룹 「STIZ 내부」 초대. 외부 심사 제출 단계만 「테스트 정보」 미입력으로 실패(내부 테스트 영향 없음). 점검표 아티팩트 QwZ72QueCs2ioXKxrhCxax. 변경은 작업 브랜치만(main 은 모아서 배포) | 업로드 완료 |
| 11-08 | developer: 체육관 대관 분 단위 전환(원장 지시) — 달력 선택(오늘~60일)·시작 10분·이용 30분(1~6시간)·주말 10:00~22:00·수업/특강/승인 대관 제외. 마이그레이션 20261108210000_gym_rental_minutes(**운영 미적용**, startMinute/endMinute nullable+기존 행 채우기+CHECK) · 요금 30분 단가(원장 확정) · 표시 formatRentalTime 하나로(관리자·문자·슬랙·앱 알림). tsc 0 · 대관 관련 테스트 9파일 129-0(신규 gym-rental-minutes 13건) | 검수 대기 |
| 11-08 | reviewer: d110f2ff(현장 결제 화면 개선) 검수 — 머지 가능. 제외 건 유입 없음·서버 재검증 유지·삭제 차단 안전. 🟡 PAID 전체(계좌이체 포함) 삭제 차단은 원장 확인 필요·서버 문구 «카드로 받은» 불일치·묶음 행 매칭 shortCode→요청 id 권장 | 검수 완료 |
| 11-08 | developer(claude/pos-multi-charge): 현장 결제 묶음 — 같은 학생 미납 수강료·셔틀비 여러 건을 POS 결제 한 번(주문 1·항목 N). 마이그레이션 20261108180000_pos_charge_request_items(표·열린 항목 유일 인덱스·닫기 트리거·기존 요청 채우기, **운영 미적용·코드보다 먼저**) · 만들기 서버 재확인(같은 학생·유형·미납·금액·10건·500만), 겹치면 ALREADY_OPEN · 매칭=결제 합계(분할)·면세 합계·묶인 청구 전부 미납일 때 markPaymentsPaidTogether(한 트랜잭션), 하나라도 어긋나면 HOLD · 취소=전부 취소면 전부 환불·일부면 PARTIAL · 납부처리 창 여러 건 현장 결제 활성·창 «외 N건 · 합계» · 플러그인 items[]·항목별 검사. 사이트 tsc 0·test 3252-0(+가드 5), 플러그인 tsc 0·test 74-0, zip 재생성 | 검수 대기 |
| 11-08 | developer(claude/payments-batch, 배포 전 검수 보완 8건, 3becaac4·bb2a403f): 납부처리 — Payment paidProvider=MANUAL(토스 키 미변경)·청구서 UPDATE 에 PAID/CANCELED 제외·여러 건 창에 대상 학생(«외 N명», targetNamesSummary). 가상계좌 — 취소 요청에 refundReceiveAccount·cancelAmount 금지 주석+가드, 멱등키에 KST 10분 단위 섞기, PARTIAL_CANCELED 는 닫기·점검 FAIL+원장 확인(웹훅도 RELEASE→REJECT 알림, 같은 규칙 양쪽), 점검 건별 try/catch·45초 예산(deferred)·토스 조회/취소 10초 제한·cron maxDuration 60, 취소 사유 actor 별, 닫기창 «이미 입금» 성공 톤. tsc 0·npm test 3229-0·바뀐 파일 eslint 신규 0(admin.ts 기존 73건 동일) | 완료 |
| 11-08 | developer 수정 1차(claude/pos-auto-charge, 검수 권장 5건): P-1 납부 기록 틈에 취소가 먼저 오면 — 취소 확정은 요청이 DONE 이어도 청구 PAID 면 환불(수렴), 청구 미납·방금 PAID 면 알림 미루고 retryLater, 납부 기록 직후 cancelState 재확인→DONE 이면 바로 환불(정상·복구 두 경로), 슬랙 문구는 실제 청구 상태대로 · P-2 토스 POS 납부 건은 «환불» 메뉴 숨김 · P-3 플러그인 결제 조회 실패·주문번호 없음이면 취소 안 하고 failed · P-4 POS 취소 보고 뒤 3분 토스 확인 없으면 창 안내. 사이트 tsc 0·가드 5+본 3167 통과, 플러그인 tsc 0·66 통과, zip 재생성 | 검수 대기 |
| 11-08 | reviewer: POS 결제 취소(0bded3e8..66c2cdd6) 검수 — 차단 0·권장 2(P-1 납부기록/취소 경합, P-2 TOSS_POS «환불» 메뉴). 테스트 3160-0·65-0 | 통과 |
| 11-08 | developer(claude/pos-auto-charge): 사이트 «결제 취소» → POS 결제 취소 → 토스 웹훅 확인 시 청구 REFUNDED. 마이그레이션 20261108120000_pos_charge_cancel(칸 추가만·**운영 미적용, 코드보다 먼저 적용**) · 환불 쓰기 = payment-ledger refundPaidPaymentInTx(트랜잭션) · 분할 결제는 전부 취소일 때만(일부=PARTIAL+알림) · POS 직접 취소도 같은 길 · 플러그인 cancel.ts(선점→getPayment→payment.cancel→재확인→보고) · 롱폴링 cancels[]·cancels=1 일 때만 깨움 · ALREADY_DONE+청구서 미납이면 30초 임대 뒤 납부 기록 복구 · 웹훅 4초 초과 시 after() · 분할 대기 retryLater(웹훅 미완료로 둬 스윕 재확인, 만료 뒤 HOLD) · justPaid=paidRecordedAt 기준. 사이트 tsc 0·test 3165-0, 플러그인 tsc 0·test 65-0, zip 재생성 | 검수 대기 |
| 11-08 | developer 수정 1차(claude/virtual-account, PM 2건+검수 권장 4건): ① 열린 계좌가 있어도 확인 후 카드·계좌이체 허용 — 토스 취소 API→재조회로 닫힘 확인 후 새 결제, 닫는 사이 입금이면 «이미 납부», 실패면 결제창 안 엶 ② 웹훅 원문 저장 시 secret 가림 ③ 입금 알림 DONE 인데 재조회 대기·4xx 면 503 재전송 + 매일 cron /api/cron/virtual-account-sweep(0 0 * * * = KST 09:00) ④ 승인 전 이미 납부·다른 결제키 거부 ⑤ 관리자 «가상계좌 닫기»(원장·위험 확인창) ⑥ 발급 0건 재확인·입금 알림 지문 transactionKey. 전체 3159 통과·tsc 0 | 검수 대기 |
| 11-08 | developer(claude/virtual-account): 학부모 결제 «무통장입금(가상계좌)» — 발급=거래만 WAITING_FOR_DEPOSIT(청구 미납 유지, secret 은 SHA-256 해시만 rawResponse 저장·마이그레이션 없음), 열린 계좌 있으면 결제 준비가 새 발급 대신 그 계좌 반환, DEPOSIT_CALLBACK=secret 타이밍안전 비교→토스 재조회(DONE·금액·면세)→PAID(입금시각 UTC 규칙)·이상건 감사기록+원장 슬랙DM, 만료·취소=EXPIRED 로 해제. 학부모 청구서·완료화면·마이페이지 2경로 안내+복사, 관리자 목록 «입금 대기 · 가상계좌» 1줄. 순수 판정 src/lib/payments/virtualAccount.ts. 테스트 34건 신규·전체 3146 통과·tsc 0 | 검수 대기 |
| 11-08 | developer(claude/pos-auto-charge): POS 즉시 결제창 — ① charge.ts 금액 검사: addLineItem 반환값 대신 다시 읽기(최대 3번·0.3초), 기준=항목 1개·항목가×수량=금액·면세·메모 번호, 합계는 >0 이고 다를 때만 불일치, 보고 reason 에 실제 값(S-704715 대응) ② 롱폴링 `?wait=20&known=` (src/lib/pos/plugin-long-poll.mjs 순수 루프·1초 EXISTS·maxDuration 30·abort) + 워커 25초 제한·연속 조기응답 0→14초 완화(정상 30분 90번·최악 133번) ③ 자동 경로 silent(alert 없음)·다음 대기 먼저 예약·자동 1건 ④ 창 문구 «보통 몇 초 안에». 사이트 tsc 0·test 3114-0, 플러그인 tsc 0·test 53-0, zip 재생성 | 검수 대기 |
| 11-08 | developer(claude/pos-auto-charge-site): «현장 결제» 창 단순화 — 플러그인 자동 결제창 전제로 큰 결제 번호·메모 입력 안내·30분·새로고침 제거, «POS로 결제 보내기»→«POS로 보냈어요 · 결제 기다리는 중»(3초 자동 읽기, 탭 숨김·창 닫힘 시 멈춤)·«요청 취소». 서버 매칭·shortCode 그대로(보류·지난 요청 줄 작은 글씨만). tests/pos-charge-modal.test.mjs 3건 신설. tsc 0·npm test 3104-0 | 검수 대기 |
| 11-08 | developer(claude/payment-method-record): 수납 «납부 처리» 창 — 계좌이체(입금일 필수·미래 금지·입금자명 1~40자·메모 200자, 한 트랜잭션·미납/연체만·PaymentAuditLog)·현장 결제(MONTHLY/SHUTTLE 1건만→기존 POS 창). 일괄도 같은 창. updatePaymentStatus/bulk 는 PAID 거부. «단말기» 메뉴·markTerminalPaymentPaid·recordTerminalPayment 제거(TOSS_TERMINAL 표시 유지). 8d433c0d·372a72f0·1bfc648e. tsc 0·npm test 3116-0 | 검수 대기 |

### 보안 리뷰 결과 (security-reviewer) — 96a4ab1b
📊 판정: 통과 (CRITICAL 0 / HIGH 0). tsc 0 · tests 3764/0 fail · studentVisibility 5/0 fail
검토 범위: src/app/actions/admin.ts, src/app/admin/finance/FinanceClient.tsx, src/lib/payments/paidStatusGuard.ts, tests/paid-status-guard.test.mjs
