# STIZ 통합 앱 스토어 출시 준비

기준일: 2026-10-28 · 출시 주체: 업턴랩스 · **출시 준비 중, 제출·공개 미승인**

2026-10-25 사용자 결정은 **STIZ 앱 하나에서 역할별 화면으로 이동**하는 방식이다. Android는 학부모·선생님·관리자·기사님, iOS는 학부모·선생님·관리자를 대상으로 한다. 기사님 운행폰은 Android만 사용한다. 기존 웹·PWA 설치 경로는 유지한다.

이 문서는 현재 소스·검증 기록과 남은 조건을 구분한다. 10월 25일 개발자 계정 결제 완료 기록은 현재 조직·계약·게시 권한을 새로 확인한 결과가 아니다. 이번 문서 정정에서 운영 설정·실제 계정·비밀키는 조회하거나 변경하지 않았다.

## 1. 현재 구현과 산출물

| 구분 | 확인한 사실 | 출시 전 남은 조건 |
|---|---|---|
| Android | `apps/driver-android` WebView+위치 서비스 통합 기반. `/store-app` 진입, target/compile SDK 36, 최소 API 26 | 정식 패키지·업턴랩스 서명·스토어 소유 확인, 실제 설치·업데이트 |
| Android 산출물 | 기본 debug `kr.stiz.driver.unified`, 이번 격리 APK `kr.stiz.driver.sandbox`, 0.1.0(1). release는 `kr.stiz.driver` unsigned | debug 자동 서명은 정식 배포 서명이 아님. 최종 식별자·서명 확정 필요 |
| iOS | `apps/stiz-ios` UIKit/WKWebView, 개발용 `kr.stiz.academy.dev`, 최소 iOS 16, 0.1.0(1) | 정식 Bundle ID·Apple 팀·기기용 프로파일·서명 IPA |
| iOS 컴파일 | Codemagic #2의 `1954bfd8`에서 실제 Swift 38+13·Xcode arm64/x86_64 성공, simulator zip 233.80KB 표시 | 시뮬레이터 UI·파일 내부·아이폰 설치 미검증. 이 zip은 아이폰용 IPA가 아님 |
| 실행 차단 | 검증 브랜치 Vercel 자동 배포 차단, Codemagic 수동 실행, Apple 서명·업로드 단계 없음 | 추가 원격 빌드·설치·서명·운영 배포·TestFlight·제출은 각각 승인 필요 |

증거 정본: [앱 기반](native-app-foundation.md), [사진·인증 후속](native-app-media-auth-followup.md), [Codemagic](stiz-ios-codemagic.md). 실행할 시험과 차단 목록은 [실기기·출시 준비 원장](native-device-release-readiness.md)으로 관리한다. 과거 태블릿 잠금·T맵 각 약 3분 시험은 최신 통합 앱의 장시간 운행 성공 근거가 아니다.

현재는 TWA/Bubblewrap 또는 PWABuilder로 새 앱을 만드는 방식이 아니다. `public/manifest-app.json`은 기존 PWA 메타데이터로 네이티브 빌드 설정을 대신하지 않는다. 모든 웹 페이지에 연결하면 기존 PWA 설치 영역과 충돌할 수 있으므로 현재 미연결 규칙을 유지한다.

## 2. 수강료·셔틀비·실물 상품 결제

실제 학원에서 이용하는 수업·셔틀과 실물 유니폼은 앱 밖에서 소비되는 서비스·상품이다. Apple 3.1.3(e)와 Google의 실물 서비스 기준으로 외부 결제 방식 적용을 검토한다. **스토어 인앱결제를 사용하지 않는다는 것과 결제 수수료가 0원이라는 것은 다르다.** PG·카드·가맹 계약 비용은 별도다. [Apple 심사지침](https://developer.apple.com/app-store/review/guidelines/), [Google 결제 정책](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)

이전 문서의 ‘외부 브라우저 결제는 항상 금지’ 안내는 적용하지 않는다. 실제 상품과 결제 제공자가 지원하는 이동 방식으로 결제 앱·브라우저 왕복을 검증한다. 디지털 강의·유료 앱 기능을 새로 판매하면 해당 상품 정책을 별도로 검토한다.

- Toss 온라인 운영 키는 마지막 사용자 확인에서 미발급이었다. 이번 작업에서 메일·운영 환경으로 발급 여부를 새로 확인하지 않았다.
- 단말기·심사용 키 또는 Cafe24 설정으로 임의 대체하지 않는다.
- 납부 완료는 서버 승인 재조회로만 표시한다. 취소·망 단절·중복 탭·앱 종료/복귀를 시험한다.
- 청구서 생성과 보호자 전달은 별도 결과다. 실제 발행·발송·결제·환불은 대상·기간·금액·수신자 승인 후 실행한다.

## 3. 인증·가족 연결·계정 삭제

| 항목 | 현재 상태 | 남은 조건 |
|---|---|---|
| 소셜 로그인 | 웹은 실제 Supabase 제공자 설정으로 버튼·시작 경로 판정. 네이버만 기존 별도 설정 | 오래된 `NEXT_PUBLIC_APPLE_LOGIN_ENABLED` 절차는 사용하지 않음. 실제 공급자·앱 복귀 시험 |
| 앱 인증 인계 | 일회용 개발용 코드·취소·만료 처리 구현, 기본 비활성·운영 강제 차단 | 격리 HTTPS 환경·운영용 설계·복귀·세션 갱신·로그아웃 |
| STIZ 본인인증 | 마지막 사용자 확인에서 전용 이니시스 MID/apikey 미발급 | 전용 채널·고지·실기기 인증. BDR 공용 채널 임의 변경 금지 |
| 가족 연결 | 기존 부모 정확한 이름·연락처 일치 후 요청·승인 모델, 새 기능 마지막 운영 확인 비활성 | 실제 알림 전달·실패/재시도·미확인 표시 미연결. 요청 DB 생성만 전달 완료로 보지 않음 |
| 자녀 보호 | 미성년자는 부모 없는 학원 승인 우회 통로를 만들지 않음. 성인 본인 연결 별도 | 잘못된 가족·자녀 없음·다중 역할·권한 회수 실기기 검증 |
| 계정 삭제 | 공통 `/account/withdraw`, 기존 학부모 경로와 관리자 검토 화면 존재 | 자녀 없는 계정·전 역할 접근, 실제 인증 해제·잔여 세션 차단·보관 예외·처리 실패·관리자 권한 이관 |

계정 삭제 후보 URL은 `https://www.stiz-dasan.kr/account/withdraw`, 개인정보처리방침은 `https://www.stiz-dasan.kr/privacy`다. 제출 전 앱 밖에서 찾을 수 있는 삭제 요청 안내와 인증 후 처리 경로를 확인한다. 로그인 화면만 존재한다고 웹 삭제 요건 통과로 표시하지 않는다. [Google 계정 삭제](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-EN), [Apple 계정 삭제](https://developer.apple.com/support/offering-account-deletion-in-your-app/)

Apple 4.8 로그인 요건은 실제 로그인·서비스 유형과 예외로 판단한다. 모든 교육 앱에 Apple 로그인이 무조건 필수라고 단정하지 않는다. 실제 제공자 설정·Apple 준비는 별도 승인 작업에서 수행한다. [Apple 심사지침](https://developer.apple.com/app-store/review/guidelines/)

## 4. 개인정보 신고 준비 원장

아래는 신고 완료표가 아니다. 출시 버전의 실제 활성 기능·위탁 계약·보관 기간을 대조해 Play 데이터 보안과 App Privacy 답안을 확정한다.

| 데이터 | 확인된 코드 용도 | 추가 확인 |
|---|---|---|
| 이름·이메일·연락처·주소 | 계정·학생·가족 연결·셔틀 | 필수/선택·계정 연결·보관/삭제·아동 자료 접근 |
| 정확한 위치 | 기사 운행 공유·승하차 위치 선택 | 네이티브 서비스와 웹 위치 모두 포함. 수집 역할·시점·전달·보관 |
| 사진·동영상 | 수업 게시물·리포트·갤러리 | 학생 촬영 동의·공유 대상·삭제 |
| 음성 | 선생님 음성 입력→서버→Gemini | 실제 외부 음성 전송·고지·동의·보관. 네이티브 마이크 연결 미완성 |
| 구매·납부·청구 이력 | 수강료·셔틀비·납부 상태 | PG 카드 처리와 자체 이력 구분. 카드 원문 저장을 추정하지 않음 |
| 결석 사유·첨부 | 질병·부상 등 이월/보강 심사 | 건강 정보 포함 여부·최소 수집·열람·보관 |
| 알림 구독 | 기존 Web Push endpoint | 네이티브 FCM/APNs 토큰과 구분. 네이티브 푸시 미구현 |

| 외부 처리 대상 | 확인된 용도 | 확인할 범위 |
|---|---|---|
| Supabase | DB·Auth·Storage | 실제 저장·국외 처리·계약·접근 |
| SOLAPI | 문자·연락처·내용 | 위탁/공유 정의·실제 활성 발송 |
| Toss Payments | 온라인 결제 승인·조회 | 운영 준비·전송 항목·가맹 계약 |
| Google 일정/시트 | 일정·업무 자료 연동 | 앱 자료와 서버 동기화 구분 |
| Gemini | 직원 음성 변환·별도 선택 기능의 문장 처리 | 음성 전송도 포함, 기능별 활성·보관 |
| Meta | Instagram 게시물 연동 | 읽기/쓰기·학생 자료 외부 공개 |

제3자 전송을 전부 ‘공유 안 함’으로 신고하지 않는다. 처리 위탁 여부와 플랫폼 정의를 실제 계약으로 판단한다. 전송 중 암호화도 앱→서버→공급자·다운로드까지 확인하기 전 ‘전 구간 검증 완료’로 표시하지 않는다. [Apple 개인정보 상세](https://developer.apple.com/app-store/app-privacy-details/)

## 5. 네이티브·스토어 남은 작업

- **안전한 시험:** 후속 승인으로 [합성 HTTPS 환경](native-device-sandbox.md)과 Android 시험 APK를 준비했다. iOS는 Debug의 명시 사설 HTTPS 설정만 허용하고 신규 Swift 컴파일·기기 설치는 미검증이다. 실제 앱 인증 계약·설치·OS 신뢰는 별도 확인한다. 기본/Release 운영 주소는 유지한다.
- **기능 빈틈:** 마이크·다운로드·일부 새 창 지도 링크·원격 푸시·로그인 기반 `/staff/run` 네이티브 위치 연결은 추가 구현/검증 대상이다. 공개 `/driver/<token>` 위치 서비스만으로 통합 기사 기능 완료를 선언하지 않는다.
- **실기기:** 사진·카메라·복수 선택·HEIC·취소·파일·전화·지도·SHOP·결제 복귀·회전·키보드·확대·오프라인을 역할별 시험한다. 웹 통과를 네이티브 통과로 바꾸지 않는다.
- **앱 링크:** assetlinks 라우트는 설정 전 404다. 최종 패키지와 실제 설치에 사용된 서명 인증서 지문을 확인하며 업로드 키와 Play 서명 키를 무조건 모두 등록하지 않는다. iOS Associated Domains/AASA도 별도 준비한다. 개발 URL scheme은 검증 링크가 아니다.
- **서명·아이콘:** STIZ 전용 ID·팀·프로파일·아이콘 준비. 웹 로고/512 아이콘 존재는 상점 아이콘 완료가 아니다. iOS AppIcon·개인정보 명세 점검이 남았다. 필요한 API/SDK를 조사한 뒤 정확한 사유를 기록하며 임의 Privacy Manifest 사유를 만들지 않는다. [Apple 필수 사유 API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api?changes=_2_8&language=objc)
- **기사 위치:** 잠금·T맵 각 20분 이상, 전화·실외·절전·망 복구·종료 후 중단을 서버 시각과 대조한다. 현 manifest에 `ACCESS_BACKGROUND_LOCATION`이 없다는 이유만으로 고지·심사를 면제하지 않는다. [Google 위치 정책](https://support.google.com/googleplay/android-developer/answer/9799150?hl=en-en)
- **심사 접근:** 합성 계정·학생·청구로 주요 기능을 재현한다. 실제 고객 자료·암호·운행 링크는 Git·문서·캡처에 넣지 않는다. WebView라는 이유만으로 거절/승인을 단정하거나 한 앱으로 4.3 통과가 보장된다고 표시하지 않는다.

## 6. 제출 조건과 승인 경계

현재 Android target 36은 Google 2026년 API 수준 요구에 대응하는 코드 값이다. Apple은 2026-04-28부터 iOS 26 SDK 이상을 요구한다. #2 Xcode 26 계열 시뮬레이터 컴파일은 서명 기기 빌드·심사 완료가 아니다. 제출 때 다시 확인한다. [Google 대상 API](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en-mt), [Apple SDK 요구](https://developer.apple.com/news/?id=ueeok6yw)

Google 12명·14일 시험은 2023-11-13 이후 생성된 개인 계정 기준이다. 업턴랩스 실제 계정 유형을 확인하지 않고 면제로 확정하지 않는다. [Google 개인 계정 시험](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)

순서: **격리 시험 환경 → 승인된 설치 빌드 → 인증·가족·기사 → 청구·결제·알림 → 네 역할 실기기 → 심사 자료**. 설치·Apple 서명·새 원격 빌드·외부 시험 배포·운영 활성화·TestFlight·공개 제출은 각각 버전과 영향을 제시하고 승인받는다. 이 문서 정정은 그 실행 승인이 아니다.
