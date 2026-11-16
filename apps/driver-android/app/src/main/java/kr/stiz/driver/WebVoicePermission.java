package kr.stiz.driver;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.widget.Toast;

/**
 * 웹 화면의 음성 입력(마이크) 요청 연결부(2026-11-16, 1.0.4). MainActivity 는 요청·취소·권한 결과·화면 바뀜·종료만 알려 준다.
 *
 * 흐름: 사용자가 웹의 «음성으로 기록» 버튼을 누른다 → 웹뷰가 onPermissionRequest 로 묻는다 →
 *       VoiceCapturePolicy 가 «우리 사이트가 마이크 하나만» 요청했는지 본다 →
 *       휴대폰 마이크 권한이 이미 있으면 바로 허용, 없으면 «그때» 휴대폰 권한 창을 띄운다(앱을 켤 때 미리 묻지 않는다).
 *
 * 지키는 것:
 *  - 기다리는 요청은 하나뿐이고, 허용·거부는 «정확히 한 번»만 답한다(답하기 전에 먼저 비운다).
 *  - 권한 창을 기다리는 사이 화면이 바뀌거나 앱 화면이 사라지면 거부로 끝낸다(늦은 허용·메모리 누수 방지).
 *  - 카메라(영상) 자원은 여기서 절대 허용하지 않는다 — 촬영은 지금처럼 휴대폰 카메라 앱(WebFileChooser)이 한다.
 */
final class WebVoicePermission {
    static final int PERMISSION_REQUEST = 13; // 10·11 = 기사님 운행(위치·알림), 12 = 앱 알림(NativePush)

    private final Activity activity;
    private final WebView web;
    private PermissionRequest pending; // 휴대폰 권한 창의 답을 기다리는 웹 요청
    private String pendingPage;        // 그 요청이 온 화면 주소
    private boolean destroyed;

    WebVoicePermission(Activity activity, WebView web) { this.activity = activity; this.web = web; }

    /** 이 빌드에서 음성 입력을 켜는가(통합 앱만 — 격리 시험 앱·기사님 전용 앱 제외) */
    static boolean enabled() { return VoiceCapturePolicy.enabled(BuildConfig.STIZ_UNIFIED_APP, BuildConfig.STIZ_SANDBOX); }

    /** WebChromeClient.onPermissionRequest 에서 부른다(화면 스레드) */
    void request(PermissionRequest request) {
        if (request == null) return;
        String page = destroyed || activity.isFinishing() || activity.isDestroyed() ? null : web.getUrl();
        Uri origin = request.getOrigin();
        boolean allowed = page != null && VoiceCapturePolicy.allowed(BuildConfig.STIZ_ORIGIN, origin == null ? null : origin.toString(),
            page, request.getResources(), BuildConfig.STIZ_UNIFIED_APP, BuildConfig.STIZ_SANDBOX);
        boolean granted = activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        VoiceCapturePolicy.Decision decision = VoiceCapturePolicy.decide(allowed, granted);
        if (decision == VoiceCapturePolicy.Decision.DENY) { deny(request); return; }
        if (decision == VoiceCapturePolicy.Decision.GRANT) { grant(request); return; }
        // 휴대폰 권한 창이 필요하다. 이미 창이 떠 있으면(앞선 요청이 기다리는 중) 앞선 요청은 거부로 끝내고 새 요청이 그 답을 받는다.
        boolean dialogOpen = pending != null;
        finish(false);
        pending = request; pendingPage = page;
        if (dialogOpen) return;
        try { activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, PERMISSION_REQUEST); }
        catch (RuntimeException failure) { finish(false); }
    }

    /** WebChromeClient.onPermissionRequestCanceled — 웹이 요청을 거둬 갔다. 답할 필요가 없으므로 잊기만 한다 */
    void canceled(PermissionRequest request) {
        if (request != null && request == pending) { pending = null; pendingPage = null; }
    }

    /** MainActivity.onRequestPermissionsResult 에서 부른다. 이 클래스의 요청 번호면 true */
    boolean onPermissionResult(int requestCode) {
        if (requestCode != PERMISSION_REQUEST) return false;
        if (pending == null) return true; // 그 사이 화면이 바뀌어 이미 거부로 끝났다
        // 결과 배열을 믿지 않고 지금 실제 권한 상태를 다시 본다(창이 중간에 끊기면 빈 결과가 온다)
        boolean granted = activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean samePage = !destroyed && !activity.isFinishing() && !activity.isDestroyed()
            && VoiceCapturePolicy.samePage(BuildConfig.STIZ_ORIGIN, pendingPage, web.getUrl());
        finish(granted && samePage);
        if (!granted && samePage) Toast.makeText(activity, "마이크 권한이 꺼져 있습니다. 휴대폰 설정 > 앱 > 권한에서 마이크를 허용해 주세요.", Toast.LENGTH_LONG).show();
        return true;
    }

    /** 화면 이동이 관찰될 때마다 — 요청이 온 화면을 떠났으면 거부로 끝낸다 */
    void navigation(String url) {
        if (pending != null && !VoiceCapturePolicy.samePage(BuildConfig.STIZ_ORIGIN, pendingPage, url)) finish(false);
    }
    /** 새 문서를 불러오기 시작하면(새로고침 포함) 앞 화면의 요청은 끝낸다 */
    void documentStarted() { finish(false); }
    void destroy() { destroyed = true; finish(false); }

    /** 기다리던 요청을 정확히 한 번만 끝낸다 — 답하기 전에 먼저 비워, 답하는 도중 다시 들어와도 두 번 답하지 않는다 */
    private void finish(boolean allow) {
        PermissionRequest request = pending;
        if (request == null) return;
        pending = null; pendingPage = null;
        if (allow) grant(request); else deny(request);
    }
    private static void grant(PermissionRequest request) {
        // 요청이 무엇이든 «마이크 하나만» 넘긴다
        try { request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); } catch (RuntimeException ignored) { }
    }
    private static void deny(PermissionRequest request) {
        try { request.deny(); } catch (RuntimeException ignored) { }
    }
}
