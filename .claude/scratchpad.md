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
| P-1 | lib/pos/chargeRequestService.ts writeLedgerPaid·settleCancelForRow | 권장 | 납부 기록(markPaymentPaid 무조건 UPDATE) 직전에 POS 취소 웹훅이 끼면 요청 DONE·청구 PENDING→뒤이어 PAID 로 덮임(사이트 납부완료·실제는 취소). 기록 뒤 cancelState 재확인 → DONE 이면 refundPaidPaymentInTx, 또는 settle 에서 refunded=false·청구 미납이면 retryLater |
| P-2 | admin/finance/FinanceClient.tsx:955 «환불» | 권장 | TOSS_POS 건에도 그대로 → POS 는 안 취소되고 사이트만 REFUNDED. TOSS_POS 면 숨기거나 확인창에 «POS 결제는 취소되지 않음, 결제 취소를 쓰세요» 경고 |


- ⚠️ (11-08 POS 결제 취소 리뷰) 마이그레이션은 build 에 migrate deploy 가 없어 **배포 전 apply_migration 필수**(안 하면 현장 결제 전체 정지).

### 수정 요청 (tester · 11-09 재검수 8144e6c7 + e2b02a6d — 결과는 작업 로그)
| 요청자 | 파일 | 문제 | 상태 |
|------|------|------|------|
| tester | lib/enrollment/admin-change-request.ts NEEDS_CHECK_SQL | 반 이동 뒤 새 반 수강을 삭제하면 그 CLASS_ADD(이동 신청에 afterJson.enrollmentChangeRequestId 로 연결)의 RALLYZ 칸이 SKIPPED 가 되는데, NEEDS_CHECK 는 RALLYZ 를 `<> 'SUCCEEDED'` 로 세어 이동 신청이 «확인 필요»에 영구히 남음. 직원이 지우려면 «랠리즈 반영 확인»을 거짓으로 눌러야 함. 삭제 사유로 닫힌 명령(holdReason=DELETED_ENROLLMENT_CLOSE_REASON) 제외 등 | 대기(권장) |

---

## 구현 기록 (developer) — 일정 탭 달력·소식 공지 3개월·홈 문구/줄바꿈 (11-09 원장 지시)
| 파일 | 변경 | 신규/수정 |
|---|---|---|
| src/lib/mypage/parentSchedule.ts | 순수: 한 달 달력(일요일 시작)·수업일(앞·이번·다음 수강월→이 달만, 개시일 전 제외)·휴무/행사(주차 표시 제외·중복 제거)·출결 KST·?month 파싱·3개월 공지 필터 | 신규 |
| src/app/mypage/history/page.tsx · ScheduleHub.tsx | 일정 탭 = 제목+‹달›·자녀 칩(주소 ?child·?month)·달력+범례·행사·휴무 행·수강 반·셔틀 배정. 수납·신청 줄 제거. 연간일정 = loadAnnualPlanEvents+getMonthlyClassDates(/annual·청구와 같은 함수) | 수정 |
| src/app/mypage/history/HistoryClient.tsx | 삭제(수납 탭은 청구 탭과 중복, 출결은 달력으로) | 삭제 |
| src/app/mypage/ParentMoreMenu.tsx | «⋯»에 «수강 변경 신청» 추가(홈에 없던 유일한 신청) | 수정 |
| src/app/mypage/reports/page.tsx | 공지 3개월 이내·3개 + «더보기»(details), 칩 이름 짧게·설명 문구 삭제 | 수정 |
| src/app/mypage/MyPageClient.tsx | 다음 수업/오늘 셔틀 줄 한 줄 고정(반 이름·하원은 아래 줄), 방학특강 줄 «방학특강 결석·보강», 메시지 폼 안내 1문장(«셔틀 자동 제외» 약속 삭제), 군더더기 설명 삭제 | 수정 |
| tests: list-stage8b·parent-app-structure·parent-child-links-ui·scheduled-enrollment-ui·ui-copy-cleanup·no-dev-jargon-parent | 새 화면 기준으로 갱신(공지 테스트는 오늘 고정) | 수정 |

💡 tester: 360·390px 에서 /mypage/history(이번 달·‹›·?month=2026-13 → 이번 달·자녀 2명 칩), 휴무일 «휴»·출석/결석 점, 연간일정에 그 달 개강/주차가 없으면 «확정 후 보여요» 한 줄. /mypage/reports 공지 4개 이상이면 «더보기». 홈 «⋯» → 수강 변경 신청.
⚠️ reviewer: 수업일 계산은 기존 getMonthlyClassDates(휴무일은 UTC 날짜 집합 — 기존 /annual 과 같은 동작) 그대로. getMyPageHistory 는 수납도 읽지만 화면에서 안 씀(공용 쿼리 무수정). 홈 «납부할 청구 · 합계» 줄은 결제 작업 중이라 손대지 않음.

#### 수정 이력
| 회차 | 날짜 | 수정 내용 | 수정 파일 | 사유 |
|------|------|----------|----------|------|
| 1차 | 11-09 | 옛 해시 #parent-absence-hub → /mypage/regular-absence · 고정 공지는 3개월 지나도 보이고 맨 앞(3개 상한 안) | lib/mypage/summary.ts · lib/mypage/parentSchedule.ts · tests/payment-bundle-ui·list-stage8b | reviewer 요청 A-1·A-2 |

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-09 | developer 수정 1차(일정 탭 리뷰 A-1·A-2): 옛 해시 #parent-absence-hub → /mypage/regular-absence, 소식 공지 고정(isPinned)은 3개월 지나도 보이고 3개 안에서 맨 앞 + 테스트. scratchpad 정리(끝난 검수 섹션·해결된 N-1/C-1 삭제, 로그 10건) | 완료(커밋, 미푸시) |
| 11-09 | developer(일정 탭 개편·소식 공지·홈 문구, 원장 지시): 일정 = 한 달 달력(연간일정 행사·휴무 + 우리 아이 수업일 + 출결)·수강 반·셔틀 배정, 수납 기록·신청 줄 제거(수강 변경 신청 → «⋯» 메뉴), HistoryClient 삭제. 소식 공지 3개월·3개+더보기. 홈 줄바꿈 2줄·문구 정리. tsc 0·tests 3612-0·studentVisibility 5-0·KST 가드 통과 | 완료(커밋, 미푸시) |
| 11-09 | tester(묶음 결제 전체 b6fa4781~a5fe8e6c): tsc 0·tests 3606-0·가드 통과, 화면 렌더+상호작용 45·홈 7·순수 함수 통과. 관찰: 입금 알림 상한·확인창 잔류·홈 버튼 문구 | 통과(관찰 3) |
| 11-09 | reviewer(묶음 결제 화면 a5fe8e6c·d90f40b2·b6fa4781 충돌부): 통과, 권장 N-1(관리자 편집 후 선생님 공지 재확인 실패)·C-1(금액 재대조·입금 알림 상한·문구) | 통과(권장 2) |
| 11-09 | developer 수정 1차(갈래 C 리뷰 권장 6건): 선생님 공지 재발송 확인 대상 반 두 모양(IN $3,$4)·결제창 전 금액 재확인(다르면 안내+새로고침)·상한이면 입금 알림도 막음·면세 문구·말투 «~요»·확인 창 닫기·bfcache 복귀 로딩 해제·홈 버튼 이름=결제 가능 건수·개시일 «12월 5일부터»·토스 실패 코드별 문구(tossFailMessage). tests 3610-0 | 완료(검수 대기) |
| 11-09 | developer(묶음 결제 화면 갈래 C + B 리뷰 반영): B·A·보안수정 cherry-pick 후 main 수강 기준(startsLater) 충돌 해결, /mypage/payments/checkout·done, 홈 청구 줄=청구 탭 기준·[한 번에 결제], 단건 KST·묶음 계좌 안내, 공지 대상 반 공용 파서·상세 ALL/CLASS만, 옛 해시→탭, 납부 신청 승인 MANUAL. tsc 0·tests 3606-0·studentVisibility·KST 가드 통과 | 완료(검수 대기) |
| 11-09 | developer(묶음 결제 갈래 A — 서버·데이터): PaymentTransactionItem(마이그레이션 20261109150000, 미적용)·checkoutBundle 규칙·bundleLedger(전부 아니면 전무·전액 취소 전부 환불)·확정/취소 묶음 갈래·승인 전 재확인·랠리즈 사본 차단(단건·묶음)·단건 열린 계좌 조회/닫기·마이페이지/관리자 lateral 이 항목까지 봄·API /api/mypage/payments/checkout·confirm·묶음 입금 알림. tsc 0·tests 3560-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | developer(학부모 화면 구조 갈래 B, 원장 D1 안 A·D6·D7·D8): 아래 탭/PC 메뉴 홈·일정·청구·소식(방학특강 탭 제거), 로그아웃 «⋯» 메뉴, 홈=납부 합계 한 줄+처리할 일+빠른 실행 4(접힌 칸 5개 제거), 일정=/mypage/history 확장(ScheduleHub), 소식=/mypage/reports 확장(공지·리포트·피드백·사진), 앱 안 공지 상세 /mypage/news/[id], KST toDateStr 2곳. 결제 서버 파일 무수정. tsc 0·tests 3540-0 | 검수 대기 |
| 11-09 | developer(정규 셔틀 통합 6단계 — 저장 노선 읽기 전부 명단으로): 학부모 확정 시각=명단 arriveTime(regularRosterEta+Logic, 그 달 이하 최신 명단 달) · 등원시간 안내 문자=명단 시각·정류장(저장 노선 필수 조건 제거, 지문=학생 명단 칸) · 배차 진행=명단 반영이면 배차 완료, 명단 지문과 같은 안내 전달 시 안내 완료 · 신청 검토 지문 routes=[] 고정(기존 지문 유지) · 결석·셔틀 기사 알림=그날 명단에 학생 있으면 기사 역할 전원(명단 변경 알림과 같은 조건) · 월 복사 명단만 · /api/shuttle/regular-order 명단만+ORM 제거(QA 11월 목 «다른 화면에서 변경» 해소 재현 확인). 남은 저장 노선 접근=/api/admin/regular/dispatch/saved(부르는 화면 없음). tsc 0·tests 3548-0·ts 195-0·KST 6-0 | 검수 대기 |
| 11-09 | developer(정규 셔틀 통합 4·5단계, 원장 «관리자 화면=기사님 화면·직접 수정»): /admin/shuttle/regular-dispatch 를 RegularRunEditor(RunBoard mode=admin + buildRegularRunRows, 월·요일 탭, ▲▼·끌기·시각 → 묶음별 reorder, 카드 «정류장 수정»=editStop, 학생 이름 → 셔틀 정보 창=editStudent, × → 이 칸/이 요일/전체 × 범위 DELETE, 카드 «반 이동·재배정» 표시) + RunEditDialogs 로 교체. 옛 RegularDispatchClient(자동 제안·T맵·차량 이동) 삭제·page 의 T맵/기사 조회 제거. 배정 필요 패널(신규·반 이동 칸 수, onBoard·openRequest) · AssignLegView 재배정 reassign:true+옛 칸 안내. 학생 상세 위치 placeName+requirePlaceName+명단 반영 안내. /staff/run?focus=BOARD|ALIGHT 스크롤(RunBoard focusKey). 5단계: regularRunRows·regularDriverRoute 저장 노선 입력·조회 제거(명단만, pending 끔), routeStatus API 항상 false. 흡수 비교(읽기 전용): 목 등원만 차이(노선 전용 학생 2명 사라짐·자이 후문 2정차 합쳐짐), 그 밖 요일 동일. tsc 0·tests 3553-0·가드 5-0·KST 6-0·shuttle 154-0 | 검수 대기 |
