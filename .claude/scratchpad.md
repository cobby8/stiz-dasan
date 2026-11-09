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

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-09 | 기간 결석(f7aa34a8): RegularAbsencePeriod+periodId(운영 적용), 학생 상세 수강·출결 카드, 크론 /api/cron/absence-periods. developer 구현·reviewer 2회 통과·tester 전체 3648-0·임시 PG 흐름 통과. 크론 연장은 사람이 취소한 날 안 되살림 | 완료 |
| 11-09 | developer(관리자 학생 상세 좌우 정리, 원장 «좌측 길다»): 좌측 = 연락처·보호자·셔틀·메모, 학부모 요청 링크는 개요 맨 아래로·개요 순서 수강 반→요약→유니폼. 보호자 계정 전화 회색 상자→한 줄+ⓘ, 보호자 버튼 줄 합침, 셔틀 승차/하차 한 줄 행·배지 삭제·«신청서 희망(9월) 15:45 · …» 한 줄, 요청 링크 설명 1줄, 메모 4→3줄. 9월 원인 = 기기 시계로 이번 달 찾고 없으면 최근 달을 «이번 달»로 표기 → todayKst+pickMonthSummary, 아니면 «최근 장부 요약/수납». 1366px 좌 1331→934·우 811→905. tsc 0·tests 3632-0 | 완료(검수 대기) |
| 11-09 | debugger(원장 «휴원 신청하기 동작 안 함»): 서버·API·휴원 판정은 정상(코드상). 화면 원인 — 오류는 맨 위·접수 완료는 맨 아래라 휴대폰에서 안 보임(아이폰 날짜 min 무시 → 시작일 이전 복귀일 거절 문구가 화면 밖), 접수 직후 refresh 전 «신청하기» 재활성 → 두 번째 누름 «이미 검토 중» 400. EnrollmentChangeClient: 결과 문구 버튼 바로 위·접수 후 잠금(submittedFor)·복귀일 사전 확인. 신규 tests/enrollment-change-submit-feedback.test.mjs(옛 코드 4-fail 재현). tsc 0·tests 3633-0·studentVisibility 5-0·KST 가드 통과. errors.md 기록 | 완료(커밋, 미푸시) |
| 11-09 | reviewer(색상 4~7·마무리 99710062..4cde00e5, 스크립트로 색/비색 분류): 수정 필요 — RouteSection 4줄 `${` 유실(비활성 흐림·44px·시간순 칸 클래스 깨짐). 그 외 색 외 변경 전부 의도·로직 무변경·기준선 정확. tsc 0·tests 3629-0 | 수정 필요(필수 1·권장 2) |
| 11-09 | developer(색상 4단계 학부모 화면): mypage·account·payments·components/parent 23파일 하드코딩 색 797→0(기준선 12341→11544), dark: 삭제, 장식 아이콘·알림 분류 중립·셔틀 변경 목록 파랑 남용 정리·셔틀 상태 statusTones 뜻(접수 warning·준비 info)·«중요» danger→warning·별점 ink·주 색 글자→ink. payments/review/* 는 academy-app 밖+토스 심사 중이라 제외. tsc 0·tests 3629-0 | 완료 |
| 11-09 | developer(색상 정리 5단계 선생님·기사님): 하드코딩 색 630건 → 토큰·statusTones, dark: 삭제, 기준선 12,341→11,711, 리뷰 지적 2건(기한 지난 미납 위험·미납 배지 4px) 반영. tsc 0·tests 3629-0·shuttle 159-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(색상 정리 1~3단계, 원장 결정 5건): 토큰 값(주 버튼 검정·바탕 #f6f7f9·상태 다섯 갈래 info/neutral 신설·체험 신청만 주황·기사님 보라 제거) · 가드 2종(대비·하드코딩 기준선 12,612→12,341) · statusTones 한 곳+StatusBadge info·4px+ui/Badge 토큰+상태 지도 16파일. tsc 0·tests 3629-0·studentVisibility 5-0 | 완료(커밋 3, 미푸시) |
| 11-09 | developer(일정 달력 색 구분, 원장 «수업·출석·지각 색 구분 안 돼»): 출석 초록 채운 점·지각 주황 빈 고리·결석 빨강 ×·행사 파랑 별·수업 연청회 칸·휴무 회색 칸 «휴»·오늘 검정 굵은 테두리, 범례 같은 부품. 토큰 --color-academy-cal-* (academy-theme.css) 신설. tsc 0·tests 3617-0 | 완료 |
| 11-09 | reviewer(결제 화면 정리 3922555d): 통과 — 조건 분기·API·금액·토스 호출 무변경 확인, tsc 0·tests 3611-0. 권장: 복사 버튼 aria-label 고정이라 «복사됨» 못 읽음(3곳)·«결제하면 바로 납부 완료» 무통장과 충돌·카페24 반영 안내 사라짐·청구 탭 머리말 «알려 주면 빨라요» 빠짐·커밋 메시지 «면세» 안내 없음 | 통과(권장 5) |
| 11-09 | developer 수정 1차(일정 탭 리뷰 A-1·A-2): 옛 해시 #parent-absence-hub → /mypage/regular-absence, 소식 공지 고정(isPinned)은 3개월 지나도 보이고 3개 안에서 맨 앞 + 테스트. scratchpad 정리(끝난 검수 섹션·해결된 N-1/C-1 삭제, 로그 10건) | 완료(커밋, 미푸시) |
| 11-09 | developer(일정 탭 개편·소식 공지·홈 문구, 원장 지시): 일정 = 한 달 달력(연간일정 행사·휴무 + 우리 아이 수업일 + 출결)·수강 반·셔틀 배정, 수납 기록·신청 줄 제거(수강 변경 신청 → «⋯» 메뉴), HistoryClient 삭제. 소식 공지 3개월·3개+더보기. 홈 줄바꿈 2줄·문구 정리. tsc 0·tests 3612-0·studentVisibility 5-0·KST 가드 통과 | 완료(커밋, 미푸시) |
| 11-09 | developer(원장 점검 «시간 수정 없음·드래그로 이동»): 관리자 정규 운행표 = 평소 보기만, 화면 위 [수정] → 편집 모드(카드마다 시각 칸·손잡이 ⠿ 끌기(터치=elementFromPoint, 손잡이만 touch-none)·▲▼ 보조·정류장 수정·×·학생 창), 편집 중 고정 줄(적용 범위 select·저장 안 됨·취소/저장). 바꾼 순서 있으면 창 열기 전 먼저 저장(편집 유지). RunBoard admin 편집 분기만 추가 — driver HTML 수정 전과 동일(일회 비교 4경우). 신규 tests/regular-run-edit-mode.test.mjs. tests 3615-0·shuttle 159-0·tsc 0·KST 가드 통과. 서버 변경 없음 · 리뷰 반영 B-1 고정 줄 top-14·z-10 / B-2 적용 범위 «N월~M월 명단에 반영» / B-3 가장자리 자동 스크롤 rAF 루프 | 완료 |
| 11-09 | developer(결제 화면 정리, 원장 «내부창 복잡·설명 많음·줄바꿈»): 단건 /payments/[id] 남색 배너·4칸 중복·하단 돌아가기 제거→청구 정보 한 덩어리(항목·상태/아이·납기/금액/번호·발행 작게), 수단 한 줄 3칸(설명 줄 삭제, 이름 «카드·간편결제/계좌이체/무통장입금»), 주 버튼 «N원 결제하기», 부가 안내 «결제 안내» 접기. 계좌 안내 부품=계좌+«복사» 한 줄·토큰색. 묶음·완료·청구 탭 반복 문구 삭제·«~요»·복사 버튼 짧게·취소 버튼 44px·회색/호박색→토큰. 로직·API·금액·토스 호출 무변경. 테스트 1줄(무통장 이름 고정) 갱신. tsc 0·tests 3611-0·studentVisibility 5-0·KST 32-0 | 완료(커밋, 미푸시) |
