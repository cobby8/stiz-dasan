package kr.stiz.driver;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.view.View;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.util.Collections;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private WebView web;
    private boolean visible;
    private String pendingToken;
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { publish(intent.getStringExtra("detail")); }
    };
    static boolean trusted(Uri uri) {
        Uri expected = Uri.parse(BuildConfig.STIZ_ORIGIN);
        return uri != null && "https".equals(uri.getScheme()) && Uri.parse(BuildConfig.STIZ_ORIGIN).getHost().equals(uri.getHost())
            && (uri.getPort() == -1 ? 443 : uri.getPort()) == (expected.getPort() == -1 ? 443 : expected.getPort()) && uri.getUserInfo() == null
            && uri.getPath() != null && uri.getPath().matches("/driver/[A-Za-z0-9_-]+/?");
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView message = new TextView(this); message.setText("Android System WebView를 업데이트한 뒤 다시 열어 주세요."); setContentView(message); return;
        }
        web = new WebView(this); web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setGeolocationEnabled(false); // Only native service may obtain and send locations.
        web.getSettings().setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebViewCompat.addWebMessageListener(web, "StizDriverGpsTransport", Collections.singleton(BuildConfig.STIZ_ORIGIN),
            (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame || !"https".equals(origin.getScheme()) || !Uri.parse(BuildConfig.STIZ_ORIGIN).getHost().equals(origin.getHost()) || !trusted(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) return;
                try { handle(new JSONObject(message.getData())); } catch (Exception failure) { error("기사님 앱 요청 형식을 확인해 주세요."); }
            });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !trusted(request.getUrl());
                Uri uri = request.getUrl();
                if (trusted(uri)) return false;
                // Intent URIs are not interpreted: only known navigation/phone schemes leave this WebView.
                if ("tel".equals(uri.getScheme()) || "tmap".equals(uri.getScheme()) || ("https".equals(uri.getScheme()) && ("apis.openapi.sk.com".equals(uri.getHost()) || "map.naver.com".equals(uri.getHost())))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException failure) { error("연결할 전화·지도 앱을 설치해 주세요."); }
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && !trusted(request.getUrl())) return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
                return super.shouldInterceptRequest(view, request);
            }
            @Override public void onPageFinished(WebView view, String url) { snapshot(); }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
        });
        setContentView(web);
        web.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        androidx.core.content.ContextCompat.registerReceiver(this, receiver, new IntentFilter(DriverLocationService.EVENT), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
        Uri incoming = getIntent().getData();
        if (trusted(incoming)) web.loadUrl(incoming.toString());
        else worker.execute(() -> {
            try {
                String token = new SessionStore(this).read().optString("token");
                runOnUiThread(() -> { if (!token.isEmpty()) web.loadUrl(BuildConfig.STIZ_ORIGIN + "/driver/" + token); else showEntry(); });
            } catch (Exception failure) { runOnUiThread(this::showEntry); }
        });
    }
    private void showEntry() {
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 64, 32, 32);
        ImageView logo = new ImageView(this); logo.setImageResource(kr.stiz.driver.R.drawable.stiz_logo); logo.setAdjustViewBounds(true); layout.addView(logo, new LinearLayout.LayoutParams(240, 100));
        TextView title = new TextView(this); title.setText("STIZ 기사님\n관리자에게 받은 운행 링크를 입력해 주세요."); title.setTextSize(20); layout.addView(title);
        EditText input = new EditText(this); input.setHint("https://www.stiz-dasan.kr/driver/…"); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); layout.addView(input);
        Button button = new Button(this); button.setText("운행 화면 열기"); layout.addView(button);
        button.setOnClickListener(view -> { Uri uri = Uri.parse(input.getText().toString().trim()); if (trusted(uri)) { setContentView(web); web.loadUrl(uri.toString()); } else input.setError("공식 STIZ 운행 링크를 입력해 주세요."); });
        setContentView(layout);
    }
    private String pageToken() {
        Uri uri = Uri.parse(web == null || web.getUrl() == null ? "" : web.getUrl());
        return trusted(uri) ? uri.getPathSegments().get(1) : "";
    }
    private void handle(JSONObject request) throws Exception {
        String action = request.getString("action");
        if ("snapshot".equals(action)) { snapshot(); return; }
        if (!visible || !pageToken().equals(request.optString("token"))) { error("운행 화면에서 직접 다시 시도해 주세요."); return; }
        final String requestedToken = pageToken();
        worker.execute(() -> {
            try {
                JSONObject stored = new SessionStore(this).read();
                boolean other = !stored.optString("token", requestedToken).equals(requestedToken) && (!stored.optBoolean("stopped", true) || stored.optBoolean("stopPending"));
                runOnUiThread(() -> {
                    if (other) { error("다른 운행 링크의 위치 공유가 남아 있습니다. 기존 운행 링크로 돌아가 종료해 주세요."); return; }
                    if (visible && requestedToken.equals(pageToken())) executeAction(action);
                });
            } catch (Exception failure) { error("운행 저장소를 확인할 수 없습니다."); }
        });
    }
    private void executeAction(String action) {
        if ("stop".equals(action)) {
            startService(new Intent(this, DriverLocationService.class).setAction(DriverLocationService.STOP)); return;
        }
        if (!"start".equals(action)) return;
        pendingToken = pageToken();
        new AlertDialog.Builder(this).setTitle("운행 중 위치 공유")
            .setMessage("운행을 시작하면 화면 잠금·지도 앱 사용 중에도 위치가 관리자에게 공유됩니다. 알림의 운행 종료로 중단할 수 있습니다. 강제 종료·권한 해제·배터리 제한·통신 장애 시 중단될 수 있습니다.")
            .setPositiveButton("동의하고 시작", (dialog, which) -> requestPermissionsAndStart()).setNegativeButton("취소", (dialog, which) -> error("위치 공유 시작을 취소했습니다.")).show();
    }
    private void requestPermissionsAndStart() {
        if (!visible) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 10); return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 11); return;
        }
        launchRun();
    }
    private void launchRun() {
        if (!visible || pendingToken == null || !pendingToken.equals(pageToken())) { error("운행 화면에서 시작해 주세요."); return; }
        try { startForegroundService(new Intent(this, DriverLocationService.class).setAction(DriverLocationService.START).putExtra("token", pendingToken)); }
        catch (RuntimeException failure) { error("휴대폰 위치 권한과 위치 설정을 확인해 주세요."); }
        pendingToken = null;
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 10) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) requestPermissionsAndStart();
            else error("정확한 위치 권한이 필요합니다. 휴대폰 설정에서 허용해 주세요.");
        } else if (request == 11) {
            if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) launchRun();
            else error("화면 밖에서도 운행 종료를 할 수 있도록 알림 권한을 허용해 주세요.");
        }
    }
    private void snapshot() {
        if (DriverLocationService.instance != null) { DriverLocationService.instance.snapshot(); return; }
        final String token = pageToken();
        worker.execute(() -> {
            try {
                JSONObject value = new SessionStore(this).read();
                boolean pending = value.optBoolean("stopPending");
                boolean confirmed = value.optBoolean("serverStopConfirmed");
                if (pending && visible) runOnUiThread(() -> { if (visible) startService(new Intent(this, DriverLocationService.class).setAction(DriverLocationService.STOP)); });
                JSONObject detail = new JSONObject().put("token", value.optString("token", token)).put("state", "off")
                    .put("transmission", pending ? "stop-unknown" : confirmed ? "stopped" : value.has("sessionId") ? "error" : "idle").put("running", false)
                    .put("lastSentAt", value.opt("lastSentAt") == null ? JSONObject.NULL : value.opt("lastSentAt"))
                    .put("lastLocationAt", value.opt("lastLocationAt") == null ? JSONObject.NULL : value.opt("lastLocationAt"))
                    .put("accuracy", value.opt("accuracy") == null ? JSONObject.NULL : value.opt("accuracy"));
                if (value.has("sessionId") && !confirmed && !pending) detail.put("state", "error").put("error", "이전 위치 공유가 중단되었거나 인증이 종료되었습니다. 운행 화면에서 확인해 주세요.");
                publish(detail.toString());
            } catch (Exception failure) { error("안전한 운행 저장소를 읽을 수 없습니다. 관리자에게 문의해 주세요."); }
        });
    }
    private void error(String message) {
        runOnUiThread(() -> { try { publish(new JSONObject().put("token", pageToken()).put("state", "error").put("transmission", "error").put("running", DriverLocationService.instance != null && DriverLocationService.instance.isRunning()).put("error", message).toString()); } catch (Exception ignored) { } });
    }
    private void publish(String detail) {
        if (detail == null) return;
        runOnUiThread(() -> { if (web != null && trusted(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('stiz-driver-gps',{detail:" + detail + "}));", null); });
    }
    @Override protected void onResume() { super.onResume(); visible = true; if (web != null) { web.onResume(); snapshot(); } }
    @Override protected void onPause() { visible = false; if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (web != null && trusted(intent.getData())) web.loadUrl(intent.getData().toString()); }
    @Override protected void onDestroy() { if (web != null) { unregisterReceiver(receiver); web.destroy(); } worker.shutdownNow(); super.onDestroy(); }
}
