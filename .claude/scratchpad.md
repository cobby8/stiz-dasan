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

| N-1 | actions/staff-notices.ts:86-90 findOwnedNotice | 권장 | 관리자가 선생님 반 공지를 편집·저장하면 대상 반이 JSON→쉼표로 바뀌어 `"targetClassIds"=JSON` 정확 비교가 실패 → 응답 유실 후 같은 작업 재확인 시 NOT_FOUND→재제출→«내용이 다릅니다» 반복(중복 공지는 안 생김). 수정: `AND "targetClassIds" IN ($3,$4)`($4=classId) |
| C-1 | mypage/payments/checkout/BundleCheckoutClient.tsx:170-178·436 | 권장 | ① 서버 data.amount≠화면 total 이면 창 열지 말고 «금액이 바뀌었어요»+router.refresh() ② «이미 계좌로 입금했어요» 버튼이 10건 상한(overCount)을 안 막음 → 서버 거절 전 같은 안내 ③ 175줄 «면세 금액» 등 학부모에게 낯선 말·«~습니다» 말투 섞임 → «결제 금액을 확인하지 못했어요. 학원으로 문의해 주세요» |

### 리뷰 결과 (reviewer · 11-08 POS 결제 취소 b7ef25d0)
📊 종합 판정: 통과(머지 가능 · 차단 없음, 권장 P-1·P-2). 마이그레이션은 build 에 migrate deploy 가 없으므로 **배포 전 apply_migration 필수**(안 하면 플러그인 GET·CLAIM_PAY 가 칸 없음으로 실패 → 현장 결제 전체 정지).
✅ 환불은 settleCancelForRow(토스 재조회 order)만 · report 는 기록만 · MARK_REFUND+refundPaidPaymentInTx 한 트랜잭션 조건부 · 일부/누락 결제는 PARTIAL(안전 방향) · 플러그인 ID 는 서버 DB 값·getPayment orderId 대조 · 마이그레이션 NULL 허용 칸만·CHECK 는 NULL 통과. 테스트 루트 3160-0(보고 3165와 5건 차이)·플러그인 65-0.

### 테스트 결과 (tester · 11-09 묶음 결제 전체 b6fa4781~a5fe8e6c)
| 테스트 항목 | 결과 | 비고 |
|-----------|------|------|
| tsc · 전체 tests · studentVisibility · KST 가드 | ✅ 통과 | 0 · 3606-0 · 5-0 · 포함 |
| checkout 정적 렌더 8종(기본·11건·100만 초과·선택 불가만·온라인 꺼짐·?result=fail·빈 목록·로드 실패) | ✅ 통과 | 기본 체크 2·막힌 1 disabled |
| checkout 상호작용(가짜 훅): 해제→합계·POST 본문·토스 인자 서버값·taxFreeAmount 없음 차단/0 전달·무통장 옵션·409 확인창(목록/빈 목록)·닫고 결제 close:true·열린 계좌→다른 방법 CARD·submit-bundle·5xx 안내·상한 막힘/풀림·모두 선택/해제 | ✅ 통과 | 31건 |
| done 상호작용: POST/GET·재시도 4회(총 5회)·재시도 후 성공·입금 대기·CONFIRM_IN_PROGRESS/OPEN_DEPOSIT_EXISTS/NOT_UNPAID 공용 문구+«다시 결제» 숨김·일반 실패·네트워크 끊김·주문 번호 없음 + decideDoneState 9경우 | ✅ 통과 | |
| 홈 정적 렌더: 2건+ 한 번에 결제·1건 결제하기·연결 가족 청구 보기·합계=pendingPayments·묶음 계좌 1회·null 폴백·청구 없음 | ✅ 통과 | 7건 |
| 서버(기존 가짜 DB·가짜 fetch 실행 테스트 재확인) + MANUAL/TOSS_POS 경로 확인(L1 오환불 방지 성립) | ✅ 통과 | |
| 공지 파서 8·옛 해시 5·formatKstDate 경계 6·탭 활성 판정 | ✅ 통과 | |
| [관찰] 상한 초과(11건)에도 «이미 계좌로 입금했어요(11건)» 버튼 눌림(서버가 10건 거절) | ⚠️ 권장 | reviewer C-1 ②와 같음 |
| [관찰] «계좌 닫고 결제» 성공 뒤 확인 창이 남음(토스가 페이지 이동해 보통 안 보임) | ⚠️ 경미 | |
| [관찰] 대표+연결 섞인 계정은 결제 가능 1건이어도 홈 버튼이 «한 번에 결제» / 개시일 안내가 «2026-12-05부터»(다른 곳은 «12월 5일») | ⚠️ 경미 | |
📊 종합: 실패 0 (권장·경미 관찰 3). 스크립트: Temp/.../scratchpad/render/(ssr·interact·home-ssr·nav).mjs·pure.test.mjs

### 수정 요청 (tester · 11-09 재검수 8144e6c7 + e2b02a6d — 결과는 작업 로그)
| 요청자 | 파일 | 문제 | 상태 |
|------|------|------|------|
| tester | lib/enrollment/admin-change-request.ts NEEDS_CHECK_SQL | 반 이동 뒤 새 반 수강을 삭제하면 그 CLASS_ADD(이동 신청에 afterJson.enrollmentChangeRequestId 로 연결)의 RALLYZ 칸이 SKIPPED 가 되는데, NEEDS_CHECK 는 RALLYZ 를 `<> 'SUCCEEDED'` 로 세어 이동 신청이 «확인 필요»에 영구히 남음. 직원이 지우려면 «랠리즈 반영 확인»을 거짓으로 눌러야 함. 삭제 사유로 닫힌 명령(holdReason=DELETED_ENROLLMENT_CLOSE_REASON) 제외 등 | 대기(권장) |

---

### 리뷰 결과 (reviewer · 11-09 묶음 결제 화면 a5fe8e6c + d90f40b2 + b6fa4781 충돌부)
📊 종합 판정: 통과(차단 없음 · 권장 N-1·C-1). 관련 테스트 4파일 33-0.
✅ 금액·건수는 서버 후보값·토스 창은 서버 amount/taxFreeAmount 그대로 · sending ref 로 이중 클릭 차단 · 실패=failUrl ?result=fail 배너, 완료 새로고침=같은 주문 재승인(서버 멱등)·CONFIRM_IN_PROGRESS 등은 «다시 결제» 대신 청구 목록 · 홈 합계=청구 탭 같은 목록(null 이면 옛 기준 폴백)·묶음 계좌 1회 · 연결 가족 [청구 보기] · 단건 결제·청구 탭 기능 보존 · KST(formatKstDate·todayKst·NOW() AT TIME ZONE 1회) · 경로 전부 /mypage 안 · 44px·12px·토큰 색 · 충돌부 startsLater 반영(홈·ScheduleHub) 정상.

## 구현 기록 (developer) — 묶음 결제 화면 갈래 C + B 리뷰 반영 (11-09)
📝 갈래 B·A(구현 기록은 작업 로그 줄로 요약)를 main 위에 합치고 «한 번에 결제» 화면을 붙였다.

| 파일 | 변경 | 신규/수정 |
|---|---|---|
| src/app/mypage/payments/checkout/page.tsx · BundleCheckoutClient.tsx | 미납 체크(selectable 기본 체크·막힘 이유)·합계·상한 안내·결제 방식·토스 창(taxFreeAmount=서버 값)·열린 계좌 충돌 확인·계좌 복사·묶음 «입금했어요» | 신규 |
| src/app/mypage/payments/done/page.tsx · BundleDoneClient.tsx | 승인/조회 → 성공·입금 대기·확인 중·실패 + 항목·영수증, CONFIRM_IN_PROGRESS 등은 납부 내역 확인 | 신규 |
| src/app/mypage/MyPageClient.tsx · page.tsx | 청구 줄 = 청구 탭 목록 기준(pendingPayments), [한 번에 결제]/[결제하기]/연결 가족 [청구 보기], 묶음 계좌 1회 표시, 옛 해시 → 탭 | 수정 |
| src/lib/payments/parent-payment-request.ts | 청구 행에 virtualAccount(단건·묶음, 대표 보호자만) | 수정 |
| src/app/mypage/payments/PaymentRequestClient.tsx | [한 번에 결제] 진입 줄 + 행별 계좌·«묶은 계좌 · 합계» | 수정 |
| src/app/payments/[invoiceId]/page.tsx | formatKstDate, 묶음 계좌 합계 안내 | 수정 |
| src/lib/noticeTargets.ts + queries·news/[id]·NoticesAdminClient | 대상 반 쉼표/JSON 둘 다 읽는 공용 파서, 공지 상세 ALL·CLASS 외 404 | 신규/수정 |
| src/lib/mypage/summary.ts | legacyHomeHashTarget | 수정 |
| src/lib/payments/admin-payment-request.ts | 납부 신청 승인 provider MANUAL | 수정 |
| ScheduleHub·reports/page·scripts/test-parent-workspace-browser.mjs | startsLater 안내·전체보기 44px·옛 앵커 갱신 | 수정 |
| tests/payment-bundle-ui.test.mjs(신규) + parent-app-structure·gestalt-parent·parent-child-links-ui·scheduled-enrollment-ui | | |

💡 tester: 390px 에서 /mypage/payments/checkout(형제 2명·랠리즈 1건·입금 대기 1건), 상한 초과, ?result=fail, /mypage/payments/done?orderId= 새로고침. 실결제 금지 — 토스 테스트 키로만.
⚠️ reviewer: 브라우저 스크립트(test-parent-workspace-browser.mjs)는 실행 못 함(playwright·크롬 필요). 관리자 공지 편집이 선생님 JSON 공지를 쉼표로 다시 저장할 수 있음(표시는 정상).

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-09 | developer(원장 점검 «시간 수정 없음·드래그로 이동»): 관리자 정규 운행표 = 평소 보기만, 화면 위 [수정] → 편집 모드(카드마다 시각 칸·손잡이 ⠿ 끌기(터치=elementFromPoint, 손잡이만 touch-none)·▲▼ 보조·정류장 수정·×·학생 창), 편집 중 고정 줄(적용 범위 select·저장 안 됨·취소/저장). 바꾼 순서 있으면 창 열기 전 먼저 저장(편집 유지). RunBoard admin 편집 분기만 추가 — driver HTML 수정 전과 동일(일회 비교 4경우). 신규 tests/regular-run-edit-mode.test.mjs. tests 3615-0·shuttle 159-0·tsc 0·KST 가드 통과. 서버 변경 없음 | 완료 |
| 11-09 | tester(묶음 결제 전체 b6fa4781~a5fe8e6c): tsc 0·tests 3606-0·가드 통과, 화면 렌더+상호작용 45·홈 7·순수 함수 통과. 관찰: 입금 알림 상한·확인창 잔류·홈 버튼 문구 | 통과(관찰 3) |
| 11-09 | reviewer(묶음 결제 화면 a5fe8e6c·d90f40b2·b6fa4781 충돌부): 통과, 권장 N-1(관리자 편집 후 선생님 공지 재확인 실패)·C-1(금액 재대조·입금 알림 상한·문구) | 통과(권장 2) |
| 11-09 | developer 수정 1차(갈래 C 리뷰 권장 6건): 선생님 공지 재발송 확인 대상 반 두 모양(IN $3,$4)·결제창 전 금액 재확인(다르면 안내+새로고침)·상한이면 입금 알림도 막음·면세 문구·말투 «~요»·확인 창 닫기·bfcache 복귀 로딩 해제·홈 버튼 이름=결제 가능 건수·개시일 «12월 5일부터»·토스 실패 코드별 문구(tossFailMessage). tests 3610-0 | 완료(검수 대기) |
| 11-09 | developer(묶음 결제 화면 갈래 C + B 리뷰 반영): B·A·보안수정 cherry-pick 후 main 수강 기준(startsLater) 충돌 해결, /mypage/payments/checkout·done, 홈 청구 줄=청구 탭 기준·[한 번에 결제], 단건 KST·묶음 계좌 안내, 공지 대상 반 공용 파서·상세 ALL/CLASS만, 옛 해시→탭, 납부 신청 승인 MANUAL. tsc 0·tests 3606-0·studentVisibility·KST 가드 통과 | 완료(검수 대기) |
| 11-09 | developer(묶음 결제 갈래 A — 서버·데이터): PaymentTransactionItem(마이그레이션 20261109150000, 미적용)·checkoutBundle 규칙·bundleLedger(전부 아니면 전무·전액 취소 전부 환불)·확정/취소 묶음 갈래·승인 전 재확인·랠리즈 사본 차단(단건·묶음)·단건 열린 계좌 조회/닫기·마이페이지/관리자 lateral 이 항목까지 봄·API /api/mypage/payments/checkout·confirm·묶음 입금 알림. tsc 0·tests 3560-0·studentVisibility 5-0 | 검수 대기 |
| 11-09 | developer(학부모 화면 구조 갈래 B, 원장 D1 안 A·D6·D7·D8): 아래 탭/PC 메뉴 홈·일정·청구·소식(방학특강 탭 제거), 로그아웃 «⋯» 메뉴, 홈=납부 합계 한 줄+처리할 일+빠른 실행 4(접힌 칸 5개 제거), 일정=/mypage/history 확장(ScheduleHub), 소식=/mypage/reports 확장(공지·리포트·피드백·사진), 앱 안 공지 상세 /mypage/news/[id], KST toDateStr 2곳. 결제 서버 파일 무수정. tsc 0·tests 3540-0 | 검수 대기 |
| 11-09 | developer(정규 셔틀 통합 6단계 — 저장 노선 읽기 전부 명단으로): 학부모 확정 시각=명단 arriveTime(regularRosterEta+Logic, 그 달 이하 최신 명단 달) · 등원시간 안내 문자=명단 시각·정류장(저장 노선 필수 조건 제거, 지문=학생 명단 칸) · 배차 진행=명단 반영이면 배차 완료, 명단 지문과 같은 안내 전달 시 안내 완료 · 신청 검토 지문 routes=[] 고정(기존 지문 유지) · 결석·셔틀 기사 알림=그날 명단에 학생 있으면 기사 역할 전원(명단 변경 알림과 같은 조건) · 월 복사 명단만 · /api/shuttle/regular-order 명단만+ORM 제거(QA 11월 목 «다른 화면에서 변경» 해소 재현 확인). 남은 저장 노선 접근=/api/admin/regular/dispatch/saved(부르는 화면 없음). tsc 0·tests 3548-0·ts 195-0·KST 6-0 | 검수 대기 |
| 11-09 | developer(정규 셔틀 통합 4·5단계, 원장 «관리자 화면=기사님 화면·직접 수정»): /admin/shuttle/regular-dispatch 를 RegularRunEditor(RunBoard mode=admin + buildRegularRunRows, 월·요일 탭, ▲▼·끌기·시각 → 묶음별 reorder, 카드 «정류장 수정»=editStop, 학생 이름 → 셔틀 정보 창=editStudent, × → 이 칸/이 요일/전체 × 범위 DELETE, 카드 «반 이동·재배정» 표시) + RunEditDialogs 로 교체. 옛 RegularDispatchClient(자동 제안·T맵·차량 이동) 삭제·page 의 T맵/기사 조회 제거. 배정 필요 패널(신규·반 이동 칸 수, onBoard·openRequest) · AssignLegView 재배정 reassign:true+옛 칸 안내. 학생 상세 위치 placeName+requirePlaceName+명단 반영 안내. /staff/run?focus=BOARD|ALIGHT 스크롤(RunBoard focusKey). 5단계: regularRunRows·regularDriverRoute 저장 노선 입력·조회 제거(명단만, pending 끔), routeStatus API 항상 false. 흡수 비교(읽기 전용): 목 등원만 차이(노선 전용 학생 2명 사라짐·자이 후문 2정차 합쳐짐), 그 밖 요일 동일. tsc 0·tests 3553-0·가드 5-0·KST 6-0·shuttle 154-0 | 검수 대기 |
| 11-09 | developer(2단계 리뷰 S-1~S-3): 위치 이름=주소면 서버 거부 · 명단 잠금 tx 첫 쿼리+ReadCommitted · 재배정 옛 칸 = 시작 같음 또는 시간대 겹침(오탐 방지)+테스트 2 | 완료(커밋 683c5866) |
