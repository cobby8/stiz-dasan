package kr.stiz.driver;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * FCM 알림 받기(2026-11-14, e2). 서버는 안드로이드에 «데이터만»(title·body·url·tag) 보낸다 —
 * 앱이 꺼져 있어도 이 서비스가 깨어나 직접 알림을 그린다(누르면 그 화면을 앱 안에서 연다).
 */
public final class StizMessagingService extends FirebaseMessagingService {
    @Override public void onCreate() {
        // 설정 플러그인 없이 직접 켜므로, 앱 화면이 없을 때(백그라운드 수신) 여기서 먼저 Firebase 를 켠다
        NativePush.ensureApp(this);
        super.onCreate();
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        if (!NativePush.supported()) return;
        Map<String, String> data = message.getData();
        String title = data.get("title");
        String body = data.get("body");
        if (title == null || title.isEmpty() || body == null) return;
        NativePush.show(this, title, body, data.get("url"));
    }

    @Override public void onNewToken(String token) {
        // 새 토큰은 다음에 웹 화면이 열릴 때 웹이 받아 서버에 등록한다(로그인 쿠키가 웹뷰에 있으므로).
    }
}
