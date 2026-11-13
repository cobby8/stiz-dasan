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
(완료·커밋됨 — 11-14 정리로 요약: 신청함 상담 버튼·휴원 승인 미리보기 PauseSettlementBox, 마이그레이션 4건 IF NOT EXISTS)

## 구현 기록 (developer) — 11-14 비회원 결제 링크 /pay/<토큰> (브랜치 claude/guest-pay-link · 미커밋)
📝 가입 안 한 학부모가 받은 링크로 청구서 한 장만 보고 결제. 토큰 32바이트 base64url, DB엔 SHA-256 해시만(새 표 PaymentInvoiceAccessToken · migration 20261114000000 **운영 미적용**). 만료 = max(납부기한, 발급일)+14일 하루 끝(KST). 토스 customerKey = 청구서 기반 stiz_g_…
| 파일 | 변경 | 신규/수정 |
|------|------|----------|
| lib/payments/guestPayLinkRules.ts · guestPayToken.ts · guestPayLink.ts · guestPayLinkService.ts | 규칙(모양·만료·마스킹·상태·가입 판정)·토큰·DB 연결부(가짜 DB 테스트)·prisma 연결부(getOrCreateInvoiceGuestLink·안내용 일괄 발급·IP 제한) | 신규 |
| lib/payment-ledger.ts | GuestInvoiceOwner · loadParentInvoiceRow 공용화 · getInvoiceForGuest · checkout/confirm 비회원 갈래(청구서 일치·한 장 주문만·개인정보 미전송) | 수정 |
| app/pay/** · api/pay/checkout · api/pay/confirm | 화면(마스킹·납부 완료 표시·가입 안내 한 줄)·성공 화면·토큰 API(no-store·실패 지연) | 신규 |
| payments/[invoiceId]/PaymentCheckoutClient · payments/success/PaymentSuccessClient | guestToken 선택 속성(기존 동작 그대로) | 수정 |
| actions/admin.ts · lib/billing/noticeQueue.ts | 청구·미납 안내: authUserId 없는 학부모 → pay 링크(미납은 한 장일 때만) | 수정 |
| actions/guest-pay-link.ts · admin/students/[id]/StudentDetailClient.tsx | ⚡ «결제 링크 복사»(원장·감사 GUEST_PAY_LINK_ISSUED) | 신규/수정 |
| next.config.ts · robots.ts · academyTheme.ts · privacy/trackingExclusion.ts | /pay 머리글(no-referrer·noindex·no-store)·픽셀 제외 | 수정 |
| tests/guest-pay-link.test.mjs(22) · payment-bundle-checkout · scheduled-enrollment-ui | 신규 · SQL 위치 이동·모의 모듈 추가 | 신규/수정 |
💡 tester: 미가입 학부모 청구 → 학생 상세 ⚡ 결제 링크 복사 → 시크릿 창에서 열기(로그인 없이 권○호·금액) → 카드 테스트 결제 → /pay/<토큰>/success 납부 완료 → 같은 링크 다시 열면 «납부 완료»만. 토큰 한 글자 바꾸면 «링크가 만료됐거나…».
⚠️ reviewer: confirmTossPayment 비회원 갈래(가족 연결 재확인 생략 — 근거는 토큰 청구서=주문 청구서 SQL) · 이전 링크 폐기 안 함(해시만 저장이라 재발급 불가) · 학부모 미연결 청구서는 이번에도 제외.
#### 수정 이력
| 회차 | 날짜 | 수정 내용 | 수정 파일 | 사유 |
|------|------|----------|----------|------|
| 1차 | 11-14 | 미연결 청구서 발급 안 함·미납 안내는 받는 사람=청구서 대표 보호자일 때만 · ⚡ «결제 링크 모두 닫기»(확인창·감사 GUEST_PAY_LINK_REVOKED) · 비회원 계좌 칸 고르기(예금주 이름 제거, 화면+API 2곳) · 주석 정정(발송 기록엔 링크 원문 남음) · bg-white→토큰 | guestPayLink · admin.ts · guest-pay-link 액션 · StudentDetailClient · pay 화면·API · guestPayToken · migration 주석 | 검수 권장 1~5 |

### 리뷰 결과 (reviewer 11-14) — 📊 통과(필수 0 · 권장 5) · tsc 0 · 지정 테스트 189/189
✅ 회원 흐름 불변(guest 없으면 기존 SQL·f8 재확인·주소 그대로) · 비회원 승인 SQL 이 «토큰 청구서·한 장 주문·대표 보호자»로 묶임 · 웹훅·환불·가상계좌 입금은 customerKey 를 안 봐 stiz_g_ 충돌 없음 · 안내 발급 실패는 건별 try/catch 로 payments/<id> 로 떨어짐 · 만료 kstAt/addDaysKst·dueDate(timestamptz) 한 번 · 마이그레이션 재실행 안전·Prisma 이름 일치 · 개인정보 미전송·이름 가림·no-referrer/noindex/픽셀 제외.
🟡 권장: ①발급 시 i."parentId" 확인 없음 → 학부모 미연결 청구서도 ⚡ 복사 «성공» 후 화면은 «만료» (guestPayLink.ts:47 issueGuestPayLink SELECT 에 i."parentId" IS NOT NULL) ②미납 안내는 s."parentId"(학생 보호자)로 가입 판정·번호를 고르나 결제 화면은 i."parentId" 기준 — 둘이 다르면 엇갈림(admin.ts sendUnpaidReminders, 같은 조건 추가로 해결) ③안내 대기열 body 에 토큰 원문이 남음(BillingNoticeDelivery) — «해시만 저장» 주석 정정 ④발급이 행마다 순차 2쿼리(guestPayLinkService.ts:44) — 100건대면 수 초, 지금은 허용 ⑤마이그레이션 FK 에 ON UPDATE CASCADE 없음(Prisma 기본과 drift, 동작 무관) · 성공 화면 fallback bg-white(success/page.tsx:37).

## 구현 기록 (developer) — 11-12 스태프 관리 추가 기능 s1~s6
(완료·커밋됨 — 11-14 정리로 요약: 초대로 전환·추가 역할·퇴사·역할 변경 확인창·담당 반, 수정 4차까지. 상세는 작업 로그·git log)

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-14 | reviewer(비회원 결제 링크 검수): 필수 0·권장 5(미연결 청구서 발급·미납 안내 보호자 기준·대기열 본문 토큰·순차 발급·FK onUpdate). tsc 0·테스트 189-0 | 통과 |
| 11-14 | developer(비회원 결제 링크 /pay/<토큰>, claude/guest-pay-link 미커밋): 청구서 한 장 전용 토큰 링크(해시만 저장·KST 만료·마스킹)·결제/승인 비회원 갈래·안내 발송 미가입자 링크·⚡ 결제 링크 복사·픽셀 제외. tsc 0 · 전체 4459/4459 · 임시 PG 마이그레이션 2회 OK. **운영 apply_migration 20261114000000 필요** | 구현 완료(검수 대기) |
| 11-13 | developer(l2 가입 f7·a6·f10, 브랜치 claude/l2-signup): 기존 학부모 활성화 «이메일+10자»→신규 가입과 같은 «아이디+8자»(공용 lib/parent-username, User.username 기록, 이메일 계정 하위호환) · 인증번호 IP 한도 시간당 100·하루 500 · 가입 안내 문자에 «▶ 앱 설치: …/install»(459→548바이트, 원래 LMS) + /install 페이지(안드로이드 Play 바로·아이폰 App Store ID 비어 «곧 출시»+웹) · 마이그레이션 없음 · tsc 0·tests 4293-0 | 커밋(push 안 함) |
| 11-13 | developer(f12 백업 확대, claude/l2-backup 2커밋): 설정 파일(복원)+업무 자료 gzip 짝 파일(DB 전체 표, 제외 15표 이유 명시·비밀 칸 가림·id::text 5000줄 키셋·큰 표부터 SIZE_LIMIT·300초), 복원 범위 그대로·목록 files/archives 분리·업무 자료 서명 주소 내려받기, 대시보드 표·행 수, tests/backup-archive | 완료(push 전) |
| 11-13 | reviewer(2ba1960c 자주 쓰는 결제 방법): HIGH 없음 · 금액·orderId·면세·주소·customerKey·계좌 흐름 동일, 저장은 승인 확정 뒤·소유자 조회 통과한 본인만·실패 로그만 · 권장: 단건 화면 연타 ref 가드, 모바일 리디렉트에선 바로가기 실패가 failUrl 로 가 재시도 안 됨(실패 문구에 «카드» 안내), 카드 거절 등도 통합창 재오픈, 가상계좌 복구 경로 미기억. tsc 0·결제 테스트 396-0 | 통과 |
| 11-13 | developer(자주 쓰는 결제 방법·간편결제 바로가기): 공통 부품 PaymentMethodPicker(지난번 방법 큰 버튼+토스페이·카카오페이·네이버페이·카드·계좌이체·무통장입금 바로가기, 단건·묶음 공용) · lib/payments/preferredMethod(코드·DIRECT easyPay·실패 시 통합창 1회·응답→저장 값) · 승인 완료 때 User.preferredPaymentMethod 기억(실패=로그만) · 설정 «결제» 줄 · 마이그레이션 20261113160000(운영 적용은 PM) | 구현 완료·검수 대기 |
| 11-13 | developer(선생님·기사님 화면 출시 전 b1~b7·G3·G6·G7·G9·G11): 전체 출석에서 결석 신고 아이 제외(화면+서버 bulk) · 날 바뀐 화면 새로고침·정규 시작/미리작성 오늘 아니면 거절 · 코치 미연결 안내 · 줄별 잠금·줄 안내·출석/종료 알림 after()·지난 날짜 알림 생략 · 권한 실패 needsLogin+다시 로그인·error.tsx 종류별 · 진행 중 수업 «○○반(○월 ○일)» 확인 · 기사님 첫 화면 /staff/driver(아이폰 스토어 앱 안내, 그 외 /staff/run)·셔틀 «운행 시작» 버튼 · 특강 미리작성 sessionDateId·사진 권한 requireStaffSessionAccess 공용. 규칙 lib/staff-session-rules.ts + tests/staff-session-rules. tsc 0·tests 4189 fail 0 | 커밋(push 안 함) |
| 11-13 | developer(출시 전 d1~d5 오류·앱 문구·보안·cron 알림): 관리자 page 44곳 requireAdmin+adminReadPayloads export 32개 adminOnly+정적 가드 · boarding-debug 삭제 · /api/chat IP 분당5·하루50+길이 제한 · cron 26곳 withCronAlert(예외·5xx→원장 슬랙, 1시간 1번) · 마이페이지 통신 실패 그 자리 안내+error.tsx+global-error · 홈 로더 .catch · 스토어 앱 우회 = storeAppLacks(cap) 한 곳(앱이 /store-app?caps= 로 끌 수 있음)+data-outside-link 복사 안내 | 완료(미푸시) |
| 11-13 | developer(12월 청구 안내·결제 c1~c5·d4·d5·10번): 청구서·미납 안내 = 발송 대기열(lib/billing/noticeQueue.ts + BillingNoticeDelivery 마이그레이션 20261113140000 **미적용** — 코드보다 먼저) · 성공한 건만 sentAt · 미납 3일 간격·KST 날짜 열쇠·링크 포함 · 템플릿 없으면 같은 본문 LMS · 이메일 거절 제거 · 단건 반영 실패 검토+슬랙 · 결제 DDL 한 번만 · 연체 KST+cron payment-overdue(UTC 15:10) · 운영 test_ 키 차단. tests 4194-0·tsc 0 | 검수 대기 |
| 11-12 | developer(원장 로그인 연결+역할 변경 창): 로그인 없는 원장·부원장 패널 [로그인 연결] → 24시간 전용 링크([링크 복사]·[문자 보내기]) · 받는 역할 판정 invitationRoleAccepted · 붙이기 targetedSignupAllowed · 역할 선택칸 → 버튼+창. «선생님 역할»은 원장이면 이미 teacher·전 반(부여 불필요). tsc 0·tests fail 0 | 완료(커밋, push 안 함) |
| 11-12 | developer(스태프 관리 s1~s6): 직접 추가 메뉴 제거·[초대로 전환](SIGNUP+targetUserId, 가입 시 기존 기록에 로그인 붙임·코치 승계, 문자는 원장이 누름) · 추가 역할 보기 전용 줄(신청함 링크) · [퇴사 처리](한 거래: 학부모·코치 해제·추가 역할 회수·대기 초대 취소·감사 STAFF_RETIRED, 직원 전용 로그인 ban, 역할 캐시 즉시) · 퇴사자 재초대=로그인 다시 열기 · 역할 변경 공용 확인창 · 초대 마지막 문자 · 담당 반. 마이그레이션 없음. tsc 0·tests 4093-0·studentVisibility 5-0 | 커밋(미푸시) |

### 보안 리뷰 결과 (security-reviewer) — 비회원 결제 링크
📊 판정: 통과 (CRITICAL 0 / HIGH 0) · 낮음 3건(링크 회수 수단 없음 · 입금계좌 customerName 이 화면 데이터에 실림 · 묶음 계좌 합계 노출)
