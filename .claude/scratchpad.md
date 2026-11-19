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
| F-2 | lib/regular/illness-unpaid-reduce.ts:~130·200 | 권장 | reduceUnpaidForIllnessAbsenceInTx 자체엔 사유 확인 없음(eligibility 'ILLNESS_INJURY' 고정 기록). 지금은 readApprovalMode 가 질병만 보내서 안전 — 함수 첫머리에 `absence.reason !== ILLNESS_REASON` 거절 한 줄(이중 방어) |


- ⚠️ (11-08 POS 결제 취소 리뷰) 마이그레이션은 build 에 migrate deploy 가 없어 **배포 전 apply_migration 필수**(안 하면 현장 결제 전체 정지).


## 작업 로그 (최근 10건)
| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-19 | developer(체험 셔틀 배정·운행표·알림, 미커밋): 마이그레이션 20261119100000_trial_shuttle(TrialLead 셔틀 13칸 + 하루 탑승 표 TrialShuttleRide, 추가만 · **운영 적용 전**) · 순수 규칙 lib/shuttle/trialShuttleRules.ts·trialShuttlePlacement.ts · 서버 trialShuttle.ts(배정·해제·대기 건수·기사 알림, releaseTrialShuttleOnLeadChange) · 운행표 셋째 출처 TRIAL(buildUnifiedRun trial 입력, 탑승 = ShuttleBoarding direction TRIAL, 새 주소 trial-boarding 2개) · 관리자 API /api/admin/trial-shuttle + TrialShuttleAssignPanel · 정규 배차 머리줄 대기 건수 · 아침 요약에 «오늘·내일 체험 셔틀 배정 대기» 한 줄(새 cron 없음) · 정규 명단·청구 쓰기 없음. tsc 0 · tests 전체 6401 fail 0 · guards 82-0. 실행 확인 없이 코드로만: DB 쓰기·알림·문자·화면 | 구현 완료(검수 전) |
| 11-19 | developer(체험 셔틀 요청 — 신청서·관리자 체험 상세, 미커밋): 신청서 2단계 끝 «셔틀이 필요하신가요?»(등원·하원·지도 위치+위치명 필수) · 규칙 lib/trial/trialShuttleRequest.ts · 저장 trialShuttleRequestStore.ts(본문 저장 뒤 따로, 실패 시 관리 메모) · 관리자 TrialShuttleSection(넣기·고치기·필요 없음+배정 패널)·목록 배지 · 일정 변경·취소·이탈·삭제 때 배정 풀기 호출 · tsc 0 · 관련 테스트 67-0. 남은 것: 등록 전환 때 위치 이어 주기(보고만), 화면 실행 확인 | 구현 완료·검수 대기 |
| 11-18 | reviewer 재검수(L-1·L-2·L-3 수정분 leaveLessonScreen): 재현 6종 모두 사라짐(Navigation API 있음·없음 둘 다 실행) · 지정 테스트 80-0 · 권장 L-5 Navigation API 없는 기기에서 앞 화면이 다른 문서이고 0.4초 안에 떠남 신호가 없으면 back 을 한 번 더 보내 한 칸 더 나갈 수 있음(가짜 기록 재현, 실기기 확인 필요) · 참고: 쿼리만 다른 칸도 «다른 주소»로 봄(지금은 그런 칸이 안 생김) | 통과 |
| 11-18 | reviewer(선생님 화면 «뒤로» A·B·C 미커밋분, 가짜 기록 실행 12종): 창만 닫힘·저장 중 막힘·종료 뒤 칸 정리·굳음 없음 OK, 지정 테스트 90-0 · **필수 L-1** lessonBackGuard.ts:241 `hadPrevious = history.length > 1` — 앱을 /staff 에서 켜고 «수업 시작» 창(또는 아무 창)을 한 번 거치면 앞으로 칸 때문에 늘 true → 뒤로→확인 뒤 go(-2) 가 무시돼 무반응·가드 죽음·안내 없음(주 사용 경로) · 권장 L-2 접자마자 펼치면 끄기의 back 이 날아가는 중 재설치돼 확인 창이 저절로 뜸 · L-3 표시 지워진 가드 칸에서 새로고침하면 가드 두 겹 → 확인 뒤 제자리(수업 주소는 기존부터) · 고칠 방향 = 나간 뒤 주소가 그대로면 «앞 화면 없음» 처리 + 판정을 범위 기록으로 | 수정 필요 |
| 11-18 | developer(이동·뒤로 D·E·F·G, 미커밋): D 관리자 목록 «보던 그대로» — 새 lib/navigation/listQuery.ts(replaceState 로 지금 칸 주소만) · 원생(q·class·grade·school·status) · 출결(?day=·?week= — 서버 key 인 ?date=&lesson= 과 다른 이름) · 청구·수납(?month=·q·status·class, 달이 다르면 서버 목록 안 씀) · 청구 준비 달 유지+«청구·수납으로»가 보던 달로 / E 관리자 «수업 진행»·«빠른 업로드» → 선생님 첫 화면의 «←» = 관리자로 back(inAppHistory: sessionStorage 표시 2개, scopeHistoryDecision 안에서 판단 — AppBackButton·ScopeBackLink 무수정, 화면 전환 메뉴는 그대로) / F 기사님 첫 화면 = 셔틀 명단(/staff/driver 는 ?start=1 일 때만 운행 화면 — auth-routes 무수정) / G 운행 링크 없으면 /staff/shuttle?notice=no-run 한 줄 안내(NoRunNotice). 테스트 tests/admin-list-state·driver-first-screen 신규 + scope-back-nav E 6건, tsc 0. 실행(브라우저) 확인 전 | 구현 완료(검수 전) |
| 11-18 | developer(관리자·공용 창 «뒤로 = 창만 닫기» + 저장 중엔 안 닫힘, 미커밋): overlayHistory `isBlocked`·훅 `{ blocked }`·`closeThen` 추가 → AdminModal 이 기본으로 기록 칸을 든다(`backToClose` 기본 켜짐·`busy`), ListDetailPanel 은 넘겨주기만(청구 시트만 끔). 확인창(askConfirm)은 칸을 되돌린 뒤 결과 반환. ⚡·알림 종·표 머리 필터는 손가락 기기에서만. busy 연결 약 30곳. 테스트 tests/overlay-back-close.test.mjs 14건 통과·tsc 0. 실기기 확인 전 | 구현 완료(검수 전) |
| 11-17 | reviewer 재검수(D-1~D-5): D-1 네 신호를 readEndedBillItems SQL 이 계산 → 승인도 잠근 뒤 같은 함수로 재계산 → CHECK 면 sameProposal 거짓 → 409(유한빈 재현 테스트) · D-4 열쇠=«대상:종료일:종류», 무시는 전체 열쇠·승인은 바탕 열쇠로 거름, 승인 요청은 key 끝 종류=kind 확인 → 멱등 충돌 없음 · D-3 숨김은 그 청구 id 의 이월 적립만(다른 결제 청구 영향 없음) · D-5 취소·변경 감사에 이전 Payment/Invoice 상태 · D-2 사유별 문구 · tsc 0 · node --test 222-0 · 참고: (c) 같은 반 재수강 신호는 Enrollment (학생,반) 유일이라 WITHDRAWN 행과 동시에 ACTIVE 불가 → 늘 거짓(해 없음) · (d)는 새 반 청구 발행 전이면 정상 반 이동 취소도 확인 필요로(보수적, 허용) | 통과 |
| 11-17 | developer(검수·실측 D-1~D-5 반영, 미커밋): D-1 청구·수강 어긋남 신호 4종(발행 기록 반≠청구 반 · 발행 기록 없는 손 수정 PAYMENT_UPDATE_UNPAID · 같은 반 재수강 · 그 달 다른 반 수강 중인데 그 반 청구 없음)이면 «확인 필요»+원인 문구, 승인은 바탕 열쇠로 다시 찾아 409(유한빈 재현 테스트) · D-2 반 변경 차액 못 구한 이유 원인별(달력·옛 반 요일·새 반 요일·계획표) · D-3 이월 근거가 된 결제 청구 숨김 · D-4 열쇠에 제안 종류 포함(승인은 바탕 열쇠로 거름) · D-5 취소·변경 감사에 이전 Payment·Invoice 상태 · tsc 0 · 전체 6135 fail 0 · guards 345-0 | 구현 완료(검수 전) |
| 11-17 | reviewer(«발행 뒤 바뀐 청구»+C-1~C-3 미커밋분): 결제됨 청구 취소·변경 경로 없음(전역 잠금→결제 잠금→FOR UPDATE→재계산·sameProposal→조건부 UPDATE status/amount→POS 재확인, 완료 거래 있으면 PAID_TX) · Payment·Invoice 함께 바뀜·감사 2곳·rollback 값(변경) · 다닌 회차 계산 한 번 반올림·셔틀 유지·이월/손수정/0원은 확인 필요 · 반 변경 월중은 옛 반 미손댐(이중 차감 없음, 차액 청구 classId NULL 이라 안 겹침) · cancelUnpaidPayment·청구 준비 발행 무수정 · effectiveFrom=@db.Date KST OK · $queryRawUnsafe 만 · UI 아이콘 없음·굵기·토큰 OK · C-1~C-3 OK · tsc 0 · node --test 215-0 · **필수 D-1(청구 반 옮긴 청구 오취소 제안=유한빈)** · 권장 D-2~D-5 | 수정 필요 |
| 11-17 | tester(«발행 뒤 바뀐 청구» 운영 DB 읽기 전용 실측 + D-1~D-5 재측정): 1차 = 유한빈 12월 목7 8만 «취소 제안» 오제안(목6 초안 청구를 원장이 반만 목7로 옮긴 건)·신이준 문구 오류 → 재측정 0.23s(2회째 0.15s) 전체 3줄 · 승인 가능 줄 0 · 유한빈=확인 필요(«발행 뒤 청구 반이 바뀌었습니다…») · 신이준=확인 필요(«옛 반의 수업 요일을 알 수 없어(보관 처리된 반 등)») · 정명환=결제됨 그대로(손 이월 끝난 건 → 무시 대상) · readWorkbench 12월·1월 C-1 0행·shuttleUnlinkedNames [] | 재테스트 통과 |
