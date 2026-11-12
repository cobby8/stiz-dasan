# 작업 스크래치패드

## 현재 작업
- **상태(2026-11-10)**: 검수 완료 7브랜치 통합 + 신청함 연결 A(상담 버튼)·B(휴원 승인 전 수강료 처리) — 통합 브랜치 worktree-agent-ad19b9c3dfc159299, 미푸시. 연결 A·B 는 검수 대기.
- ⚠️ **배포 전 필수**: 운영 apply_migration 4개(20261110150000 체험비 · 160000 상담 · 170000 학부모 알림 설정 · 180000 휴원 수강료). 130000 은 적용됨.
- 테스트 기준선(11-10 통합 후): tests 4006-0 · studentVisibility 5-0 · tsc 0 · prisma validate 통과

## 진행 현황
| 항목 | 상태 |
|------|------|
| 11-10 7브랜치 통합 + 신청함 연결 A·B | 통합 완료·연결 A·B 검수 대기·마이그레이션 4개 운영 미적용 |
| 색상 통합(1~7단계·마무리) | 완료(11-09) |
| UI 기능/UI 제거 46건 | 대기(원장 확인 필요 항목 다수) |

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

## 구현 기록 (developer) — 11-10 7브랜치 통합 + 신청함 연결 A·B
📝 통합 순서(각 --no-ff): ①학부모 알림·수업 탭·⚙설정·/api/push 매핑·직원 알림 ②결석 신고 즉시 보강권 ③상담 신청 ④신청함 6탭 ⑤POS 자동 납부 ⑥휴원 시작일·수강료 정산 ⑦체험비 온라인 결제·안내·Meta 픽셀 토큰 차단. 코드 충돌 0 — 충돌은 문서(합집합)·consult-inbox.ts(③ 실제 구현 채택)·ParentMoreMenu.tsx(① 삭제 유지, 상담 링크는 ⚙설정)뿐.

| 파일 | 변경 | 신규/수정 |
|------|------|----------|
| src/app/admin/inbox/InboxClient.tsx | A 상담 버튼(ref.actions 만·취소 확인·메모 초기값 adminNote·tel:) · B 휴원 승인 전 미리보기→방식 필수·{mode, expectedPreviewKey}·환불 확인 실패 경고 · «변경» 탭 남은 일 링크 | 수정 |
| src/app/admin/inbox/PauseSettlementBox.tsx | 미리보기·방식 고르기(수강 변경 화면과 같은 규칙·문구) | 신규 |
| src/app/actions/enrollment-changes.ts | getPauseTuitionPreview(관리자 전용, 실패=ok:false) | 수정 |
| src/app/admin/inbox/page.tsx · src/lib/requests/admin-inbox.ts | 변경 탭 countOpenPauseSettlements · 행 ref.changeKind | 수정 |
| tests/inbox-consult-pause-wiring.test.mjs · admin-inbox · consult-request | 연결 7건 · 스텁→실제 구현 시그니처 · 상담 링크=설정 화면 | 신규/수정 |

⚠️ 배포 전 운영 apply_migration 필요(전부 IF NOT EXISTS 멱등): 20261110150000_trial_fee_online_payment · 20261110160000_consult_request · 20261110170000_parent_notification_preference · 20261110180000_enrollment_pause_settlement (130000 은 적용됨). 선택: prisma/sql/backfill_makeup_credit_for_reported_absences.sql.
💡 tester: 신청함 상담 탭 → 새 상담 열기 → 메모 칸에 기존 메모·[취소][메모 저장][연락함][상담 완료]·전화 걸기 / 변경 탭 휴원(PENDING) 열기 → «계산하는 중» → 금액 있으면 방식 고르기 전 [승인] 잠김 → 고르면 «승인 · 환불» + 확인창 금액. 실토스 부분 취소는 테스트 키로 1건 확인 필요(⑥). 체험비 결제는 설정 «온라인 결제» 켜기+토스 키 있어야 보임(⑦).
⚠️ reviewer: 미리보기 지문 불일치로 승인 거절되면 칸을 닫았다 다시 열어야 재계산(자동 재조회 없음) · 신청함 휴원 규칙·문구는 수강 변경 화면과 두 벌(문구 비교 테스트로 묶음) · ②출결 «되살림» 동작 변경 · ⑦이미 확정된 신청에 온 결제 = NEEDS_REFUND.

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-12 | developer(청구 알림톡 2종): BILLING_ALIMTALK_TEMPLATES(청구서 발행=원장 승인 원문·미납=초안) + 버튼 «청구서 확인하기»(도메인 고정·#{청구서경로}) · sendInvoiceLinksForMonth/sendUnpaidReminders 연결(env ALIMTALK_TPL_BILLING_INVOICE/UNPAID 비면 지금 그대로·잠금 유지) · 발송부 alimtalk.text/buttons 선택 항목 · 문서·테스트(가짜 발송자) | 완료(검수 대기) |
| 11-10 | developer(연결 A·B 검수 권장 3건): 서버 강제(휴원 승인에 방식 없고 금액 있으면 «수강료 처리 방식을 골라 주세요(금액이 바뀌었어요)» 거절·needsSettlementChoice → 신청함 미리보기 재조회·수강 변경 화면 상세 칸 열기) · 상담 상태 버튼은 메모 안 고치면 note=undefined · problems 안내 문구 두 화면 공용 상수 · 판정 settlementChoiceRequired 공용 | 완료(미푸시) |
| 11-10 | developer(7브랜치 통합+연결): ①알림·설정→②보강권→③상담→④신청함 6탭→⑤POS 자동 납부→⑥휴원 수강료→⑦체험비 결제 merge(코드 충돌 0, 문서 합집합·consult-inbox=③·ParentMoreMenu 삭제 유지) · A 상담 탭 버튼 · B 휴원 승인 전 수강료 미리보기·방식 필수 · architecture 48→19 묶음 · 테스트 2건 시그니처 갱신 | 완료(미푸시) |
| 11-10 | developer(원장 k7·m5 머리줄·설정): ⋯→⚙ /mypage/settings(내 정보 이름 수정·연락처 보기, 비밀번호 바꾸기(현재 비번 재확인·비번 로그인만), 간편로그인, 자녀·가족 초대, 형제·자매 상담 링크, 알림 설정(휴대폰 알림+종류별 출결·청구·공지·셔틀), 글자 크기 3단(쿠키→layout html 배율), 문제 신고·문의(OTHER), 앱 정보, 로그아웃·탈퇴, 테마 숨김) · 🔔 ParentNotificationBell(배지 9+·시트/드롭다운·알림 설정 줄) · 홈 알림 칸 제거 · 종류별 거르기=pushNotification 한 곳(표 없으면 보냄) · 마이그레이션 20261110170000_parent_notification_preference(운영 미적용) · tests/parent-settings | 커밋(미푸시) |
| 11-10 | developer(원장 점검 k5·k6 학부모 보완): 알림 읽음=학부모 전용 actions/parent-notifications.ts(requireVerifiedParent·WHERE "userId"=로그인 사용자, 관리자 함수는 유지) · 알림 줄 전체 누름=읽음+내부 linkUrl 이동(safeInternalHref) · 수업 탭 반 카드→한 달 달력(ScheduleHub MonthCalendar 공용·getParentMonthViews)→신청 내역, «달력 ▸» 제거 · 버튼 [결석][보강][셔틀][변경 ▾] 한 줄(휴원 중=복귀 신청 유지) · 아이 선택 기억(?child=+localStorage, useRememberedChild/RememberChildSync — 홈·수업·일정) · tests 3827 pass | 커밋(미푸시) |
| 11-10 | developer(결석 신고 즉시 보강권 k4): 신고 순간 발급(키=기존 REGULAR:{반}:{날짜} 그대로라 출결·랠리즈와 1장) · 학부모 취소 = 미사용 회수/예약은 확인 후 예약 취소+회수/사용 완료·지난 예약은 막음 · 관리자 취소 = 기존 회수 규칙 · 출결 결석 확정이면 유지 · 출결 경로 REVOKED 되살림 · 문구 «보강권 1장이 생겼어요»(신고 직후·신청 내역·카톡). 마이그레이션 없음, 채움 SQL 선택(prisma/sql). tsc 0·tests 3843-0·studentVisibility 5-0 | 구현·검증 완료(검수 대기, 미푸시) |
| 11-10 | developer(상담 신청 신설): ConsultRequest 표+마이그레이션 20261110160000(운영 미적용) · /apply/consult(+/apply 세 번째 칸) · 챗봇 [ACTION:CONSULT] · 학부모 ⋯ 메뉴 «형제·자매 상담 신청»(/mypage/consult, 자동 채움) · 관리자 벨·웹푸시 · consult-inbox.ts(신청함 상담 탭) · 처리 액션(requireAdmin). tsc 0·tests 3841-0·studentVisibility 5-0 | 검수 대기(미푸시) |
| 11-10 | developer(원장 k1~k4·m1~m3 신청함 재편): 맨 위 6탭(체험·수강·상담·대관·변경·기타, 배지=처리 필요) · catalog KIND_TAB/TAB_SUBS/tabActionCounts · 체험·수강(신청/대기)=ApplyAdminClient mode 끼우기 · 대관=RentalAdminClient embedded(처리할 것 먼저·완료 보기) · 변경·기타=공통 한 줄(처리 필요→진행 중, «완료 보기»), 필터=날짜만 · 진행 중 처리 버튼(보강 4종·결석 신고 취소) · 학부모 연결(CHILD_LINK) 추가 · 현장 수납 승인 기타 탭 유지(PM 정정) · 상담=CONSULT catalog+consult-inbox.ts 스텁(상담 브랜치 계약) · ⚙ 신청 설정(/admin/inbox/settings) · 메뉴 «신청·상담» 제거. tsc 0·전체 3831-0 | 완료(커밋, 미푸시) |
| 11-10 | developer(현장 수납 승인 자동화, 원장 m1 «POS 확인되면 끝»): 번호 없는 POS 카드 결제 중 AUTO_CANDIDATE(메모 이름 1명 정확 일치+그 달 미납 1건 금액 일치)는 슬랙 버튼 없이 자동 납부(새 공용 핵심부 lib/pos/paymentNoticePay.ts — 버튼·자동이 같은 재확인 SQL 조각·markPaymentPaid 1곳, 자동은 SYSTEM·pos-notice-auto:id). 자동 전용 보류 조건 = 직원 현금·계좌 확인 대기·현장 결제 요청 PENDING/SENT/HELD/PAID·랠리즈 사본 → DM 버튼 그대로. 직원 현금·계좌 확인 요청(StaffPaymentConfirmationRequest)은 POS 근거가 없어 승인 유지(선택지 보고). 마이그레이션 없음. tsc 0·tests 3828-0·studentVisibility 5-0. **검수 후속**: 납부를 markPaymentsPaidTogether(1건, 미납+금액 그대로)로 → 0행이면 선점 해제+«이중 수납 확인 필요»(버튼 경로 공통) · 처음 DM 실패한 자동 납부는 결과 전용 DM(slackTs SENDING 선점, 스윕 재시도) · 납부 반영 뒤 POS 취소면 원장 DM+관리자 알림 벨 1회(advisory lock+감사 기록 POS_NOTICE_CANCELLED_WHILE_PAID, 청구 되돌리지 않음). tests 3837-0. **권장 3건**: CONFLICT=알림 닫힌 채(CONFIRMED·SYSTEM:conflict·error CONFLICT:)+감사 POS_NOTICE_PAID_ELSEWHERE+알림 벨(DM 없으면 결과 DM) · 취소 판정=CANCELLED_PAYMENT_STATES+PARTIAL_CANCEL(L)ED · 현장 결제 요청 묶인 주문·결제는 취소 경고 제외. tsc 종료 0·tests 3840-0 | 검수 대기(미푸시) |
| 11-10 | developer(휴원 시작일 자유 + 승인 시 수강료 처리 m6): 시작일 오늘(수업 전)/내일~3개월 · 이월·환불·없음 자동 계산·실행(토스 부분 취소 신설·현금/랠리즈/POS=할 일·미납 감액·이월 다음 청구 차감) · 알림 «○원 예정». tsc 0·tests 3841-0·studentVisibility 5-0. ⚠️ 마이그레이션 20261110180000 운영 미적용 | 검수 대기(미푸시) |
