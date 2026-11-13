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
📝 통합 순서(각 --no-ff): ①학부모 알림·수업 탭·⚙설정·/api/push 매핑·직원 알림 ②결석 신고 즉시 보강권 ③상담 신청 ④신청함 6탭 ⑤POS 자동 납부 ⑥휴원 시작일·수강료 정산 ⑦체험비 온라인 결제·안내·Meta 픽셀 토큰 차단. 코드 충돌 0 — 충돌은 문서(합집합)·consult-inbox.ts(③ 실제 구현 채택)·ParentMoreMenu.tsx(① 삭제 유지, 상담 링크는 ⚙설정)뿐.

| 파일 | 변경 | 신규/수정 |
|------|------|----------|
| src/app/admin/inbox/InboxClient.tsx | A 상담 버튼(ref.actions 만·취소 확인·메모 초기값 adminNote·tel:) · B 휴원 승인 전 미리보기→방식 필수·{mode, expectedPreviewKey}·환불 확인 실패 경고 · «변경» 탭 남은 일 링크 | 수정 |
| src/app/admin/inbox/PauseSettlementBox.tsx | 미리보기·방식 고르기(수강 변경 화면과 같은 규칙·문구) | 신규 |
| src/app/actions/enrollment-changes.ts | getPauseTuitionPreview(관리자 전용, 실패=ok:false) | 수정 |
| src/app/admin/inbox/page.tsx · src/lib/requests/admin-inbox.ts | 변경 탭 countOpenPauseSettlements · 행 ref.changeKind | 수정 |
| tests/inbox-consult-pause-wiring.test.mjs · admin-inbox · consult-request | 연결 7건 · 스텁→실제 구현 시그니처 · 상담 링크=설정 화면 | 신규/수정 |

⚠️ 배포 전 운영 apply_migration 필요(전부 IF NOT EXISTS 멱등): 20261110150000_trial_fee_online_payment · 20261110160000_consult_request · 20261110170000_parent_notification_preference · 20261110180000_enrollment_pause_settlement (130000 은 적용됨). 선택: prisma/sql/backfill_makeup_credit_for_reported_absences.sql.
💡 tester: 신청함 상담 탭 → 새 상담 열기 → 메모 칸에 기존 메모·[취소][메모 저장][연락함][상담 완료]·전화 걸기 / 변경 탭 휴원(PENDING) 열기 → «계산하는 중» → 금액 있으면 방식 고르기 전 [승인] 잠김 → 고르면 «승인 · 환불» + 확인창 금액. 실토스 부분 취소는 테스트 키로 1건 확인 필요(⑥). 체험비 결제는 설정 «온라인 결제» 켜기+토스 키 있어야 보임(⑦).
⚠️ reviewer: 미리보기 지문 불일치로 승인 거절되면 칸을 닫았다 다시 열어야 재계산(자동 재조회 없음) · 신청함 휴원 규칙·문구는 수강 변경 화면과 두 벌(문구 비교 테스트로 묶음) · ②출결 «되살림» 동작 변경 · ⑦이미 확정된 신청에 온 결제 = NEEDS_REFUND.

## 구현 기록 (developer) — 11-12 스태프 관리 추가 기능 s1~s6 (원장 «추천대로 해»)
📝 직접 추가 메뉴 제거·초대로 전환 / 추가 역할 줄 / 퇴사 처리 / 역할 변경 확인창 / 초대 마지막 문자 / 담당 반. 마이그레이션 없음(전환 초대 = 기존 칸 SIGNUP+targetUserId).

| 파일 | 변경 | 신규/수정 |
|------|------|----------|
| src/lib/staff/staffAccountLink.ts | 로그인 종류 판정(none/staffLogin/other)·로그인 id·퇴사 시 차단 여부 | 신규 |
| src/lib/staff/staffPanelData.ts | 추가 역할 직원·초대 문자 마지막 발송(NotificationDelivery)·담당 반 조회 | 신규 |
| src/lib/staff/staffRoster.ts | grant 줄·전환 초대는 직원 줄에 붙임·targetUserId 초대 코치 짝짓기 제외·classesForStaff | 수정 |
| src/app/actions/admin.ts | convertDirectStaffToInvite·retireStaffMember(requireOwner) · inviteStaff 퇴사자 재초대 targetUserId · 전환 문자 문구 | 수정 |
| src/app/actions/invite.ts | targetUserId 초대 수락: 직접 추가 기록에 로그인 붙임 / 퇴사 직원 로그인 다시 열기(ban 해제)+역할 복구 | 수정 |
| src/lib/auth-guard.ts | 역할 캐시 적중 때도 역할을 다시 읽음 + forgetAppUserRoleCache | 수정 |
| src/app/admin/staff/StaffClient.tsx · page.tsx · lib/queries.ts · lib/adminReadPayloads.ts | 화면·데이터 연결 | 수정 |
| tests/staff-management-additions.test.mjs · staff-roster.test.mjs | 16건 신규 · 직접 추가 제거 반영 | 신규/수정 |

💡 tester: 원장 로그인 → 직접 추가 직원 줄(«로그인 없음») → 패널 [초대로 전환] → «가입 대기» + [링크 복사][문자 보내기] → 링크로 가입하면 같은 직원 기록(코치 연결 유지)으로 로그인. [퇴사 처리] → 확인창 나열·체크 → 목록에서 빠짐·로그인 차단. 부원장은 패널 버튼 없음.
⚠️ reviewer: auth-guard 캐시 변경(모든 권한 판정 경로) · Supabase ban(876000h) 사용 · 퇴사 후 Class.instructorId(슬롯 없는 반 담당자)는 그대로 둠.

#### 수정 이력
| 회차 | 날짜 | 수정 내용 | 수정 파일 | 사유 |
|------|------|----------|----------|------|
| 1차 | 11-12 | 역할 변경·퇴사 시 대상 초대(PENDING·PROCESSING) 취소 + 가입 거래가 직원 기록→초대 순서로 잠그고 PROCESSING·역할 재확인 · 재입사 거래 실패 시 로그인 다시 차단 · 퇴사자 재초대 이름 일치만 연결(직원 전용 로그인+이름 다름=거절, 그 밖=안내) · 직접 추가 재초대 시 [초대로 전환] 안내 · 로그인 차단 실패 다시 시도(⋯ 더보기) · createStaffUser·AddStaffModal 삭제 | admin.ts · invite.ts · staffAccountLink.ts · staffPanelData.ts · adminReadPayloads.ts · StaffClient.tsx · InviteStaffModal.tsx · page.tsx · 테스트 4개 | 정확성 검수: 필수1·권장2~5·사소 |
| 2차 | 11-12 | 복구가 대상 초대(targetUserId)를 대기로 되돌리지 않고 취소로 끝냄(감사 STAFF_INVITE_RECOVERY_CANCELLED, 목록 «정리 후 취소») · 전환 가입은 지금도 코치/기사일 때만·역할 변경 없음(CASE 제거) · 로그인 없던 퇴사자는 재초대 자동 연결 안 함 · 처리 중 취소된 대상 초대도 계정 정리 필요 시 RECOVERY_REQUIRED 로 올림 | staff-invite-recovery.ts · invite.ts · staffAccountLink.ts · StaffInviteRecoveryClient.tsx · 테스트 | 재검수 HIGH·메모 |
| 3차 | 11-12 | 원장·부원장 «로그인 연결»(linkOwnerStaffLogin 원장 전용·24h·자동 발송 없음, 가입은 초대 역할=대상 지금 역할일 때만·감사 STAFF_LOGIN_LINKED·다른 원장·부원장 알림) · 역할 선택칸 → [역할 변경] 버튼+RoleChangeModal(«바뀌는 것» 미리보기) | admin.ts · invite.ts · inviteAuthFailure.ts · staffAccountLink.ts · roleChange.ts(신규) · RoleChangeModal.tsx(신규) · StaffClient.tsx · 테스트 4개(1 신규) | 원장 지시(권혜미 대표원장) |
| 4차 | 11-13 | 부원장 화면 데이터에서 원장·부원장 초대 토큰 제거(page·API) · 받을 번호 끝 4자리 표시 · 만료 시각 · 역할 미리보기를 서버 조건과 일치(선생님 추가 역할·코치 연결·재설정 링크) · 원장·부원장 비밀번호 재설정(sendStaffPasswordReset userId 경로, 24h·자동 문자 없음·감사·알림) · 마우스 올림 테두리 | admin.ts · invite.ts · inviteAuthFailure.ts · roleChange.ts · staffRoster.ts · queries.ts · page.tsx · api/admin/staff · StaffClient · RoleChangeModal · 테스트 3개 | 보안·정확성 검수 |

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-13 | developer(a1 앱 간편로그인 운영 전환, claude/l3-applogin): 복귀 주소 운영=kr.co.upturnlabs.stizdasan(개발 주소는 개발 서버만)·서버 스위치 NATIVE_AUTH_ENABLED+키·실패 복귀(no_account/cancelled)·Android 맞춤 탭+NativeAuthReturnActivity·iOS 실패 안내·웹 앱 버튼/비밀번호 만들기 안내·NativeAuthFlow 마이그레이션(운영 미적용) — tests 4454-0·tsc 0·Java 85 | 검수 대기 |
| 11-13 | developer(l2 가입 f7·a6·f10, 브랜치 claude/l2-signup): 기존 학부모 활성화 «이메일+10자»→신규 가입과 같은 «아이디+8자»(공용 lib/parent-username, User.username 기록, 이메일 계정 하위호환) · 인증번호 IP 한도 시간당 100·하루 500 · 가입 안내 문자에 «▶ 앱 설치: …/install»(459→548바이트, 원래 LMS) + /install 페이지(안드로이드 Play 바로·아이폰 App Store ID 비어 «곧 출시»+웹) · 마이그레이션 없음 · tsc 0·tests 4293-0 | 커밋(push 안 함) |
| 11-13 | developer(f12 백업 확대, claude/l2-backup 2커밋): 설정 파일(복원)+업무 자료 gzip 짝 파일(DB 전체 표, 제외 15표 이유 명시·비밀 칸 가림·id::text 5000줄 키셋·큰 표부터 SIZE_LIMIT·300초), 복원 범위 그대로·목록 files/archives 분리·업무 자료 서명 주소 내려받기, 대시보드 표·행 수, tests/backup-archive | 완료(push 전) |
| 11-13 | reviewer(2ba1960c 자주 쓰는 결제 방법): HIGH 없음 · 금액·orderId·면세·주소·customerKey·계좌 흐름 동일, 저장은 승인 확정 뒤·소유자 조회 통과한 본인만·실패 로그만 · 권장: 단건 화면 연타 ref 가드, 모바일 리디렉트에선 바로가기 실패가 failUrl 로 가 재시도 안 됨(실패 문구에 «카드» 안내), 카드 거절 등도 통합창 재오픈, 가상계좌 복구 경로 미기억. tsc 0·결제 테스트 396-0 | 통과 |
| 11-13 | developer(자주 쓰는 결제 방법·간편결제 바로가기): 공통 부품 PaymentMethodPicker(지난번 방법 큰 버튼+토스페이·카카오페이·네이버페이·카드·계좌이체·무통장입금 바로가기, 단건·묶음 공용) · lib/payments/preferredMethod(코드·DIRECT easyPay·실패 시 통합창 1회·응답→저장 값) · 승인 완료 때 User.preferredPaymentMethod 기억(실패=로그만) · 설정 «결제» 줄 · 마이그레이션 20261113160000(운영 적용은 PM) | 구현 완료·검수 대기 |
| 11-13 | developer(선생님·기사님 화면 출시 전 b1~b7·G3·G6·G7·G9·G11): 전체 출석에서 결석 신고 아이 제외(화면+서버 bulk) · 날 바뀐 화면 새로고침·정규 시작/미리작성 오늘 아니면 거절 · 코치 미연결 안내 · 줄별 잠금·줄 안내·출석/종료 알림 after()·지난 날짜 알림 생략 · 권한 실패 needsLogin+다시 로그인·error.tsx 종류별 · 진행 중 수업 «○○반(○월 ○일)» 확인 · 기사님 첫 화면 /staff/driver(아이폰 스토어 앱 안내, 그 외 /staff/run)·셔틀 «운행 시작» 버튼 · 특강 미리작성 sessionDateId·사진 권한 requireStaffSessionAccess 공용. 규칙 lib/staff-session-rules.ts + tests/staff-session-rules. tsc 0·tests 4189 fail 0 | 커밋(push 안 함) |
| 11-13 | developer(출시 전 d1~d5 오류·앱 문구·보안·cron 알림): 관리자 page 44곳 requireAdmin+adminReadPayloads export 32개 adminOnly+정적 가드 · boarding-debug 삭제 · /api/chat IP 분당5·하루50+길이 제한 · cron 26곳 withCronAlert(예외·5xx→원장 슬랙, 1시간 1번) · 마이페이지 통신 실패 그 자리 안내+error.tsx+global-error · 홈 로더 .catch · 스토어 앱 우회 = storeAppLacks(cap) 한 곳(앱이 /store-app?caps= 로 끌 수 있음)+data-outside-link 복사 안내 | 완료(미푸시) |
| 11-13 | developer(12월 청구 안내·결제 c1~c5·d4·d5·10번): 청구서·미납 안내 = 발송 대기열(lib/billing/noticeQueue.ts + BillingNoticeDelivery 마이그레이션 20261113140000 **미적용** — 코드보다 먼저) · 성공한 건만 sentAt · 미납 3일 간격·KST 날짜 열쇠·링크 포함 · 템플릿 없으면 같은 본문 LMS · 이메일 거절 제거 · 단건 반영 실패 검토+슬랙 · 결제 DDL 한 번만 · 연체 KST+cron payment-overdue(UTC 15:10) · 운영 test_ 키 차단. tests 4194-0·tsc 0 | 검수 대기 |
| 11-12 | developer(원장 로그인 연결+역할 변경 창): 로그인 없는 원장·부원장 패널 [로그인 연결] → 24시간 전용 링크([링크 복사]·[문자 보내기]) · 받는 역할 판정 invitationRoleAccepted · 붙이기 targetedSignupAllowed · 역할 선택칸 → 버튼+창. «선생님 역할»은 원장이면 이미 teacher·전 반(부여 불필요). tsc 0·tests fail 0 | 완료(커밋, push 안 함) |
| 11-12 | developer(스태프 관리 s1~s6): 직접 추가 메뉴 제거·[초대로 전환](SIGNUP+targetUserId, 가입 시 기존 기록에 로그인 붙임·코치 승계, 문자는 원장이 누름) · 추가 역할 보기 전용 줄(신청함 링크) · [퇴사 처리](한 거래: 학부모·코치 해제·추가 역할 회수·대기 초대 취소·감사 STAFF_RETIRED, 직원 전용 로그인 ban, 역할 캐시 즉시) · 퇴사자 재초대=로그인 다시 열기 · 역할 변경 공용 확인창 · 초대 마지막 문자 · 담당 반. 마이그레이션 없음. tsc 0·tests 4093-0·studentVisibility 5-0 | 커밋(미푸시) |
