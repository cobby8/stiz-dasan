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


## 작업 로그 (최근 10건)
| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-17 | developer(직원 간편로그인 연결, claude/staff-app-08fde4): 직원 화면 /staff/mypage/login-methods(requireStaff·앱에서는 버튼 숨김+안내·1회용 표 발급 없음) · 마이페이지에 진입 줄 · 공용 판정 lib/account/link-actor.ts(학부모→직원)+순수 규칙 login-methods-rules.ts · 시작 라우트·콜백의 복귀 화면을 서버 판정으로(주소 파라미터 안 받음) · 브라우저 간편로그인 콜백이 직원 계정을 /auth/continue 로(requireNativeAccount 재사용) · 새 테스트 tests/staff-login-methods-link.test.mjs, 기존 단정 2곳 조정. tester 참고: 로그인 화면 실행 확인 못 함 — 브라우저에서 직원 로그인 → 연결 → «연결됨», 앱에서 버튼 숨김·안내, 연결 뒤 /login 간편로그인으로 직원 화면 진입을 실기기로 볼 것. reviewer 참고: 자녀 있는 직원은 학부모 화면으로 복귀·보안 문자의 recipientRole 이 PARENT 로 기록됨. tsc 0 · tests 5829 fail 0 · guards 337 fail 0 | 구현 완료(검수 전) |
| 11-16 | developer(학생별 고정 수강료 + 평일 대회준비반 주N회, claude/fixed-tuition): 표 StudentFixedTuition(마이그레이션 20261116500000, **운영 적용 전**) · planWeeklyTuition 2번째 인자 = 첫 반 고정액·나머지 0원·할인/3회 차감 없음·셔틀 유지 · 청구 준비 «고정 15만» 표시 · 학생 상세 «청구/수납» FixedTuitionPanel(원장 requireOwner) · 평일 대회준비반 15만 고정 삭제 → 주N회 합계÷N(할인·3회 차감 없음, 주1회 priceWeek1 우선) · 검수 반영: 확정 장부 일부면 미적용·발행 가능한 첫 행에 고정액·패널 «원본 변경» 안내 · tsc 0·test fail 0 | 완료 |
| 11-16 | developer(가입 안내 가입함 포함, claude/signup-guide-signed-in): 가입한 보호자·성인 본인도 대상 «가입함»(로그인 안내 문구 원장 전문, 성인은 회원·혜택 2줄 변경) · 가입 막힘·학원 문의 판정은 미가입에만 · 구성 = 미가입 재원/휴원/성인 + 가입함(겹침 없음) · 미리보기 문구 4종 블록 · 지문에 가입 여부·네 문구 포함 · /login 실재 확인. tsc 0 · tests 5739-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(가입 안내 전체, claude/signup-guide-all): 대상 = 수강 ACTIVE+PAUSED 학생 대표 보호자(퇴원만 제외)·성인(만19+ KST)은 대표 보호자=본인 빈 계정이라 같은 길 · 번호별 구분 재원/휴원/성인(성인만 있는 번호=성인용 문구, 학부모 승인본에서 3줄만 바꿈) · 가입 막힘(«빈 보호자 계정» 아닌 계정이 같은 번호) 제외·빈 계정 여럿은 경고 · 미리보기 구성·성인 문구 표시 · 큐 items 로 사람별 문구, 지문에 구분 포함. tsc 0 · tests 5716-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(청구서 안내 묶어보내기, claude/invoice-notice-bundle): 같은 번호의 같은 달 청구서 2장↑ = 묶음 LMS 1통(열쇠 invoice-bundle:정렬id, 2,000바이트 넘으면 나눔), 1장은 예전 그대로(알림톡 심사본) · 예약 잠금 안 청구서 단위 겹침 검사(invoiceIds &&, 재발송 종류끼리) · 대상 조회 loadInvoiceNoticeCandidates 를 발송·확인창(previewInvoiceNoticeCounts, 읽기만) 공용 · 앱 알림 학부모당 1건 · 확인창·진행 줄 «청구서 N장 → 문자 M통(묶음 K통)». 12월 예상 179장→120통(묶음 48·최장 941바이트). tsc 0 · tests 5717-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(쇼핑몰 유니폼 주문 → 학부모 화면, claude/uniform-shop-orders): 표 UniformShopOrder·UniformShopOrderItem(마이그레이션 20261116300000, 운영 적용 전) · lib/uniform/shopOrderSync.ts(서명 GET·응답 엄격 검증·한 SQL 문 upsert, 지우기 없음) · cron /api/cron/uniform-shop-sync 매시 17분(?days·?from&to) · loadChildUniformOrders 사이트+쇼핑몰 합쳐 최신순(본인 번호=구매자/수령인 + 이름 열쇠, 이름 빈 품목 제외, 표 없으면 빈 목록) · 줄에 «쇼핑몰»/«사이트» 글자. tsc 0 · tests 5703-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(아이 위주 프로필, claude/parent-child-photo): 홈 히어로 아이 사진 옆 «사진 올리기/바꾸기» 글자 버튼 늘 표시(ProfilePhotoEditor variant="button", 그 자리 업로드) · 설정 맨 위 «우리 아이»(아이마다 사진·이름→아이 정보, 사진 버튼) · 보호자 «내 사진» 칸(MyPhotoRow) 제거, 사진 파일·DB·API 는 그대로 · 테스트 갱신. tsc 0 · tests 5681-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(핵심 데이터 seed 자동 저장, claude/seed-auto): 매일 백업 cron·«전체 백업 지금 저장»이 같은 실행에서 스냅샷(Program·ClassSlotOverride·이용약관, 정해진 칸만)을 backups/seed/seed-latest.json + seed-<날짜>.json(30일)로 저장 · POST /api/admin/seed 는 Storage 최신본 먼저 → 없음·읽기 실패·모양 이상·프로그램 0줄이면 prisma/seed-data.ts · 공용 lib/backup/seedSnapshot.ts(순수) · 대시보드 «핵심 데이터 자동 저장» 한 줄 · 버킷 목록 3곳 seed 폴더 칸 제외 · CLAUDE.md 는 developer 수정 불가라 문안만 PM 에 전달. tsc 0 · tests 5646-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | PM(통합 claude/deploy-1116): 재원생 무료 대관 화면(memberMode)·글자 12px↑·굵기 4단계·ORM 4건·브라우저 경고창 178곳 → feedback.tsx, 가드 예외 폴더 제거, 크론 퇴원 정리(141768e4) 배포 |
| 11-16 | 남은 정리(claude/cleanup-type-weight): 12px 미만 글자 20곳→12px · 800/900 굵기 35곳→제목 font-[700]·그 외 600(OG·지도·도넛 700) · 입학 완료 확인 화면 ORM 4건→$queryRawUnsafe · 가드 tests/type-weight-guard.test.mjs. tsc 0 · tests 5619-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(브라우저 기본 경고창 제거, claude/no-browser-alert): 공용 부품 `src/components/ui/feedback.tsx`(showNotice·askConfirm·showCopyText, 레이아웃에 FeedbackHost) · alert 76·confirm 99·prompt 3곳 교체(대관 두 폴더 제외) · 링크 가드는 막고→확인→다시 클릭, 확인 함수는 Promise<boolean> · 가드 tests/no-browser-dialog-guard · tsc 0·test fail 0 | 브랜치 push(main 미반영) |
