# 스토어 앱 알림(FCM) — 구조와 켜는 법

2026-11-14 (e2·d2). 스토어 앱(안드로이드 `kr.co.upturnlabs.stizdasan` · 아이폰 같은 번들 ID) 안에서도 휴대폰 알림을 받게 한다.
설정 파일·키가 없으면 **빌드·발송은 그대로 되고 앱 알림만 꺼진다**(웹에는 «중요한 안내는 문자·카카오톡으로 보내드려요»).

## 1. 기존 웹푸시 구조(바꾸지 않음)

| 무엇 | 어디 |
|---|---|
| 구독 저장 표 | `PushSubscription`(endpoint·p256dh·auth, 기기 하나에 한 줄) — `/api/push` POST/DELETE, 로그인에 직접 연결된 계정만 |
| 발송 함수 | `src/lib/pushNotification.ts` 의 `sendPushToUser`(한 사람) · `sendPushToAllParents`(학부모 전원 공지). **모든 발송이 이 두 함수를 지난다** |
| 종류별 받기 | `isPushAllowed`·`optedOutUserIds`(출결·청구·공지·셔틀) — 두 함수 안에서 거른다 |
| 대기열 | `NotificationDelivery`(channel PUSH, 중복방지 키 `…:push`) → `processPushOutbox`(cron `/api/cron/push-outbox` · 운영 알림 `operational-notification-delivery` · 직원 알림 `staff-notifications`). 결석 알림(`absence-parent-notice*`)도 여기로 보낸다. 부분 실패는 `failedSubscriptionIds` 로 실패한 기기만 다시 보낸다 |
| 바로 발송 | `createNotificationRecord`(종 목록 + 푸시) · `notifyAllParents`(전체 공지) · 관리자 상담 상태 안내 |

## 2. 앱 알림이 더해진 곳

- 표 `NativePushToken`(userId·platform·token unique·lastSeenAt, RLS ENABLE+FORCE·anon/authenticated 권한 없음) — `prisma/migrations/20261114000001_native_push_token`.
- 발송: 두 발송 함수가 웹푸시 구독에 **더해** 그 사람의 앱 토큰에도 FCM HTTP v1 으로 보낸다(`src/lib/push/fcm.ts`, 외부 라이브러리 없이 서비스 계정 JWT 서명).
  - 끈 종류는 웹·앱 모두 안 보낸다(같은 스위치).
  - 같은 사람이 PC 브라우저 + 휴대폰 앱이면 **둘 다 받는다** — 예전에도 기기마다 하나씩 보냈다(같은 규칙). 같은 알림을 두 번 만들지 않는 건 대기열 중복방지 키(1건 = 발송 함수 1회)가 맡는다. 앱 웹뷰는 브라우저 웹푸시를 못 받으므로 한 휴대폰에서 앱·웹뷰가 겹치지 않는다(단, 같은 휴대폰에 옛 홈 화면 앱(PWA)까지 켜 두었으면 두 번 울릴 수 있다).
  - 재시도: 실패한 앱 토큰은 `native:<id>` 로 `failedSubscriptionIds` 에 담겨 그 토큰만 다시 보낸다.
  - 죽은 토큰(UNREGISTERED·«registration token» INVALID_ARGUMENT)만 지운다. SENDER_ID_MISMATCH(서버 키가 다른 프로젝트 것 = 설정 실수)·본문 없는 404·429·5xx·인증 오류는 지우지 않는다.
  - 구글 인증 토큰 발급은 진행 중 요청 하나를 같이 기다리고(동시 발송에도 1회), FCM·인증 요청은 각각 10초 제한. 기기 발송은 동시 20개씩. 제목 200바이트·본문 2,000바이트(한글 안 깨지게)로 자른다.
  - 전체 공지(`notifyAllParents`)의 푸시는 `after()` 로 응답 뒤에 보낸다(서버 함수가 중간에 멈추지 않게).
  - `FCM_SERVICE_ACCOUNT_JSON` 이 없으면 앱 토큰을 조회하지도 않는다(웹푸시만). 둘 다 없으면 예전과 같은 `NOT_CONFIGURED`.
- 등록: 앱이 웹 화면에 «알림 창구»(안드로이드 `StizPushTransport` · 아이폰 `stizPush`)를 연다 → 웹(`NativePushRegistrar`, 루트 레이아웃)이 상태를 묻고 → 권한이 켜져 있으면 **웹뷰의 로그인 쿠키로** `POST /api/push/native {platform, token}`. 주인은 로그인 계정(본문 userId 무시). 같은 토큰이 다시 오면 지금 로그인한 사람으로 옮긴다. 한 사람 최근 10개까지.
  - 로그인한 사람에게만, 서버 발송 키가 있을 때만(`GET /api/push/native` → `configured`), 기기당 한 번 자동으로 권한을 묻는다. 거절하면 설정 화면에 «휴대폰 설정에서 알림을 켜 주세요».
  - 서버 키가 없거나(`configured=false`) 아이폰인데 허용 후에도 토큰이 없으면(푸시 권한 서명 미연결) 화면은 «중요한 안내는 문자·카카오톡으로 보내드려요».
  - «방금 보냄» 기록(6시간)은 «토큰 + 로그인한 사람» 짝 — 다른 계정으로 로그인하면 바로 다시 등록되어 토큰 주인이 새 계정으로 옮겨진다. 로그인 화면(/login·/staff/login)에 들어오거나 세션이 없으면 기록을 지운다.
  - 안드로이드 창구는 요청에 번호를 붙여(`state#7` → 답 `"id":7`) 짝짓고, 시간 초과된 요청은 버린다.
- 로그아웃: 등록 때 남긴 httpOnly 쿠키 `stiz_np`(줄 id)로 **이 기기 토큰만** 지운다(`logout`·`logoutStaff`, 지금 로그인한 사람을 알면 그 사람 줄일 때만). 탈퇴: 그 사람 토큰 전부(표가 없으면 건너뜀).
- 알림 누르기: 서버는 우리 사이트 «경로»만 보낸다(`safeNativePushPath`). 앱이 기존 주소 정책으로 한 번 더 거른다 — 안드로이드 `NativePushPolicy.target`(→ `AppNavigationPolicy.sameOrigin`) → MainActivity 의 기존 링크 열기 길, 아이폰 `NavigationPolicy.pushTarget`(→ `decide == .website`) → `openUniversalLink`. 로그인·운행 위치·바깥 주소는 열지 않는다.
- 앱 형태: 안드로이드 = «데이터만» 보내 앱(`StizMessagingService`)이 알림을 그린다(채널 «학원 알림»). 아이폰 = APNs 알림(제목·본문·소리)을 붙여 아이폰이 띄운다.

## 3. 설정 파일·키 두는 곳

| 무엇 | 어디에 | 저장소 |
|---|---|---|
| 서비스 계정 JSON(서버 발송 키) | Vercel 환경변수 **`FCM_SERVICE_ACCOUNT_JSON`**(JSON 원문 그대로 또는 base64) · Production | 넣지 않음 |
| `google-services.json`(안드로이드) | 안드로이드 빌드하는 PC 의 `apps/driver-android/app/google-services.json` | `.gitignore` |
| `GoogleService-Info.plist`(아이폰) | 빌드 직전 `apps/stiz-ios/STIZ/Firebase/GoogleService-Info.plist`(폴더 참조로 앱에 복사) | `.gitignore` |
| APNs 인증 키(.p8) | Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → Apple 앱 구성 | 넣지 않음 |

- 안드로이드: google-services 플러그인을 쓰지 않고 `app/build.gradle` 이 파일을 직접 읽어 BuildConfig 에 넣는다. 파일이 없거나 그 빌드의 패키지 이름이 파일에 없으면 그 빌드만 알림이 꺼진다(스토어 release = `kr.co.upturnlabs.stizdasan`, 개발 debug = `kr.stiz.driver.unified`). 시험(sandbox)·기기검증 빌드는 항상 꺼짐.
- 아이폰: Firebase SDK(SPM `firebase-ios-sdk` 11.x · FirebaseMessaging)를 쓴다. `Package.resolved` 는 Windows 에서 만들 수 없어 아직 없다 — **Codemagic 첫 빌드 후 생성된 `STIZ.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` 를 커밋**해 버전을 고정한다. `aps-environment` 는 `STIZ.entitlements` 에 준비만 했고 서명에는 아직 연결하지 않았다(유니버설 링크와 같이 — `docs/store-release.md` 7-1).

## 4. 아이폰 설정 파일 주입(Codemagic) — 원장 승인 후

스토어 작업(`stiz-ios-app-store`)은 지문(`APPROVED_STORE_WORKFLOW`)으로 잠겨 있어, 아래를 넣을 때 지문도 함께 바꿔야 한다.

> **2026-11-13 1.0.2 반영 완료** — 2·3·4번(그룹·주입 단계·지문·Release 권한 파일 연결)은 코드에 들어갔다. 주입 단계는 값이 없거나 번들 ID 가 다르면 빌드를 멈춘다(알림 꺼진 앱이 올라가지 않게). 1번(Codemagic 그룹 값)은 원장님이 넣는다.

1. Codemagic 팀 설정 → 환경변수 그룹 `stiz_firebase` 에 `GOOGLE_SERVICE_INFO_PLIST_B64`(plist 를 base64 로, Secure) 저장.
2. `stiz-ios-app-store` 의 `environment.groups` 에 `stiz_firebase`, 「배포 서명 프로파일 적용」 앞에 한 단계:
   ```yaml
   - name: 앱 알림 설정 파일 넣기
     script: |
       set -euo pipefail
       echo "$GOOGLE_SERVICE_INFO_PLIST_B64" | base64 --decode > apps/stiz-ios/STIZ/Firebase/GoogleService-Info.plist
   ```
3. `apps/stiz-ios/tools/native_signed_sandbox.py` 의 `APPROVED_STORE_WORKFLOW` 지문을 새 값으로 바꾸고 `validate-project.py` 통과 확인.
4. Release 에 `CODE_SIGN_ENTITLEMENTS = STIZ/STIZ.entitlements;` 연결(애플 포털에서 Push Notifications·Associated Domains 를 켠 프로파일을 받은 뒤 — 7-1).

## 5. 원장이 할 외부 작업(순서대로)

> ⚠️ **순서: 서버 키(7번)를 먼저 넣고 → 설정 파일이 든 앱을 출시**한다. 반대로 하면 앱이 «알림 켜기»를 물어 허용받고도 알림이 안 간다
> (지금은 서버 키가 없으면 앱이 권한을 묻지 않고 «문자·카카오톡» 안내만 보이지만, 키 → 앱 순서가 가장 안전하다).

1. **Firebase 콘솔**(console.firebase.google.com, 업턴랩스 계정) → 프로젝트 만들기(예: «STIZ 농구교실»). 애널리틱스는 꺼도 된다.
2. 프로젝트 → 앱 추가 → **Android**: 패키지 이름 `kr.co.upturnlabs.stizdasan` → `google-services.json` 내려받기.
   (개발용 알림도 시험하려면 Android 앱을 하나 더: `kr.stiz.driver.unified` — 같은 json 에 함께 들어간다)
3. 프로젝트 → 앱 추가 → **iOS**: 번들 ID `kr.co.upturnlabs.stizdasan` → `GoogleService-Info.plist` 내려받기.
4. **Apple Developer**(developer.apple.com) → Certificates, IDs & Profiles → Keys → «+» → **Apple Push Notifications service (APNs)** 체크 → 키 만들기 → `.p8` 내려받기(한 번만 받을 수 있음) + Key ID·Team ID 메모.
5. Firebase 콘솔 → 프로젝트 설정 → **클라우드 메시징** → Apple 앱 구성 → APNs 인증 키에 `.p8`·Key ID·Team ID 올리기.
6. Apple Developer → Identifiers → `kr.co.upturnlabs.stizdasan` → **Push Notifications** 켜기(유니버설 링크용 Associated Domains 도 같이) → App Store 배포 프로파일 다시 발급.
7. Firebase 콘솔 → 프로젝트 설정 → **서비스 계정** → «새 비공개 키 생성» → JSON 내려받기 → **Vercel → Settings → Environment Variables → `FCM_SERVICE_ACCOUNT_JSON`**(Production)에 JSON 내용 그대로 붙여넣기 → 재배포.
8. `google-services.json`·`GoogleService-Info.plist` 두 파일을 개발 담당(PM)에게 전달 — 안드로이드는 빌드 PC 의 `apps/driver-android/app/`, 아이폰은 Codemagic 환경변수(4절). 채팅·git 에 올리지 말고 파일로 직접 전달.
9. 새 버전 빌드(안드로이드 versionCode·iOS 빌드 번호 올림) → 실기기에서 로그인 → 권한 허용 → 관리자 화면에서 공지·출결 알림 → 알림 누르면 그 화면이 열리는지 확인.

## 6. 검증

- 서버·웹: `tests/native-push.test.mjs`(토큰 등록 본인만·발송 대상·무효 토큰 정리·FCM 키 없음·주소 정책·로그아웃/탈퇴 정리).
- 안드로이드: `tests/NativePushPolicyTest.java`(javac 로 `NativePushPolicy`·`AppNavigationPolicy` 와 함께 실행), `./gradlew.bat :app:assembleDebug :app:assembleRelease :app:lintDebug`(설정 파일 없이 통과 확인).
- 아이폰: `tools/NavigationPolicyTests.swift`(pushTarget 17개 — Codemagic 의 swiftc 단계), `tools/validate-project.py`. **실제 Xcode 빌드·실기기 알림은 Codemagic·기기에서만 확인 가능**(이 PC 는 Windows).
