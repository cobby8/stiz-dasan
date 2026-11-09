# 작업 스크래치패드

## 현재 작업
- **상태(2026-11-10)**: 신청함 통합 — 관리자 신청함(설계 A)·학부모 수업 탭(설계 B) 브랜치 통합 + 수강 변경 «취소 요청 검토 중» 연결. 검수 대기·미푸시.
- ⚠️ **배포 전 필수**: `prisma/migrations/20261110130000_enrollment_change_cancel_request` 운영 apply_migration(미적용). 적용 전에도 화면은 열리지만 학부모 [취소 요청]은 실패한다.
- 테스트 기준선(11-10): tests 3821-0 · studentVisibility 5-0 · tsc 0

## 진행 현황
| 항목 | 상태 |
|------|------|
| 신청함 통합(관리자 신청함 A·학부모 수업 탭 B·취소 요청 d8) | 통합 완료·검수 대기, 마이그레이션 20261110130000 운영 미적용 |
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

## 구현 기록 (developer) — 신청함 통합 + 취소 요청 연결 (11-10)
📝 수업 탭 브랜치(a922f982) → 신청함 브랜치(ae684307) 순서로 merge. 충돌 = scratchpad 작업 로그 1곳(양쪽 보존). catalog 동일 패치는 자동 병합.
| 파일 | 변경 |
|---|---|
| src/lib/requests/catalog.ts | 수강 변경 파생 상태 `CANCEL_REQUESTED`(처리 필요·«취소 요청 검토 중»·warning) + 상수 ENROLLMENT_CANCEL_REQUESTED, deriveEnrollmentChangeStatus 셋째 인자 cancelRequestStatus(APPROVED+PENDING → 적용 여부보다 먼저) |
| src/lib/requests/parent-timeline-rules.ts | timelineStatus 하드코딩 «취소 요청 검토 중» → catalog 파생 상태로(rawStatus 는 단계·버튼용 그대로) |
| src/lib/requests/admin-inbox.ts | 수강 변경 어댑터 rawExpr 에 취소 요청 분기·정렬 시각 = 요청일·상세 칸(취소 요청일·사유·적용일 지남 안내), `fallback`(마이그레이션 전 식) — 목록은 종류별 재시도, getInboxCounts 는 buildInboxCountsSql(true) 로 재시도 |
| src/app/admin/inbox/InboxClient.tsx | 취소 요청 행 [요청 거절]/[취소 승인](확인창) = decideEnrollmentChangeCancelRequest 재사용, 적용일 지난 건(tooLate)은 거절만 |
| tests/request-catalog · admin-inbox | 파생 상태 7건·버튼 연결·fallback 블록에 새 칸 없음 |
💡 tester: 실DB 미검증(쓰기 금지) — 마이그레이션 적용 후 신청함 «처리 필요»에 취소 요청 행·메뉴 숫자 포함 확인. 적용 전 DB 면 수강 변경은 예전 그대로 보여야 정상.
⚠️ reviewer: fallback 은 «아무 오류»에 한 번 재시도(칸 없음 오류만 고르지 않음) — 진짜 SQL 오류면 두 번 실패 후 기존처럼 failedKinds/null.

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-10 | developer(현장 수납 승인 자동화, 원장 m1 «POS 확인되면 끝»): 번호 없는 POS 카드 결제 중 AUTO_CANDIDATE(메모 이름 1명 정확 일치+그 달 미납 1건 금액 일치)는 슬랙 버튼 없이 자동 납부(새 공용 핵심부 lib/pos/paymentNoticePay.ts — 버튼·자동이 같은 재확인 SQL 조각·markPaymentPaid 1곳, 자동은 SYSTEM·pos-notice-auto:id). 자동 전용 보류 조건 = 직원 현금·계좌 확인 대기·현장 결제 요청 PENDING/SENT/HELD/PAID·랠리즈 사본 → DM 버튼 그대로. 직원 현금·계좌 확인 요청(StaffPaymentConfirmationRequest)은 POS 근거가 없어 승인 유지(선택지 보고). 마이그레이션 없음. tsc 0·tests 3828-0·studentVisibility 5-0 | 검수 대기(미푸시) |
| 11-10 | developer(신청함 통합): 수업 탭→신청함 브랜치 merge(충돌 scratchpad 1곳) · catalog «취소 요청 검토 중»(CANCEL_REQUESTED, 처리 필요) · 타임라인 상태명 catalog 로 · 신청함 어댑터·getInboxCounts 에 취소 요청 행 + 마이그레이션 전 fallback · 상세 칸 [취소 승인]/[요청 거절](기존 action). tsc 0·tests 3821-0·studentVisibility 5-0. ⚠️ 20261110130000 운영 적용 필요 | 검수 대기(미푸시) |
| 11-10 | developer(신청함 5·6단계 수업 탭): 탭 홈·수업·청구·소식 · 반 카드(상태 칩=buildClassStatusLine·다음 수업·출결 4칸·셔틀·버튼 프리셋) · 신청 내역 타임라인 7종류+하단 시트 · d8 취소 요청(대상 신청 칸 5개, 마이그레이션 20261110130000 운영 미적용) · queries.ts KST 2곳. tsc 0·전체 fail 0 | 구현·검증 완료(검수 대기, 미푸시) |
| 11-10 | developer(신청함 1단계 급한 불): 홈 반 상태 한 줄(휴원 예정·검토 중·휴원 중, getParentClassStatusLines) · 수강 변경 화면 «지난 결과» 3개월(거절 사유) · 결정/적용 시 신청 학부모 앱 알림(HELD 해제, change-decision-notify·EXTERNAL 장부·중복 키) · getMyPageData 이번 달 KST. 새 순수 모듈 parentChangeStatus.ts(다음 단계 수업 탭 재사용) | 구현·검증 완료(검수 대기) |
| 11-10 | developer(신청함 통합 설계 A·실행 2~4): catalog(14종류 상태→처리 필요/진행 중/완료·statusTones, 35d8401e+문의 REJECTED 7ce04830) · admin-inbox 어댑터 14개+getInboxCounts(UNION ALL 1회) · /admin/inbox(탭3·필터 모달·검색·한 줄 행·상세 칸/하단 시트·기존 action 재사용·일괄=결석 확정·문의 확인함) 559c2d88 · 메뉴 최상위 «신청함 N»·«요청·신청함» 묶음 제거(주소 유지)·오늘 업무 숫자 통일 28bd0068. 탈퇴 «처리»·특강 결석(처리방식 필요)·카카오·대관·보강·사진 회수=기존 화면. 실DB 읽기전용 트랜잭션으로 14종 SQL 실행 확인. tsc 0·tests 3788-0. PNG scratchpad/inbox | 검수 대기 |
| 11-10 | developer(원장 점검: 정규 셔틀 운행표 묶음별 연필): 화면 위 [수정] 제거 → 묶음 머리 오른쪽 연필(36px 원·44px 터치, «16:00 등원 묶음 수정») · 누른 묶음만 편집 · 그 머리 줄 [취소][저장]+아래 한 줄 적용 범위(sticky) · 다른 묶음 연필 시 미저장 확인. RunBoard editingGroupKey/onEditBlock/renderEditActions/renderEditBar(기사님 미전달=변경 없음). tsc 0·tests 3765-0·shuttle 159-0·끌기 e2e 전부 통과 | 완료(커밋, 미푸시) |
| 11-10 | debugger(원장 «김루빈 휴원 신청했는데 복귀 버튼 안 보여»): 코드 결함 없음. 운영 pg_stat_statements(읽기 전용) 시각표 — 11-09 20:19 KST 화면 3회·20:20 신청 2회 서버 도착(본인 자녀 확인 2/2 통과) 뒤 중복 확인·INSERT 0회 = 입력 검사 400(휴원에서 가능한 건 복귀 예정일 ≤ 12-01 뿐). 당시 옛 화면은 오류가 맨 위라 원장은 접수된 줄 앎(20:38 수정 전). 11-10 00:36 화면 1회 = 신청 0건이라 검토 중 상자 없음, 다니는 반이라 «복귀» 없음(설계: 복귀는 휴원 시작 뒤). 학부모 계정이 저장한 신청은 운영 전체 0건(86건 전부 관리자). 재현 테스트 1건 추가(한 학생 두 반). tsc 0·전체 3765-0·studentVisibility 5-0. 앱 코드 무변경 | 완료(제안 3건 승인 대기) |
| 11-09 | developer(PM 결정 3건, 색상 3차 후속): 셔틀 명단 «확정하기»=주 버튼(검정) · 상태 버튼 위험 채움(StatusChoiceButton·TONE_SOLID_CLASS)=danger-fill+hover · 선생님 학생 시트·반 학생 시트 «학부모 전화»=보조 버튼. tsc 0·tests 3734-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(원장 «색 더 정리» 3차): 묶음 버튼 고른 칸=옅은 상태 바탕+진한 글자+안쪽 링(statusTones TONE_SELECTED_CLASS 신설, 학생 상세 수강 상태·결제 상태) · 전화 버튼 보조로 통일(학생 상세 머리·셔틀 명단 펼침·셔틀 학생 상세창·학부모 기사님 전화) · 명단 «확정하기»·«좌표 설정으로 이동»·«반 이동» 주황 채움→warning-soft+테두리 · «안전 복구»=인증 계정 삭제라 danger-fill 유지 · 기사님 결석 꼬리표 danger-fill. tsc 0·tests 3734-0 | 완료(커밋, 미푸시) |
| 11-09 | developer(원장 «빨강 애매·퀵버튼 보기 싫다» 색상 2차): 위험색 역할 분리(danger-fill #dc2626·hover #b91c1c·line #fecaca, 글자 #b91c1c 유지) · ⚡ 버튼 중립(흰+입력선+검정 아이콘, 열림=옅은 주 색) · InlineConfirm 흰 바탕+왼쪽 위험 띠 한 줄 · 수납 환불 막대 «선택 해제» 첫 줄 고정 · 위험 아닌 빨강·초록 채움 12곳 정리+위험 확정 6곳 새 채움 · account-deletion 색 토큰화(가드 실패 해소). tsc 0·전체 3734-0. PNG scratchpad/color-fix2 | 완료 |
