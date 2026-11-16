# 작업 스크래치패드

## 현재 작업
- **상태(2026-11-16)**: 12월 실사용 출시 진행 중. 개발 환경을 SAM 데스크탑으로 옮겼고, 총괄 세션 아래 업무별 세션 5개로 나눠 일한다 — 출시·배포 / 청구·수납 / 학부모 화면 / 선생님·기사님 앱 / 관리자 화면·코드 정리. 세션마다 자기 worktree(브랜치)에서 일하고, main 반영·운영 배포는 «출시·배포» 세션이 모아서 한다.
- 운영 = `main`(`eac74476`, 앱 1.0.4 준비·고정 수강료 포함). 운영 DB 마이그레이션은 `20261116500000_student_fixed_tuition` 까지 모두 적용됨(11-16 list_migrations 로 확인 — 11-10 의 4개 포함).
- 검수 전 브랜치가 여럿 있다(아래 작업 로그의 «구현 완료(검수 전)» 줄). 통합 여부는 «출시·배포» 세션이 판단한다.

## 진행 현황
| 항목 | 상태 |
|------|------|
| 목록 화면 개편 8단계 | 전부 배포(10-30, `98fe9fe9`). 뺀 것: 방학특강 반 카드·출석부·결석·셔틀, 수업 진행·사진 게시, 학부모 결제·수납 탭 |
| UI 통일(네이비+하늘색·아이콘 없이 글자·굵기 4단계) | 배포(11-13) · 12px 미만 글자·800/900 굵기·브라우저 경고창 정리 배포(11-16, `3d73fac4`) |
| 안 쓰는 기능 정리 | 결정표 9칸 전부 «안 쓴다» → 가 5건·나 2건·다(수업 기록 창) 모두 완료·push(11-17). 결정표 https://claude.ai/artifact/QbAMyZW2XvbTA3aCsZraNe |
| 이월 리뷰 수정 | R-1·R-3 이미 고쳐짐 · M-1·R-8② 완료(11-17). 남은 것 R-2·R-7②(관리자 세션) · P-1·P-2(청구 세션) |
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
| R-2 | actions/public.ts:283·833 | 권장 | source/referralSource 가 «비어 있지 않은지»만 본다 — 서버 화이트리스트 검증 |
| R-7② | lib/seasonal/shuttleRoster.ts `seasonScope` | 권장 | 다음 시즌 신청자가 목록·확정 버튼에서 사라짐(시즌 스코프 전체 합산) — 11-16 코드는 그대로, 증상 재현은 아직 안 함 |
| P-1 | lib/pos/chargeRequestService.ts writeLedgerPaid·settleCancelForRow | 권장 | 납부 기록(markPaymentPaid 무조건 UPDATE) 직전에 POS 취소 웹훅이 끼면 요청 DONE·청구 PENDING→뒤이어 PAID 로 덮임(사이트 납부완료·실제는 취소). 기록 뒤 cancelState 재확인 → DONE 이면 refundPaidPaymentInTx, 또는 settle 에서 refunded=false·청구 미납이면 retryLater |
| P-2 | admin/finance/FinanceClient.tsx:955 «환불» | 권장 | TOSS_POS 건에도 그대로 → POS 는 안 취소되고 사이트만 REFUNDED. TOSS_POS 면 숨기거나 확인창에 «POS 결제는 취소되지 않음, 결제 취소를 쓰세요» 경고 |


- ⚠️ (11-08 POS 결제 취소 리뷰) 마이그레이션은 build 에 migrate deploy 가 없어 **배포 전 apply_migration 필수**(안 하면 현장 결제 전체 정지).


## 작업 로그 (최근 10건)
| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-17 | 이월 리뷰 R-8②(claude/admin-cleanup-204a7d): 방학 셔틀 확정 명단 아래 «뺀 학생 N명» 접힌 목록 + 줄마다 «되돌리기»(removedShuttleRosterRows, GET 새 키 removed, 첫 화면 initialRemoved). 수강이 취소된 학생은 화면·서버 모두 되돌리기 거부(ROSTER_ENROLLMENT_CANCELLED_SQL 한 상수, 409 한글 문구). «신청관리에서 취소»로 빠진 학생을 되돌리면 원본 신청서 status 도 CANCELLED→REQUESTED(확정본이 살아 있을 때만). 기사님·배차 조회는 불변. 남은 것(범위 밖): 신청관리의 «이용» 복구가 확정본을 되살리지 못하는 것으로 읽힘(route.ts isShuttleRequestConfirmed 가 removedAt IS NULL 만 확정으로 봄 — 실행 확인 전) · 부원장에게도 버튼이 보이고 누르면 403. tsc 0 · tests fail 1(staff-session-review 날짜 고정, 무관) · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-17 | 이월 리뷰 M-1(claude/admin-cleanup-204a7d): 관리자 보강 예약 bookMakeupSession 이 잠금(lockCompensation) 뒤·INSERT 전에 정원을 tx 로 한 번 더 확인(assertMakeupSeatAvailable 에 db 인자, tx 안에서는 집계 실패를 삼키지 않음). 정원 문구는 catch 에서 그대로 다시 던짐. tests/makeup-capacity 에 소스 순서 3건 + 실행 2건(동시 예약 2건 → 저장 1건, 재확인 뺀 사본은 2건 = 초과 재현). 남은 것(범위 밖): 운영 빌드는 서버 액션 오류 문구를 가려 결석 화면(RegularAbsenceAdminClient)에 영어 문구가 뜰 수 있음 · 학부모 길 정원 기준(+2)과 다름 · updateMakeupStatus 의 CANCELLED→BOOKED 는 정원 확인 없음. tsc 0 · tests fail 1(staff-session-review 날짜 고정, 무관) · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-17 | 관리자 정리 다 묶음(claude/admin-cleanup-204a7d): 반 상세 «수업 기록» 창(SessionLogModal)·saveSessionLog·resolveSessionLogTarget·/api/admin/session-detail 삭제 → «추가»는 /admin/attendance, 기록 칸은 리포트 편집 링크. 출결은 saveAttendance 한 길(과거 날짜 고치면 보강권도 맞춰짐, 알림은 오늘 수업만). 사라진 것: 수업 요일 밖 날짜의 새 기록·그런 기존 기록의 출석 수정(운영 1건, 2026-05-08) · 출석 없이 기록만 만들기 · 수강생 0명 반 기록. KST 가드 R1 19→17·R4 2→1. tsc 0 · tests 5818 중 fail 1 = tests/staff-session-review.test.mjs:293 (수업 날짜 2026-11-16 고정이라 날짜가 넘어가면 깨짐 — 이번 변경 무관, 선생님 앱 세션 확인 필요) · guards 337-0 · reviewer 결함 없음 | 브랜치 push(main 미반영) |
| 11-16 | 관리자 정리 나 묶음(claude/admin-cleanup-204a7d): 설정 «시설 사진»·프로그램 «이미지»의 주소 입력 → «사진 올리기»(미리보기+삭제, 시설은 여러 장). 기존 길 그대로 = uploadImagesWithProgress → /api/upload, 폴더 coaches(허용 목록 그대로). 저장 payload 불변, 새 부품 components/admin/AdminPhotoThumb(일반 img·실패 글자). 운영 프로그램 이미지 7개는 모두 자체 저장소 주소. 안 쓰게 된 사진 파일은 저장소에 남음(코치·갤러리와 같음). tsc 0 · tests 5819-0 · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-16 | 관리자 정리(claude/admin-cleanup-204a7d): 원장 결정표 9칸 전부 «안 쓴다» → 가 묶음 5건 삭제(방학특강 «상태 직접 변경» select · 공지 «페이스북 광고 소재» · 갤러리 «인스타 가져오기» 버튼+액션 · 설정 AppliesTo 9곳 · «외부 신청 링크» 2칸+siteOpsBot 신청서 점검). trialFormUrl·enrollFormUrl 은 저장 요청에서 빼 DB 값 유지. 남은 것: 나(주소 입력→파일 올리기 2건) · 다(수업 기록 창, 원장 선택 대기). 다음 정리 후보: 발행 때마다 쌓이는 FACEBOOK_AD_DRAFT 기록(social-campaigns.ts). architecture 51→28 병합. tsc 0 · tests 5819-0 · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-16 | developer(학생별 고정 수강료 + 평일 대회준비반 주N회, claude/fixed-tuition): 표 StudentFixedTuition(마이그레이션 20261116500000, **운영 적용 전**) · planWeeklyTuition 2번째 인자 = 첫 반 고정액·나머지 0원·할인/3회 차감 없음·셔틀 유지 · 청구 준비 «고정 15만» 표시 · 학생 상세 «청구/수납» FixedTuitionPanel(원장 requireOwner) · 평일 대회준비반 15만 고정 삭제 → 주N회 합계÷N(할인·3회 차감 없음, 주1회 priceWeek1 우선) · 검수 반영: 확정 장부 일부면 미적용·발행 가능한 첫 행에 고정액·패널 «원본 변경» 안내 · tsc 0·test fail 0 | 완료 |
| 11-16 | developer(가입 안내 가입함 포함, claude/signup-guide-signed-in): 가입한 보호자·성인 본인도 대상 «가입함»(로그인 안내 문구 원장 전문, 성인은 회원·혜택 2줄 변경) · 가입 막힘·학원 문의 판정은 미가입에만 · 구성 = 미가입 재원/휴원/성인 + 가입함(겹침 없음) · 미리보기 문구 4종 블록 · 지문에 가입 여부·네 문구 포함 · /login 실재 확인. tsc 0 · tests 5739-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(가입 안내 전체, claude/signup-guide-all): 대상 = 수강 ACTIVE+PAUSED 학생 대표 보호자(퇴원만 제외)·성인(만19+ KST)은 대표 보호자=본인 빈 계정이라 같은 길 · 번호별 구분 재원/휴원/성인(성인만 있는 번호=성인용 문구, 학부모 승인본에서 3줄만 바꿈) · 가입 막힘(«빈 보호자 계정» 아닌 계정이 같은 번호) 제외·빈 계정 여럿은 경고 · 미리보기 구성·성인 문구 표시 · 큐 items 로 사람별 문구, 지문에 구분 포함. tsc 0 · tests 5716-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(청구서 안내 묶어보내기, claude/invoice-notice-bundle): 같은 번호의 같은 달 청구서 2장↑ = 묶음 LMS 1통(열쇠 invoice-bundle:정렬id, 2,000바이트 넘으면 나눔), 1장은 예전 그대로(알림톡 심사본) · 예약 잠금 안 청구서 단위 겹침 검사(invoiceIds &&, 재발송 종류끼리) · 대상 조회 loadInvoiceNoticeCandidates 를 발송·확인창(previewInvoiceNoticeCounts, 읽기만) 공용 · 앱 알림 학부모당 1건 · 확인창·진행 줄 «청구서 N장 → 문자 M통(묶음 K통)». 12월 예상 179장→120통(묶음 48·최장 941바이트). tsc 0 · tests 5717-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-16 | developer(쇼핑몰 유니폼 주문 → 학부모 화면, claude/uniform-shop-orders): 표 UniformShopOrder·UniformShopOrderItem(마이그레이션 20261116300000, 운영 적용 전) · lib/uniform/shopOrderSync.ts(서명 GET·응답 엄격 검증·한 SQL 문 upsert, 지우기 없음) · cron /api/cron/uniform-shop-sync 매시 17분(?days·?from&to) · loadChildUniformOrders 사이트+쇼핑몰 합쳐 최신순(본인 번호=구매자/수령인 + 이름 열쇠, 이름 빈 품목 제외, 표 없으면 빈 목록) · 줄에 «쇼핑몰»/«사이트» 글자. tsc 0 · tests 5703-0 · guards 337-0 | 구현 완료(검수 전) |
