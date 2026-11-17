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


- ⚠️ (11-08 POS 결제 취소 리뷰) 마이그레이션은 build 에 migrate deploy 가 없어 **배포 전 apply_migration 필수**(안 하면 현장 결제 전체 정지).


## 작업 로그 (최근 10건)
| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-17 | reviewer(셔틀 당일 변경 칸 → 버튼): 통과 · 필수 0 · 권장 3(겹친 창 뒤로가기 스크롤 잠금·취소 뒤 포커스·달 경계 재마운트) · tsc 0 · tests 5988 fail 0 | 리뷰 완료 |
| 11-17 | developer(셔틀 당일 변경 칸 → 버튼, claude/staff-app-08fde4): 운행표 위 «셔틀 당일 변경» 칸을 없애고 머리줄 «기사 요청» 뒤 «당일 변경» 버튼 하나(건수 배지 = 안내색) + 창(목록 전부·목록만 스크롤). ShuttleDayExceptionAdminPanel 이 버튼+창을 그리고 page.tsx 가 RegularRunEditor 의 headerExtra 로 넘김. 겹친 창은 맨 위만 Esc 로 닫힘(closeList, AdminModal 안 고침). 로그인 화면 실행 확인 못 함. tsc 0 · tests 5988 fail 0 · guards 337 fail 0 | 구현 완료(검수 전) |
| 11-17 | reviewer(수업 미처리 장치 1단계): 통과 · 필수 1(마이그레이션 «가장 최근 폴더» 단정) · 권장 4 · tsc 0 · tests 5966 fail 0 · guards(src/lib/*.test.ts) 82 fail 0 · eslint 변경 파일 0 | 리뷰 완료 |
| 11-17 | developer(수업 미처리 장치 1단계, claude/staff-app-08fde4): 순수 규칙 lib/class-nudge/rules.ts(상태 10종·임계 10·10·30 한 곳·시계 안 읽음) · 집합 조회 boardQuery.ts(정규·특강·휴강·담당 4번 차례로) · 조립 board.ts · 휴강 저장 cancelStore.ts · 연결부 boardServer.ts(DB 사실 30초 캐시, 휴무는 캐시 밖) · 대시보드 «오늘의 수업» → «오늘 수업 처리 현황»(components/admin/ClassDayBoardCard, /api/admin/class-day-board, 60초 새로 읽기) · 휴강 표시·취소 액션(actions/class-day-cancel.ts, 원장·부원장, 감사 기록) · 새 표 ClassDayCancel(마이그레이션 20261117120000_add_class_day_cancel, **운영 적용 전** — 표 없으면 읽기 «휴강 없음»·쓰기 «준비 중»). 설계와 다른 점: 특강 미확인은 진행 중만 좌석 칸 기준·그 밖은 «좌석도 출결 기록도 없음»(관리자 특강 저장이 좌석 칸을 안 채움) · 휴무 판정은 캐시 밖. 조회 SQL 은 실제 DB 에서 못 돌려 봄·로그인 화면 실행 확인 못 함. 새 테스트 tests/class-nudge-*.test.mjs 94건. tsc 0 · tests 5966 fail 0 · guards 337 fail 0 | 구현 완료(검수 전) |
| 11-17 | developer(선생님 음성으로 기록 수리, claude/staff-app-08fde4): 다른 화면에서 넘어온 선생님 화면은 한 번 새로 불러오기(순수 규칙 lib/staff/documentPolicy.ts + 부품 staff/StaffDocumentReload.tsx, 운행 화면 /staff/run 제외·되풀이 방지 표식) · 음성 변환 라우트 모델 = GEMINI_CHAT_MODEL, 실패 기록에 오류 번호 추가, 로그인 풀림 401 · 버튼 안내 원인별 5문구 + «새로 불러오기»(lib/staff/voiceStartError.ts) · 새 테스트 tests/staff-voice-input.test.mjs 16건. 실기기 확인 못 함. tsc 0 · tests 5849 fail 0 · guards 337 fail 0 | 구현 완료(검수 전) |
| 11-17 | developer(직원 간편로그인 연결 보안 보강, claude/staff-app-08fde4): 직원 연결 시작 = 폼 POST + 출처 확인(isAllowedLinkHandoffOrigin 재사용), 직원 GET intent=link 는 시작 안 함(e=start) · 직원 화면 오류 = 주소 코드 e → 표(STAFF_LINK_ERROR_MESSAGES), error 문장은 읽지 않음 · 학부모 흐름 그대로 · 시작 라우트 실행 테스트 추가 · tsc 0 · 전체 5833 fail 0 · guards 337 fail 0 | 완료(검수 전) |
| 11-17 | developer(직원 간편로그인 연결, claude/staff-app-08fde4): 직원 화면 /staff/mypage/login-methods(requireStaff·앱에서는 버튼 숨김+안내·1회용 표 발급 없음) · 마이페이지에 진입 줄 · 공용 판정 lib/account/link-actor.ts(학부모→직원)+순수 규칙 login-methods-rules.ts · 시작 라우트·콜백의 복귀 화면을 서버 판정으로(주소 파라미터 안 받음) · 브라우저 간편로그인 콜백이 직원 계정을 /auth/continue 로(requireNativeAccount 재사용) · 새 테스트 tests/staff-login-methods-link.test.mjs, 기존 단정 2곳 조정. tester 참고: 로그인 화면 실행 확인 못 함 — 브라우저에서 직원 로그인 → 연결 → «연결됨», 앱에서 버튼 숨김·안내, 연결 뒤 /login 간편로그인으로 직원 화면 진입을 실기기로 볼 것. reviewer 참고: 자녀 있는 직원은 학부모 화면으로 복귀·보안 문자의 recipientRole 이 PARENT 로 기록됨. tsc 0 · tests 5829 fail 0 · guards 337 fail 0 | 구현 완료(검수 전) |
| 11-17 | 이월 리뷰 R-8②(claude/admin-cleanup-204a7d): 방학 셔틀 확정 명단 아래 «뺀 학생 N명» 접힌 목록 + 줄마다 «되돌리기»(removedShuttleRosterRows, GET 새 키 removed, 첫 화면 initialRemoved). 수강이 취소된 학생은 화면·서버 모두 되돌리기 거부(ROSTER_ENROLLMENT_CANCELLED_SQL 한 상수, 409 한글 문구). «신청관리에서 취소»로 빠진 학생을 되돌리면 원본 신청서 status 도 CANCELLED→REQUESTED(확정본이 살아 있을 때만). 기사님·배차 조회는 불변. 남은 것(범위 밖): 신청관리의 «이용» 복구가 확정본을 되살리지 못하는 것으로 읽힘(route.ts isShuttleRequestConfirmed 가 removedAt IS NULL 만 확정으로 봄 — 실행 확인 전) · 부원장에게도 버튼이 보이고 누르면 403. tsc 0 · tests fail 1(staff-session-review 날짜 고정, 무관) · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-17 | 이월 리뷰 M-1(claude/admin-cleanup-204a7d): 관리자 보강 예약 bookMakeupSession 이 잠금(lockCompensation) 뒤·INSERT 전에 정원을 tx 로 한 번 더 확인(assertMakeupSeatAvailable 에 db 인자, tx 안에서는 집계 실패를 삼키지 않음). 정원 문구는 catch 에서 그대로 다시 던짐. tests/makeup-capacity 에 소스 순서 3건 + 실행 2건(동시 예약 2건 → 저장 1건, 재확인 뺀 사본은 2건 = 초과 재현). 남은 것(범위 밖): 운영 빌드는 서버 액션 오류 문구를 가려 결석 화면(RegularAbsenceAdminClient)에 영어 문구가 뜰 수 있음 · 학부모 길 정원 기준(+2)과 다름 · updateMakeupStatus 의 CANCELLED→BOOKED 는 정원 확인 없음. tsc 0 · tests fail 1(staff-session-review 날짜 고정, 무관) · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-17 | 관리자 정리 다 묶음(claude/admin-cleanup-204a7d): 반 상세 «수업 기록» 창(SessionLogModal)·saveSessionLog·resolveSessionLogTarget·/api/admin/session-detail 삭제 → «추가»는 /admin/attendance, 기록 칸은 리포트 편집 링크. 출결은 saveAttendance 한 길(과거 날짜 고치면 보강권도 맞춰짐, 알림은 오늘 수업만). 사라진 것: 수업 요일 밖 날짜의 새 기록·그런 기존 기록의 출석 수정(운영 1건, 2026-05-08) · 출석 없이 기록만 만들기 · 수강생 0명 반 기록. KST 가드 R1 19→17·R4 2→1. tsc 0 · tests 5818 중 fail 1 = tests/staff-session-review.test.mjs:293 (수업 날짜 2026-11-16 고정이라 날짜가 넘어가면 깨짐 — 이번 변경 무관, 선생님 앱 세션 확인 필요) · guards 337-0 · reviewer 결함 없음 | 브랜치 push(main 미반영) |
| 11-17 | 관리자 정리 «발견한 것 4건»(claude/admin-cleanup-204a7d): ① 유입 경로 한글 이름 한 곳(REFERRAL_SOURCE_LABELS, 통계·수강 신청·체험 관리 공용, 선택 상자 3곳 16개·순서 통일, «스티즈 네이버블로그»·«네이버 외 포털검색»으로 글자 변경) b679f36e ② 보강 예약 거절 사유를 결과 값으로(bookMakeupSession·scheduleMakeupForAbsence 가 {ok:false,message} — 운영 빌드가 던진 문구를 가림) 1c322223 ③ 신청관리 «이용» 복구가 뺀 확정본도 되살림(hasRevivableRemovedShuttleRosterRow, 부원장은 403) 62ac73e3 ④ 공지 소셜 발행의 FACEBOOK_AD_DRAFT 기록 중단 52253e07. ①~④ 모두 reviewer 통과(①② 는 한도 해제 뒤 11-17 재개 검수). 원생 가입경로 칸에 유튜브·당근·문자·검색광고 류 값 0건이라 통계 숫자 합쳐짐 없음(운영 조회). 남은 것: 결석 화면의 다른 던지는 사유(«이미 지정된 보강이 있습니다» 등)도 운영에서 영어로 뜸 · 부원장 403 문구가 «확정은 원장만»이라 복구 상황에 어색 · placeStudentAtFreeHub 는 수강 취소 확인 없음. tsc 0 · tests 5883 중 fail 1(staff-session-review 날짜 고정, 무관) · guards 337-0 | 브랜치 push(main 미반영) |
| 11-17 | 이월 리뷰 R-2(claude/admin-cleanup-204a7d): 공개 체험·수강 신청의 유입 경로를 서버가 허용 목록과 대조 — 목록 밖 값은 거절하지 않고 OTHER 로 저장. 목록 한 곳 = src/lib/enrollment/referralSources.ts(16개: 두 신청서 선택지 합집합 + 관리자·예전 값, UNKNOWN 은 통계가 만드는 이름이라 제외). public.ts 두 저장 함수의 INSERT·UPDATE 4곳. tests/referral-source-allowlist(17건: 화면 선택지가 목록 안인지·가짜 DB 실행·대조). 남은 것(범위 밖): 통계 라벨 표(sourceLabels)·관리자 수강 수정 선택지에 NAVER_AD·YOUTUBE·DANGGEUN·SMS_PROMOTION 이름 없음(코드 글자 그대로 보임), 라벨 표 세 벌이 서로 다름. tsc 0 · tests fail 1(staff-session-review 날짜 고정, 무관) · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-16 | 관리자 정리 나 묶음(claude/admin-cleanup-204a7d): 설정 «시설 사진»·프로그램 «이미지»의 주소 입력 → «사진 올리기»(미리보기+삭제, 시설은 여러 장). 기존 길 그대로 = uploadImagesWithProgress → /api/upload, 폴더 coaches(허용 목록 그대로). 저장 payload 불변, 새 부품 components/admin/AdminPhotoThumb(일반 img·실패 글자). 운영 프로그램 이미지 7개는 모두 자체 저장소 주소. 안 쓰게 된 사진 파일은 저장소에 남음(코치·갤러리와 같음). tsc 0 · tests 5819-0 · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-16 | 관리자 정리(claude/admin-cleanup-204a7d): 원장 결정표 9칸 전부 «안 쓴다» → 가 묶음 5건 삭제(방학특강 «상태 직접 변경» select · 공지 «페이스북 광고 소재» · 갤러리 «인스타 가져오기» 버튼+액션 · 설정 AppliesTo 9곳 · «외부 신청 링크» 2칸+siteOpsBot 신청서 점검). trialFormUrl·enrollFormUrl 은 저장 요청에서 빼 DB 값 유지. 남은 것: 나(주소 입력→파일 올리기 2건) · 다(수업 기록 창, 원장 선택 대기). 다음 정리 후보: 발행 때마다 쌓이는 FACEBOOK_AD_DRAFT 기록(social-campaigns.ts). architecture 51→28 병합. tsc 0 · tests 5819-0 · guards 337-0 · reviewer 통과 | 브랜치 push(main 미반영) |
| 11-16 | developer(학생별 고정 수강료 + 평일 대회준비반 주N회, claude/fixed-tuition): 표 StudentFixedTuition(마이그레이션 20261116500000, **운영 적용 전**) · planWeeklyTuition 2번째 인자 = 첫 반 고정액·나머지 0원·할인/3회 차감 없음·셔틀 유지 · 청구 준비 «고정 15만» 표시 · 학생 상세 «청구/수납» FixedTuitionPanel(원장 requireOwner) · 평일 대회준비반 15만 고정 삭제 → 주N회 합계÷N(할인·3회 차감 없음, 주1회 priceWeek1 우선) · 검수 반영: 확정 장부 일부면 미적용·발행 가능한 첫 행에 고정액·패널 «원본 변경» 안내 · tsc 0·test fail 0 | 완료 |
| 11-16 | developer(가입 안내 가입함 포함, claude/signup-guide-signed-in): 가입한 보호자·성인 본인도 대상 «가입함»(로그인 안내 문구 원장 전문, 성인은 회원·혜택 2줄 변경) · 가입 막힘·학원 문의 판정은 미가입에만 · 구성 = 미가입 재원/휴원/성인 + 가입함(겹침 없음) · 미리보기 문구 4종 블록 · 지문에 가입 여부·네 문구 포함 · /login 실재 확인. tsc 0 · tests 5739-0 · guards 337-0 | 구현 완료(검수 전) |
| 11-17 | developer(랠리즈 피드 이관 도구 → 실제 파일 모양): normalizeFeedItem 이 media[{kind,src}] 직접 읽기 · 반 매칭 = 앞 순번·[종료] 떼고 «괄호 안 말까지» 먼저, 없으면 괄호 떼고(suffix, 출력에 확인 표시) · 지난 반 요일은 이름에서(dowsForClass) · 영상 주소 = 템플릿 우선(hls-template.txt 자동) · 사진 content-type 확인 · 계획 출력에 반 매칭 요약·«반 요일 아닌 날»·0명 요약. 계획만(쓰기 0): 글 748·사진 475·영상 2,339·반 34(맞음 33·못 맞춤 1 «5. 금요일 2교시»), 전체 722수업(기존 617·새 105)·0명 60·요일 밖 22·보낸 수업 1, 영상 547묶음, 11월 22수업·0명 0. 매핑 초안 .tmp/rallyz-feed-import/class-map.draft.json. tsc 0 · tests fail 0 | 구현 완료(검수 전) |
| 11-17 | reviewer(학부모 카카오 문의 닫기·보강 후보 2줄, claude/parent-ui-9d527d 미커밋): 통과 · 필수 1(«${pickedText}로 바꾸기» — 반 이름 받침이면 «…반로» 조사 오류) · 권장 3(가드 테스트 범위·shortDate 사본 검사·가로 스크롤 포커스 테두리 잘림) · 우회 경로 0 · `!px-3` TW4.2.1 생성 확인 · tsc 0 · 관련 4파일 94 fail 0 | 리뷰 완료 |
