# STIZ 토스 POS 플러그인 — «현장 결제»

사이트 관리자 화면에서 원장님이 **«현장 결제»** 를 누르면, 매장 토스 POS 에 알림이 뜨고
선생님이 **[결제하기]** 한 번으로 수강료(면세)가 담긴 결제 화면을 여는 플러그인입니다.

```
사이트 «현장 결제» ─▶ 서버에 요청(S-4821) 생성
                         │  (30초마다 확인)
POS 워커 ◀───────────────┘
  └ 토스트 «김○○ 수강료(11월) 100,000원 현장 결제 요청 (S-4821) [결제하기]»
       └ [결제하기] → 서버 선점(SENT) → 결제 화면에 «수강료(11월) 100,000원 · 면세 · 메모 STIZ:S-4821»
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
| `src/core/api.ts` | 서버 호출(Bearer 토큰), 오류 종류 분류 |
| `src/core/backoff.ts` | 폴링 30초 + 실패 시 지수 백오프(최대 10분) |
| `src/core/notify.ts` | 같은 요청 알림 반복 방지(5분 간격 최대 3번) |
| `src/core/token.ts` | 토큰 secureStore 보관·모양 검사·마스킹 |
| `src/worker/main.ts` | 웹 워커(백그라운드): 폴링·알림·결제 신호 |
| `src/tab/*` | 탭 화면: 대기 요청·미납 검색·토큰 입력 |
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

> ⚠️ 비밀값(토큰)은 이 문서·코드·zip 어디에도 없습니다. POS 에서 사람이 직접 넣습니다.

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
8. **토큰 넣기** — 사이트 관리자 «POS 연결»에서 토큰 발급(한 번만 보임) → 둘 중 하나에 붙여 넣기
   - POS 메뉴 → 기타 → 외부 서비스 설정 → **STIZ 현장 결제** 탭 → [토큰] → 붙여 넣기 → 저장 (권장)
   - 또는 POS 설정 → 외부 서비스 설정 → «사이트 연결 토큰» 칸
   - 탭 머리줄이 **연결됨** 이면 성공
9. **1,000원 시험 결제·취소**
   1. 사이트에서 1,000원 시험 청구서 → «현장 결제» → 번호(S-xxxx) 확인
   2. 30초 안에 POS 에 알림 → [결제하기] → 결제 화면에 «1,000원 · 면세» 확인 → 카드 결제
   3. 사이트에서 청구서 **납부완료**, 토스 매출 리포트에서 **면세** 로 잡혔는지 확인
   4. POS 에서 그 결제 **취소** → 사이트 청구서는 자동으로 되돌아가지 **않음**(사람이 처리) 확인

### 운영 매장에서 쓰려면 (문서: 검수 및 배포하기)
- 개발 배포는 **검수 없이 즉시**, 단 **테스트 단말기 최대 5대**에만 적용됩니다.
- 운영 가맹점 전체에 쓰려면 **라이브 배포 → 검수 요청**(매주 월·목) → 승인 후,
  **VAN 대리점**이 토스플레이스 파트너스에서 이 플러그인을 ON 해야 합니다(매장에서 직접 설치 불가).
  대리점 권한 연결은 `developer-support@tossplace.com` 으로 «플러그인 이름·ID, 대리점명·사업자번호» 전달.

## 서버 API 계약 (플러그인이 부르는 것)

모든 호출: `Authorization: Bearer <매장 토큰>` · JSON. 칸 이름은 camelCase/snake_case 둘 다 읽습니다.

| 메서드·경로 | 응답(성공) | 실패 |
|---|---|---|
| `GET /api/pos-plugin/charge-requests` | `{ requests: [요청] }` | 401 토큰 오류 |
| `POST /api/pos-plugin/charge-requests/{id}/claim` | `{ request: 요청 }` (status SENT) | 409/410 이미 선점·만료 |
| `POST /api/pos-plugin/charge-requests/{id}/report` 본문 `{event:'paid'|'cancel'|'start_failed', tossOrderId?, tossPaymentId?, amount?, taxExemptAmount?, reason?}` | `{ status }` (PAID 면 POS 에 «사이트 납부완료») | — |
| `GET /api/pos-plugin/unpaid?q=이름` | `{ items: [{paymentId, studentName, className, title, amount}] }` | — |
| `POST /api/pos-plugin/unpaid/{paymentId}/charge` (제안) | `{ request: 요청 }` (생성+선점) | 409 열린 요청 있음 |

요청 = `{ id, shortCode:"S-4821", studentName:"김○○"(마스킹), itemTitle:"수강료(11월)", amount, taxFreeAmount, expiresAt(ISO, 시간대 포함), status }`

- 플러그인은 `taxFreeAmount === amount` 일 때만 결제 화면을 엽니다(수강료 = 전액 면세). 다르면 멈춥니다.
- **메모 위치**: SDK 0.0.31 에는 «주문 전체 메모»를 넣는 함수가 없어, `STIZ:S-4821` 을
  **상품(항목) 메모**와 **상품 코드(item.code)** 에 넣습니다. 서버 웹훅 매칭은 주문 메모뿐 아니라
  `lineItems[].memo`·`lineItems[].item.code` 도 봐야 합니다.

## 안전 장치
- 결제 화면에 다른 상품이 담겨 있으면 **덮어쓰지 않고** 안내만 합니다(서버 선점 전·후 두 번 확인).
- [결제하기] 중복 클릭은 잠금으로 막습니다. 선점은 서버 조건부 UPDATE 로 한 기기만 성공합니다.
- 수량·메모·옵션은 POS 에서 고칠 수 없게 잠급니다. 추가 후 주문 금액이 요청과 다르면 비우고 멈춥니다.
- 폴링 30초(30분 60번) — 토스 POS 요청 제한(60초 100번·30분 200번) 안. 실패하면 1→2→4…분, 최대 10분.
- 납부완료 처리 근거는 **토스 웹훅(서명) + Open API 재조회**뿐. 플러그인 보고는 참고용입니다.

## 근거 문서 (2026-11-07 확인)
- 튜토리얼 https://docs.tossplace.com/guide/pos-integration/plugin/develop/develop-tutorial.html
- 웹 워커 /guide/pos-integration/plugin/develop/package.html · 탭 /iframe-package.html · zip 구조 /umd.html
- 동작 방식 /guide/pos-integration/plugin/how-to-work.html · 배포 /guide/pos-integration/plugin/deploy.html
- SDK /reference/plugin-sdk/pos/ — draftOrder · payment · order · http · secureStore · setting · toast · alert · rateLimit · error
- 공식 템플릿 https://github.com/tossplace/toss-pos-plugin-template · npm `@tossplace/pos-plugin-sdk@0.0.31`
