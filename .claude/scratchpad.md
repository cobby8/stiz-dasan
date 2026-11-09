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

### 테스트 결과 (tester · 11-09 수강 새 기준 3c4d4cc4 + 반 이동·삭제 d559228c)
| 테스트 항목 | 결과 | 비고 |
|-----------|------|------|
| tsc · 전체 tests · studentVisibility · KST 가드 | ✅ 통과 | 0 · 3540-0 · 5-0 · 16-0 |
| planEnrollmentMove 경계(같은 반·종료/휴원·미래 적용일·개시일 승계 월말/연말·WITHDRAWN 되살리기·정원 9/10·10/10) | ✅ 통과 | 7건 |
| moveEnrollmentToClass 가짜 tx(순서·실패 시 쓰기 0·UPDATE 0행/DB 오류 롤백·원장 WITHDRAW+CLASS_ADD/RESUME) | ✅ 통과 | 14건 |
| removeMistakenEnrollment 가짜 tx(연결 7종 각 1건 차단·DELETE 0행 롤백·감사) | ✅ 통과 | 12건 |
| 개시일 미래 ACTIVE = 수강 중·대관 무료 대상 / 청구 시수 개시일 기준(11-28·11-29·11-30·10-31·11-08) / 자정 경계 | ✅ 통과 | 9건 |
| [권장] 삭제 시 운영 원장 «수강 등록» 대기 건 미확인·미정리 | ⚠️ 관찰 | enrollment-admin-edit.ts removeMistakenEnrollment |
📊 종합: 59개 중 59개 통과 / 0개 실패 (권장 1). 스크립트: Temp/.../scratchpad/mock-enroll-edit.test.mjs·billing-edge.test.mjs

### 테스트 결과 (tester · 11-09 재검수 8144e6c7 + e2b02a6d)
| 테스트 항목 | 결과 | 비고 |
|-----------|------|------|
| tsc · 전체 tests · studentVisibility · KST 가드+대상 테스트 | ✅ 통과 | 0 · 3546-0 · 5-0 · 18-0 |
| 이동: 처리 중 신청 1건이면 차단(쓰기 0·롤백), 출석·결석·셔틀 연결은 이동 안 막음 | ✅ 통과 | 집계 인자 (enr, stu, class) |
| moveEffectiveMinYmd 11경계(과거/미래 개시·등록일·무효·윤년·연말) + 화면 toKstYmd(KST 자정)=서버 이중 AT TIME ZONE | ✅ 통과 | 개시 전 수강 → 오늘 허용+원래 개시일 승계 |
| 삭제 차단 결석(CANCELLED 제외)·셔틀 승객(그 반 Session) | ✅ 통과 | 각 1건 차단, 원장/삭제 쓰기 없음 |
| 원장 닫기: CLASS_ADD/RESUME × PENDING·PARTIAL·HELD 만, SYNCED·WITHDRAW·다른 수강 손대지 않음, SUCCEEDED 칸 보존·알림, 삭제보다 먼저, 감사 | ✅ 통과 | 단계별 DB 오류 8곳·DELETE 0행 → 전부 롤백 |
| scheduled 집계 제거 — 남은 사용처 없음, 칩은 active/paused/withdrawn/noEnrollment | ✅ 통과 | |
| [권장] 이동→삭제 시 이동 신청이 «확인 필요»에서 안 빠짐 | ⚠️ 관찰 | 아래 수정 요청 |
📊 종합: 24(모의)+전체 중 실패 0 (권장 1). 스크립트: Temp/.../scratchpad/mock-enroll-edit2.test.mjs

| 요청자 | 파일 | 문제 | 상태 |
|------|------|------|------|
| tester | lib/enrollment/admin-change-request.ts NEEDS_CHECK_SQL | 반 이동 뒤 새 반 수강을 삭제하면 그 CLASS_ADD(이동 신청에 afterJson.enrollmentChangeRequestId 로 연결)의 RALLYZ 칸이 SKIPPED 가 되는데, NEEDS_CHECK 는 RALLYZ 를 `<> 'SUCCEEDED'` 로 세어 이동 신청이 «확인 필요»에 영구히 남음. 직원이 지우려면 «랠리즈 반영 확인»을 거짓으로 눌러야 함. 삭제 사유로 닫힌 명령(holdReason=DELETED_ENROLLMENT_CLOSE_REASON) 제외 등 | 대기(권장) |

---

## 구현 기록 (developer) — 학부모 화면 구조 갈래 B (11-09)

📝 원장 결정 D1 안 A·D6·D7·D8. 기존 주소 전부 유지(문자 링크 보호). 결제 서버(payment-ledger·lib/payments·app/payments·결제 API) 무수정.

| 파일 | 변경 | 신규/수정 |
|---|---|---|
| src/app/mypage/MyPageBottomNav.tsx | PARENT_TABS 4개·isParentTabActive(하위 화면 소속 탭)·variant top(PC) | 수정 |
| src/app/mypage/ParentMoreMenu.tsx | «⋯» 메뉴(알림·자녀 연결·간편로그인·로그아웃) | 신규 |
| src/app/mypage/layout.tsx | 로그아웃 → ⋯ 메뉴, PC 4탭 메뉴, «홈으로»→«홈페이지» | 수정 |
| src/app/mypage/MyPageClient.tsx | 홈=납부 합계 한 줄(PAYMENT_HOME_HREF)+히어로+처리할 일+빠른 실행 4, 접힌 칸·공지·사진·피드백·기록 제거 | 수정 |
| src/app/mypage/page.tsx | 사진·피드백 조회 제거, 보강권·방학특강 회차 조회 추가 | 수정 |
| src/app/mypage/ParentShuttleDetail.tsx | 셔틀 배정 상세(홈 접힌 칸에서 이동) | 신규 |
| src/app/mypage/history/ScheduleHub.tsx · page.tsx · HistoryClient.tsx | 일정 탭 윗부분, embedded, toDateStr KST | 신규/수정 |
| src/app/mypage/reports/page.tsx | 소식 탭(공지·리포트·피드백·사진, 칩 앵커) | 수정 |
| src/app/mypage/news/[id]/page.tsx | 앱 안 공지 상세(전체·우리 반 공지만, sanitize) | 신규 |
| src/lib/mypage/summary.ts | summarizePendingPayments·countRecentAnswers·countRecentNotices | 수정 |
| tests/parent-app-structure·mypage-home-todo (신규) + 기존 9개 위치 갱신 · kst 가드 R1 21→19 | | |

💡 tester: 휴대폰 390px 홈 첫 화면(청구 있을 때/없을 때), 하위 화면에서 탭 켜짐, ⋯ 메뉴 «알림» → 홈 알림 펼침, 일정 탭 #mypage-shuttle 이동, 소식 공지 → /mypage/news/[id](설치 앱 주소창 안 뜸), 남의 반 공지 id 직접 입력 → 404.
⚠️ reviewer: 홈 청구 합계는 getMyPageData 자녀별 최근 5건 기준(청구 탭은 60건) · 공지 상세 반 판정은 getMyPageData 의 ACTIVE 수강 기준 · /payments/[invoiceId] formatDate(시간대 없는 toLocaleDateString) 는 결제 담당 영역이라 미수정.

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-09 | developer(학부모 화면 구조 갈래 B, 원장 D1 안 A·D6·D7·D8): 아래 탭/PC 메뉴 홈·일정·청구·소식(방학특강 탭 제거), 로그아웃 «⋯» 메뉴, 홈=납부 합계 한 줄+처리할 일+빠른 실행 4(접힌 칸 5개 제거), 일정=/mypage/history 확장(ScheduleHub), 소식=/mypage/reports 확장(공지·리포트·피드백·사진), 앱 안 공지 상세 /mypage/news/[id], KST toDateStr 2곳. 결제 서버 파일 무수정. tsc 0·tests 3540-0 | 검수 대기 |
| 11-09 | tester(8144e6c7+e2b02a6d): tsc 0·tests 3546-0·가드 통과, 모의 24 통과. 권장: 이동→삭제 시 NEEDS_CHECK 잔류 | 통과(권장 1) |
| 11-09 | developer 수정 2차(수강 삭제 운영 원장 정리): removeMistakenEnrollment 가 같은 트랜잭션에서 그 수강(afterJson.enrollmentId)의 열린 CLASS_ADD·RESUME 명령(PENDING·HELD·PARTIAL)을 닫음 — CHECK 에 취소 값이 없어 명령 SYNCED·확인 칸 SKIPPED+사유·감사 기록, 이미 랠리즈 반영된 칸은 «직접 정리» 안내. adminReadPayloads 항상 0 scheduled 집계 제거. tsc 0·tests 3546-0·studentVisibility 5-0 | 완료(커밋, 미푸시) |
| 11-09 | developer 수정 1차(반 이동·삭제 검수 4건): ① 이동도 처리 중 수강 변경 신청 있으면 차단(readEnrollmentLinkCounts 재사용) ② 적용일 하한 moveEffectiveMinYmd(개시일→없으면 등록일 KST, 개시 전 수강은 오늘로) 화면 min·서버 공용 ③ 삭제 차단에 RegularAbsence(취소 제외)·ShuttleRoutePassenger(그 반 Session) 추가+확인 창 «시트·랠리즈 직접 정리» ④ 수강 변경 신청 화면 adminDirectMove 안내 + summary.ts 죽은 SCHEDULED 분기 제거. tsc 0·tests 3542-0·studentVisibility 5-0·KST 6-0 | 완료(커밋, 미푸시) |
| 11-09 | tester(3c4d4cc4+d559228c): 전체 3540-0·tsc 0·가드 통과, 모의 실행 37+청구 경계 5 통과. 권장: 잘못 등록 수강 삭제 시 운영 원장 대기 «수강 등록» 처리 | 통과(권장 1) |
| 11-09 | developer(수강 상태 새 기준+반 줄 편집, 원장 허재원·토 2교시 사례): ① 공용 판정 commencement.ts isCurrentEnrollment/currentEnrollmentSql — ACTIVE면 승인일부터 수강 중·재원생(학생 상태·원생 목록 활성·인원 집계·대관 재원생·학부모 홈), SCHEDULED(수강 예정) 분류 제거, 개시일은 startsLater 안내 문구로만. 청구 시수·출석부 회차·셔틀 월 배차는 개시일 유지 ② 반 줄 «퇴원»→«수강 종료», ⋯ 메뉴 반 이동(actions/enrollment-admin-edit moveEnrollmentToClass — ECR CLASS_CHANGE APPLIED+원장 2건)·삭제(연결 기록 0건일 때만, 서버 재확인). tsc 0·tests 3540-0·studentVisibility 5-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(셔틀 기존 정류장 추천 장소명 일치 우선, 원장 승인 허재원 후문 사례): 공용 순수 함수 lib/shuttle/stopNameMatch.ts(pickNearbyStop — 정규화·출입구 단어·같은 단지·300m) → 관리자 학생 추가 suggestPlacement ②·기사님/관리자 새 학생 배정 planLeg 추천이 같은 함수, 추천 배지 옆 이유(«이름 일치: 후문»/«가장 가까움 88m»). 테스트 8개. tsc 0·tests 3530-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | developer(셔틀 미운행 반 칸 제외, 원장 발견 허재원 토 등원/하원): 공용 판정 classRunsShuttle(workbench-pricing, 평일+runsShuttle) → 배정 보드(driverAssign)·신청 검토(shuttle-review-query)·배차 진행(shuttle-progress-query)·청구 셔틀비 같은 함수. 테스트 4개 추가. tsc 0·tests 3530-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | developer(원생 등록 3차, 원장 실사용 4건): ① 반 줄 대상 학년(슬롯 gradeRange→직접 슬롯→Program.targetAge) ② 셔틀 장소명 필수 — lib/shuttle/placeNameRule.ts·지도 창 requirePlaceName(등록 창·학부모 /shuttle/location/[token]만)·서버 validateRegularLocation·등록 규칙 거부 ③ 유니폼 선택칸 삭제 → 보호자 번호+학생 이름 일치 UniformOrder 로 등록 시 자동(주문/신청)·요약 표시 ④ 사진 동의 체크박스(IN_PERSON 기본, 범위 3칸 기본 켬). tsc 0·tests 3526-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | tester(claude/rental-evening): 평일 20:40~22:10 수업 무시·평일 마감 22:10 규칙 — 대관 테스트 3파일 기대값을 원장 규칙에서 직접 계산해 수정(7건)+새 테스트 3개(평일 저녁 90분 가능·100/120분 불가, 저녁 승인대관 막힘, 토 21:10 불가·22:00 마감). 대관 69-0·전체 3520-0·tsc 0 | 통과 |
| 11-09 | developer: 기사님 셔틀 결석 아이 «빼지 말고 뱃지» — 정규 결석(학부모 신고·출석부 질병 모두) 행 유지·«결석·질병» 뱃지·흐린 행·기본 결석(탑승 누르면 체크)·정차 «결석 N명·정차 안 해도 됨». 판정 riderBoardingView/stopAbsenceSummary. tests 3507-0·guards 5-0 | 검수대기 |
