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

## 구현 기록 (developer) — 11-14 수업 피드(claude/feed-ui, 원장 결정표)
📝 사진 공개 동의 제거 + «볼 수 있는가» 판정 하나(src/lib/feed/rules·server: 완료+발행 수업 × 참여=출결 또는 ACTIVE 수강·개시일≤수업일) → 사진 보기·영상·소식 목록/상세·홈 카드 공용. 수업일 SQL = 무tz «두 번» 변환(sessionKstDateSql, 영상도 교체). 선생님 «수업 피드» 칸(한 줄 Session.content 수업 전·중·후 당일 자정까지·음성·사진 태그 없음·실패분만 재업로드·사진 시간=영상 규칙) + 오늘 수업 홈 시트. 학부모 홈 «최신 수업 피드» 카드·소식 상세 재작성(사진 크게 보기·영상)·목록 행 «사진 n · 영상 n». 동의 UI 제거(학생 상세 링크·media-consent 화면·등록 창 질문), 공개 게시 동의 검사는 스위치로 끔(PUBLIC_POST_CONSENT_GATE_ENABLED=false, 관리자/원장 수동 승인 유지). DB 변경 없음.

| 파일 | 변경 | 신규/수정 |
|------|------|----------|
| src/lib/feed/rules.ts · server.ts | 순수 규칙·공용 판정/조회 | 신규 |
| api/staff/sessions/[id]/photos(+[photoId]) · api/sessions/[id]/videos · sessionVideo/server | 판정 통일·시간 규칙·PATCH 제거 | 수정 |
| components/staff/SessionFeedPanel·SessionPhotoUploader · staff/StaffHomeClient · SessionInProgressClient · actions/staff-sessions(saveSessionFeedLine) · staff-session-queries(content) | 선생님 수업 피드 | 신규/수정 |
| mypage/page·MyPageClient · components/parent/LatestFeedCard·FeedPhotoGallery · mypage/reports(목록·상세) · queries.getStudentReports | 학부모 화면 | 신규/수정 |
| admin/students([id]/media-consent 삭제·StudentDetailClient·StudentRegisterModal) · actions/student-media-consent(삭제) · lib/studentMediaConsent | 동의 UI 제거·공개 게시 스위치 | 수정/삭제 |
| tests/feed-rules(신규 14) · parent-report-render(재작성 11) · parent-app-structure(+3) 외 8개 갱신 | 테스트 | 신규/수정 |

💡 tester: 선생님 수업 중 «수업 피드»에 한 줄 저장→종료 창에 같은 글 / 끝난 수업 행→«수업 피드 쓰기·사진 추가»(자정 전만) / 학부모 홈 처리할 일 아래 카드→상세 사진 누르면 크게·영상. 남의 sessionId·photoId 403/404.
⚠️ reviewer: 공개 게시 동의 검사 끔(법적 판단은 원장) · 참여 기준에 개시일 조건 추가(영상 판정이 조금 엄격해짐) · 영상도 published 필요(종료 때 «바로 보내기» 끄면 숨김) · reports/page.tsx 기존 린트 1건(photoCount 재할당, 손대지 않음).

#### 수정 이력
| 회차 | 날짜 | 수정 내용 | 수정 파일 | 사유 |
|------|------|----------|----------|------|
| 1차 | 11-14 | 참여 시작일 = COALESCE(개시일, 등록일 KST 두 번 변환) · 개시일 없이 ACTIVE 만들던/되살리던 4곳(수강 추가·대기자=새 등록·되살리기 오늘 / 시트·특강=새 행 NULL 유지·되살리기만 오늘, 이미 ACTIVE 면 유지) · 종료 한 줄 그대로 반영(빈 값=NULL) · 대타 날짜 sessionKstDateSql · 운영 ACTIVE 183 중 개시일 빈 것 1건 | feed/rules · actions/admin · api/admin/seasonal · actions/staff-sessions · staff-class-access · tests 2 | security HIGH + reviewer 권장 2 |

### 리뷰 결과 (reviewer · 11-14 ab61a2db) — 📊 통과(필수 0)
- 검증: tsc 0 · 관련 12개 테스트 111-0 · 운영 DB 읽기 전용 대조: Session.date 1015행 모양 = 00:00(925)/00:30/02:00/04:30 뿐(«전날 15:00» 없음), `::date` 와 두 번 변환 불일치 0 → 영상·사진 시간 판정 변화 없음. 소식 (학생,수업) 쌍 옛 20 → 새 20(손실·추가 0). 미발행 완료 수업의 영상 0건.
- 동의 제거: 지운 파일·PATCH 참조 0, 공개 게시(갤러리·인스타)는 checkSocialDraftMediaConsent 한 곳 경유 → 스위치로 일괄 통과, 수동 승인 유지.
- 🟡 권장: ① staff-sessions.ts:745 종료 UPDATE `COALESCE($3, content)` — 종료 창이 이제 저장된 한 줄로 채워지므로 거기서 글을 지워도 옛 글이 남음(수업 피드 칸 «한 줄 저장»으로는 지워짐) ② staff-class-access.ts:272 대타 판정은 여전히 `s.date::date`(운영 데이터상 결과 같음, 조각 통일 권장) ③ 진행 중으로 자정 넘긴 수업은 사진 올리기 막힘(예전엔 허용) — 의도면 OK.

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
| 11-14 | developer(아이 정보+셔틀, claude/child-profile): /mypage/record 위에 아이 정보(생년월일·학년(생일 기준+등록 학년)·학교·성별·등록일·대표 보호자·내 연락처·연결 가족 이름·보강권)·수강 반(수업 탭 칩)·셔틀(요일별 승하차·7일 운행: 휴무·휴원·결석·안 탐·다른 곳, 방학특강·신청 접수, 기사님 전화) 접기 칸 · **버그 수정: 학부모 홈·수업 탭 정규 셔틀이 빈 옛 표(ShuttleRoutePassenger 0행)만 읽어 60명 전원 미표시 → 명단 기준(childShuttleRules) 항목 추가** · 운영 읽기 대조 6명 요일별 불일치 0 · **1차 수정(검수)**: 신청 접수 카드 = 명단 등재 여부(getRosterStudentIds)로 제외 · 일정 탭 명단 항목 요일별 한 줄+«아이 기록 › 셔틀» · 반 없음/못 찾음 = 운행 아님(NO_CLASS·CHECK) · 명단 조회 첫 병렬 묶음·기록은 그 아이만 · 빈 studentId 11행 = 2호점 운영 정차(학생 행 아님, 채울 것 없음) · tests 4583-0·tsc 0 | 검수 대기 |
| 11-14 | reviewer(수업 피드 ab61a2db): 통과 — 필수 0·권장 3(종료 창 비우기 COALESCE·대타 날짜 조각·자정 넘긴 진행 수업 사진). 운영 대조 날짜 불일치 0·소식 20→20 | 통과 |
| 11-14 | developer(수업 피드, claude/feed-ui): 동의 제거·볼 수 있는가 판정 통일(feed/rules·server)·선생님 수업 피드 칸·홈 최신 수업 피드 카드·소식 상세 재작성·동의 UI 제거·공개 게시 동의 스위치 끔. tsc 0·tests 4620-0·guards 5-0 | 완료(검수 대기) |
| 11-14 | developer(아이 기록 w1~w4·q1~q4, claude/child-record): 새 화면 /mypage/record(홈 소속·요약 4칸·청구 이력 연도칩+필터 시트+월 묶음 접기·출석 12개월 막대(기록 없음 «–»)·수강 반 타임라인·특강/유니폼/리포트) · 순수 lib/parent/childRecordRules + 조회 childRecordQuery(첫 SQL 권한 재확인·섹션별 null·무tz 두 번) · 홈 한 줄·청구 탭 요약 줄/형제 칩/월 묶음/납부 완료 한 줄 행·수업 탭 «이번 달 출석 n/m»+«전체 기록»·소식 요약 줄 · 홈 영수증 = 결제 권한자(q3) · BarChart missing/showValues · tests/parent-child-record-rules 15건. tsc 0·tests 4571-0·운영 읽기 대조(납부 합계 SQL 일치) | 검수 대기 |
|------|----------|------|
| 11-14 | developer(수업 영상, claude/session-video): SessionVideo·YouTubeConnection 표(마이그레이션 20261114120000, RLS FORCE, 버킷 session-videos 50MB — 운영 미적용) · 선생님 촬영·직접 업로드·삭제(당일 KST 자정까지) · 학부모 재생 API/부품 · /admin/youtube 연결 · cron youtube-upload 15분 · 안드로이드 영상 촬영·선택. tsc 0·전체 테스트 fail 0 | 검수 대기 |
| 11-14 | developer(학부모 설정 화면 손보기, claude/parent-settings-fix): 결제 방법 줄 세로 접힘(.academy-input width:100% 가 w-32 를 이김) · 옛 앱 알림 «업데이트» 안내(nativePushNotice·appUpdateTarget, 아이폰 1.0 은 버튼 없이 글) · 버전 «앱 1.0.2 / 화면 xxxxxxx»(appVersionLabels) · 아래 탭 64→48px+env 안전영역(pb-safe 는 정의 없던 글자) · tests/parent-settings-fix-1114 | 완료(전체 fail 0·tsc 0) |
| 11-13 | developer(대시보드·통계 개편, claude/admin-stats 2커밋): 대시보드 맨 위 카드 6개(재원생·수납률·출석률·신규/퇴원·체험→등록·유니폼) + 통계 /admin/stats 탭 5개(?tab=&branch=&period=, 필터 버튼+창) · 순수 규칙 lib/stats/statsRules.ts(학년 KST 3월 기준·성별·지점·유니폼 5묶음) + 조회 statsQueries.ts(무tz 두 번·tz 한 번) · 접힌 «운영 현황» 제거(내용은 통계 탭) · 신청 설정 «유입 통계» 제거 · «통계» 메뉴 대시보드 아래 · 옛 /api/admin/stats 삭제. 운영 DB 대조: 재원생 133 = 목록 «활성» 133, 학년·성별·지점·유니폼 합 133. tests 4521-0 · tsc 0 · studentVisibility 4-1(payerAccess.ts 기존 실패, 이번 변경 무관) | 검수 대기 |
| 11-13 | developer(관리자 메뉴 정리, claude/admin-menu): 사이드바 33→15칸(맨 위 6 + 수업 2·홈페이지 2·설정 5, «오늘 업무»→«대시보드») · 탭 줄 5묶음 = lib/admin-sections.ts 한 곳 + components/admin/SectionTabs(셸이 그림, 화면 파일 무변경) · 유니폼·빠른 업로드 메뉴만 뺌(갤러리 «빠른 업로드») · 수강생 이관 화면·API 6·전용 lib 4 삭제(11-05 9월분까지 반영, DB 무변경) · tests 4509-0·tsc 0 | 검수 대기 |
| 11-14 | 비회원 결제 링크 /pay/<토큰>: PaymentInvoiceAccessToken(운영 적용)·미가입자 안내 자동 링크·⚡ 링크 복사/닫기. reviewer·security 통과(권장 5 반영), 전체 4462-0 | 완료 |
| 11-13 | developer(a1 앱 간편로그인 운영 전환, claude/l3-applogin): 복귀 주소 운영=kr.co.upturnlabs.stizdasan(개발 주소는 개발 서버만)·서버 스위치 NATIVE_AUTH_ENABLED+키·실패 복귀(no_account/cancelled)·Android 맞춤 탭+NativeAuthReturnActivity·iOS 실패 안내·웹 앱 버튼/비밀번호 만들기 안내·NativeAuthFlow 마이그레이션(운영 미적용) — tests 4454-0·tsc 0·Java 85 | 검수 대기 |
| 11-14 | developer(e2·d2 스토어 앱 알림 FCM, claude/l3-push): NativePushToken 표(마이그레이션 20261114000001, RLS) · 발송 함수 2개가 웹푸시+앱 토큰(FCM v1, FCM_SERVICE_ACCOUNT_JSON 없으면 건너뜀·죽은 토큰 정리·재시도 native:id) · /api/push/native(본인만)·로그아웃 이 기기 토큰·탈퇴 정리 · 안드로이드 NativePush/StizMessagingService(json 없으면 꺼짐, gradle 빌드·lint 통과) · iOS NativePush.swift+SPM FirebaseMessaging(Xcode 빌드 미검증) · 설정 화면 앱 상태 문구 · 문서 docs/native-push.md | 구현 완료·검수 대기 |
| 11-13 | developer(l2 가입 f7·a6·f10, 브랜치 claude/l2-signup): 기존 학부모 활성화 «이메일+10자»→신규 가입과 같은 «아이디+8자»(공용 lib/parent-username, User.username 기록, 이메일 계정 하위호환) · 인증번호 IP 한도 시간당 100·하루 500 · 가입 안내 문자에 «▶ 앱 설치: …/install»(459→548바이트, 원래 LMS) + /install 페이지(안드로이드 Play 바로·아이폰 App Store ID 비어 «곧 출시»+웹) · 마이그레이션 없음 · tsc 0·tests 4293-0 | 커밋(push 안 함) |
| 11-13 | developer(f12 백업 확대, claude/l2-backup 2커밋): 설정 파일(복원)+업무 자료 gzip 짝 파일(DB 전체 표, 제외 15표 이유 명시·비밀 칸 가림·id::text 5000줄 키셋·큰 표부터 SIZE_LIMIT·300초), 복원 범위 그대로·목록 files/archives 분리·업무 자료 서명 주소 내려받기, 대시보드 표·행 수, tests/backup-archive | 완료(push 전) |
