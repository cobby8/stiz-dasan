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
| P-1 | lib/pos/chargeRequestService.ts writeLedgerPaid·settleCancelForRow | 권장 | 납부 기록(markPaymentPaid 무조건 UPDATE) 직전에 POS 취소 웹훅이 끼면 요청 DONE·청구 PENDING→뒤이어 PAID 로 덮임(사이트 납부완료·실제는 취소). 기록 뒤 cancelState 재확인 → DONE 이면 refundPaidPaymentInTx, 또는 settle 에서 refunded=false·청구 미납이면 retryLater |
| P-2 | admin/finance/FinanceClient.tsx:955 «환불» | 권장 | TOSS_POS 건에도 그대로 → POS 는 안 취소되고 사이트만 REFUNDED. TOSS_POS 면 숨기거나 확인창에 «POS 결제는 취소되지 않음, 결제 취소를 쓰세요» 경고 |

### 리뷰 결과 (reviewer · 11-08 POS 결제 취소 b7ef25d0)
📊 종합 판정: 통과(머지 가능 · 차단 없음, 권장 P-1·P-2). 마이그레이션은 build 에 migrate deploy 가 없으므로 **배포 전 apply_migration 필수**(안 하면 플러그인 GET·CLAIM_PAY 가 칸 없음으로 실패 → 현장 결제 전체 정지).
✅ 환불은 settleCancelForRow(토스 재조회 order)만 · report 는 기록만 · MARK_REFUND+refundPaidPaymentInTx 한 트랜잭션 조건부 · 일부/누락 결제는 PARTIAL(안전 방향) · 플러그인 ID 는 서버 DB 값·getPayment orderId 대조 · 마이그레이션 NULL 허용 칸만·CHECK 는 NULL 통과. 테스트 루트 3160-0(보고 3165와 5건 차이)·플러그인 65-0.

---

## 작업 로그 (최근 10건)

| 날짜 | 작업 내용 | 상태 |
|------|----------|------|
| 11-09 | developer: 원생 등록 1차(버그 수정) — 학부모 계정 연결을 src/lib/students/parentAccountLink.ts 한 곳으로(주 보호자 휴대폰 숫자로 PARENT 1순위·없으면 같은 번호 직원 1명(원장 결정)·둘 다 없으면 parent_<번호>@stiz.local 빈 계정·같은 등급 2명↑ 오류, 기존 계정 이름·번호·이메일 UPDATE 없음, 주 보호자 Guardian 저장). createStudent·convertTrialToStudent 교체(트랜잭션·ok:false 안내), updateStudent 이메일 NULL 덮기 제거·빈 계정만 이름·번호, 엑셀 덮어쓰기 계정 이름 덮기 제거(보호자1 주 보호자 재삽입). 목록 폼 이메일 칸 제거·관계 칸·휴대폰 필수·등록 뒤 미배정 필터+상세 패널. tsc 0·tests 3407-0(신규 16)·guards 1실패=기존 gym-rental | 검수 대기 |
| 11-09 | developer: 학부모 가입 안내 보내기(/admin/sms 수동 발송 탭) — 받는 사람 서버 계산(재원생 대표 학부모·계정 없음·탈퇴 제외·번호 중복 제거·이미 받은 번호 기본 제외/다시 보내기), 대관 안내와 같은 미리보기 승인(OperationsAuditLog)·재대조·잠금 뒤 기존 대량 큐(reserveManualMessageQueue→매분 크론). 문자 깨짐 때문에 🏀 삭제·꺾쇠 따옴표→‘’. 실제 발송 없음. tsc 0 · tests 3403-0(신규 parent-signup-guide 13건) | 검수 대기 |
| 11-08 | pm(claude/dec-launch→main 5c30e081): 12월 출시 A 9건 — 주2·3회 요금·형제할인 10%(전원, 셔틀 제외)·셔틀비 자동 제안, 보강 아이 코치 출석부(보강권 같은 트랜잭션), 같은 반·같은 날 Session 하나(regularSession.ts), 셔틀 명단 수강 점검·카카오 셔틀 신청 할 일, 학부모 청구·수납 결제하기, 공지 SEO. 검수 4건+재검수 통과, tests 3388-0, guards 1건 실패는 main 대관 gym-rental-service 병합 필터(다른 세션). 남은 것: 특강 회차 수업일지 수정 시 정규 학생 출석 저장(기존 문제), 원장 결정표 Bf1CPJqw76JGK5yp1Z7LmG | 배포 |
| 11-08 | developer: 체육관 대관 분 단위 전환(원장 지시) — 달력 선택(오늘~60일)·시작 10분·이용 30분(1~6시간)·주말 10:00~22:00·수업/특강/승인 대관 제외. 마이그레이션 20261108210000_gym_rental_minutes(**운영 미적용**, startMinute/endMinute nullable+기존 행 채우기+CHECK) · 요금 30분 단가(원장 확정) · 표시 formatRentalTime 하나로(관리자·문자·슬랙·앱 알림). tsc 0 · 대관 관련 테스트 9파일 129-0(신규 gym-rental-minutes 13건) | 검수 대기 |
| 11-08 | reviewer: d110f2ff(현장 결제 화면 개선) 검수 — 머지 가능. 제외 건 유입 없음·서버 재검증 유지·삭제 차단 안전. 🟡 PAID 전체(계좌이체 포함) 삭제 차단은 원장 확인 필요·서버 문구 «카드로 받은» 불일치·묶음 행 매칭 shortCode→요청 id 권장 | 검수 완료 |
| 11-08 | developer(claude/pos-multi-charge): 현장 결제 묶음 — 같은 학생 미납 수강료·셔틀비 여러 건을 POS 결제 한 번(주문 1·항목 N). 마이그레이션 20261108180000_pos_charge_request_items(표·열린 항목 유일 인덱스·닫기 트리거·기존 요청 채우기, **운영 미적용·코드보다 먼저**) · 만들기 서버 재확인(같은 학생·유형·미납·금액·10건·500만), 겹치면 ALREADY_OPEN · 매칭=결제 합계(분할)·면세 합계·묶인 청구 전부 미납일 때 markPaymentsPaidTogether(한 트랜잭션), 하나라도 어긋나면 HOLD · 취소=전부 취소면 전부 환불·일부면 PARTIAL · 납부처리 창 여러 건 현장 결제 활성·창 «외 N건 · 합계» · 플러그인 items[]·항목별 검사. 사이트 tsc 0·test 3252-0(+가드 5), 플러그인 tsc 0·test 74-0, zip 재생성 | 검수 대기 |
| 11-08 | developer(claude/payments-batch, 배포 전 검수 보완 8건, 3becaac4·bb2a403f): 납부처리 — Payment paidProvider=MANUAL(토스 키 미변경)·청구서 UPDATE 에 PAID/CANCELED 제외·여러 건 창에 대상 학생(«외 N명», targetNamesSummary). 가상계좌 — 취소 요청에 refundReceiveAccount·cancelAmount 금지 주석+가드, 멱등키에 KST 10분 단위 섞기, PARTIAL_CANCELED 는 닫기·점검 FAIL+원장 확인(웹훅도 RELEASE→REJECT 알림, 같은 규칙 양쪽), 점검 건별 try/catch·45초 예산(deferred)·토스 조회/취소 10초 제한·cron maxDuration 60, 취소 사유 actor 별, 닫기창 «이미 입금» 성공 톤. tsc 0·npm test 3229-0·바뀐 파일 eslint 신규 0(admin.ts 기존 73건 동일) | 완료 |
| 11-08 | developer 수정 1차(claude/pos-auto-charge, 검수 권장 5건): P-1 납부 기록 틈에 취소가 먼저 오면 — 취소 확정은 요청이 DONE 이어도 청구 PAID 면 환불(수렴), 청구 미납·방금 PAID 면 알림 미루고 retryLater, 납부 기록 직후 cancelState 재확인→DONE 이면 바로 환불(정상·복구 두 경로), 슬랙 문구는 실제 청구 상태대로 · P-2 토스 POS 납부 건은 «환불» 메뉴 숨김 · P-3 플러그인 결제 조회 실패·주문번호 없음이면 취소 안 하고 failed · P-4 POS 취소 보고 뒤 3분 토스 확인 없으면 창 안내. 사이트 tsc 0·가드 5+본 3167 통과, 플러그인 tsc 0·66 통과, zip 재생성 | 검수 대기 |
| 11-08 | reviewer: POS 결제 취소(0bded3e8..66c2cdd6) 검수 — 차단 0·권장 2(P-1 납부기록/취소 경합, P-2 TOSS_POS «환불» 메뉴). 테스트 3160-0·65-0 | 통과 |
| 11-08 | developer(claude/pos-auto-charge): 사이트 «결제 취소» → POS 결제 취소 → 토스 웹훅 확인 시 청구 REFUNDED. 마이그레이션 20261108120000_pos_charge_cancel(칸 추가만·**운영 미적용, 코드보다 먼저 적용**) · 환불 쓰기 = payment-ledger refundPaidPaymentInTx(트랜잭션) · 분할 결제는 전부 취소일 때만(일부=PARTIAL+알림) · POS 직접 취소도 같은 길 · 플러그인 cancel.ts(선점→getPayment→payment.cancel→재확인→보고) · 롱폴링 cancels[]·cancels=1 일 때만 깨움 · ALREADY_DONE+청구서 미납이면 30초 임대 뒤 납부 기록 복구 · 웹훅 4초 초과 시 after() · 분할 대기 retryLater(웹훅 미완료로 둬 스윕 재확인, 만료 뒤 HOLD) · justPaid=paidRecordedAt 기준. 사이트 tsc 0·test 3165-0, 플러그인 tsc 0·test 65-0, zip 재생성 | 검수 대기 |
| 11-08 | developer 수정 1차(claude/virtual-account, PM 2건+검수 권장 4건): ① 열린 계좌가 있어도 확인 후 카드·계좌이체 허용 — 토스 취소 API→재조회로 닫힘 확인 후 새 결제, 닫는 사이 입금이면 «이미 납부», 실패면 결제창 안 엶 ② 웹훅 원문 저장 시 secret 가림 ③ 입금 알림 DONE 인데 재조회 대기·4xx 면 503 재전송 + 매일 cron /api/cron/virtual-account-sweep(0 0 * * * = KST 09:00) ④ 승인 전 이미 납부·다른 결제키 거부 ⑤ 관리자 «가상계좌 닫기»(원장·위험 확인창) ⑥ 발급 0건 재확인·입금 알림 지문 transactionKey. 전체 3159 통과·tsc 0 | 검수 대기 |
