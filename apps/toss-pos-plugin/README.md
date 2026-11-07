# STIZ 토스 POS 플러그인 — «현장 결제»

사이트 관리자 화면에서 원장님이 **«POS로 결제 보내기»** 를 누르면, 매장 토스 POS 에
수강료(면세)가 담긴 결제 화면이 **바로 열리는** 플러그인입니다(2026-11-08부터 버튼을 누르는 단계 없음).

```
사이트 «현장 결제» ─▶ 서버에 요청(S-482193) 생성
                         │  (롱폴링: 워커가 «최대 20초 기다려 줘» 하고 묻고, 새 요청이 생기면 서버가 즉시 답함 → 보통 1~2초)
POS 워커 ◀───────────────┘
  └ 새 요청이면 바로(못 열면 토스트 «… 현장 결제 요청 [결제하기]» 로 남김)
       └ 서버 선점(SENT) → 결제 화면에 «2026년 11월 수강료(홍*동) 180,000원 · 면세 · 메모 STIZ:S-482193»
            └ 카드 결제(사람) → 토스플레이스 웹훅 → 서버가 재조회 후 납부완료
                 └ (참고) 플러그인도 «결제 시도됨»을 서버에 알림 — 납부 처리 근거로는 쓰지 않음
```

> 설계안: `docs/toss-pos-plugin-plan.md` · 사이트 빌드와 **완전히 분리**된 독립 폴더입니다
> (루트 `tsconfig.json`·`eslint.config.mjs` 에서 제외, 루트 `package.json` 에 의존성 없음).

## 폴더 구조

| 경로 | 하는 일 |
|------|--------|
| `src/core/contract.ts` | 서버 API 주소·응답 해석(**계약은 이 파일 한 곳**) |
| `src/core/order.ts` | 요청 → POS 주문 항목 변환, 메모 `STIZ:S-xxxx`, 금액·면세 검증 |
| `src/core/charge.ts` | 결제 흐름(다른 주문 담김·중복 클릭·선점 순서), 결제/취소 신호 보고 |
| `src/core/cancel.ts` | 사이트 «결제 취소» → POS 결제 취소(선점 → 결제마다 상태 확인·`payment.cancel`·다시 확인 → 결과 보고) |
| `src/core/api.ts` | 서버 호출(Bearer POS 연결 코드), 오류 코드 → 화면 안내 |
| `src/core/backoff.ts` | 롱폴링 간격(정상 0초·연속으로 일찍 답하면 최대 14초) · 옛 서버 대비 14초 폴링 · 실패 시 지수 백오프(최대 10분) |
| `src/core/notify.ts` | 같은 요청 알림 반복 방지(5분 간격 최대 3번) |
| `src/core/token.ts` | POS 연결 코드 secureStore 보관·모양 검사·마스킹 |
| `src/worker/main.ts` | 웹 워커(백그라운드): 롱폴링·자동 결제창(한 번에 1건)·알림·결제 신호·결제 취소할 일 |
| `src/tab/*` | 탭 화면: 대기·선점 요청(다시 결제)·미납 검색·연결 코드 입력 |
| `scripts/build.mjs` · `scripts/zip.mjs` | 묶기 · 업로드용 zip 만들기 |
| `tests/*.test.ts` | 단위 테스트(`node --test`) · `sdk-compat.typecheck.ts` = 실제 SDK 타입과 맞는지 |

## 개발 명령 (이 폴더 안에서)

```bash
npm install          # 이 폴더에만 설치(사이트와 별개)
npm test             # 단위 테스트
npm run typecheck    # 타입 검사(실제 SDK 0.0.31 타입과 비교 포함)
npm run zip          # dist/stiz-pos-worker.zip · dist/stiz-pos-tab.zip 생성
```

zip 구조(문서 기준):
- `stiz-pos-worker.zip` → `stiz-pos-worker/main.js` (웹 워커, 메인 파일 이름은 반드시 `main.js`)
- `stiz-pos-tab.zip` → `stiz-pos-tab/index.html · tab.js · tab.css · iframe-manifest.json` (탭 화면)

## 원장님 설치 순서

> ⚠️ 비밀값(POS 연결 코드)은 이 문서·코드·zip 어디에도 없습니다. POS 에서 사람이 직접 넣습니다.

1. **개발자센터 로그인** — https://developers.tossplace.com (업턴랩스 계정 `kimsubin@upturnlabs.co.kr`)
2. **플러그인 등록** — [내 플러그인] → [플러그인 등록]
   - 플러그인 타입: **토스 POS** · 이름: `STIZ 현장 결제` · 플러그인 ID · 회사명
   - **ACL**(호출 허용 주소)에 한 줄: `https://www.stiz-dasan.kr`
3. **zip 업로드** — 내 플러그인 → **개발 배포** → 개발용 파일 추가 → `stiz-pos-worker.zip`
   - 탭 화면도 쓰려면 `stiz-pos-tab.zip` 도 올립니다. 한 플러그인에 파일을 하나만 받는다면
     플러그인을 하나 더 등록(`STIZ 현장 결제 탭`, ACL 동일)해 거기에 올립니다.
4. **테스트 가맹점 연결** — [테스트 가맹점 관리]에서 가맹점 연결 → 상세 화면에서 이 플러그인 **사용 ON**
5. **POS 시리얼 확인** — POS → 설정 → 정보 → 포스정보/소프트웨어 → «포스 시리얼 번호»
6. **테스트 단말기 등록** — 개발자센터 → 이 플러그인 → 테스트 단말기 → 단말기 등록(5번의 시리얼)
7. **POS 재시작** — POS 우측 상단 설정 → **다시 시작** (새 zip 을 올릴 때마다 재시작)
8. **POS 연결 코드 넣기** — 사이트 관리자 «POS 연결»(`/admin/pos-plugin`)에서 연결 코드 발급(한 번만 보임) → 둘 중 하나에 붙여 넣기
   - POS 메뉴 → 기타 → 외부 서비스 설정 → **STIZ 현장 결제** 탭 → [연결 코드] → 붙여 넣기 → 저장 (권장)
   - 또는 POS 설정 → 외부 서비스 설정 → «POS 연결 코드» 칸
   - 탭 머리줄이 **연결됨** 이면 성공
9. **1,000원 시험 결제·취소**
   1. 사이트에서 1,000원 시험 청구서 → «현장 결제» → «POS로 결제 보내기»
   2. 15초 안에 POS 결제 화면이 저절로 열림 → «1,000원 · 면세» 확인 → 카드 결제
   3. 사이트에서 청구서 **납부완료**, 토스 매출 리포트에서 **면세** 로 잡혔는지 확인
   4. 사이트 수납 관리 ⚡ «결제 취소» → 확인 → POS 가 저절로 그 결제를 취소 → 사이트 창 «환불 처리됐습니다»·청구 **환불** 확인
      - ⚠️ 실기기에서 꼭 볼 것: 카드 취소 때 POS 에 확인 창이 뜨는지(뜨면 눌러 줌), 거절하면 사이트 창이 «POS 에서 직접 취소해 주세요» 로 바뀌는지
   5. 다른 1,000원 결제를 **POS 에서 직접 취소** → 사이트 청구가 자동으로 **환불**로 바뀌는지 확인(같은 토스 웹훅 경로)

### ⚠️ POS 연결 코드가 샜다면 — 바로 끊기
연결 코드는 «이 매장 POS 가 사이트에 현장 결제 요청을 묻고 미납 목록을 볼 수 있는 열쇠»입니다.
채팅·사진·메모 등으로 남에게 보였거나 POS 기기를 잃어버렸다면 **기다리지 말고**:
1. 사이트 관리자 **`/admin/pos-plugin`**(«POS 연결») → 그 연결 코드 **끊기** — 그 순간부터 그 코드로는 아무것도 못 합니다.
2. 같은 화면에서 새 연결 코드 발급 → POS 탭 [연결 코드]에 다시 넣기.
- 연결 코드로는 **납부 처리를 할 수 없습니다**(납부는 토스 웹훅으로만). 그래도 미납 목록(가린 이름·금액)이 보이므로 바로 끊습니다.
- 연결 코드를 카카오톡·문자·사진으로 주고받지 마세요. 사이트 화면에서 복사해 POS 에 바로 붙여 넣습니다.

### 운영 매장에서 쓰려면 (문서: 검수 및 배포하기)
- 개발 배포는 **검수 없이 즉시**, 단 **테스트 단말기 최대 5대**에만 적용됩니다.
- 운영 가맹점 전체에 쓰려면 **라이브 배포 → 검수 요청**(매주 월·목) → 승인 후,
  **VAN 대리점**이 토스플레이스 파트너스에서 이 플러그인을 ON 해야 합니다(매장에서 직접 설치 불가).
  대리점 권한 연결은 `developer-support@tossplace.com` 으로 «플러그인 이름·ID, 대리점명·사업자번호» 전달.

## 서버 API 계약 (플러그인이 부르는 것)

정본은 서버 브랜치 `docs/toss-pos-plugin-plan.md` **8장**입니다. 아래는 플러그인이 쓰는 부분 요약입니다.

모든 호출: `Authorization: Bearer <POS 연결 코드(stizpos_…)>` · JSON. 칸 이름은 camelCase/snake_case 둘 다 읽습니다.
실패 응답 `{ ok:false, error, message }` 의 `error` 코드는 화면 안내로 바꿔 보여 줍니다
(`NOT_CLAIMABLE` 다른 POS 가 가져감·만료 / `NOT_ELIGIBLE` 미납 청구서가 아님 / `CHANGED` 청구 금액이 바뀜 /
`RATE_LIMITED` + `retryAfterSeconds` 만큼 쉼 / `UNAUTHORIZED` 연결 코드 오류 / 모르는 코드는 서버 문구 그대로).

| 메서드·경로 | 응답(성공) | 실패 |
|---|---|---|
| `GET /api/pos-plugin/charge-requests` (롱폴링 선택: `?wait=0~20&cancels=1&known=id,…`) | `{ ok, requests: [요청], cancels: [취소할 일] }` (PENDING·SENT) · wait>0 이면 `waitSec` 추가 · `cancels=1` 을 보낸 기기만 새 취소 요청으로도 대기가 깨어남 | 401 |
| `POST /api/pos-plugin/charge-requests/{id}/claim` | `{ ok, request }` (SENT, 같은 연결 코드 재시도 성공) | 409 `NOT_CLAIMABLE` |
| `POST /api/pos-plugin/charge-requests/{id}/report` 본문 `{event:'paid'|'cancel'|'start_failed', reason?}` | `{ ok, status, paid, duplicate }` (paid 면 POS 에 «사이트 납부완료») | — |
| `POST /api/pos-plugin/charge-requests/{id}/cancel/claim` (본문 없음) | `{ ok, cancel: { id, shortCode, amount, studentName, itemName, tossOrderId, tossPaymentIds: [...] } }` — 취소할 주문·결제 ID 는 서버 DB 값(분할 결제면 전부) | 409 `NOT_CLAIMABLE` |
| `POST /api/pos-plugin/charge-requests/{id}/cancel/report` 본문 `{result:'done'|'failed', message?}` | `{ ok, cancelState, refunded }` — **기록만**(환불은 토스 웹훅으로), 가져간 연결 코드만 보고 가능 | 409 `NOT_CLAIMABLE` |
| `GET /api/pos-plugin/unpaid?q=이름` | `{ ok, items: [{paymentId, studentLabel, className, title, amount, …}] }` | — |
| `POST /api/pos-plugin/unpaid/{paymentId}/charge` | `{ ok, request }` (생성+선점) | 409 `NOT_CLAIMABLE`/`NOT_ELIGIBLE`/`CHANGED` |

요청 = `{ id, shortCode:"S-482193"(4~6자리 허용), studentLabel:"홍*동"(가린 이름), itemName:"2026년 11월 수강료(홍*동)", amount, taxFreeAmount, memo, expiresAt, status, items:[…] }`

- **묶음(2026-11-08 원장 결정 «같은 학생이면 한 번에 결제»)**: `items: [{ itemName, amount, taxFreeAmount, memo }]` — 청구마다 1개.
  플러그인은 항목마다 주문 항목 1개를 담고(key `stiz-번호`, `stiz-번호-2` …, 메모·상품 코드는 전부 같은 `STIZ:번호`),
  다시 읽어 «항목 수 = N · 항목마다 금액·면세·메모 일치 · 합계 = amount» 일 때만 결제 화면을 엽니다. 하나라도 어긋나면 비우고 멈춥니다.
  항목 합계·면세 합계가 요청과 다르거나 항목이 10개(`MAX_ITEMS`)를 넘으면 담지도 않습니다. `items` 가 없으면(옛 서버) 요청 하나 = 항목 하나.
  요청 한도: 담기가 항목 수만큼 늘어 결제 1건 약 12+N번(최대 24번).

- 탭 화면은 PENDING 과 함께 **SENT(이 매장이 선점했지만 결제 시작이 안 된 건)** 도 «다시 결제» 버튼으로 보여 줍니다.
- POS 알림·탭 목록에서는 상품명의 «(가린 이름)»을 떼어 이름이 한 번만 보이게 합니다(결제 화면 상품명은 서버 값 그대로).
- 결제/취소 신호(`payment.on`)는 **워커만** 받습니다. 탭은 등록하지 않아 주문 조회·안내가 두 번 나지 않습니다.
- **결제 취소(2026-11-08)**: 사이트에서 «결제 취소»를 누르면 롱폴링 응답 `cancels[]` 로 옵니다. 워커는 한 건씩
  선점 → 결제마다 `payment.getPayment` 로 상태 확인(이미 취소면 건너뜀 · 서버가 준 주문과 다른 주문의 결제면 손대지 않음)
  → `payment.cancel({id:주문},{id:결제})` → 다시 읽어 확인 → 서버에 done/failed 보고. 사이트 청구의 **환불은 토스 웹훅 재조회로만**
  바뀝니다(분할 결제는 전부 취소됐을 때만, 일부만이면 원장 확인). POS 에서 사람이 직접 취소해도 같은 웹훅으로 환불됩니다.

- 플러그인은 `taxFreeAmount === amount` 일 때만 결제 화면을 엽니다(수강료 = 전액 면세). 다르면 멈춥니다.
- **메모 위치**: SDK 0.0.31 에는 «주문 전체 메모»를 넣는 함수가 없어, `STIZ:S-4821` 을
  **상품(항목) 메모**와 **상품 코드(item.code)** 에 넣습니다. 서버 웹훅 매칭은 주문 메모뿐 아니라
  `lineItems[].memo`·`lineItems[].item.code` 도 봐야 합니다.

## 안전 장치
- 결제 화면에 다른 상품이 담겨 있으면 **덮어쓰지 않고** 안내만 합니다(서버 선점 전·후 두 번 확인).
- [결제하기] 중복 클릭은 잠금으로 막습니다. 선점은 서버 조건부 UPDATE 로 한 기기만 성공합니다.
- 수량·메모·옵션은 POS 에서 고칠 수 없게 잠급니다. 담은 뒤 주문을 **다시 읽어**(최대 3번, 0.3초 간격)
  «우리 항목 1개 · 항목가×수량 = 금액 · 면세 · 메모 번호»를 확인하고, 다르면 비우고 멈춥니다.
  주문 합계는 «0보다 크고 금액과 다를 때»(자동 할인 등)만 불일치로 봅니다 — 담은 직후 합계가 0으로 오는
  경우가 있어서입니다(2026-11-08 S-704715). 멈추면 서버 보고에 실제 값이 남습니다
  (예: `draft_mismatch n=1 item=1000x1 unit=1 total=0 taxFree=true memo=ok`).
- 워커가 자동으로 여는 경로는 화면을 막는 알림창(alert)을 띄우지 않습니다. 못 열면 [결제하기] 토스트가 남고,
  금액 문제는 짧은 경고 토스트로만 알립니다. 사람이 [결제하기]를 누른 경로는 예전처럼 알림창으로 안내합니다.
- **롱폴링**: `GET /api/pos-plugin/charge-requests?wait=20&known=id,…` — 서버가 최대 20초 동안 약 1초마다 가벼운
  확인을 하다가, 워커가 아직 모르는(known 에 없는) 대기 요청이 생기면 바로 답합니다. 시간 제한 25초.
  응답이 오면 곧바로 다음 대기를 겁니다. 정상이면 30분 90번 · 60초 3번 → 토스 POS 요청 제한(60초 100번·30분 200번)
  안에서 결제 처리 몫 110번(결제 1건 ≈ SDK 호출 13번). 서버가 연달아 일찍 답하면 쉬는 시간을 0→1→2→4→8→14초로
  늘려 최악에도 30분 133번입니다. 서버가 `waitSec` 를 안 돌려주면(옛 서버) 예전처럼 14초(±10%) 간격으로 묻습니다.
  실패하면 28초→56초→…, 최대 10분.
- 납부완료 처리 근거는 **토스 웹훅(서명) + Open API 재조회**뿐. 플러그인 보고는 참고용입니다.

## 근거 문서 (2026-11-07 확인)
- 튜토리얼 https://docs.tossplace.com/guide/pos-integration/plugin/develop/develop-tutorial.html
- 웹 워커 /guide/pos-integration/plugin/develop/package.html · 탭 /iframe-package.html · zip 구조 /umd.html
- 동작 방식 /guide/pos-integration/plugin/how-to-work.html · 배포 /guide/pos-integration/plugin/deploy.html
- SDK /reference/plugin-sdk/pos/ — draftOrder · payment · order · http · secureStore · setting · toast · alert · rateLimit · error
- 공식 템플릿 https://github.com/tossplace/toss-pos-plugin-template · npm `@tossplace/pos-plugin-sdk@0.0.31`
