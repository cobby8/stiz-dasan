package kr.stiz.driver;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 앱 알림(FCM) 연결부(2026-11-14, e2). MainActivity 는 install()·onPermissionResult() 두 줄만 부른다.
 *
 * 흐름: 웹 화면(우리 사이트, 맨 위 화면)만 «StizPushTransport» 창구로 "state"/"request" 를 보낸다 →
 *       이 클래스가 휴대폰 알림 권한·FCM 토큰을 JSON 한 줄로 답한다 → 웹이 로그인 쿠키로 /api/push/native 에 등록한다.
 * 앱은 쿠키·로그인 정보를 따로 다루지 않는다(웹뷰가 이미 로그인돼 있다).
 *
 * Firebase 설정 파일(app/google-services.json)이 없이 빌드하면 BuildConfig.FCM_APP_ID 가 비어 있고,
 * 이때는 «supported:false» 로만 답한다 → 웹이 «알림은 문자·카카오톡으로 보내드려요» 안내를 보인다(빌드는 그대로 된다).
 */
final class NativePush {
    static final int PERMISSION_REQUEST = 12; // 10·11 은 기사님 운행(위치·알림) 권한이 쓴다
    static final String CHANNEL_ID = "stiz-notice";
    private static final String PREFS = "stiz-native-push";
    private static final String ASKED = "asked";

    private final Activity activity;
    // 권한 창 결과를 기다리는 웹 요청들(창이 닫히면 한꺼번에 답한다)
    private final List<JavaScriptReplyProxy> waiting = new ArrayList<>();

    private NativePush(Activity activity) { this.activity = activity; }

    /** 통합 앱(시험 앱 제외)에서만 웹 창구를 연다. 창구가 없으면 웹은 «옛 앱»으로 보고 아무것도 하지 않는다 */
    static NativePush install(Activity activity, WebView web) {
        if (!BuildConfig.STIZ_UNIFIED_APP || BuildConfig.STIZ_SANDBOX || web == null) return null;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return null;
        NativePush push = new NativePush(activity);
        ensureChannel(activity);
        WebViewCompat.addWebMessageListener(web, "StizPushTransport", Collections.singleton(BuildConfig.STIZ_ORIGIN),
            (view, message, origin, mainFrame, reply) -> {
                // 우리 사이트의 맨 위 화면만 — 광고·결제창 같은 안쪽 화면(iframe)은 답하지 않는다
                if (!mainFrame || !AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, origin.toString())) return;
                if (message.getType() != WebMessageCompat.TYPE_STRING) return;
                if ("request".equals(message.getData())) push.request(reply);
                else if ("state".equals(message.getData())) push.answer(reply);
            });
        return push;
    }

    /** Firebase 설정이 들어 있는 빌드인가 */
    static boolean supported() {
        return BuildConfig.STIZ_UNIFIED_APP && !BuildConfig.STIZ_SANDBOX && !BuildConfig.FCM_APP_ID.isEmpty();
    }

    /**
     * Firebase 를 설정 값(BuildConfig)으로 직접 켠다. google-services 플러그인을 쓰지 않아,
     * 설정 파일이 없을 때 빌드가 깨지지 않고 패키지 이름이 다른 개발 빌드도 그대로 만들어진다.
     */
    static boolean ensureApp(Context context) {
        if (!supported()) return false;
        try {
            if (!FirebaseApp.getApps(context).isEmpty()) return true;
            FirebaseApp.initializeApp(context, new FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APP_ID)
                .setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                .build());
            return true;
        } catch (RuntimeException failure) {
            return false;
        }
    }

    private String permission() {
        boolean granted = Build.VERSION.SDK_INT < 33
            || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        boolean canAskAgain = Build.VERSION.SDK_INT >= 33 && activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS);
        return NativePushPolicy.permission(Build.VERSION.SDK_INT, granted,
            NotificationManagerCompat.from(activity).areNotificationsEnabled(), prefs(activity).getBoolean(ASKED, false), canAskAgain);
    }

    /** 지금 상태로 답한다. 권한이 켜져 있으면 FCM 토큰을 받아 함께 보낸다 */
    private void answer(JavaScriptReplyProxy reply) {
        final String permission = permission();
        if (!"granted".equals(permission) || !ensureApp(activity)) {
            post(reply, NativePushPolicy.stateJson(supported(), permission, null));
            return;
        }
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task ->
                post(reply, NativePushPolicy.stateJson(true, permission, task.isSuccessful() ? task.getResult() : null)));
        } catch (RuntimeException failure) {
            post(reply, NativePushPolicy.stateJson(true, permission, null));
        }
    }

    /** 아직 안 물어봤으면 휴대폰 권한 창을 띄우고, 이미 정해졌으면 상태만 답한다 */
    private void request(JavaScriptReplyProxy reply) {
        if (!supported() || Build.VERSION.SDK_INT < 33 || !"default".equals(permission())) { answer(reply); return; }
        waiting.add(reply);
        if (waiting.size() > 1) return; // 이미 권한 창이 떠 있다
        prefs(activity).edit().putBoolean(ASKED, true).apply();
        activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
    }

    /** MainActivity.onRequestPermissionsResult 에서 부른다. 이 클래스의 요청이면 true */
    boolean onPermissionResult(int requestCode) {
        if (requestCode != PERMISSION_REQUEST) return false;
        List<JavaScriptReplyProxy> replies = new ArrayList<>(waiting);
        waiting.clear();
        for (JavaScriptReplyProxy reply : replies) answer(reply);
        return true;
    }

    private void post(JavaScriptReplyProxy reply, String json) {
        // 답은 화면 스레드에서만 보낼 수 있다
        activity.runOnUiThread(() -> {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
            try { reply.postMessage(json); } catch (RuntimeException ignored) { }
        });
    }

    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "학원 알림", NotificationManager.IMPORTANCE_HIGH));
        }
    }

    /**
     * 받은 알림을 휴대폰 알림줄에 띄운다. 누르면 MainActivity 가 그 주소(우리 사이트만)를 웹뷰로 연다 —
     * 문자·카카오톡 링크로 앱이 열릴 때와 같은 길(getIntent().getData() → trustedAppPage → navigateSafely).
     */
    static void show(Context context, String title, String body, String path) {
        if (Build.VERSION.SDK_INT >= 33
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(context);
        String url = NativePushPolicy.target(BuildConfig.STIZ_ORIGIN, path);
        int id = (int) (System.currentTimeMillis() & 0x7fffffff);
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(url), context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(id, notification);
    }
}
