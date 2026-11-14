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

### 구현 기록 (developer · 11-15 부상·질병 기간 결석 1b 승인 분리, claude/illness-period-approve)
📝 구현한 기능: 신청함 «부상 결석(기간)» 한 줄(기간 1건 = 1줄) + 금액 없는 [부상 결석 승인]·[승인 취소] + 하루씩 이월 승인 가드 + 학부모 상태 글자

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| prisma/migrations/20261116100000_absence_period_carry_state/migration.sql · prisma/schema.prisma | RegularAbsencePeriod 칸 6개·CHECK·부분 색인(운영은 PM 이 적용함) | 신규/수정 |
| src/lib/regular/illnessPeriodRules.ts | 상태 상수(PERIOD_CARRY_STATES)·문구·기간 글자·공용 SQL 조각 | 신규 |
| src/lib/regular/illness-period-admin.ts · src/app/actions/illness-period-admin.ts | 승인(NONE→APPROVED)·승인 취소·상세 읽기 + 서버 액션(requireAdmin) | 신규 |
| src/lib/regular/absence-period-service.ts | periodCarryColumnsReady(6칸 확인) | 수정 |
| src/lib/requests/catalog.ts · admin-inbox.ts | 종류 ILLNESS_PERIOD + ILLNESS_CARRY 에서 질병 기간 결석 제외 + 칸 없는 DB 용 식(beforePeriodCarry) | 수정 |
| src/app/admin/inbox/IllnessPeriodInboxDetail.tsx · InboxClient.tsx | 상세 칸(증빙 확인 체크 → 승인, 승인 뒤 승인 취소) | 신규/수정 |
| src/lib/billing/workbench-absence.ts | 결석을 찾은 직후 기간 가드 7줄(근거·적립부는 안 건드림) | 수정 |
| src/lib/regular/illness-carry-cron.ts | 승인된 기간의 결석은 7일 자동 전환 후보에서 제외 | 수정 |
| src/lib/regular/parent-regular-absence.ts · parent-absence-period.ts · mypage/regular-absence/RegularAbsenceClient.tsx | 학부모 글자 «부상 결석 인정 · 금액은 복귀 뒤 확정», 여러 날 질병 알림 링크 → 기간 줄 | 수정 |
| tests/illness-period.test.mjs(신규 20건) · billing-workbench·illness-carry·request-catalog·list-stage8b 테스트 | 실행 테스트 | 신규/수정 |

💡 tester 참고: 신청함 › 변경 › 결석·보강에서 윤수영이 16줄이 아니라 «부상 결석 11/6 ~ · n회 · 사진 n장» 1줄 → 상세에서 체크 후 [부상 결석 승인] → «진행 중»으로 이동·상태 «인정 · 금액은 복귀 뒤» → [승인 취소]로 «승인 대기» 복귀. 승인 뒤 청구 준비의 결석 정산에서 그 기간의 날짜를 이월 처리하면 «기간 정산에서 한 번에 처리합니다»로 거절. 미래 날짜·그 달 청구 미발행·저장 스위치 꺼짐에서도 승인돼야 정상.
⚠️ reviewer 참고: 새 SQL 은 실제 Postgres 에서 못 돌렸다(가짜 DB 실행만). 승인 때 학원 등록 기간의 결석에는 검토 줄을 새로 만든다(source STAFF) — 승인 취소하면 그 줄이 «검토 중»으로 남는다. 승인 뒤 복귀 처리로 취소된 날의 검토는 APPROVED 로 남는다(3단계 정산에서 정리 필요).

#### 수정 이력
| 회차 | 날짜 | 수정 내용 | 수정 파일 | 사유 |
|------|------|----------|----------|------|
| 1차 | 11-15 | «보강권으로 전환»(기간의 결정 전인 날 일괄) 추가 · 승인 때 거둔 보강권 id·새 검토 줄 id 를 carrySettlement.approval+감사 기록에 남기고 승인 취소 때 되돌림 · 취소된 결석의 승인 검토는 닫음 · 보강 예약/사용한 날은 승인 대상 제외 · 가드에 질병 사유 조건 · 학부모 글자를 기간 상태 기준으로 · 정산 시작일 상수화 · 알림 24시간 중복 방지 | illness-period-admin.ts · actions/illness-period-admin.ts · IllnessPeriodInboxDetail.tsx · illnessPeriodRules.ts · parent-regular-absence.ts · workbench-absence.ts · tests | reviewer 필수 1 + 권장 5 + 보안 LOW |

### 구현 기록 (developer · 11-15 부상·질병 기간 결석 2단계 청구 발행 보류, claude/illness-billing-hold)
📝 구현한 기능: 승인됐고 금액 미확정인 부상 결석 기간이 있는 아이는 청구 준비에서 발행 보류 + 이미 발행된 미납 청구를 원장이 «발행 보류로 돌리기» + 학생 상세·학부모 결제 화면 상태 한 줄. DB 스키마 변경 없음.

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| src/lib/regular/illnessPeriodRules.ts | 보류 판정 조각(illnessHoldPeriodSql·illnessBillingHoldSql)·글자·건너뛰는 이유·held 기록 꺼내기 | 수정 |
| src/lib/billing/workbench-service.ts · workbench.ts | 보류 읽기(기간 시작 달 이후) → 차단 사유 맨 앞·hold/holdPeriodId·지문(보류 0건이면 키 없음 = 예전 지문 그대로) | 수정 |
| src/lib/regular/illness-period-admin.ts | readIllnessPeriodBillingHold(미리보기)·holdIssuedBillsForPeriod(실행)·readStudentName · 승인 취소: heldBills 반환·보강권 되돌림에 출석 조건 | 수정 |
| src/app/actions/illness-period-admin.ts | loadIllnessPeriodHold(금액은 원장만)·holdIllnessPeriodBillsAction(requireOwner)·알림 본문 아이 이름 | 수정 |
| src/app/admin/inbox/IllnessPeriodInboxDetail.tsx · InboxClient.tsx · page.tsx | 보류 칸·«발행 보류로 돌리기»(확인 창) · «?kind=…&open=id» 로 상세 열기 | 수정 |
| src/app/admin/finance/prepare/BillingWorkbench.tsx | «발행 보류 n» 요약·필터·행 글자·선택 불가·신청함 이동 | 수정 |
| src/app/admin/students/[id]/AbsencePeriodPanel.tsx · absence-period-service.ts | 기간 줄에 «부상 결석 중 · 청구 보류»(billingHold) | 수정 |
| src/app/mypage/payments/* · src/lib/payments/parent-payment-request.ts | 학부모 결제 화면 보류 안내 한 줄(getParentBillingHolds) | 수정 |
| src/lib/requests/catalog.ts · admin-inbox.ts | 신청함 상태 APPROVED_HOLD «인정 · 발행 보류 중» | 수정 |
| src/lib/regular/parent-regular-absence.ts | getParentIllnessReviews 한도 30 → 200 | 수정 |
| tests/illness-billing-hold.test.mjs(신규 16건) · billing-workbench(+6)·illness-period·payment-bundle-ui·rallyz-mirror-release · billing-workbench-postgres.integration | 실행 테스트 + 로컬 Postgres 31개 | 신규/수정 |

💡 tester 참고: ① 신청함에서 부상 결석 승인 → 청구 준비(그 기간 시작 달 이후)에서 그 아이 행이 «부상 결석 중 · 발행 보류»·체크 불가, 요약 «발행 보류 n», 필터 «발행 보류(부상 결석)», 글자를 누르면 신청함 기간 상세가 열림 ② 승인된 기간 상세에 «이미 발행된 미납 청구 n건 ○원» → [발행 보류로 돌리기](원장만, 부원장은 건수만) → 수납 관리에서 그 청구 «취소», 청구 준비 행은 보류 ③ 학부모 결제 화면에 «○○ · 부상 결석 중이라…» 한 줄, 취소된 청구는 안 보임 ④ [승인 취소] → 청구 준비에 «확인 필요»로 다시 나와 저장→확정→발행하면 새 청구 1건. 주의 입력: 학부모가 30분 안에 결제창을 연 청구·현장 결제 요청 중·이월을 쓴 청구는 건너뛰고 이유가 보여야 한다.
⚠️ reviewer 참고: 초안 ISSUED→DRAFT 는 처음 생긴 전이(BillingWorkbenchRevision action 'HOLD' — 운영 표에 action CHECK 가 없는지 확인 필요, 준비 파일 workbench-schema.sql 에는 없음). 보류 범위가 둘이다 — 청구 준비는 «학생 단위», 보류 전환은 «기간 대상 반(classIds)». 수납 관리의 직접 발행(createPayment)은 보류 학생도 막지 않는다(원장이 일부러 하는 길). getParentBillingHolds·listAbsencePeriodsInDb 의 완성된 문장은 실제 DB 에서 못 돌렸다(조각은 돌림).

### 구현 기록 (developer · 11-15 학부모 여러 날 결석, claude/absence-period-parent)
📝 구현한 기능: 학부모 «결석 알리기 › 여러 날»(4주 한도·모든 사유) + 관리자 «기간 결석 등록» 빠른 입구 + 이월 재검수 권장 ②~⑤

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| prisma/migrations/20261115100000_parent_absence_period · schema.prisma | RegularAbsencePeriod 칸 3개(되돌림 주석) | 신규/수정 |
| src/lib/regular/parentAbsencePeriodRules.ts · parent-absence-period.ts · api/mypage/regular-absence/period | 규칙·서비스·API | 신규 |
| src/app/mypage/regular-absence/PeriodAbsencePanel.tsx · RegularAbsenceClient.tsx · page.tsx | 하루/여러 날 선택·미리보기·복귀했어요 | 신규/수정 |
| src/lib/regular/absence-period-service.ts · parent-regular-absence.ts · illness-*.ts · requests/admin-inbox.ts · operational-notification-reconciliation.ts | 관리자 기간과 분리·저장 함수 공용·증빙 기간 묶음·알림 재조정 | 수정 |
| src/components/admin/AbsencePeriodQuickCreate.tsx · admin/absence · admin/students(⚡) · AbsencePeriodPanel · inbox 상세 | 빠른 입구·학부모 신고 표시·같은 기간 함께 승인 | 신규/수정 |

💡 tester 참고: 마이그레이션 적용 «전»은 «하루/여러 날» 선택이 안 보이고 나머지는 그대로. 적용 «후» 여러 날 → 미리보기(휴무일·이미 알린 날 제외) → n회 알리기 → 날짜마다 보강권(또는 이월 검토), 원장 알림 1통. 주의 입력: 29일째 끝일(휴원 안내)·끝일 미정·형제·마감 지난 오늘 수업·보강 예약된 날이 낀 «알림 취소».
⚠️ reviewer 참고: ① 새 SQL 은 실제 Postgres 미실행 ② 학부모 기간은 status ACTIVE 로 남는다(끝일이 지나도 — 목록은 날짜로 거른다) ③ 관리자 등록의 겹침 검사가 학부모 기간도 본다 ④ 증빙 묶음 SQL 조각을 안 쓰는 새 조회가 생기면 기간의 다른 날이 «사진 없음»으로 전환된다.

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

### 구현 기록 (developer · 11-14 학부모 5단계, claude/parent-step5-enroll-shuttle)
📝 구현한 기능: c2 승인된 휴원·퇴원 «취소 요청» 한 번에 · c8 «반 추가» 신청 · c5 셔틀 «계속 바꾸기» 신청

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| src/lib/enrollment/parentChangeStatus.ts · requests/parent-timeline-rules.ts · enrollment/parent-change-request.ts | c2 판정·문구 한 곳, «예정»에 신청 번호·취소 요청 상태 | 수정 |
| src/lib/enrollment/classAddRules.ts · parent-class-add.ts · admin-class-add.ts | c8 규칙·접수·승인(수강 등록) | 신규 |
| src/lib/enrollment/admin-change-request.ts · change-decision-notify.ts · changeRequestRules.ts · requests/admin-inbox.ts · parent-timeline.ts | c8 승인 연결·이름·표시 | 수정 |
| src/app/mypage/enrollment-change(page·EnrollmentChangeClient) · api/mypage/enrollment-change · admin/enrollment-changes/EnrollmentChangesClient | c2·c8 화면 | 수정 |
| prisma/migrations/20261115120000_shuttle_regular_change_request · schema.prisma | c5 새 표(되돌림 주석·RLS) | 신규/수정 |
| src/lib/shuttle/regularChangeRules.ts · regularChangeRequest.ts · regularRosterEdit.ts(onlyWeekdays) | c5 규칙·접수·승인·적용 | 신규/수정 |
| src/app/mypage/shuttle/regular(page·RegularChangeClient) · mypage/shuttle(page·ShuttleExceptionClient 입구 한 줄) · api/mypage/shuttle-regular | c5 학부모 화면 | 신규/수정 |
| src/app/admin/shuttle/regular(page·RegularChangeRequestsPanel) · actions/shuttle-regular-change.ts · api/cron/enrollment-changes | c5 원장 승인 목록·적용일 처리 | 신규/수정 |
| tests/enrollment-class-add · shuttle-regular-change (+기존 4개 보강) | 35건 신규 | 신규/수정 |

💡 tester 참고: c2 = 수강 변경 화면 «○○ 예정» 상자의 «취소 요청»(확인 1회) → 한 줄로 바뀜·수업 탭과 같은 문구. c8 = 종류 칩 «반 추가» → 학년 맞는 반·시작일 → «검토 중» 줄·취소 → 원장 승인 시 바로 수강 등록(정원 차면 승인 막힘). c5 = 마이그레이션 «전»은 입구가 안 보인다. «후» 셔틀 변경 › 계속 바꾸기 → 신청 → /admin/shuttle/regular 맨 위 승인 → 적용일에 정류장 이름 변경. 주의 입력: 형제·휴원 중인 반만 있는 아이·정원 찬 반·오늘 날짜·요일 한정·이용 시작/중단.
⚠️ reviewer 참고: ① 새 SQL 은 실제 Postgres 미실행 ② 운영 EnrollmentChangeRequest.kind 에 CHECK 가 있으면 CLASS_ADD 접수가 실패(표 생성 SQL 이 저장소에 없음 — 적용 전 확인) ③ 반 추가는 enrollmentId NULL — enrollmentId 로 묶는 조회에는 안 잡힌다 ④ c5 이용 시작·중단은 명단을 자동으로 안 바꾼다(원장이 고치면 닫힘) ⑤ applyLocationToRosterInTx 6번째 인자 추가(기본 동작 불변).

### 구현 기록 (developer · 11-14 학부모 5단계 claude/parent-step5-inquiry)

📝 구현한 기능: 보낸 문의 다시 보기·이어 쓰기(c3) · 소식 사진 앱 안 크게 보기(c4) · 지난 공지·연간 일정(c10) · 앱 안 «신청» 메뉴(c9) · 환불 문의(c11)

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| prisma/migrations/20261115110000_parent_request_thread · schema.prisma | ParentRequestMessage(RLS FORCE) + ParentRequest.paymentId·paymentAmount | 신규/수정 |
| src/lib/requests/inquiryThreadRules.ts · inquiry-thread.ts · actions/parent-inquiry.ts | 대화 규칙 / DB / 서버 동작(이어 쓰기·학원 답·환불 문의) | 신규 |
| mypage/requests(page·[id]·InquiryReplyForm) · components/parent/InquiryThread | 보낸 문의 목록·대화 | 신규 |
| admin/requests/RequestsAdminClient · admin/inbox/InboxClient · lib/requests/admin-inbox | 대화 표시·답변 이어 쓰기 | 수정 |
| mypage/news/page · mypage/annual/page · lib/mypage/parentNotices · parentSchedule | 지난 공지·연간 일정 | 신규/수정 |
| mypage/apply · rental · seasonal/apply/** · components/parent/ParentEmbeddedPublic · lib/mypage/parentApplyMenu·parentApplyPrefill · app/rental/RentalGuide | 앱 안 신청 | 신규 |
| components/seasonal/Seasonal{List,Detail,Apply}Client · app/rental/RentalClient·page | basePath·homeHref 선택 속성(기본값 그대로) | 수정 |
| mypage/MyPageClient·page · settings/page · reports/page · history/ScheduleHub · MyPageBottomNav · payments/PaymentRequestClient | 입구·사진·환불 문의 | 수정 |

💡 tester 참고: `node --test tests/parent-inquiry-thread.test.mjs tests/parent-news-annual.test.mjs tests/parent-apply-menu.test.mjs`. 마이그레이션 적용 «전»: 대화는 첫 글+옛 답변만·학부모 이어 쓰기는 «새 문의» 안내·학원 답은 adminNote 에 저장·환불 문의는 청구 연결 없이 접수. 주의 입력: 2,000/2,001자 · 남의 문의 id 주소 직접 입력(404) · 종결된 문의에 이어 쓰기(대기중 복귀) · 같은 청구 환불 문의 두 번 · 지난 공지 ?page=0/99/abc · 형제 계정의 특강 신청서(아이 칸 비움).
⚠️ reviewer 참고: ① 새 SQL 은 실제 Postgres 미실행 ② 앱 안 대관·특강 화면은 공개 테마를 /mypage 틀 안에 겹쳐 그린다 — 모양·하단 고정 바 위치는 실기기 확인 필요 ③ 요청함 답변 칸은 이제 빈칸으로 열린다(예전엔 저장된 답을 고쳐 덮어씀).

### 구현 기록 (developer · 11-14 묶음 B 지각·조퇴·자차, claude/late-early-selfdrive)

📝 구현한 기능: 학부모 «결석 알리기»에 «늦어요 · 일찍 가요»(예상 시각) · 조퇴/지각 날 셔틀 «안 타요» 연결 · 셔틀 변경 «안 타요» → 자차 문구 · 기사 화면 «자차·조퇴·지각» 표시 + 탑승·미탑승 잠금 · 선생님 출석부 «지각 예정 17:20»

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| prisma/migrations/20261115140000_regular_arrival_notice/migration.sql · schema.prisma · studentMerge/tables.ts | 표 RegularArrivalNotice(RLS·권한 회수) | 신규/수정 |
| src/lib/regular/arrivalNoticeRules.ts · parent-arrival-notice.ts · arrival-notice-read.ts | 규칙(순수)·알리기/취소·읽기 | 신규 |
| src/app/api/mypage/regular-absence/arrival/route.ts · mypage/regular-absence/ArrivalNoticeArea.tsx · RegularAbsenceClient.tsx | 학부모 API·화면 | 신규/수정 |
| src/lib/shuttle/{parent-shuttle-exception,regularDriverRouteLogic,unifiedDriverRunLogic,dayExceptionRules}.ts · components/shuttle/UnifiedDriverClient.tsx | 기사 화면 사유 글자·잠금, 학부모 자차 문구 | 수정 |
| src/lib/staff-session-queries.ts · staff/sessions/[sessionId]/SessionInProgressClient.tsx | 출석부 줄 표시(배지 1개 추가) | 수정 |

💡 tester 참고: 실행 테스트 tests/arrival-notice.test.mjs(20건 — 시간 경계·자정·보강권 미발급·조퇴+하원 셔틀·기사 잠금·화면 부품). 운영 DB 에 표가 없으면 «늦어요 · 일찍 가요» 입구만 숨는다(다른 화면 그대로).
⚠️ reviewer 참고: ① 기사 화면 잠금은 화면만(체크 저장 서버는 건드리지 않음 — 다른 작업 영역) ② 알림에 딸린 셔틀 SKIP 은 셔틀 «1시간 전» 마감을 적용하지 않음 ③ 결석을 알린 날은 지각·조퇴 표시가 읽는 쪽에서 가려짐(행은 남음) ④ 방학특강·카카오 대화·관리자 출결 화면은 미적용
### 구현 기록 (developer · 11-14 셔틀 탑승 알림 묶음 A, claude/shuttle-board-notify)
📝 구현한 기능: 셔틀 «탔어요·내렸어요» 알림 · «수업 종료» 출결 스위치 · 홈 «오늘 셔틀» 실제 시각 · 관리자 출결 저장 알림 규칙 통일 · 가입 안내문 문구

| 파일 경로 | 변경 내용 | 신규/수정 |
|----------|----------|----------|
| src/lib/shuttle/boardingNoticeRules.ts · boardingNoticeSweep.ts · api/cron/push-outbox/route.ts | 탑승 알림 규칙(순수)·훑기·크론 연결 | 신규/수정 |
| src/lib/attendance/attendanceNoticeRules.ts · actions/staff-sessions.ts · actions/admin.ts(saveAttendance) | 출석 알림 규칙 한 곳, 선생님·관리자 공용 | 신규/수정 |
| src/lib/shuttle/parent.ts · lib/mypage/summary.ts · app/mypage/MyPageClient.tsx | 홈 «오늘 셔틀» 실제 시각 | 수정 |
| src/lib/mypage/parentSettings.ts · lib/customer-notice/templates.ts | CLASS_COMPLETED=출결 · «결석 알리기» | 수정 |
| tests/shuttle-boarding-notice(신규 17건) · staff-session-completion-policy · staff-session-review · staff-attendance-toggle · parent-signup-guide | 테스트 | 신규/수정 |

💡 tester 참고: 기사 화면에서 «탑승» → 1분 뒤 대표 보호자 앱 알림(등원 줄 «셔틀에 탔어요», 하원 줄 «셔틀에서 내렸어요»). 1분 안에 되돌리거나 미탑승으로 고치면 안 옴. 보낸 뒤 고쳐도 정정 알림 없음. 설정 «셔틀» 끄면 휴대폰 울림 없음(종 목록에는 남음). 관리자 출결: 오늘 수업에서 상태가 바뀐 출석·지각 아이만 «○○ 학생이 출석했습니다», 같은 저장 반복·지난 날짜는 조용. 주의: 형제·보호자 없는 아이·방학특강 미전환 신청·자정 직후.
#### 수정 이력
| 회차 | 날짜 | 수정 내용 | 수정 파일 | 사유 |
|------|------|----------|----------|------|
| 1차 | 11-14 | 관리자 출결 알림: 수업 시작 전 저장은 알리지 않음(classStarted·startsAtMs) · 응답 뒤(after)·한 명씩 차례로 · 학부모를 학생으로 바로 찾기 / ShuttleBoarding.checkedAt `@db.Timestamptz(6)` 표기 | attendanceNoticeRules.ts · actions/admin.ts · schema.prisma · tests/shuttle-boarding-notice | 검수 권장 4건 |

⚠️ reviewer 참고: ① 새 SQL 2개 실제 Postgres 미실행 ② ShuttleBoarding.checkedAt 은 운영 timestamptz 확인(11-14) — 코드는 초(EXTRACT EPOCH)로만 비교 ③ 30분 한도는 내가 넣은 안전장치(배포 직후·크론 장애 뒤 몰아 보내기 방지) ④ 관리자 방학특강 출결도 같은 규칙으로 바꿈(예전 «방학특강 출석이 기록되었습니다» 전원 발송 제거).

---

### 리뷰 결과 (reviewer · 11-15 앱 간편로그인 연결 A안, claude/app-link-handoff)

📊 종합 판정: 수정 필요(필수 1)

✅ 잘된 점: 웹(앱 아님) 경로 무회귀(mode=client·via 없으면 기존 함수 그대로) · 발급 실패 catch→옛 숨김 폴백 · raw SQL 만·조건부 UPDATE 원자 소비·hash 저장 · @supabase/ssr 0.8.0 확인: code-verifier 는 즉시 setAll, 세션은 SIGNED_IN 이벤트로 setAll, getItem 이 setItems 먼저 읽어 verifyOtp→linkIdentity 같은 클라이언트 OK · 유니버설/앱 링크 경로에 /auth/link-handoff 없음 · 아이콘·hex·800/900 없음 · KST 금지 패턴 없음 · node --test 38-0

🔴 필수 수정:
- src/app/auth/link-handoff/page.tsx:22 `referrer: "no-referrer"` + start/route.ts:39 Origin 검사 → Fetch 규격상 referrer policy 가 no-referrer 인 문서의 POST 는 같은 출처여도 `Origin: null` 을 보낸다(Chrome·Firefox, Rails 의 유명한 CSRF 오류 사례). 그러면 [계속]이 항상 «이 화면에서 바로 시작할 수 없어요»로 끝나 기능 전체가 막힌다. 수정: 확인 화면 referrer 를 `same-origin`(또는 `strict-origin`)으로 바꾸거나, Origin 이 "null" 일 때 `Sec-Fetch-Site: same-origin` 을 대안으로 받기. 실기기(안드 Chrome·iOS Safari)로 확인 필수.

🟡 권장 수정:
- start/route.ts:69~89 — verifyOtp 뒤 사용자가 카카오/구글 화면에서 창을 닫거나 뒤로 가면 콜백이 안 와서 휴대폰 브라우저에 학부모 로그인(갱신 토큰)이 그대로 남는다. 확인 화면 문구 «자동으로 로그아웃됩니다»와 어긋남. 완화안: done/확인 화면 재방문 시 signOut, 또는 linkIdentity URL 받은 직후 세션 쿠키만 지우고 code-verifier 는 남기기(동작 검증 필요).
- 같은 이유로 1회용 표 = 10분짜리 «로그인 열쇠»다(연결뿐 아니라 그 브라우저 전체 로그인·타인 소셜 연결 가능). 노출 경로는 앱 화면뿐이라 낮음이지만 문서·주석에 명시 권장. 연결 알림(SOCIAL_LOGIN_LINKED)은 유지돼 있어 좋음.
- 바깥 브라우저가 이미 다른 계정(가족)으로 로그인돼 있으면 verifyOtp 가 덮고 콜백에서 로그아웃 → 그 브라우저의 원래 로그인이 사라진다(안내 문구 정도).
- LinkProviderButton.tsx:151 visibilitychange 마다 router.refresh → 매번 표 1~3행 INSERT(이전 표는 10분간 계속 유효). 정리 크론이 있어 치명적이진 않음.
- start/route.ts:56 getEnabledParentOAuthProviders 예외 시 표는 이미 소비된 채 500 — try/catch→"failed" 권장.
- iOS NavigationPolicy: paymentActive 중이면 apex 링크가 .paymentPage 로 웹뷰 안에서 열린다(드문 경우).
- 테스트 대부분이 소스 문자열 정규식 확인이라 위 Origin:null 같은 실제 동작은 못 잡는다(규칙 함수 실행 테스트는 의미 있음).

---

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-15 | developer(부상·질병 기간 결석 2단계 청구 발행 보류, claude/illness-billing-hold): 청구 준비 보류(차단 사유·hold·지문)·이미 발행된 미납 청구 «발행 보류로 돌리기»(원장만, 결제 진행 중 등은 건너뜀)·학생 상세/학부모 결제 화면 한 줄·신청함 «인정 · 발행 보류 중»·1단계 숙제 3건. tsc 0 · tests 5484-0 · guards 337-0 · 로컬 Postgres 31개 통과. 스키마 변경 없음 | 검수 대기 |
| 11-15 | developer(부상·질병 기간 결석 1b, claude/illness-period-approve): 신청함 기간 한 줄(ILLNESS_PERIOD)·금액 없는 승인/승인 취소·하루씩 이월 가드·7일 자동 전환 제외·학부모 글자. tsc 0 · tests 5422-0 · guards 337-0. 새 SQL 실제 Postgres 미실행 | 검수 대기 |
| 11-14 | developer(묶음 B 지각·조퇴·자차, claude/late-early-selfdrive): 학부모 «늦어요 · 일찍 가요»(RegularArrivalNotice, 지각=시작 전·조퇴=끝나기 전, 보강권 없음, 원장·담당 선생님 앱 알림) · 조퇴/지각 날 셔틀 SKIP 연결 · «안 타요»→자차 문구 · 기사 화면 «자차·조퇴·지각» 뱃지+버튼 잠금(화면만) · 출석부 «지각 예정 17:20». tsc 0 · tests 5312-0 · guards 337-0. 마이그레이션 20261115140000(changeCount 포함) 운영 미적용. 2차(보안·리뷰 반영): 하루 변경 5회 상한 · 기존 셔틀 변경 있으면 묻지 않음 · 홈/아이 기록/카카오 자차 문구 · 먼 날짜 셔틀 안내 | 재검수 대기 |
| 11-14 | developer(셔틀 탑승 알림 묶음 A, claude/shuttle-board-notify): 셔틀 «탔어요·내렸어요» 앱 알림(탑승 체크 1분 뒤·30분 한도·대표 보호자·정규+방학특강·SHUTTLE_ 이벤트, push-outbox 크론 훑기) · «수업 종료»를 «출결» 스위치로 · 홈 «오늘 셔틀» 실제 시각(탑승 08:52·하차 18:40) · 관리자 출결 저장 알림 = 선생님과 같은 규칙 함수(바뀐 아이만·출석/지각만·오늘만·한 번만, «출결이 기록되었습니다» 전체 발송 제거) · 가입 안내문 «결석 알리기». DB 변경 없음. tsc 0·tests 5284-0·guards 337-0. 새 SQL 2개(훑기·홈 시각) 실제 Postgres 미실행 | 검수 대기 |
| 11-14 | developer(재검수 권장, claude/merged-carry): 휴원 수강료 «남은 이월» 차감 대상을 처리 기록의 학생 + 병합된 대표 학생(mergedIntoStudentId 따라가기, 5단계) 청구로 넓힘(pause-settlement.ts CARRY_TARGET_STUDENTS_SQL) · 병합 결과(PairResult.carryNotice)에 «남은 이월 ○원은 대표 학생 청구에서 차감됩니다» 한 줄 · 관리자 수강 변경 화면은 신청 id 로 읽어 이미 보임(변경 없음). tsc 0·tests 5267-0·guards 337-0. 새 SQL(재귀 CTE) 실제 Postgres 미실행 | 검수 대기 |
| 11-14 | developer(학부모 5단계, claude/parent-step5-inquiry): 보낸 문의 화면·대화·이어 쓰기(ParentRequestMessage, 관리자 요청함·신청함 답변 이어 쓰기, 앱 알림만) · 소식 사진 앱 안 크게 보기 · 지난 공지(/mypage/news 20건씩)·연간 일정(/mypage/annual) · 앱 안 «신청» 메뉴(유니폼=본사 쇼핑몰 바깥 링크, 대관·방학특강=공개 부품을 /mypage 아래에서) · 청구 탭 «환불 문의»(청구 id·금액 연결). **마이그레이션 20261115110000 운영 미적용**(없어도 동작). tsc 0·tests 5202-0·guards 82-0. 새 SQL 실제 Postgres 미실행·앱 안 신청 화면 실기기 미확인 | 검수 대기 |
| 11-14 | developer(학부모 5단계, claude/parent-step5-enroll-shuttle): c2 수강 변경 화면에서 승인된 휴원·퇴원 «취소 요청» 한 번에(708ae954) · c8 «반 추가» 신청 — 학년 맞는 반·정원 차면 대기·원장 승인 때 수강 등록(6a00d594) · c5 셔틀 «계속 바꾸기» — 신청→원장 승인→적용일 명단 반영, 이용 시작·중단은 같은 목록(7fab2086). **마이그레이션 20261115120000 운영 미적용**(없으면 입구만 숨김). tsc 0·tests 5204-0·guards 82-0. 새 SQL 실제 Postgres 미실행 | 검수 대기 |
| 11-14 | developer(학부모 문구 정리, claude/parent-copy-cleanup): 원장 결정표 d1~d7 — 이름 통일(결석 알리기·셔틀 변경·보강 예약)·맨 아래 계정 링크 줄 삭제(설정 «계정» 묶음으로)·역할 신청 링크 제거·옛 기록 안내 삭제·빈 칸/«○○ 확인 중» 줄 숨김·셔틀 알림 결과 한 줄. 학부모용 셔틀 라벨 분리(PARENT_SHUTTLE_*), 가드 tests/parent-copy-names-guard. 미완: 수강 변경 «취소 요청»은 신청 내역으로 가는 버튼(조회에 신청 id 없음) | tsc 0 · fail 0 |
| 11-15 | developer(학부모 여러 날 결석, claude/absence-period-parent): 이월 재검수 권장 ②~⑤(564ce9bc) + 학부모 «결석 알리기 › 여러 날»(4주·모든 사유, 날짜마다 saveReportedAbsenceInTx·알림 기간당 1회·복귀했어요/알림 취소·끝나기 전 앱 알림) · 질병·부상 증빙 기간 한 묶음·같은 기간 함께 승인 · 관리자 «기간 결석 등록» 입구 2곳·학부모 신고 표시. **마이그레이션 20261115100000 운영 미적용**(없으면 여러 날만 숨김). tsc 0·tests 5000-0·guards 82-0. 새 SQL 실제 Postgres 미실행 | 검수 대기 |
| 11-14 | developer(완료한 수업 다시 보기·고치기, claude/staff-session-review): 수정 기간 규칙 한 곳(staffSessionEditWindow — 수업일 포함 7일·원장/부원장 무제한, 사진·영상·한 줄·메모·출결 정정 공통) · 수업 주소가 완료한 수업도 연다(CompletedSessionPanel: 발행 상태·[학부모에게 보내기]·출결 정정(정규·특강 좌석만, 미리 보기+확인 1회)·메모) · «지난 수업» 목록(/staff/sessions, 최근 14일) · 완료 뒤 수정은 OperationsAuditLog(STAFF_SESSION_REVIEW_EDIT)·알림 없음. tsc 0·tests 5088-0·guards 82-0. 새 SQL 은 실제 Postgres 미실행 | 검수 대기 |
| 11-15 | reviewer(앱 연결 A안): 수정 필요 — 확인 화면 no-referrer 로 POST Origin:null → 시작 항상 거절(필수 1) · 중도 이탈 시 바깥 브라우저 로그인 잔존 등 권장 6 | 수정 요청 |
| 11-15 | developer(앱에서 간편로그인 연결 A안, claude/app-link-handoff): 앱(UA STIZApp/)+nativeAuthEnabled 이면 /mypage/login-methods 가 제공자별 1회용 표(AccountLinkHandoff, hash 저장·10분) 발급 → apex https://stiz-dasan.kr/auth/link-handoff?t= 링크(바깥 브라우저) → 확인 화면(읽기만)·[계속] POST /start(Origin·원자 소비·magiclink 로그인·같은 계정 확인·linkIdentity via=app) → 콜백 via=app 은 이 브라우저 signOut local + /auth/link-handoff/done. 마이그레이션 20261115020000 **운영 미적용**. tsc 0·tests 5105-0 · **검수 1차 반영**: referrer same-origin+Origin null 은 Sec-Fetch-Site same-origin 만 · linkIdentity 직후 관리자 signOut(local)+세션 쿠키만 삭제(PKCE 열쇠 유지) · 발급·사용 모두 계정 재확인(PARENT·직원 역할 없음·휴대폰 인증·탈퇴 아님) · 옛 표 무효화·5분 · 주소 t 지우기 · 표시 쿠키 stiz-link-app 게이트 · 완료 화면 코드 문구+가린 아이디 · 확인 화면 가린 이름. tsc 0·tests 5108-0 | 재검수 대기 |
| 2026-11-14 | 수강 정리 검수 권장 2건 확인·마무리(developer) — 취소 요청 대기 건 REJECTED+안내 문구(«…정리되었습니다»로 맞춤), closeOpenRequests=보여 준 신청 id 목록 대조(관리자 상태 변경·반 이동·화면 2곳) · tsc 0 · npm test 5145/fail 0 | 완료 |
| 11-15 | developer(학부모 여러 날 결석, claude/absence-period-parent): 이월 재검수 권장 ②~⑤(564ce9bc) + 학부모 «결석 알리기 › 여러 날»(4주·모든 사유, 날짜마다 saveReportedAbsenceInTx·알림 기간당 1회·복귀했어요/알림 취소·끝나기 전 앱 알림) · 질병·부상 증빙 기간 한 묶음·같은 기간 함께 승인 · 관리자 «기간 결석 등록» 입구 2곳·학부모 신고 표시. **마이그레이션 20261115100000 운영 미적용**(없으면 여러 날만 숨김). tsc 0·tests 5000-0·guards 82-0. 새 SQL 실제 Postgres 미실행 | 검수 대기 |
| 11-14 | reviewer(수강 변경 뒤 정리, 미커밋): 조건부 통과 — 필수 0·권장 4(①학부모 «취소 요청 대기» 걸린 승인 건을 SUPERSEDED 하면 cancelRequestStatus=PENDING 이 남아 «수강 변경 신청» 취소 요청 목록에 찌꺼기로 남음 → 함께 닫거나 ask 로 ②«함께 정리» 확인 시 화면에 보인 신청 id 를 서버에 넘겨 그 사이 새로 생긴 신청은 다시 묻기 ③쓰는 곳 없는 deleteEnrollment 반환형 정리 ④이미 ACTIVE 인 수강의 묵은 승인 신청은 같은 상태 저장으로는 안 닫힘(반 이동·신청함으로만)). tsc 0·관련 테스트 34/34 | 통과(권장 남음) |
| 11-14 | developer(수강 변경 뒤 정리, claude/supersede-stale-change-requests): 관리자 상태 변경·반 이동 때 같은 수강의 처리 중 신청 = 같은 방향 승인 건 SUPERSEDED·대기/반대는 확인창·청구서/정산/원장 걸린 건 차단, 수강 종료·이동 시 옛 반 효력일(포함) 이후 결석 CANCELLED(note «수강 종료로 정리» → 알림 재조정 제외)·미사용 보강권 REVOKED(정산·이월·보강 예약·출석 기록은 보호), 미납 청구는 목록 안내만. 새 enrollment-end-cleanup.ts·EnrollmentCleanupNotice.tsx·테스트 15개, SUPERSEDED 이름표(신청함·학부모 내역). tsc·전체 5104 fail 0. 미커밋 | 검수 대기 |
| 11-14 | developer(출결 다시 누르면 취소, claude/attendance-toggle): 선생님 수업 화면에서 선택된 출결 버튼을 다시 누르면 미확인(출결 기록 삭제) — 새 액션 clearStaffAttendance(정규·보강·체험·특강 좌석, dryRun 미리 보기). 결석 취소는 확인 1회·안 쓴 보강권 회수(기존 규칙 함수), 예약·사용된 보강권/정산된 결석이면 거부, 학부모 신고와 그 보강권은 유지, 알림 없음. tsc 0·tests 5023-0 | 완료(main 머지 전) |
| 11-14 | developer(아이 정보 수정, claude/child-edit): 학부모 «수정» 시트(학교·학생 전화·주소·건강 특이사항 바로 반영 / 이름·생년월일 변경 신청→학생 상세 «정보 변경 요청» 승인·반려) · 건강 글 선생님 «특이»+상세 시트·기사님 줄 «특이» · 연락처 바꾸기(본인인증) · 연결된 가족 보기·끊기(대표만) · 막다른 문구 3곳 · 임시 생일 학년. 마이그레이션 20261114140000 **운영 미적용**. tsc 0·tests 4938-0·guards 82-0 | 검수 대기 |
| 11-14 | developer(질병·부상 결석 이월, claude/illness-carry): 질병·부상 결석 = 보강권 대신 «이월 검토 중»(RegularAbsenceCarryReview) · 사유 글 필수+증빙 사진 1~3장(비공개 버킷 absence-evidence, 7일 안 추가) · 신청함 «질병·부상 결석»(ILLNESS_CARRY) [이월 승인]=기존 resolveWorkbenchAbsence 재사용 / [보강권으로] · 7일 사진 없음 자동 전환·90일 뒤 사진 삭제(cron/makeup-credits) · 출결 결석 시 보류 · 카카오 안내·FAQ·«결석 알리기» 문구. **마이그레이션 20261114130000 운영 미적용**(없어도 예전 방식으로 동작). tsc 0·tests 4827-0·guards 82-0. 새 SQL 은 실제 Postgres 에서 미실행 — 적용 후 읽기 검증 필요 | 검수 대기 |
| 11-14 | developer(수업 진행 화면 간결화, claude/staff-session-compact): 출석부 화면·«출석 확인» 칸·«학생 정보·수업 관리» 펼침을 없애고 학생 한 줄 명단(이름+출결 3버튼)+상세 시트(SessionStudentSheet)+«더보기» · «오늘 수업 내용»+«수업 피드» → «오늘 수업» 한 칸(계획 접힘·불러오기) · 종료 창 중복 입력 제거 · 옛 안드로이드 앱(1.0.3 미만) 영상 촬영 안내. 서버·액션 변경 없음. tsc 0·tests 4808-0 | 완료(main 머지 전·실기기 점검 필요) |
| 11-14 | developer(보강 예약 학년 판정, claude/makeup-grade): 학생 학년 = 생년월일 계산(student-grade.ts, 임시 생일 2000-01-01·빈 값이면 학년 글자), 후보 = 포함 먼저+±1 유지·미취학 위로 2학년·성인반끼리(credit-rules.makeupGradeFit, 목록·예약 같은 판정), 빈 목록 4종 그 자리 버튼(학년 확인·다시 확인·학원에 문의→홈 메시지 폼), 문구 한 줄씩. 휴원 차단 조건 없음. tsc 0·node --test 4795/0 | 검수 대기 |
| 11-14 | PM: 청구 월 카드(f8bc4572+결제하기 안전장치 87c09363·중복 누름 8e43b575)·기사 운행표 휴원·휴무(067011c5)·앱 1.0.3 버전(5175e8ec) 묶음 배포 a2ce24e READY·오류 0. 안드로이드 vc6 내부 테스트 게시·iOS Codemagic #6 TestFlight 처리 완료(외부 베타 정보 미입력 경고만) | 완료 |
| 11-15 | developer(부상·질병 복귀 정산 1a, claude/illness-carry-payment-evidence): 결석 이월 근거에 «납부완료 Payment 1건» 허용(초안·장부 없을 때만 — 2건 이상 차단·취소/환불/미납은 기존 문구·이미 줄인 금액은 원래 금액·월중 등록은 개시일 이후). 새 carryEvidence.ts(순수)·creditCarryForAbsenceInTx 추출·readWorkbench 유효성 PAID_PAYMENT 갈래·신청함 billReady. DB 변경 없음. tsc 0·tests 5426-0·guards 337-0. 새 SQL 4개는 임시 로컬 Postgres 16 에서 실행 확인(운영 DB 미실행). **검수 권장 반영**: 휴원 정산이 처리한 날 거절(공통) · 신청함 상세 근거 미리보기 한 줄(금액은 원장만) · 셔틀비 섞임 경고 · 버튼 꺼짐 문구 «납부한 뒤/발행한 뒤» 구분 · 통합 실행기 임시 스키마 보정(로컬 Postgres 24개 통과). tsc 0·tests 5430-0·guards 337-0 | 재검수 대기 |
| 11-14 | developer(기사님 운행표 휴원·휴무, claude/driver-paused-holiday): 휴원·퇴원·첫 수업 전 = 회색 뱃지+탑승·미탑승 잠금(명단 유지), 휴무일 = 맨 위 «오늘은 휴무(사유)»+정규 줄 잠금, 저장 API 2곳 409, 관리자 운행표 뱃지+«이 달 휴무». 판정 = regularRunDayRules(학부모 childShuttleRules 재사용). 운영 읽기: 휴원 3명·6행 뱃지 대상. 리뷰 반영(월말 다음 달 미입력=모름·반 0개는 퇴원 기록 있을 때만 퇴원·409 문구 표시) tsc 0·node --test 4672/0·guards 5/0 | 재검수 대기 |
