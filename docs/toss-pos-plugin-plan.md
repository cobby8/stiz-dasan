# 토스 POS 플러그인 «현장 결제» 설계안 (2026-11-07, planner-architect)

> 원장 승인: «플러그인 진행해» (2026-11-07). 이 문서는 **설계만** 담는다. 코드 변경 없음.
>
> ⚠️ **문서 근거 미확인 경고**: 이 설계를 쓴 에이전트에게는 내장 브라우저 도구가 주어지지 않아
> docs.tossplace.com 을 직접 읽지 못했다(WebFetch 403). 아래 «플러그인 SDK 능력» 표는 **가설**이며,
> 0단계(문서 확인)에서 표의 각 칸을 문서 URL 로 확정한 뒤에만 4단계 이후를 시작한다.
> 사이트 쪽 1~3단계는 플러그인 능력과 무관하게 먼저 쓸 수 있도록 설계했다.

---

## 1. 플러그인으로 가능한 것 / 불가능한 것 (0단계에서 확정할 표)

| # | 질문 | 가설 | 확인할 문서 | 아니면(대안) |
|---|------|------|------------|-------------|
| Q1 | 플러그인이 우리 서버(www.stiz-dasan.kr)를 호출할 수 있나 | Http 모듈로 가능하되 **허용 도메인 등록**·rateLimit 제약 | reference/plugin-sdk/pos/http.html, rateLimit.html | 불가면 플러그인 방식 중단 → 1~3단계(메모 번호 매칭)로 운영 |
| Q2 | 탭을 안 열어도(백그라운드) 주기적으로 요청을 가져와 알림을 띄울 수 있나 | 웹 워커 패키지(package.html)가 상주, setInterval 폴링 + alert/toast | develop/package.html, alert.html, toast.html, plugin.html | 불가면 «탭 열면 목록 새로고침»만(선생님이 탭을 연다) |
| Q3 | draftOrder 에 임의 금액 상품(AD_HOC)·면세(isTaxFree)·메모를 넣을 수 있나 | 가능 | draftOrder.html, order.html | 면세 불가면 **4단계 보류**(과세로 결제되면 세금 신고가 틀어진다) |
| Q4 | 플러그인이 «결제 시작»을 불러 카드 결제 화면을 띄울 수 있나 | draftOrder → 결제 시작 API, 최종 카드 삽입은 사람이 | draftOrder.html, payment.html, paymentMethod.html | 불가면 «주문만 만들어 두고 선생님이 결제 버튼» |
| Q5 | 결제 완료(또는 취소) 이벤트를 플러그인이 받나 | 이벤트 구독 또는 결제 결과 콜백 | payment.html, order.html | 못 받아도 **기존 웹훅**(/api/webhooks/tossplace)이 같은 결제를 알려준다 → 서버가 웹훅으로 확정 |
| Q6 | 매장 전용 비밀값을 안전하게 저장할 곳 | secureStore(기기 암호화 저장) | secureStore.html, storage.html, setting.html | 없으면 setting(설정 화면 입력) + 서버 쪽 회전 주기 단축 |
| Q7 | 매장 식별(merchantId)을 플러그인이 알 수 있나 | merchant.html 로 조회 | merchant.html | 서버가 토큰으로 매장을 고정 |
| Q8 | 배포·심사 절차, 테스트 매장/샌드박스 유무 | 개발자센터 앱 등록 → 개발 모드 설치 → 심사 → 공개/비공개 배포 | developers.tossplace.com, open-api/faq.html, service-install.html, develop-tutorial.html | 테스트 매장 없으면 운영 매장에 **비공개(개발) 설치** + 1,000원 테스트 결제 후 취소 |

**핵심 원칙(문서 결과와 무관)**: 돈을 «납부완료»로 바꾸는 근거는 **토스 서버가 서명해 보낸 웹훅 + Open API 재조회**뿐이다.
플러그인이 «결제됐어요»라고 보내는 말만으로는 납부 처리하지 않는다(플러그인은 기기 위 코드라 위조 가능).

---

## 2. 흐름 설계

### 2-1. 새 표 `PosChargeRequest` (현장 결제 요청)
엑셀 비유: «POS 로 보낼 결제 요청 쪽지함». 한 줄 = 청구서 1건에 대한 요청 1번.

| 칸 | 뜻 |
|----|----|
| id (uuid) | 요청 번호 |
| shortCode | 사람이 읽는 6자리 번호(예: `S-4821`) — POS 메모·화면에 크게 표시 |
| paymentId | 청구서(Payment.id) |
| amount (Int) | 요청 순간의 청구 금액(스냅샷) |
| taxFreeAmount (Int) | 면세 금액(수강료 = amount 전액) |
| status | PENDING(사이트에서 만듦) → SENT(플러그인이 가져감) → PAID / CANCELLED / EXPIRED / HELD(확인 필요) |
| expiresAt (timestamptz) | 만료(기본 30분) |
| createdBy | 누른 관리자 |
| claimedAt / tossOrderId / tossPaymentId / paidAt | 플러그인이 가져간 시각, 매칭된 토스 주문·결제 |
| note | 보류 사유 |

DB 제약(코드가 아니라 DB 가 막게):
- `UNIQUE(paymentId) WHERE status IN ('PENDING','SENT')` — 같은 청구서에 열린 요청은 1개만.
- `UNIQUE(shortCode) WHERE status IN ('PENDING','SENT')`.
- `UNIQUE(tossPaymentId) WHERE tossPaymentId IS NOT NULL` — 토스 결제 1건은 요청 1개에만.
- `CHECK (status IN (...))`, `CHECK (taxFreeAmount BETWEEN 0 AND amount)`.
- 마이그레이션 파일로 적용(`prisma db push` 금지), schema.prisma 는 사본으로 함께 갱신.

### 2-2. 순서
1. 관리자 청구서 → «현장 결제» 버튼 → 서버 액션(원장·재무 권한, `requireFinanceOwner`)이
   청구서가 PENDING/OVERDUE 인지, 열린 요청이 없는지 확인 후 PosChargeRequest(PENDING) 생성.
   화면에 **번호 `S-4821` · 원생 · 금액**을 크게 표시.
2. (플러그인) 워커가 20~30초마다 `GET /api/pos-plugin/charge-requests` 폴링 → 새 요청이 있으면 POS 에 알림.
3. 선생님이 알림/탭에서 «결제» → `POST /api/pos-plugin/charge-requests/{id}/claim`
   (조건부 UPDATE `status='PENDING' AND expiresAt>now()` → SENT, 영향 1행일 때만 성공) → 응답으로 금액·면세·메모 문구.
4. 플러그인이 draftOrder 생성: 상품명 «2026년 11월 수강료(홍길동)», 금액, 면세, **메모 `STIZ:S-4821`** → 결제 시작 → 카드.
5. 토스 웹훅 도착 → 기존 `processPosWebhookEvent` 앞단에 **«요청 번호 매칭»** 추가:
   메모에서 `STIZ:S-\d{4}` 를 찾고, 요청이 SENT 이고 금액이 일치하고 토스 재조회(fetchTossOrderById)로 APPROVED 확인되면
   → 한 문장 조건부 UPDATE 로 요청 PAID 선점 → `markPaymentPaid`(provider `TOSS_POS`, providerOrderId=토스 주문, paymentKey=토스 결제 ID).
6. 플러그인이 결제 완료를 받으면 `POST .../{id}/report`(참고용 기록만, 납부 처리 안 함). 서버 응답이 PAID 면 POS 에 «사이트 납부완료» 토스트.

반대 방향(POS 탭에서 미납 고르기): 탭 화면이 `GET /api/pos-plugin/unpaid?q=이름` 으로 미납 목록 조회 → 고르면 서버가 그 자리에서 PosChargeRequest 를 만들고(3번과 같은 claim 까지 한 번에) 이후 동일.

### 2-3. 예외 처리
| 상황 | 처리 |
|------|------|
| 중복 결제(같은 요청에 결제 2건) | 두 번째 웹훅은 tossPaymentId 유일 제약에 걸림 → 요청 HELD 가 아니라 **새 PosPaymentNotice(ALREADY_PAID)** 로 슬랙 DM(기존 흐름) |
| 금액 불일치(선생님이 금액을 고침) | 자동 납부 안 함 → 요청 HELD + 슬랙 DM |
| 청구서가 그 사이 바뀜(금액 수정·이미 납부) | claim·확정 시점에 `Payment.amount = 요청.amount AND status IN (PENDING,OVERDUE)` 재확인, 아니면 HELD |
| 부분취소·전액취소 웹훅 | 납부를 자동으로 되돌리지 않음(환불 처리는 사람이) → 슬랙 DM «POS 에서 취소됨, 청구서 확인» + 요청에 note |
| 만료 | 30분 지난 PENDING/SENT 는 크론(기존 10분 스윕에 끼움)이 EXPIRED. 단 **SENT 후 만료됐는데 결제가 오면** 금액·메모 맞으면 정상 매칭(돈이 실제로 들어왔으므로) |
| 메모 없이 결제 | 기존 이름·금액 매칭 + 슬랙 버튼 흐름 그대로 |
| 플러그인 장애 | 1~3단계 방식(선생님이 메모에 번호 입력)으로 그대로 운영 |

### 2-4. 랠리즈와의 관계 (원장 결정 필요)
현재 웹훅 라우트는 «청구서 원본은 랠리즈 → 원장이 슬랙에서 [랠리즈 처리함·사이트 납부 반영]을 눌러야만 납부 반영»이 규칙이다
(`src/app/api/webhooks/tossplace/route.ts`, `src/lib/pos/paymentNoticeActions.ts`).
«자동 납부완료»는 이 규칙을 바꾸는 것이므로 **결정 D1** 이 필요하다:
- (가) 사이트에서 «현장 결제» 요청으로 받은 건만 자동 납부, 슬랙엔 «랠리즈에도 처리해 주세요» 알림만 → **추천**
- (나) 자동 납부 없이 슬랙 확인 버튼 유지(지금과 같음, 매칭만 정확해짐)

---

## 3. 보안
- **플러그인→서버 인증**: 매장 전용 토큰(32바이트 랜덤) — 서버엔 **SHA-256 해시만** 저장(`PosPluginToken`: hash, label, createdAt, lastUsedAt, revokedAt).
  관리자 화면 «POS 연결»에서 원장이 발급 → 한 번만 보여 주고 POS 설정에 붙여 넣기 → secureStore 보관. 회전 = 새 토큰 발급 후 옛 토큰 revoke(동시에 2개까지 유효해 끊김 없음).
  비교는 `timingSafeEqual`. 헤더 `Authorization: Bearer`.
- **권한 범위**: 토큰이 할 수 있는 일은 ①열린 요청 목록 ②claim ③결과 보고 ④미납 목록(이름 일부·반·금액만, 전화번호·주소 없음). **납부 처리 API 는 토큰에 없음.**
- **IDOR**: claim/report 는 요청 id 만 받고, 금액·청구서는 **서버 DB 값**만 쓴다(본문 금액 무시). 미납 목록은 2호점(다산) 학생만.
- **위조 방지**: 납부 확정은 웹훅 서명 검증(`verifyWebhookSignature`) + Open API 재조회 두 겹. 플러그인 보고는 기록용.
- **속도 제한**: 토큰당 분당 60회, 실패 인증은 IP 당 제한. 로그에 토큰 원문·카드번호 금지(`redact` 재사용).
- **관리자 쪽**: «현장 결제» 버튼과 토큰 발급은 원장(재무 권한)만. 신설 화면은 `AdminShellClient` 의 `EXTRA_GROUPS` 에 등록 + 테스트 고정(사고 2회 함정).
- CORS: 플러그인 출처(문서로 확인한 origin)만 허용.

## 4. 면세
- 토스페이먼츠와 같은 결정: **학원 수강료 = 전액 면세**. 요청 생성 시 `taxFreeAmount = amount`(type MONTHLY·특강 수강료).
- 유니폼·물품(UNIFORM/OTHER)은 **과세** — 이번 범위에서는 «현장 결제» 버튼을 MONTHLY(수강료)에만 노출, 나머지는 기존 방식.
- 셔틀비 과세 여부는 **결정 D2**(토스페이먼츠 쪽 결정과 같게 맞춤 — 그쪽 코드에서 확인 후 동일 상수 사용).
- 판정은 **한 함수**(`taxFreeAmountFor(payment)`)에만 두고 토스페이먼츠 경로와 같은 모듈을 쓴다(두 경로가 갈라지는 사고 방지).
- POS 쪽 표현(상품 isTaxFree vs 결제 taxExemptAmount)은 Q3 에서 확정. 첫 실결제 후 매출 리포트에서 면세로 잡혔는지 원장이 확인.

## 5. 저장소 구조·빌드·테스트
```
apps/toss-pos-plugin/          ← 새 폴더(사이트 빌드와 분리, 자체 package.json)
  src/worker.ts                ← 웹 워커: 폴링 + 알림
  src/tab/                     ← iframe 탭 화면: 미납 목록·결제 버튼
  src/api.ts                   ← 우리 서버 호출(토큰 헤더)
  src/order.ts                 ← draftOrder 조립(금액·면세·메모 STIZ:S-xxxx)
  tests/                       ← 순수 함수 테스트(메모 문구·주문 조립)
src/app/api/pos-plugin/**      ← 플러그인 전용 API(토큰 인증)
src/lib/pos/chargeRequest.ts   ← 요청 생성·claim·매칭 (raw SQL)
src/lib/pos/charge-request.mjs ← 순수 규칙: 번호 형식·메모 파싱·만료·면세 판정
```
- 빌드는 문서의 UMD/패키지 형식(Q8)대로 번들 → 개발자센터 업로드. Vercel 빌드와 무관(사이트 tsconfig 에서 제외).
- 테스트: 순수 모듈 실행 테스트 + 웹훅 매칭은 기존 tossplace-match 테스트처럼 가짜 웹훅 본문으로. 실기기는 운영 매장 개발 설치 + 소액 결제·취소.

## 6. 원장님이 직접 해야 할 것 (단계별)
1. 개발자센터(developers.tossplace.com) 로그인 — 업턴랩스 계정(kimsubin@upturnlabs.co.kr)으로 통일.
2. «플러그인 앱» 새로 만들기 → 앱 이름·설명·아이콘 → 개발자에게 앱 ID 전달.
3. 허용 도메인에 `www.stiz-dasan.kr` 등록(Q1 결과에 따라).
4. 개발 모드로 **우리 매장 POS 에 설치** 및 권한(주문·결제·알림) 승인.
5. 사이트 «POS 연결» 화면에서 토큰 발급 → POS 플러그인 설정에 붙여 넣기.
6. 1,000원 테스트 결제 → 사이트 납부완료·매출 면세 표시 확인 → POS 에서 취소.
7. (공개 배포가 필요할 때만) 심사 신청. 우리 매장 전용이면 비공개 설치로 끝날 수 있음(Q8).
※ 토스페이먼츠 카드사 심사 중(하단정보·상품·URL 수정 금지)과는 별개 상품이지만, **사이트 하단·상품 페이지는 건드리지 않는다.**

## 7. 단계별 구현 계획
| 단계 | 작업 | 담당 | 선행 | 위험 |
|------|------|------|------|------|
| 0 | 문서 확인: 1장 표 Q1~Q8 을 URL 근거로 확정 | PM(브라우저 도구) | 없음 | 면세·서버 호출 불가 판명 시 4단계 이후 중단 |
| 1 | PosChargeRequest 표 + 순수 규칙 모듈(번호·메모 파싱·만료·면세) + 테스트 | developer | 없음(0과 **병렬**) | DB 제약 누락 시 중복 요청 |
| 2 | 관리자 «현장 결제» 버튼 → 번호 크게 표시 화면(POS 메모에 `STIZ:S-4821` 입력 안내), 만료 스윕 | developer | 1 | 원장 권한 누락(IDOR) |
| 3 | 웹훅 매칭 강화: 메모 번호 → 요청 → 재조회 → 자동 납부(D1 결정대로) + 취소·불일치 슬랙 DM | developer → tester+reviewer(+security) **병렬** | 2, D1 | 돈이 움직이는 단계. 이 단계까지로 **플러그인 없이 운영 가능** |
| 4 | 플러그인 전용 API + 토큰 표·발급 화면 | developer → security-reviewer | 0, 3 | 토큰 유출·미납 목록 개인정보 |
| 5 | 플러그인 앱(워커 폴링·알림, draftOrder·결제 시작) | developer | 0, 4 | SDK 가 가설과 다르면 재설계 |
| 6 | 플러그인 탭(미납 고르기 → 결제) | developer | 5 | 동명이인 — 반·금액 함께 표시 |
| 7 | 실기기 테스트·배포(원장 6장 4~6번) — 점검 항목은 아티팩트로 | 원장 + PM | 5·6 | 운영 매장에서 시험 → 소액·즉시 취소 |

## ⚠️ developer 주의사항
- 납부 처리는 반드시 `markPaymentPaid`(src/lib/payment-ledger.ts) 경유 — Payment 직접 UPDATE 금지(감사로그·청구서 어긋남).
- 선점·재확인은 `paymentNoticeActions.ts` 의 `CLAIM_PAY_SQL` 처럼 **한 문장 조건부 UPDATE**.
- 시각은 `timestamptz` 로, 날짜 표시는 `@/lib/datetime/kst` 만. 참고: `payment-ledger.ts` 의 `buildTerminalOrderId` 가 `toISOString().slice(0,10)` 을 써서 KST 새벽엔 전날 날짜가 박힌다(기존 빚 — 새 코드에서 따라 쓰지 말 것).
- 웹훅 라우트는 지금처럼 «서명 실패만 401, 나머지 200» 유지(재시도 폭풍 방지).
- 기존 `recordTerminalPayment`(승인번호 수기 입력) 경로는 그대로 둔다(플러그인 장애 시 대체 수단).

---

## 8. 플러그인 API 계약 (최종 · 2026-11-07 developer 구현, 플러그인 팀 제안 4건 반영)

공통: `Authorization: Bearer stizpos_…` (관리자 «POS 연결»에서 발급, 서버엔 SHA-256 해시만) · JSON · `Cache-Control: no-store`.
응답 칸은 camelCase(플러그인은 snake_case 도 읽음). 성공 `{ ok: true, … }` / 실패 `{ ok: false, error, message }`.
실패 코드: 401 `UNAUTHORIZED` · 429 `RATE_LIMITED`(+`retryAfterSeconds`, 토큰당 분당 60회·인증 실패 IP 당 분당 10회, 인스턴스 메모리 기준) ·
400 `BAD_REQUEST` · 404 `NOT_FOUND` · 409 `NOT_CLAIMABLE`/`NOT_ELIGIBLE`/`CHANGED` · 503 `CODE_EXHAUSTED` · 500 `SERVER_ERROR`.
CORS: 환경변수 `POS_PLUGIN_ALLOWED_ORIGINS`(쉼표) 에 있는 Origin 만 허용(없으면 헤더를 붙이지 않음).

**요청(request) 모양**
```
{ id, shortCode:"S-4821", status:"PENDING|SENT|…", amount:180000, taxFreeAmount:180000,
  itemName:"2026년 11월 수강료(홍*동)", itemTitle:(itemName 과 같음), memo:"STIZ:S-4821",
  studentLabel:"홍*동", studentName:(studentLabel 과 같음 — 가린 이름), expiresAt:"…Z", createdAt:"…Z" }
```
`taxFreeAmount` 는 항상 들어 있고 `taxFreeAmountFor(amount)`(= 전액, D2)로 만들 때 저장한 값이다.

| 메서드·경로 | 요청 | 성공 응답 |
|---|---|---|
| `GET /api/pos-plugin/charge-requests` | — | `{ ok, requests: [요청] }` (열린 PENDING/SENT·만료 전, 최대 50) |
| `POST /api/pos-plugin/charge-requests/{id}/claim` | 본문 없음 | `{ ok, request }` (SENT). 같은 토큰 재시도는 성공, 남이 가져갔거나 만료·취소면 409 |
| `POST /api/pos-plugin/charge-requests/{id}/report` | `{ event: paid\|cancel\|start_failed (또는 SENT/PAID/CANCELLED/FAILED/START_FAILED), reason?, message? }` | `{ ok, status, paid, duplicate }` — **기록만**. `cancel` 은 열린 요청만 CANCELLED. 같은 요청+같은 event 두 번째는 `duplicate:true`(아무것도 안 바뀜). 본문의 금액·토스 ID 는 무시 |
| `GET /api/pos-plugin/unpaid?q=이름일부` | — | `{ ok, items: [{ paymentId, studentLabel, studentName(가림), className, title, amount, status, hasOpenRequest }] }` 수강료·셔틀비 미납, 최대 30 |
| `POST /api/pos-plugin/unpaid/{paymentId}/charge` | 본문 없음 | `{ ok, request }` (생성+선점 SENT). 열린 요청이 있으면 그걸 선점해 돌려줌(남이 가져갔으면 409) |

**웹훅 매칭**(서버만): 주문 `memo` · `lineItems[].memo` · `lineItems[].code` · `lineItems[].item.memo` · `lineItems[].item.code` 에서
`STIZ[:：]? S-?\d{4,6}` 를 찾는다(손 입력 변형 허용). 번호가 정확히 1개 + 카드 승인 1건 + 금액 = 요청 금액 + 청구서 미납·금액 그대로 +
승인 시각 ≤ 만료 시각이면 자동 납부(`markPaymentPaid`, CARD·TOSS_POS). 하나라도 어긋나면 요청 HELD + 기존 슬랙 확인 알림.

**설계안과 달라진 점(계약 변경)**
- 탭 흐름 경로를 `POST /api/pos-plugin/unpaid/{paymentId}/charge` 로 확정(플러그인 팀 제안).
- report 의 event 에 `start_failed` 추가 + 중복 보고 1회 처리, 소문자 별칭 허용.
- 응답에 `studentName`(가린 이름)·`itemTitle` 별칭 추가 — 실명은 플러그인에 나가지 않는다(상품명에도 가린 이름).
- 만료: 2-3 표의 «SENT 후 만료돼도 정상 매칭»을 «**결제 승인 시각**이 만료 전이면 매칭, 뒤면 HELD»로 좁혔다(PM 지시: 만료는 HELD).
- 권한: «현장 결제»·토큰 발급은 원장(ADMIN)만(부원장 불가) — 기존 «단말기 결제 반영»과 같은 재무 권한.
- 셔틀비(SHUTTLE)도 «현장 결제» 대상(D2: 면세).
