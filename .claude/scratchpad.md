# 작업 스크래치패드

## 현재 작업
-| 11-08 | developer(claude/pos-auto-charge, 6c109f11·ca24cf4f·30a22721·65edfb4e): ① 현장 결제 매칭 = 방식 무관 APPROVED 전부(extractChargePayments, 알림 범위는 그대로)·분할 결제 합계/면세 합계 판정(진행 중 부족=SKIP+알림 미룸, 완료 후 부족=HOLD), 대표 결제만 유일 칸·나머지 note+감사 기록 POS_CHARGE_PAYMENTS, 같은 주문 다른 요청 PAID 면 선점 차단, Payment.method 실제 방식(CARD·CASH·EASY_PAY·BANK_TRANSFER·ETC·«CARD+CASH»)·수납 «현장 · 카드+현금», 월 대사도 현장 결제 주문은 방식 무관+분할 합계 매칭 ② 현장 결제·POS DM «랠리즈에 처리» 안내 제거 ③ 수납 납부일 하루 전 표시(toISOString→toKstYmd, page 이번 달 todayKst, R1 빚 22→21) ④ 결제 후 목록 미갱신(fetch no-store + 요청 PAID·청구서 미납 2분 이내는 창에 «기다리는 중»). tsc 0·npm test 3137-0. 건의: 웹훅 4초 타임아웃 뒤 함수 동결 시 «요청 PAID·청구서 미납» 잔존 가능(ALREADY_DONE 이 원장부를 다시 안 봄) | 검수 대기 |
 **상태(2026-10-05)**: Phase 2-A 자동화 배포(보강권 버그·특강 자동 퇴원·휴원/퇴원 예약 자동 적용). 랠리즈 10월 청구 정리·오래된 미납 94건 납부 처리 완료.
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
- 테스트는 `node --test tests/*.test.mjs` **+ 가드 `node --experimental-strip-types --test src/lib/*.test.ts`**(=`npm test`). ⚠️ 2026-10-25 실측: `tests/` 만 돌려 **학생 병합 필터 가드(src/lib/studentVisibility.test.ts)를 놓쳤다** — 회원 탈퇴 배포 후 release:preflight 가 실패하던 상태였다. **`npx vitest`는 이 프로젝트에 없음**(설정도 없어 worktree까지 긁어 전부 오탐).
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
| 11-08 | developer(claude/pos-auto-charge): POS 즉시 결제창 — ① charge.ts 금액 검사: addLineItem 반환값 대신 다시 읽기(최대 3번·0.3초), 기준=항목 1개·항목가×수량=금액·면세·메모 번호, 합계는 >0 이고 다를 때만 불일치, 보고 reason 에 실제 값(S-704715 대응) ② 롱폴링 `?wait=20&known=` (src/lib/pos/plugin-long-poll.mjs 순수 루프·1초 EXISTS·maxDuration 30·abort) + 워커 25초 제한·연속 조기응답 0→14초 완화(정상 30분 90번·최악 133번) ③ 자동 경로 silent(alert 없음)·다음 대기 먼저 예약·자동 1건 ④ 창 문구 «보통 몇 초 안에». 사이트 tsc 0·test 3114-0, 플러그인 tsc 0·test 53-0, zip 재생성 | 검수 대기 |
| 11-08 | developer(claude/pos-auto-charge-site): «현장 결제» 창 단순화 — 플러그인 자동 결제창 전제로 큰 결제 번호·메모 입력 안내·30분·새로고침 제거, «POS로 결제 보내기»→«POS로 보냈어요 · 결제 기다리는 중»(3초 자동 읽기, 탭 숨김·창 닫힘 시 멈춤)·«요청 취소». 서버 매칭·shortCode 그대로(보류·지난 요청 줄 작은 글씨만). tests/pos-charge-modal.test.mjs 3건 신설. tsc 0·npm test 3104-0 | 검수 대기 |
| 11-07 | developer 수정 1차(claude/pos-charge-request, 검수 권장 5건): ① 동시 웹훅 진 쪽 보류 0행이면 다시 읽어 같은 결제로 PAID 면 처리 끝(슬랙 DM 중복 방지) ② 번호 6자리 S-482193(정규식·CHECK·테스트·문서) ③ 토스 taxExemptAmount ≠ 요청 면세액(또는 못 읽음)이면 HELD ④ 문서 «2호점 학생만» → «현재 단일 지점, 지점 추가 시 필터» ⑤ /admin/pos-plugin 용어 «POS 연결 코드» 통일+유출 시 끊기 안내. tsc 0·npm test 3101-0 | 완료 |
| 11-07 | developer(claude/pos-charge-request): 토스 POS «현장 결제» 1~3단계+플러그인 서버 API — PosChargeRequest·PosPluginToken 마이그레이션(20261107150000, **운영 미적용**)·순수 규칙 charge-request.mjs·chargeRequestService(웹훅 매칭→자동 납부/HELD)·⚡ «현장 결제» 창·/admin/pos-plugin(토큰 발급·끊기)·/api/pos-plugin 5경로. 플러그인 팀 계약 변경 4건 반영(item.code 매칭·unpaid/{id}/charge·start_failed 중복 1회·taxFreeAmount). 계약 docs 8장. tsc 0·npm test 전체 통과 | 검수 대기 |
| 11-07 | developer 수정 1차(claude/toss-pos-plugin, 검수 의견 5건): ① 탭에 SENT(이 매장 선점·결제 시작 실패)도 «다시 결제» ② payment.on 은 워커만(탭 등록 제거) ③ 실패 응답 {error,message,retryAfterSeconds} 반영 — NOT_ELIGIBLE/CHANGED/NOT_CLAIMABLE 등 쉬운 안내, 모르는 코드는 서버 문구, 429 는 retryAfter 만큼 대기 ④ 용어 «POS 연결 코드» 통일·알림/탭에서 상품명의 «(가린 이름)» 떼어 이름 1번 ⑤ README «연결 코드 새면 /admin/pos-plugin 에서 바로 끊기». 서버 8장 칸(itemName·studentLabel·paid) 읽기, S-482193 6자리·stizpos_ 모양 테스트, zip 비밀값 검사에 stizpos_ 추가. 테스트 42/42·tsc 0·zip 재검증 OK | 검수 대기 |
| 11-07 | developer(claude/toss-pos-plugin): 토스 POS 플러그인 apps/toss-pos-plugin(자체 package.json·tsconfig, 루트 tsconfig exclude·eslint ignore 1줄씩). 워커(30초 폴링·지수 백오프·토스트 [결제하기]→선점→draftOrder 비었는지 2회 확인→면세 항목 id0·메모/상품코드 STIZ:S-xxxx→startPayment, paid/cancel 은 order.getOrder 로 우리 주문만 참고 보고)+탭(대기 요청·미납 검색·토큰 secureStore). SDK 0.0.31 문서·타입 직접 확인: **주문 전체 메모 함수 없음 → 서버 웹훅은 lineItems[].memo/item.code 도 봐야**. 운영 매장은 라이브 검수+VAN 대리점 활성화 필요. 테스트 37/37·tsc 0·zip 2개 재검증 OK. main 미머지 | 검수 대기 |
| 11-07 | developer(claude/toss-tax-free): 토스 면세 정리 — 요청 2곳 taxFreeAmount 는 10-29(9960667a)에 이미 반영돼 있어, 계산을 src/lib/payments/taxFree.ts(taxFreeAmountFor·describeTaxFreeMismatch) 한 곳으로 모으고 승인 응답(finalizeVerifiedTossPayment·심사 success) 면세 아님이면 console.warn. 셔틀비 면세 = 원장 10-29 결정. 저장은 기존 rawResponse. 화면 변경 0줄. tsc·npm test 3057/3057. main 미머지 | 검수 대기 |
| 11-07 | developer(claude/kakao-chat-flows, 690e2701·d60b7070·084c6767·8f2e3053): 카카오 대화 완결 — ①결석 신청·취소(kakao-absence-flow → reportRegularAbsence/cancelRegularAbsence) ②당일 셔틀 안 탐·다른 곳·취소(kakao-shuttle-flow → submit/cancelShuttleException) ③정규 셔틀 신청·중단·장소·시간 = 요일·방향·장소·시작일을 structuredJson(effectiveDate·shuttleIntent·details)에 담아 SUBMITTED 접수 ④RENTAL 의도+대관 카드(/rental 링크만, 셔틀·정책보다 앞). 공용 상태 저장 kakao-flow-store(흐름 열 때 보강·결석·셔틀·초안 모두 닫음). 스키마 변경 없음. tsc·npm test 3002/3002. main 미머지 → reviewer·security-reviewer 대기 | 검수 대기 |
| 11-07 | developer(체육관 대관): 공개 /rental(안내·날짜칩·1시간 칸·인원/냉난방·실시간 요금·동의·완료 화면에만 계좌) + 관리자 /admin/rental(한 줄 행·상태 칩·⚡/상세 패널·확인 창, 승인→입금 확인→사용 완료→환불·취소) + GymRentalRequest(EXCLUDE 겹침 제약·RLS) + 문자 규칙 4종(원장 켬·신청자 3종 끔+env 스위치). 운영 DB 시험 실행(BEGIN…ROLLBACK)으로 겹침 제약 23P01 확인. 실제 적용·머지·배포는 독립 검수 후. tsc 0·eslint 0·전체 2993 통과(새 19) | 검수 대기 |
| 11-07 | developer 수정 1차(claude/gym-rental, 검수 권장 6건): ① 계좌를 서버 전용 notify(server-only)로 이동·클라이언트 import 그래프 검사 테스트 ② [종료]·ACTIVE 수강생 없는 반 제외 ③ 승인 때 정규 반·특강 재확인 ④ 확정 뒤 취소는 돌려준 금액 필수(cancelRefundAmount)+메모 ⑤ IP 한도(10분 5·하루 15, 지문 clientIpHash)+신청 tx·advisory lock, 원장 문자 10분 창 묶기 ⑥ 접수 문자 전용 스위치. 마이그레이션 2칸·색인 1개 추가(미적용, 시험 실행 OK). tsc 0·eslint 0·전체 2998 통과 | 완료 |
