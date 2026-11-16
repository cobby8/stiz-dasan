# STIZ 농구교실 안드로이드 앱 — 코드 줄이기(R8) 규칙 (2026-11-16, 1.0.4)
#
# 왜 켰나: Play 콘솔 경고 «DEX 코드 최적화 낮음·난독화 1%». release 빌드만 R8 이 쓰지 않는 코드를 지우고 이름을 짧게 바꾼다
#          (debug·기기 시험 빌드는 그대로 — 계측 검사 androidTest 는 debug 를 쓴다).
# 원칙: «이름으로 불리는 것»만 지킨다. 지킬 이유가 없는 것까지 넓게 -keep 하면 경고가 다시 난다.
#       규칙을 추가할 때는 «누가 이름으로 부르는지»를 주석에 적는다.
# 기본 규칙(proguard-android-optimize.txt)과 라이브러리(androidx.webkit·androidx.core·swiperefreshlayout·firebase-messaging)가
# 함께 실어 온 규칙(consumer rules)은 자동으로 합쳐진다. 이 파일은 «이 앱만의» 규칙이다.

# ── 1. 오류 기록(스택 추적)을 읽을 수 있게 ─────────────────────────────────────
# 줄 번호를 남기고, 원래 파일 이름은 «SourceFile» 한 낱말로 가린다.
# 바뀐 이름 ↔ 원래 이름 표(mapping.txt)는 app/build/outputs/mapping/release/ 에 생기고 AAB 안에도 들어가
# Play 콘솔이 비정상 종료 기록을 원래 이름으로 풀어 보여 준다. 스토어에 올린 버전의 mapping.txt 는 따로 보관할 것.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ── 2. 매니페스트가 «이름으로» 부르는 화면·서비스 ───────────────────────────────
# 안드로이드가 AndroidManifest.xml 에 적힌 클래스 이름으로 직접 만든다. 빌드 도구(aapt)가 같은 규칙을 자동으로 만들어 주지만,
# 이름이 바뀌면 앱이 아예 안 켜지므로(알림·위치 서비스 포함) 여기에도 못박아 둔다.
#   MainActivity             — 앱 첫 화면·앱 링크(https://www.stiz-dasan.kr/...)·알림을 눌렀을 때
#   NativeAuthReturnActivity — 간편로그인 복귀 주소(kr.co.upturnlabs.stizdasan://auth/return)
#   DriverLocationService    — 기사님 운행 위치 전송(화면 밖에서도 도는 서비스)
#   StizMessagingService     — 앱 알림(FCM) 받기. Firebase 가 com.google.firebase.MESSAGING_EVENT 로 이 이름을 찾는다
-keep public class kr.stiz.driver.MainActivity { public <init>(); }
-keep public class kr.stiz.driver.NativeAuthReturnActivity { public <init>(); }
-keep public class kr.stiz.driver.DriverLocationService { public <init>(); }
-keep public class kr.stiz.driver.StizMessagingService { public <init>(); }

# ── 3. 웹 화면이 «이름으로» 부르는 자바 메서드 ─────────────────────────────────
# 지금 이 앱에는 addJavascriptInterface·@JavascriptInterface 가 하나도 없다(2026-11-16 전수 확인).
# 웹과의 대화는 전부 WebViewCompat.addWebMessageListener(StizDriverGpsTransport·StizAppNavigationTransport·StizPushTransport)로 하고,
# 그 창구 이름은 «글자»라서 R8 이 바꾸지 않는다. 받는 쪽 코드는 androidx.webkit 이 실어 온 규칙이 지킨다.
# 아래는 나중에 누가 @JavascriptInterface 를 추가했을 때 메서드 이름이 바뀌어 조용히 안 되는 사고를 막는 안전장치다.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── 4. 따로 지키지 않는 것(이유) ───────────────────────────────────────────────
# - BuildConfig: 값(STIZ_ORIGIN·FCM_* 등)을 코드에서 직접 읽기만 한다(이름으로 찾는 리플렉션 없음) → 규칙 불필요.
# - 리플렉션(Class.forName·getMethod)·JNI(native)·Serializable/Parcelable: 앱 코드에 없다(2026-11-16 전수 확인).
# - 순수 규칙 클래스(AppNavigationPolicy·VoiceCapturePolicy 등)·SessionStore(JSON+KeyStore 저장): 이름에 기대지 않는다.
# - Firebase·androidx: 각 라이브러리가 실어 온 규칙이 처리한다.
# 앱 코드에 위 종류가 새로 생기면 이 파일에 규칙과 이유를 추가할 것.
