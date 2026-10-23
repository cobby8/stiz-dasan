# 작업 스크래치패드

## 현재 작업
- **상태(2026-10-05)**: Phase 2-A 자동화 배포(보강권 버그·특강 자동 퇴원·휴원/퇴원 예약 자동 적용). 랠리즈 10월 청구 정리·오래된 미납 94건 납부 처리 완료.
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
- 테스트는 `node --test tests/*.test.mjs`. **`npx vitest`는 이 프로젝트에 없음**(설정도 없어 worktree까지 긁어 전부 오탐).
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

---

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 2026-10-23 | **체험↔수강신청 연결 보강(developer)** — 순수 판정 `src/lib/enrollment/trialLeadMatch.ts`(AUTO=번호 같음+이름 같음/성 같고 음절 1글자 오타·후보 1명, 이름 완전일치 중복은 가장 진행된 기록 / SUGGEST=번호 다름+학교·학년/생년·체험반 근거, 성 다름, 오타 후보 2명↑ / 종료상태·타 신청 연결·120일·체험일 신청+30일 초과 제외) + 연결부 `trialLeadLinkService.ts`(조건부 UPDATE 한 트랜잭션·승인건은 CONVERTED·이력 UPDATED 2줄·문자 없음). 제출 매칭 교체·updateTrialLead 이름/번호 수정 후 재비교·신청 목록 「체험 기록 후보」+[연결]. 테스트 tests/enrollment-trial-lead-match.test.mjs(21). tsc 0·전체 2248/2248. 기존 미연결 데이터 일괄정리 미실시. **리뷰 수정 1차**: 재제출 시 기존 신청서 선조회→applicationId 전달·기존 연결 유지, UPDATE trialLeadId=COALESCE($1,기존)로 연결 삭제 방지 / 오타 AUTO는 생년 같음·학교+학년·체험반=희망반 근거 필수 / 재비교는 selectApplicationForTrialAutoLink(여러 건이면 이름 완전일치 1건만) / 이름·번호 완전일치는 기간 제한 없음. 테스트 27·전체 2254/2254 | 검수 대기 |
| 2026-10-17 | **카카오 보강 신청·취소 대화(developer, 브랜치 claude/kakao-makeup-request)** — 신규 `src/lib/kakao-makeup-flow.ts`(보강권 목록→14일 후보 최대 8→확인→`bookMakeup`, 「보강 취소」→목록→확인→`cancelMakeupBooking`, 당일 불가, 0장=원장님 문의, 상태=KakaoParentIntake MAKEUP_FLOW 30분, 번호만 받아 IDOR 차단+직전 재조회). 챗봇 재확인 뒤에 연결·메뉴 「보강 신청」「보강 취소」·MAKEUP 화면링크 제거(마이페이지는 보조 버튼). 알림 linkUrl 선택값(/admin/makeup). 새 테스트 tests/kakao-makeup-flow.test.mjs(13, 실제 parent-makeup 실행). tsc 0 · 10-23 「주차」 셔틀 오분류 수정 + 검수 반영(학원차 등 앞말 예외·긍정 답 확장·짧은 말 재표시·형제 이름 정확 일치·다른 보강권 버튼·예약 목록 오늘 KST 0시 조건) + main 병합 | 보안 검수 통과·일반 검수 반영 |
| 2026-10-09 | **체험비 입금완료 오표시 수정(developer, 브랜치 claude/trial-fee-confirm-fix)** — 학부모 「비용·계좌 확인」 체크를 새 칸 `trialFeeNoticeAgreedAt`(동의 시각)에 저장, 신규 신청은 `trialFeeConfirmed=false`·재제출은 이 칸 미변경. true 쓰기는 `confirmTrialFeePayment`(감사 이력)만 — 공용 수정 허용목록·수정 모달에서 제거. 문구는 `trialFeeStatusLabel` 하나(입금 완료/입금 대기(학부모 동의함)/입금 대기). 마이그레이션 20261009090000(+ensureTrialLeadTable ADD COLUMN). 운영 정리는 제안만(24건 전부 true, 감사이력 1건). tsc 0·전체 1914/1914 | 완료(배포 7d69075c) |
| 2026-10-09 | **카카오 정책 답변(Gemini, developer, 브랜치 claude/kakao-policy-qa)** — 순수 엔진 `src/lib/kakao-policy-qa.ts`(질문 판별·주입 방어 프롬프트·[ESCALATE]·3.5초/50초 제한·useCallback·runPolicyFlow) + 연결부 `kakao-policy-qa-service.ts`(thinkingBudget 0·HMAC 해시 기록·콜백 POST) + 공용 `gemini-client.ts`(웹 챗봇도 사용). 라우트: 게스트=인증 판별 뒤·기본 카드 앞 질문만, 학부모=업무·메뉴·작성중 뒤 질문만, 못 답하면 기존 접수(+한 줄). 테이블 3(문서 이력·킬스위치 기본 꺼짐·로그 180일) migration 20261009120000. 관리자 `/admin/kakao-policy`(문서·기록 탭, 사이드바 등록). 테스트 tests/kakao-policy-qa.test.mjs(21). tsc 0·전체 1932/1932. 운영 DB 미적용. **검수 반영 1차**: 학부모 정책 종류 5개로 축소(조퇴·셔틀 신청/변경·수업 추가·복귀=접수, 예문 5개 고정)·청구/환불 답 아래 「원장님께 접수할까요?」(원 질문으로 기존 접수)·「원장님께 문의: 질문60자」→HUMAN 접수 원문·게스트 문구 교체·게스트 신규 신호면 기존 카드·한도(사용자 1분5/24h30·KST 하루 1500, 로그 기준, 인덱스 2)·동기 min(3500,4300-경과)/800ms 미만 즉시 대체·콜백 40초·redirect manual·포트 443만·알려주신 오탐·보존 42P01만 무시. 테스트 28·tsc 0·전체 1939/1939 | 검수 통과·배포(꺼짐) |
| 2026-10-08 | **카카오 학부모 인증·빈 계정 활성화(developer, 브랜치 claude/kakao-parent-claim)** — 가입에서 빈 계정 번호는 신규처럼 문자 → OTP 통과 뒤 `resolveVerifiedSignupPhone`(활성화/간편로그인 연결/여러 개=학원 문의/로그인 계정=기존 안내), `issueVerifiedSelfParentClaim`·활성화 화면 ACCOUNT 단계 직행. 연결 화면 `/kakao-connect`(rewrite·미들웨어 예외, 상황별 안내·인앱 활성화 우선). 챗봇: 유효 링크 재사용(HMAC 토큰)·인증 의도 매칭 확대·basicCard→textCard(오픈빌더 2461)·접수 확정 시 관리자 앱 알림·아침 요약 「카카오 접수 대기」. 새 테스트 4파일. tsc 0·전체 1906/1906 | 검수 대기 |
| 2026-10-06 | **Phase 2 시트 «읽기» 화면 정리(developer)** — 같은 스위치 `isSheetSyncRetired` 로 은퇴면 숨김("0"=옛 화면): 시간표 「구글시트 연동」 버튼·안내, 시스템 도구 「시트 동기화」(layout→Shell→BackupButtons), 재무 「시트 점검」 버튼·패널, 학생 관리 「점검 도구」. 크론 `/api/cron/sync-schedule` 은퇴면 410. 수강생 이관 화면 상단 "과거 자료 조회용" 안내. 삭제: readUniformOrderSheet·syncScheduleToClasses·getClassSyncPreview(호출처 0). queries.ts 요일 → kstDow(R3_ALLOW 2→1). 새 테스트 tests/sheet-read-retirement.test.mjs(9). tsc 0·npm test 1878/1879(기준선 1건) | 완료(미커밋) |
| 2026-10-06 | **Phase 2 시트 원장 은퇴(developer)** — 스위치 `src/lib/operations-sync/sheetRetirement.ts`(`STIZ_SHEET_SYNC_RETIRED` 기본=은퇴, "0"만 옛 방식 · `initialSyncAttempt`=은퇴 시 SHEET SKIPPED+`SHEET_RETIRED` · `isSheetTargetDone`). 생성처 5파일 6곳 분기, 완료판정 TS/SQL 공용 `VERIFIED_SYNC_TARGET_SQL`(SHEET만 SKIPPED 통과), 랠리즈·홈페이지 선행조건·NEEDS_CHECK·배지·워커·등록준비·수동확인(SKIPPED=할일없음)·화면(시트 버튼 숨김·랠리즈 잠금 해제·문구). 기존 PENDING/FAILED 는 코드로 안 바꿈(PM 운영 DB 정리). 시트 쓰기 코드 보존. 테스트 tests/sheet-retirement.test.mjs(12, TS·SQL 512조합 실행 대조) + 기존 6파일 의도 주석 갱신. tsc 0·관련 303/303·전체 1855/1856(기준선 worktrees 1). 미커밋 **2-D 수정 1차**: 은퇴 모드 직접 복귀(HELD·SHEET SKIPPED) 영구 정체 → recordOperationsSheetManualCheck SKIPPED+HELD 는 sheetHoldReleaseDecision 통과 시 보류만 해제(SHEET 불변·감사 COMMAND_HOLD_RELEASED) + 화면 「보류 해제 후 랠리즈 확인 진행」(래퍼 releaseEnrollmentChangeHoldSheetRetired)·보류문구 한국어. 테스트 +4. tsc 0·317/317·boundary 10/10 | 검수 대기 |
| 2026-10-06 | **원장 아침 요약 알림(developer)** — 신규 `src/lib/admin-daily-digest.ts`(순수 문구: 미납 최근 3개월 월별+그 이전 합계·기한 지남·수강변경 확인필요/승인대기, 0건이면 null, 링크 finance→NEEDS_CHECK→enrollment-changes) · `admin-daily-digest-service.ts`(Payment PENDING/OVERDUE 월별 SQL, dueDate UTC→KST 두 번 변환, `countEnrollmentChangesNeedingCheck` 호출만, 받는 사람 ADMIN·VICE_ADMIN, `createNotificationRecord`=앱알림+푸시만·문자 없음, KST 날짜당 1회 중복방지) · 크론 `/api/cron/admin-daily-digest`(CRON_SECRET) · vercel.json `30 23 * * *`(KST 08:30). 테스트 tests/admin-daily-digest.test.mjs(11). tsc 0·가드·알림테스트 통과. 미커밋 | 검수 대기 |
| 2026-10-06 | **학부모 청구 안내 사이트 발송 잠금 B안(developer)** — 신규 `src/lib/billing/parentSendGuard.ts`(`BILLING_PARENT_SEND_ENABLED==="1"`만 허용·랠리즈 사본 제외 SQL·학부모별 미납 합계). admin.ts `sendInvoiceLinksForMonth`·`sendUnpaidReminders` 첫머리 잠금(결과 반환)+사본 제외(method RALLYZ·감사로그 MIRROR)+미납 앱알림 학부모별 금액. FinanceClient 두 버튼 비활성·"랠리즈에서 발송"·안내문구 3곳, page.tsx 잠금값 전달. 테스트 billing-parent-send-lock(7)+notification-policy 3번 갱신. tsc·49+5 통과. 미커밋 | 검수 대기 |
| 2026-10-06 | **확인 필요 화면 오류 이유 노출 + 시트 수동 확인 탈출구(developer)** — enrollment-changes.ts 래퍼 3개(`applyEnrollmentChangeSheet`·`confirmEnrollmentChangeRallyz`·`confirmEnrollmentChangeSheetManually`, `{ok}|{ok:false,message}`, 한글 메시지만 노출). operations-sync.ts `recordOperationsSheetManualCheck` 신설(WEBSITE SUCCEEDED·PAUSE/WITHDRAW/RESUME·적용일 도래만, SHEET→SUCCEEDED+verifiedAt, HELD→PENDING 해제, 감사 `SYNC_TARGET_MANUALLY_CONFIRMED`). 클라이언트 래퍼만 호출·HELD 여도 버튼 노출·「시트 직접 수정 완료」. 테스트 tests/enrollment-sync-manual-check.test.mjs(5)+due-auto-apply 3줄 갱신. tsc·211+5 통과. **권장 2건 반영**: HELD 해제는 `sheetHoldReleaseDecision`(src/lib/enrollment/sheetManualCheckRules.ts — studentId·enrollmentChangeRequestId 필수 + 시트 충돌 보류 또는 RESUME 어댑터 보류만) 통과 시만, RESUME 은 「시트에 반영」 숨김·보류 문구 한국어 표시. 테스트 9개·215+5 통과. 미커밋 | 검수 대기 |
