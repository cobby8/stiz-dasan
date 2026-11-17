# 작업 스크래치패드

## 현재 작업
- **상태(2026-11-16)**: 12월 실사용 출시 진행 중. 개발 환경을 SAM 데스크탑으로 옮겼고, 총괄 세션 아래 업무별 세션 5개로 나눠 일한다 — 출시·배포 / 청구·수납 / 학부모 화면 / 선생님·기사님 앱 / 관리자 화면·코드 정리. 세션마다 자기 worktree(브랜치)에서 일하고, main 반영·운영 배포는 «출시·배포» 세션이 모아서 한다.
- 운영 = `main`(`eac74476`, 앱 1.0.4 준비·고정 수강료 포함). 운영 DB 마이그레이션은 `20261116500000_student_fixed_tuition` 까지 모두 적용됨(11-16 list_migrations 로 확인 — 11-10 의 4개 포함).
- 검수 전 브랜치가 여럿 있다(아래 작업 로그의 «구현 완료(검수 전)» 줄). 통합 여부는 «출시·배포» 세션이 판단한다.

## 진행 현황
| 항목 | 상태 |
|------|------|
| 11-17 | developer(경조사 사유·이월 구멍 막기, claude/billing-92f9f8 미커밋): 사유 FAMILY_EVENT «경조사(직계 가족)» 추가(VALID_REASONS 맨 뒤 — 카카오 번호 유지) · 짝 규칙 새 파일 lib/regular/carryReasonRules.ts(import 0: 질병↔ILLNESS_INJURY·경조사↔DIRECT_FAMILY_EVENT, 그 밖 사유는 «약관상 이월 대상… 보강으로만» 409) · resolveWorkbenchAbsence·청구 준비 화면(이월 선택지 숨김+안내·짝 아닌 분류 비활성·경조사 기본 이월)·신청함 승인(사유로 분류, 미납 빼기는 질병만)·학부모/카카오 신고(경조사도 이월 검토, 사진 7일·자동 전환은 질병만)·신청함 목록(경조사 결석 제목) · 마이그레이션 20261117210000(RegularAbsencePeriod CHECK 확장, **운영 적용 전** — 하루 결석은 TEXT 라 무관, 기간 결석 «경조사»만 적용 필요) · 출석부 «질병·부상» 토글은 그대로(경조사 표시 없음). 후속 과제: 학원 사정 휴강 = 다음 달 이월(코드 변경 없음). tsc 0 · 관련 28파일 650-0 · 전체 6080 fail 0 · guards 345-0 | 구현 완료(검수 전) |
| 목록 화면 개편 8단계 | 전부 배포(10-30, `98fe9fe9`). 뺀 것: 방학특강 반 카드·출석부·결석·셔틀, 수업 진행·사진 게시, 학부모 결제·수납 탭 |
| UI 통일(네이비+하늘색·아이콘 없이 글자·굵기 4단계) | 배포(11-13) · 12px 미만 글자·800/900 굵기·브라우저 경고창 정리 배포(11-16, `3d73fac4`) |
| 안 쓰는 기능 정리 | 결정표 9칸 전부 «안 쓴다» → 가 5건·나 2건·다(수업 기록 창) 모두 완료·push(11-17). 결정표 https://claude.ai/artifact/QbAMyZW2XvbTA3aCsZraNe |
| 이월 리뷰 수정 | 관리자 세션 몫은 모두 끝(11-17): R-1·R-3·R-7②(11-10 `18bb8749`)는 이미 고쳐져 있었고 M-1·R-8②·R-2 를 고침. 남은 것 P-1·P-2(청구 세션) |
| KST 가드 빚 | R1(오늘을 UTC 로) 17파일 · R3 0 · R4 0(원본만) |

## 안 쓰는 기능 — 원장 결정 대기 (2026-11-16 코드 대조)
결정표 9칸과 코드 위치. «안 쓴다» 답이 온 것만 정리한다.
- `seasonal-status-select` — `admin/seasonal/SeasonalAdminClient.tsx` «상태 직접 변경» 셀렉트. 버튼 4개(승인·대기·반려·취소)와 중복이나 **PENDING 되돌리기는 셀렉트에만** 있다
- `facebook-ad` — `admin/notices/NoticeSocialModal.tsx` «페이스북 광고 소재»
- `insta-import` — `admin/gallery/GalleryAdminClient.tsx` «인스타 가져오기»(`syncInstagramGalleryPosts`)
- `applies-to-badge` — `admin/settings/AdminSettingsClient.tsx` `AppliesTo` 9곳
- `facility-photo-url` · `program-image-url` — 설정 «시설 사진 URL», `admin/programs/ProgramFormPanel.tsx` «프로그램 이미지 URL»(다른 이미지는 전부 파일 업로드)
- `external-form-links` — `admin/apply/ApplySettingsTab.tsx` 체험·수강 «외부 신청 링크» 2칸(유니폼 링크는 유지)
- `site-ops-form-check` — `lib/siteOpsBot.ts` trial-form·enroll-form 점검(자체 신청서라 늘 ok)
- `session-log-vs-report` — `admin/classes/[id]/SessionLogModal.tsx` 와 `admin/attendance/report/[sessionId]/ReportEditClient.tsx` 가 같은 Session 을 편집
- 이미 없어져 목록에서 뺀 것: 이관 화면 CSV 붙여넣기, 스킬 «평가자» 자유 입력(11-16 코드에 없음)
- **테스트가 문구·코드 존재를 단정하는 곳**(지우려면 테스트 동반 수정): 신청관리 문구 2건, 방학특강 문구 2건
- ⚠️ **다중 에이전트 동시 작업 중 `git stash` 금지.** 이번에 한 에이전트가 baseline 측정용으로 실행해 다른 4개의 미저장 변경 46파일을 함께 치웠고 pop이 충돌했다. baseline이 필요하면 `git show HEAD:<파일>`로 개별 조회할 것.

## ⚠️ 배포 메커니즘(중요)
- Vercel 빌드는 `prisma generate && next build`뿐 — **`migrate deploy` 자동 실행 안 됨**. 스키마 변경은 **멱등 SQL을 운영 Supabase(ref gpjdtkumqxzfgkixjamp)에 직접 적용**(Supabase MCP apply_migration). 마이그레이션 폴더는 기록용.
- 운영 배포 = `git push origin HEAD:main` fast-forward.
- 테스트는 `node --test tests/*.test.mjs` **+ 가드 `node --experimental-strip-types --test src/lib/*.test.ts`**(=`npm test`). ⚠️ 2026-10-25 실측: `tests/` 만 돌려 **학생 병합 필터 가드(src/lib/studentVisibility.test.ts)를 놓쳤다** — 회원 탈퇴 배포 후 release:preflight 가 실패하던 상태였다. **`npx vitest`는 이 프로젝트에 없음**(설정도 없어 worktree까지 긁어 전부 오탐).


## 미해결 리뷰 수정 사항 (이월)
| 번호 | 파일 | 심각도 | 내용 |
|------|------|--------|------|
| P-1 | lib/pos/chargeRequestService.ts writeLedgerPaid·settleCancelForRow | 권장 | 납부 기록(markPaymentPaid 무조건 UPDATE) 직전에 POS 취소 웹훅이 끼면 요청 DONE·청구 PENDING→뒤이어 PAID 로 덮임(사이트 납부완료·실제는 취소). 기록 뒤 cancelState 재확인 → DONE 이면 refundPaidPaymentInTx, 또는 settle 에서 refunded=false·청구 미납이면 retryLater |
| P-2 | admin/finance/FinanceClient.tsx:955 «환불» | 권장 | TOSS_POS 건에도 그대로 → POS 는 안 취소되고 사이트만 REFUNDED. TOSS_POS 면 숨기거나 확인창에 «POS 결제는 취소되지 않음, 결제 취소를 쓰세요» 경고 |
| F-1 | app/actions/staff-sessions.ts:131-139 hasLiveIllnessAbsence | 권장 | 경조사(FAMILY_EVENT) 결석도 이월 검토 대상인데 이 확인은 ILLNESS_INJURY 만 봄 → 완료 수업 정정(결석→출석→결석)으로 검토를 건너뛰고 보강권 자동 발급 가능. `reason = ANY(CARRY_REVIEW_REASONS)` 로 |
| B-7 | workbench-service.ts:514 unlinkedShuttleNames | 권장 | 명단은 있는데 학생 연결이 빠진 사람은 셔틀비 0원 제안 + 안내 한 줄뿐 → 자동 초안·승인 대상이 될 수 있음. 연결 빠진 학생이 있으면 그 학생 행(이름 일치)을 확인 필요로 |
| F-2 | lib/regular/illness-unpaid-reduce.ts:~130·200 | 권장 | reduceUnpaidForIllnessAbsenceInTx 자체엔 사유 확인 없음(eligibility 'ILLNESS_INJURY' 고정 기록). 지금은 readApprovalMode 가 질병만 보내서 안전 — 함수 첫머리에 `absence.reason !== ILLNESS_REASON` 거절 한 줄(이중 방어) |


- ⚠️ (11-08 POS 결제 취소 리뷰) 마이그레이션은 build 에 migrate deploy 가 없어 **배포 전 apply_migration 필수**(안 하면 현장 결제 전체 정지).


## 작업 로그 (최근 10건)
| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-17 | reviewer 재검수(B-1~B-6): 셔틀 명단 없음 cron 중단·승인 409·알림 OK · amountCheckReason 하나를 화면·서버·cron 공용 OK · DB 오류 503 즉시 throw → 거래 롤백 OK · 따라잡기 +1~3일(감사 기록 있으면 건너뜀) 멱등 OK · «건» 표기 · BILLING_OPEN_RE 끝 고정 · tsc 0 · node --test 181-0 · 권장 B-7(연결 빠진 셔틀 학생) | 통과 |
| 11-17 | developer(검수 B-1~B-6 반영, 미커밋): 셔틀 명단 없는 달 = 보기 shuttleRosterMissing → cron 저장 안 함+원장 알림·한꺼번에 발행 서버 409·버튼 막음(명단은 regular-shuttle-months 가 매일 00:05 이번·다음 달을 직전 달 복사로 만듦 — 청구일엔 보통 있음) · 이월 차감·기간 조정·부상 결석 정산 행은 자동 초안·승인 제외(amountCheckReason) · 승인 DB 오류는 전체 중단 · cron 청구일+1~3일 따라잡기·청구일 못 정함 알림 · «건» 표기 · 개강 판정은 제목 끝만 · tsc 0 · 전체 6105 fail 0 · guards 345-0 | 구현 완료(검수 전) |
| 11-17 | reviewer(청구일·자동 초안·승인 대기 미커밋분): 이중 발행 경로 없음(자문 잠금+FOR UPDATE+sourceVersion·외곽 거래 전부 또는 무), cron 멱등·스위치 존중·발송 없음·KST OK · tsc 0 · node --test 174-0 · 필수 B-1(셔틀 명단 없는 달 0원 셔틀) B-2(기간 조정 미표시) | 수정 필요 |
| 11-17 | tester(자동 청구 초안 운영 DB 읽기 전용 실측): 청구일 5달 기대값 일치(12월 11-17·1월 12-15·2월 1-18·3월 2-15·4월 3-16, 달력 DB_AND_ICS 203건) · readWorkbench 2회 각 ~0.4s(달력 fresh 0.7s) · 2026-12: 516행 ISSUED 184·초안 185·자동 대상 1(김루빈 12만) · 2027-01: 516행 REVIEW 167 전부 자동 대상(학생 118명·15,686,750원)·구체 사유 0 · SAVE 추정 ~750왕복×13ms≈10s(거래 한도 30s·함수 60s 안) · 위험: 1월 셔틀 명단 없어 셔틀비 0원으로 초안(12월 기준 46명 555,000원 빠질 수 있음, 사유 없이 notice 만) · 이월 71,250원 자동 차감 행(윤수영)이 일반 문구만으로 대상 · 0원 고정 수강료 둘째 반 2행 | 실측 완료 |
| 11-17 | developer(승인 대기·한꺼번에 발행, 미커밋): 자동 초안 대상 = 사유 없음·일반 문구 하나뿐(isAutoDraftCandidate, workbench.ts 상수) · 행 autoDraft(저장자 SYSTEM_CRON_BILLING_DRAFT)→«자동 초안(원장 확인 전)» · 화면 맨 위 «승인 대기»(자동 초안 한 줄 행+합계+«N명 한꺼번에 발행» AdminConfirmDialog, «확인 필요 M명» 누르면 행 펼침) · 서버 lib/billing/workbench-approve.ts(한 거래·묶음마다 SAVEPOINT·원장 이름 SAVE→CONFIRM→ISSUE·실패 묶음 반씩 재시도, 학부모 발송 없음) · 기본 달 = 다음 달 청구일 이후면 다음 달(page.tsx 서버 계산) · tsc 0 · 전체 6098 fail 0 · guards 345-0 | 구현 완료(검수 전) |
| 11-17 | developer(청구일·자동 초안, claude/billing-92f9f8 미커밋): 순수 규칙 lib/billing/billing-schedule.ts(전달 «N월 개강»+14일·특강 제외·없음/중복 날짜는 null 성격·planAutoDraft) · 청구 준비 안내 첫 줄(api/admin/billing-workbench 에서 notices 앞에 붙임 — BillingWorkbench.tsx·workbench-service 무수정) · cron /api/cron/billing-draft(UTC 15:25, READY·초안 없음만 SAVE, REVIEW 손대지 않음, 스위치 꺼지면 로그만, 원장 ADMIN 앱 알림) · tests/billing-schedule 11-0 · tsc 0 · 관련 24파일 592-0 | 구현 완료(검수 전) |
| 11-17 | reviewer(경조사 이월 사유, claude/billing-92f9f8 미커밋): 통과 · 필수 0 · 권장 2(F-1 출결 정정 확인이 질병만·F-2 미납 감액 함수 이중 방어) + 참고 3(사유 질병↔경조사 변경 시 옛 검토·사유 글 유지·카카오 STALE_CONTROL 10자 딱 맞음·예전 «개인 사정» 경조사는 사유를 고쳐야 이월) · 이월 4경로(작업대·신청함 승인·기간 묶음 승인·미납 감액) 서버 거절 확인 · 마이그레이션 넓히기만·되돌림 주석 OK(배포 전 apply_migration) · 카카오 번호 1~5 불변 · KST 새 코드 0 · tsc 0 · 관련 15파일 404 fail 0 | 리뷰 완료 |
| 11-17 | reviewer(기타 매출, claude/billing-92f9f8 미커밋): 통과 · 필수 0 · 권장 3(삭제 확인창이 고치던 값을 보임·목록 LIMIT 500 인데 합계를 목록으로 계산·otherRevenueSeries 안 씀) · 권한 원장만(액션 4개 requireOwner·화면 canSeeAllMoney)·SQL 전부 $n 바인딩·RLS FORCE+REVOKE·되돌림 주석·KST 금지 패턴 0·revenue/revenueSeries 불변·UI 토큰만 · tsc 0 · 규칙 8-0 · 메뉴+KST 가드 14-0 | 리뷰 완료 |
| 11-17 | developer(기타 매출, claude/billing-92f9f8 미커밋): 표 OtherRevenue(마이그레이션 20261117200000, **운영 적용 전** — 없으면 읽기 0원·쓰기 «준비 중») · 규칙 lib/billing/other-revenue-rules.ts(+테스트, CHECK 값 목록 대조) · DB lib/billing/other-revenue.ts · 액션 actions/other-revenue.ts(requireOwner·감사 OTHER_REVENUE_*·admin-stats 무효화) · 화면 /admin/other-revenue(원장만, ?ym 달 이동·한 줄 행·모달) · 청구·수납 탭 «기타 매출»(ownerOnly) · 통계 수납 탭 «기타 매출 n원» 한 줄(revenue 불변). 로그인 화면 실행 확인 못 함. tsc 0 · tests 6074 fail 0 · guards 345 fail 0 | 구현 완료(검수 전) |
| 11-17 | reviewer(셔틀 당일 변경 칸 → 버튼): 통과 · 필수 0 · 권장 3(겹친 창 뒤로가기 스크롤 잠금·취소 뒤 포커스·달 경계 재마운트) · tsc 0 · tests 5988 fail 0 | 리뷰 완료 |
