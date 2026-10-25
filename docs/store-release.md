# 앱 스토어 출시 준비 (구글플레이 · 애플 앱스토어)

출시 주체: **업턴랩스** · 개발자 계정 결제 완료(2026-10-25 확인)
대상: **통합 앱 하나** — 로그인하면 역할(학부모·선생님·기사님, 여러 개 가능)에 따라 화면이 열린다
(원장 결정 2026-10-25). 웹으로 설치하는 기존 3개 PWA(`/mypage`·`/staff`·`/driver`)는 그대로 둔다.

> 이 문서는 **코드에서 확인한 사실**만 적는다. 확인하지 못한 항목은 「확인 필요」로 표시했다.
> 추측으로 채우면 데이터 보안 양식에서 허위 신고가 되고, 그건 앱 삭제 사유다.

---

## 1. 수수료 — 수강료는 0%

| 파는 것 | 수수료 | 근거 |
|---|---|---|
| 수강료·셔틀비(오프라인 수업) | **0%** | 애플 3.1.3(e) 「앱 밖에서 소비되는 실물 서비스는 인앱결제를 쓰지 말 것」 / 구글 「실물 서비스(헬스장 멤버십 등)」 제외 |
| 유니폼 등 실물 상품 | **0%** | 같은 조항 |
| 앱 전용 디지털 구독 | 15~30% | **현재 그런 상품 없음.** 만들면 수강료와 분리할 것 |

⚠️ 앱 안에서 「다른 결제수단을 쓰세요」로 **유도하지 말 것**(애플 3.1.3 anti-steering, 미국 외
스토어에 적용). 외부 브라우저로 내보내지 말고 앱 안에서 카드 결제창을 띄우는 방식이어야 한다.
제출 시 Notes for Review 에 「오프라인 농구 수업료, 3.1.3(e) 해당」을 적는다.

---

## 2. 구글플레이 데이터 보안 양식 — 코드 근거

### 수집하는 개인정보

| 항목 | 수집 | 어디서 | 용도 |
|---|---|---|---|
| 이름 | 예 | `User.name`, `Student.name` | 앱 기능(수강·출결 관리) |
| 이메일 | 예 | `User.email` | 계정 관리 |
| 전화번호 | 예 | `User.phone`, `Student.childPhone` | 앱 기능·연락 |
| 주소 | 예 | `Student.address`, 셔틀 승하차 주소 | 셔틀 배차 |
| **정확한 위치(GPS)** | **예** | `src/hooks/useGpsShare.ts` · `src/lib/shuttle/driverGpsController.ts` (`watchPosition`) | **기사님 앱의 실시간 운행 위치 공유** |
| 대략적 위치 | 예 | `LocationPickerModal` 의 「현재 위치」(`getCurrentPosition`) | 셔틀 승하차 지점 선택 |
| 사진·동영상 | 예 | 수업 사진 업로드(`/staff/quick-post`), 갤러리 | 수업 기록·공유 |
| 기기 식별자 | 예 | `PushSubscription.endpoint` | 푸시 알림 |

> 🚨 **정확한 위치를 빠뜨리지 말 것.** 기사님 앱이 `watchPosition` 으로 실시간 위치를
> 서버에 올린다(`/api/driver/location`). 양식에 신고하지 않으면 정책 위반이다.
> 「앱 기능」 용도, 「공유 안 함」, 「선택적」(기사님이 공유 버튼을 눌러야 시작)으로 신고한다.

### 제3자 전송 (코드에서 확인된 외부 호출)

| 대상 | 무엇이 나가나 | 비고 |
|---|---|---|
| SOLAPI (`api.solapi.com`) | 전화번호·문자 내용 | 문자 발송 위탁 |
| 토스페이먼츠 (`api.tosspayments.com`) | 결제 정보 | **현재 키 없어 미사용** |
| Google (`googleapis.com`, `calendar.google.com`, `docs.google.com`) | 일정·시트 데이터 | 연간일정·시간표 |
| Meta (`graph.instagram.com`, `graph.facebook.com`) | 갤러리 게시물 | 인스타 연동 |
| Gemini | 문의 문장 등 | 카카오 정책 답변(기본 꺼짐) |
| Supabase | 전체 데이터 | DB·스토리지·인증 |

> 「확인 필요」: 위 대상들이 구글 기준으로 **처리 위탁**인지 **공유**인지. 위탁이면 "공유 안 함"으로
> 신고할 수 있으나, 판단이 애매하면 보수적으로 신고하는 편이 안전하다.

### 보안·권리

- 전송 중 암호화: **예** (전 구간 HTTPS)
- 데이터 삭제 요청: **예** — `/mypage/withdraw`
- 계정 삭제 URL(양식 입력란): **`https://stiz-dasan.kr/mypage/withdraw`**
- 개인정보처리방침 URL: **`https://stiz-dasan.kr/privacy`**

---

## 3. TWA 앱 껍데기 (안드로이드)

### 먼저 할 일 — 서명키 지문

1. Play Console 에서 앱 생성 → **「Play 앱 서명」 사용**(권장). 그러면 업로드 키만 만들면 된다.
2. Play Console → 설정 → **앱 서명** 에서 지문 두 개를 확인한다.
   - 「앱 서명 키 인증서」 SHA-256
   - 「업로드 키 인증서」 SHA-256
3. **두 개를 모두** 아래 환경변수에 콤마로 넣는다. 하나만 넣으면 어느 한쪽 경로로 설치된 앱에서
   검증이 실패한다(가장 흔한 실수).

### 환경변수 (Vercel)

```
ANDROID_APP_PACKAGE_NAME=kr.co.upturnlabs.stizdasan        # 예시 — 실제 패키지명으로
ANDROID_APP_SHA256_FINGERPRINTS=AA:BB:...:FF,11:22:...:99   # 앱 서명 키, 업로드 키 둘 다
```

설정하면 `https://stiz-dasan.kr/.well-known/assetlinks.json` 이 자동으로 올바른 내용을 서빙한다
(`src/app/api/assetlinks/route.ts`). **설정 전에는 404** — 잘못된 지문이 배포되면 TWA 가
「검증 실패」로 주소표시줄을 띄우는데 원인을 찾기 매우 어렵기 때문에 일부러 그렇게 뒀다.

### 통합 앱 manifest — `https://stiz-dasan.kr/manifest-app.json`

```
bubblewrap init --manifest https://stiz-dasan.kr/manifest-app.json
```

| 항목 | 값 |
|---|---|
| Host | `stiz-dasan.kr` |
| Start URL | `/store-app` → 표식을 찍고 `/auth/continue`(역할 판별)로 넘긴다 |
| Scope | `/` (사이트 전체) |
| App name | 스티즈 농구교실 / 스티즈 |
| id | `/?app=stiz-store` — 기존 3개 PWA 와 겹치지 않는 고유 값 |
| 아이콘 | `icon-v2-512.png` + maskable |

**⚠️ 이 manifest 는 어느 화면에도 연결하지 않는다(의도적).**
2026-08 에 사이트 전체를 영역으로 잡은 공식 앱 하나가 **같은 기기의 다른 PWA 설치를 전부 막은** 사고가 있었다.
통합 앱도 영역이 사이트 전체라, 화면에 연결하면 브라우저가 이걸 설치 대상으로 제안하면서 같은 사고가 난다.
그래서 스토어 앱 도구(Bubblewrap·PWABuilder)가 **주소로 직접 읽게만** 하고, 웹 설치는 기존 3개 PWA 가 맡는다.
이 규칙은 `tests/store-app-manifest.test.mjs` 가 지킨다.

**스토어 앱 표식** — 스토어 앱은 사이트 전체가 앱 영역이라 기존 PWA 의 「영역 밖 링크 막기」가 필요 없다.
`/store-app` 이 `sessionStorage` 에 표식을 찍으면 `useInstalledApp` 이 영역 제한을 끈다.
localStorage 가 아닌 이유: 안드로이드 스토어 앱(TWA)은 휴대폰 크롬과 저장소를 공유해서, localStorage 에 두면
크롬·기존 설치 앱에서도 제한이 풀린다.

**iOS** — TWA 는 안드로이드 전용이다. 앱스토어용은 같은 manifest 로 PWABuilder 의 iOS 패키지(WKWebView)를
만들거나 Capacitor 로 감싼다. 시작 주소는 똑같이 `/store-app`.

---

## 4. 애플 앱스토어 — 실질적 장벽

수수료는 깨끗하지만 심사가 어렵다.

| 항목 | 상태 |
|---|---|
| **Apple 로그인** | 코드 완료, **스위치 OFF**. 아래 설정 후 켠다 |
| **지침 4.2 최소 기능** | ⚠️ **웹 래핑 앱은 거부되는 경우가 많다** — 가장 큰 위험 |
| 지침 4.3 스팸 | 비슷한 앱 여러 개 금지 → ✅ **통합 앱 하나**로 해결(2026-10-25) |
| 계정 삭제 | ✅ 완료(`/mypage/withdraw`) |

### Apple 로그인 켜는 절차

1. 애플 개발자 콘솔 → **Service ID** 생성(Sign in with Apple), 도메인 `stiz-dasan.kr` 및
   Return URL 등록(Supabase 콜백 주소)
2. **Sign in with Apple 용 Key(.p8)** 발급 → Team ID · Key ID 확보
3. Supabase → Authentication → Providers → **Apple** 에 Service ID·Team ID·Key ID·Key 입력
4. Vercel 환경변수 **`NEXT_PUBLIC_APPLE_LOGIN_ENABLED=true`** → 재배포
5. 버튼 디자인을 애플 가이드라인(공식 로고, 검정/흰색 스타일)에 맞춰 다듬기 — 현재는 임시

---

## 5. 남은 일 체크리스트

### 원장님(업턴랩스)이 하실 일
- [ ] Play Console 앱 생성 + Play 앱 서명 → **지문 2개 확보**
- [ ] 패키지명 확정
- [ ] 애플 Service ID·Key 발급 → Supabase Apple provider 설정
- [ ] 토스 가맹 심사 통과 → 라이브 키 수령
- [ ] 스토어 스크린샷 촬영(로그인이 필요해 AI가 찍을 수 없음)
- [x] ~~앱을 몇 개 올릴지 결정~~ → **통합 앱 하나**(2026-10-25 원장 결정)

### AI가 이어받을 일
- [ ] 지문·패키지명 → Vercel 환경변수 설정 후 `assetlinks.json` 동작 확인
- [ ] `NEXT_PUBLIC_APPLE_LOGIN_ENABLED=true` 설정 + Apple 버튼 디자인 정리
- [ ] 토스 라이브 키 환경변수 설정 + `release:preflight` 통과 확인
- [ ] 데이터 보안 양식 답변 최종 검토

### 이미 완료
- [x] 회원 탈퇴 기능(구글플레이 필수) — `/mypage/withdraw`, 원장 확인 화면 `/admin/withdrawals`
- [x] Apple 로그인 코드(스위치 OFF)
- [x] `assetlinks.json` 서빙 라우트(지문만 넣으면 작동)
- [x] PWA 품질 요건 — manifest 4종, Service Worker, maskable 아이콘, HTTPS
- [x] 개인정보처리방침 공개 페이지
- [x] **통합 앱** — 가입 시 역할 선택(여러 개), 직원 역할은 초대 링크 또는 원장 승인, 화면 전환, 기사님 로그인 운행표,
      통합 manifest(`/manifest-app.json`, 화면 미연결) + 스토어 앱 시작 주소(`/store-app`)

---

## 참고 — 사업자 계정 이점

업턴랩스가 **사업자 계정**이면 구글플레이의 「신규 개인 개발자는 테스터 12명·14일 비공개 테스트
필수」 규정이 **면제**된다. 출시가 훨씬 빠르다.
