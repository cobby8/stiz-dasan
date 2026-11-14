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

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-14 | developer(보강 예약 학년 판정, claude/makeup-grade): 학생 학년 = 생년월일 계산(student-grade.ts, 임시 생일 2000-01-01·빈 값이면 학년 글자), 후보 = 포함 먼저+±1 유지·미취학 위로 2학년·성인반끼리(credit-rules.makeupGradeFit, 목록·예약 같은 판정), 빈 목록 4종 그 자리 버튼(학년 확인·다시 확인·학원에 문의→홈 메시지 폼), 문구 한 줄씩. 휴원 차단 조건 없음. tsc 0·node --test 4795/0 | 검수 대기 |
| 11-14 | PM: 청구 월 카드(f8bc4572+결제하기 안전장치 87c09363·중복 누름 8e43b575)·기사 운행표 휴원·휴무(067011c5)·앱 1.0.3 버전(5175e8ec) 묶음 배포 a2ce24e READY·오류 0. 안드로이드 vc6 내부 테스트 게시·iOS Codemagic #6 TestFlight 처리 완료(외부 베타 정보 미입력 경고만) | 완료 |
| 11-14 | developer(기사님 운행표 휴원·휴무, claude/driver-paused-holiday): 휴원·퇴원·첫 수업 전 = 회색 뱃지+탑승·미탑승 잠금(명단 유지), 휴무일 = 맨 위 «오늘은 휴무(사유)»+정규 줄 잠금, 저장 API 2곳 409, 관리자 운행표 뱃지+«이 달 휴무». 판정 = regularRunDayRules(학부모 childShuttleRules 재사용). 운영 읽기: 휴원 3명·6행 뱃지 대상. 리뷰 반영(월말 다음 달 미입력=모름·반 0개는 퇴원 기록 있을 때만 퇴원·409 문구 표시) tsc 0·node --test 4672/0·guards 5/0 | 재검수 대기 |
| 11-14 | developer(청구 월 카드, claude/billing-cards): 학부모 청구 탭·아이 기록 = 한 달 한 줄(청구월·합계·상태) + 세부 시트(할인 «원래−할인=낼 금액»·기존 결제 버튼 그대로 시트 안) · 할인 원인 = Payment 에 할인 칸 없음, 글(description) 안에만 있어 카드가 원문을 통째로 보였음 → 해석 156/157건 · 청구 탭 날짜 두 번 변환 · tests 4661-0·guards 5-0·tsc 0 | 검수 대기 |
| 11-14 | developer(아이 정보+셔틀, claude/child-profile): /mypage/record 위에 아이 정보(생년월일·학년(생일 기준+등록 학년)·학교·성별·등록일·대표 보호자·내 연락처·연결 가족 이름·보강권)·수강 반(수업 탭 칩)·셔틀(요일별 승하차·7일 운행: 휴무·휴원·결석·안 탐·다른 곳, 방학특강·신청 접수, 기사님 전화) 접기 칸 · **버그 수정: 학부모 홈·수업 탭 정규 셔틀이 빈 옛 표(ShuttleRoutePassenger 0행)만 읽어 60명 전원 미표시 → 명단 기준(childShuttleRules) 항목 추가** · 운영 읽기 대조 6명 요일별 불일치 0 · **1차 수정(검수)**: 신청 접수 카드 = 명단 등재 여부(getRosterStudentIds)로 제외 · 일정 탭 명단 항목 요일별 한 줄+«아이 기록 › 셔틀» · 반 없음/못 찾음 = 운행 아님(NO_CLASS·CHECK) · 명단 조회 첫 병렬 묶음·기록은 그 아이만 · 빈 studentId 11행 = 2호점 운영 정차(학생 행 아님, 채울 것 없음) · tests 4583-0·tsc 0 | 검수 대기 |
| 11-14 | reviewer(수업 피드 ab61a2db): 통과 — 필수 0·권장 3(종료 창 비우기 COALESCE·대타 날짜 조각·자정 넘긴 진행 수업 사진). 운영 대조 날짜 불일치 0·소식 20→20 | 통과 |
| 11-14 | developer(수업 피드, claude/feed-ui): 동의 제거·볼 수 있는가 판정 통일(feed/rules·server)·선생님 수업 피드 칸·홈 최신 수업 피드 카드·소식 상세 재작성·동의 UI 제거·공개 게시 동의 스위치 끔. tsc 0·tests 4620-0·guards 5-0 | 완료(검수 대기) |
| 11-14 | developer(아이 기록 w1~w4·q1~q4, claude/child-record): 새 화면 /mypage/record(홈 소속·요약 4칸·청구 이력 연도칩+필터 시트+월 묶음 접기·출석 12개월 막대(기록 없음 «–»)·수강 반 타임라인·특강/유니폼/리포트) · 순수 lib/parent/childRecordRules + 조회 childRecordQuery(첫 SQL 권한 재확인·섹션별 null·무tz 두 번) · 홈 한 줄·청구 탭 요약 줄/형제 칩/월 묶음/납부 완료 한 줄 행·수업 탭 «이번 달 출석 n/m»+«전체 기록»·소식 요약 줄 · 홈 영수증 = 결제 권한자(q3) · BarChart missing/showValues · tests/parent-child-record-rules 15건. tsc 0·tests 4571-0·운영 읽기 대조(납부 합계 SQL 일치) | 검수 대기 |
| 11-14 | developer(수업 영상, claude/session-video): SessionVideo·YouTubeConnection 표(마이그레이션 20261114120000, RLS FORCE, 버킷 session-videos 50MB — 운영 미적용) · 선생님 촬영·직접 업로드·삭제(당일 KST 자정까지) · 학부모 재생 API/부품 · /admin/youtube 연결 · cron youtube-upload 15분 · 안드로이드 영상 촬영·선택. tsc 0·전체 테스트 fail 0 | 검수 대기 |
| 11-14 | developer(학부모 설정 화면 손보기, claude/parent-settings-fix): 결제 방법 줄 세로 접힘(.academy-input width:100% 가 w-32 를 이김) · 옛 앱 알림 «업데이트» 안내(nativePushNotice·appUpdateTarget, 아이폰 1.0 은 버튼 없이 글) · 버전 «앱 1.0.2 / 화면 xxxxxxx»(appVersionLabels) · 아래 탭 64→48px+env 안전영역(pb-safe 는 정의 없던 글자) · tests/parent-settings-fix-1114 | 완료(전체 fail 0·tsc 0) |
| 11-13 | developer(대시보드·통계 개편, claude/admin-stats 2커밋): 대시보드 맨 위 카드 6개(재원생·수납률·출석률·신규/퇴원·체험→등록·유니폼) + 통계 /admin/stats 탭 5개(?tab=&branch=&period=, 필터 버튼+창) · 순수 규칙 lib/stats/statsRules.ts(학년 KST 3월 기준·성별·지점·유니폼 5묶음) + 조회 statsQueries.ts(무tz 두 번·tz 한 번) · 접힌 «운영 현황» 제거(내용은 통계 탭) · 신청 설정 «유입 통계» 제거 · «통계» 메뉴 대시보드 아래 · 옛 /api/admin/stats 삭제. 운영 DB 대조: 재원생 133 = 목록 «활성» 133, 학년·성별·지점·유니폼 합 133. tests 4521-0 · tsc 0 · studentVisibility 4-1(payerAccess.ts 기존 실패, 이번 변경 무관) | 검수 대기 |
