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

### 리뷰 결과 (reviewer · 11-08 POS 결제 취소 b7ef25d0)
📊 종합 판정: 통과(머지 가능 · 차단 없음, 권장 P-1·P-2). 마이그레이션은 build 에 migrate deploy 가 없으므로 **배포 전 apply_migration 필수**(안 하면 플러그인 GET·CLAIM_PAY 가 칸 없음으로 실패 → 현장 결제 전체 정지).
✅ 환불은 settleCancelForRow(토스 재조회 order)만 · report 는 기록만 · MARK_REFUND+refundPaidPaymentInTx 한 트랜잭션 조건부 · 일부/누락 결제는 PARTIAL(안전 방향) · 플러그인 ID 는 서버 DB 값·getPayment orderId 대조 · 마이그레이션 NULL 허용 칸만·CHECK 는 NULL 통과. 테스트 루트 3160-0(보고 3165와 5건 차이)·플러그인 65-0.

---

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-09 | developer(수강 상태 새 기준+반 줄 편집, 원장 허재원·토 2교시 사례): ① 공용 판정 commencement.ts isCurrentEnrollment/currentEnrollmentSql — ACTIVE면 승인일부터 수강 중·재원생(학생 상태·원생 목록 활성·인원 집계·대관 재원생·학부모 홈), SCHEDULED(수강 예정) 분류 제거, 개시일은 startsLater 안내 문구로만. 청구 시수·출석부 회차·셔틀 월 배차는 개시일 유지 ② 반 줄 «퇴원»→«수강 종료», ⋯ 메뉴 반 이동(actions/enrollment-admin-edit moveEnrollmentToClass — ECR CLASS_CHANGE APPLIED+원장 2건)·삭제(연결 기록 0건일 때만, 서버 재확인). tsc 0·tests 3540-0·studentVisibility 5-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(셔틀 기존 정류장 추천 장소명 일치 우선, 원장 승인 허재원 후문 사례): 공용 순수 함수 lib/shuttle/stopNameMatch.ts(pickNearbyStop — 정규화·출입구 단어·같은 단지·300m) → 관리자 학생 추가 suggestPlacement ②·기사님/관리자 새 학생 배정 planLeg 추천이 같은 함수, 추천 배지 옆 이유(«이름 일치: 후문»/«가장 가까움 88m»). 테스트 8개. tsc 0·tests 3530-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | developer(셔틀 미운행 반 칸 제외, 원장 발견 허재원 토 등원/하원): 공용 판정 classRunsShuttle(workbench-pricing, 평일+runsShuttle) → 배정 보드(driverAssign)·신청 검토(shuttle-review-query)·배차 진행(shuttle-progress-query)·청구 셔틀비 같은 함수. 테스트 4개 추가. tsc 0·tests 3530-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | developer(원생 등록 3차, 원장 실사용 4건): ① 반 줄 대상 학년(슬롯 gradeRange→직접 슬롯→Program.targetAge) ② 셔틀 장소명 필수 — lib/shuttle/placeNameRule.ts·지도 창 requirePlaceName(등록 창·학부모 /shuttle/location/[token]만)·서버 validateRegularLocation·등록 규칙 거부 ③ 유니폼 선택칸 삭제 → 보호자 번호+학생 이름 일치 UniformOrder 로 등록 시 자동(주문/신청)·요약 표시 ④ 사진 동의 체크박스(IN_PERSON 기본, 범위 3칸 기본 켬). tsc 0·tests 3526-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | tester(claude/rental-evening): 평일 20:40~22:10 수업 무시·평일 마감 22:10 규칙 — 대관 테스트 3파일 기대값을 원장 규칙에서 직접 계산해 수정(7건)+새 테스트 3개(평일 저녁 90분 가능·100/120분 불가, 저녁 승인대관 막힘, 토 21:10 불가·22:00 마감). 대관 69-0·전체 3520-0·tsc 0 | 통과 |
| 11-09 | developer: 기사님 셔틀 결석 아이 «빼지 말고 뱃지» — 정규 결석(학부모 신고·출석부 질병 모두) 행 유지·«결석·질병» 뱃지·흐린 행·기본 결석(탑승 누르면 체크)·정차 «결석 N명·정차 안 해도 됨». 판정 riderBoardingView/stopAbsenceSummary. tests 3507-0·guards 5-0 | 검수대기 |
| 11-09 | pm(main 2f385fd6): 원장 2차 답 반영 — 여러 프로그램 합산·대회준비반 30만 묶음·1호점 무료 거점 셔틀비 0, 출석 질병·부상 결석(RegularAbsence)·보강 아이 종료 필수·출석 알림, 학부모 가입 안내 보내기(미리보기→원장 직접 발송), 입금 계좌 안내, 특강 회차 수업일지 출석 차단. 데이터: 셔틀 명단 18행 삭제(감사기록), 미납 POS 5건 43만 납부완료. tests 3449-0·guards 5-0. 3차 결정표 Bf1CPJqw76JGK5yp1Z7LmG 대기 | 배포 |
| 11-09 | developer 수정 1차(학부모 공지 검수 5건): ① 브랜드 메시지 disableSms:true·크론 문자 재발송에서 BMS 제외·못 받은 건 BMS_NOT_DELIVERED: 사유로 실패 기록 → 화면 «카톡 친구가 아니어서 못 받은 학부모 N명» + «정보성 문자로 다시 보내기»(별도 미리보기·승인, 광고 표시 없는 [스티즈농구교실] 문자, 기존 대량 큐, 묶음당 1회, 결과 확인 끝난 뒤만) ② markManualMessageAccepted 에 channel·fallbackUsed·fallbackChannel ③ 30분 중복 지문 = 종류+입력값+버튼 경로(contentHash) ④ 이름 빈 번호 noNameCount 표시 ⑤ 카톡 틀 묶음 지문 본문에 입력값 포함. tsc 0·tests 3501-0 | 완료(재검수 대기) |
| 11-09 | developer(학부모 공지): 공지 알림톡 3종(휴무·행사·월 안내, NOTICE_ALIMTALK_TEMPLATES·env ALIMTALK_TPL_NOTICE_*·버튼 «공지 자세히 보기» https://www.stiz-dasan.kr/#{공지경로}·선택 칸 기본 «보강: 없음»/«별도 신청은 필요 없습니다.») + /admin/sms «학부모 공지 보내기»(재원생 학부모 서버 계산·미리보기→승인→대량 큐, 받는 사람마다 다른 본문) + 자유 공지 = 솔라피 BMS 자유형 텍스트형(템플릿 id 불필요·targeting I·(광고)/수신거부 본문 삽입·08:00~20:40 접수·마감 지나면 미발송, 스위치 ALIMTALK_BMS_FREE_NOTICE=on 꺼지면 문자). 큐/크론 per-item 경로 추가(기존 문자 묶음 그대로). tsc 0·tests 3500-0 | 완료(검수 대기) |
| 11-09 | developer 수정 1차(원생 등록 2차 검수 반영 5건): ① 수강료 미리보기가 청구 모듈 workbench-pricing 의 planWeeklyTuition·planShuttleFee 를 그대로 호출(반 요일·슬롯 전달 → 주말·일8 면제·직접 입력 셔틀비·반 4개 대체 계산 청구와 동일), 셔틀 자동 요금 상수는 AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT 하나 ② 체험 생년 seoulDateInputValue ③ registerStudent 번호 잠금 직후 tx 로 중복 재확인→RegisterDuplicate ④ 엑셀 «트랜잭션 사용 불가» 주석 갱신 ⑤ 중복 판정 생년을 KST 날짜로(무tz 두 번 AT TIME ZONE, 자정·전날 15:00 행 둘 다 원래 생일 테스트). tsc 0·tests 3434-0·KST 가드 6-0·studentVisibility 5-0 | 검수 대기 |
