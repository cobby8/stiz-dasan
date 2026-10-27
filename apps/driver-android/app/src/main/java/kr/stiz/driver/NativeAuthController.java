package kr.stiz.driver;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONObject;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Disabled by default, and always disabled in release builds until verified App Links are configured. */
final class NativeAuthController {
    private final Activity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private Attempt pending;
    private AlertDialog dialog;
    private Runnable timeout;
    private boolean destroyed;
    private volatile long consumeUntil;
    private String consumePage;
    private Runnable consumeTimeout;
    private boolean consumeNavigationStarted;
    private static final class Attempt {
        final String verifier = random();
        final String state = random();
        final long started = SystemClock.elapsedRealtime();
        final String page;
        volatile String flow;
        Attempt(String page) { this.page = page; }
    }
    NativeAuthController(Activity activity, WebView web) { this.activity = activity; this.web = web; }
    static boolean enabled() { return BuildConfig.DEBUG && !BuildConfig.STIZ_SANDBOX && BuildConfig.STIZ_UNIFIED_APP && BuildConfig.STIZ_NATIVE_AUTH; }

    boolean begin(Uri uri, boolean userGesture) {
        if (!enabled() || destroyed || pending != null || consumePage != null || uri == null) return false;
        String provider = NativeAuthPolicy.provider(BuildConfig.STIZ_ORIGIN, uri.toString(), userGesture);
        String page = web.getUrl();
        if (provider == null || page == null || !MainActivity.trustedAppPage(Uri.parse(page))) return false;
        Attempt attempt = new Attempt(page);
        pending = attempt;
        dialog = new AlertDialog.Builder(activity).setTitle("간편로그인")
            .setMessage("브라우저에서 인증을 마치면 앱으로 돌아옵니다. 다른 계정으로 바꾸려면 먼저 로그아웃해 주세요.")
            .setNegativeButton("취소", (value, which) -> cancel())
            .setOnCancelListener(value -> cancel()).create();
        dialog.show();
        timeout = () -> { if (pending == attempt) { cancel(); message("로그인 시간이 만료되었습니다. 다시 시도해 주세요."); } };
        main.postDelayed(timeout, NativeAuthPolicy.LIFETIME_MS);
        network.execute(() -> {
            try {
                String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(attempt.verifier.getBytes(StandardCharsets.US_ASCII)));
                JSONObject response = post("/auth/native/start", new JSONObject().put("provider", provider).put("platform", "android")
                    .put("codeChallenge", challenge).put("state", attempt.state));
                String flow = response.getString("flowId");
                String browser = response.getString("browserUrl");
                if (!NativeAuthPolicy.token(flow) || !NativeAuthPolicy.browserUrl(BuildConfig.STIZ_ORIGIN, browser, flow)) throw new java.io.IOException("Invalid start response");
                attempt.flow = flow;
                main.post(() -> {
                    if (pending != attempt || destroyed || !attempt.page.equals(web.getUrl())) { abort(attempt); return; }
                    try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(browser)).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (RuntimeException failure) { cancel(); message("로그인에 사용할 브라우저를 열지 못했습니다."); }
                });
            } catch (Exception failure) {
                main.post(() -> { if (pending == attempt) { cancel(); message("앱 로그인을 시작하지 못했습니다. 이메일·비밀번호로 로그인하거나 잠시 뒤 다시 시도해 주세요."); } });
            }
        });
        return true;
    }

    boolean callback(Uri uri) {
        if (uri == null || !NativeAuthPolicy.isCallback(uri.toString())) return false;
        Attempt attempt = pending;
        if (!enabled() || attempt == null || attempt.flow == null || destroyed) { message("진행 중인 앱 로그인이 없습니다. 다시 시작해 주세요."); return true; }
        String code = NativeAuthPolicy.returnCode(uri.toString(), attempt.flow, attempt.state, SystemClock.elapsedRealtime() - attempt.started);
        if (code == null || !attempt.page.equals(web.getUrl())) { cancel(); message("로그인 요청을 확인하지 못했습니다. 다시 시작해 주세요."); return true; }
        pending = null;
        stopTimer();
        dismiss();
        String body = form("flowId", attempt.flow) + "&" + form("code", code) + "&" + form("codeVerifier", attempt.verifier) + "&" + form("state", attempt.state);
        // This native POST lets the server set the WebView session; no browser cookies or JWTs are copied.
        consumeUntil = SystemClock.elapsedRealtime() + 15000;
        consumePage = attempt.page;
        consumeNavigationStarted = false;
        consumeTimeout = () -> { if (consumePage != null) consumeFailed(Uri.parse(BuildConfig.STIZ_ORIGIN + "/auth/native/consume")); };
        main.postDelayed(consumeTimeout, 30000);
        web.postUrl(BuildConfig.STIZ_ORIGIN + "/auth/native/consume", body.getBytes(StandardCharsets.UTF_8));
        return true;
    }
    synchronized boolean takeConsumePermission(Uri uri, String method) {
        if (!enabled() || destroyed || !"POST".equals(method) || uri == null
            || !uri.toString().equals(BuildConfig.STIZ_ORIGIN + "/auth/native/consume")
            || consumeUntil <= SystemClock.elapsedRealtime()) return false;
        consumeUntil = 0;
        return true;
    }
    void navigation(String url) { if (pending != null && !pending.page.equals(url)) cancel(); }
    void documentStarted(String url) {
        if (pending != null) cancel();
        if (consumePage != null && AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, url)) consumeNavigationStarted = true;
    }
    void documentFinished(String url) {
        if (consumePage == null) return;
        if ((BuildConfig.STIZ_ORIGIN + "/auth/native/consume").equals(url)) consumeFailed(Uri.parse(url));
        else if (consumeNavigationStarted && AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, url)) clearConsume();
    }
    void consumeFailed(Uri uri) {
        if (consumePage == null || uri == null || !uri.toString().equals(BuildConfig.STIZ_ORIGIN + "/auth/native/consume")) return;
        String fallback = consumePage;
        clearConsume();
        if (destroyed || activity.isFinishing() || activity.isDestroyed()) return;
        web.stopLoading();
        // Failed native exchange must not leave the user on a JSON error response.
        web.loadUrl(MainActivity.trustedAppPage(Uri.parse(fallback)) ? fallback : BuildConfig.STIZ_ORIGIN + "/login");
        message("앱 로그인을 완료하지 못했습니다. 기존 로그인 화면에서 다시 시도해 주세요.");
    }
    private void clearConsume() {
        consumeUntil = 0; consumePage = null; consumeNavigationStarted = false;
        if (consumeTimeout != null) { main.removeCallbacks(consumeTimeout); consumeTimeout = null; }
    }
    void cancel() { Attempt attempt = pending; pending = null; stopTimer(); dismiss(); if (attempt != null) abort(attempt); }
    void destroy() { destroyed = true; clearConsume(); cancel(); main.removeCallbacksAndMessages(null); network.shutdown(); }
    private void abort(Attempt attempt) {
        if (attempt.flow == null || network.isShutdown()) return;
        network.execute(() -> { try { post("/auth/native/cancel", new JSONObject().put("flowId", attempt.flow).put("state", attempt.state).put("codeVerifier", attempt.verifier)); } catch (Exception ignored) { } });
    }
    private void dismiss() { if (dialog != null) { dialog.dismiss(); dialog = null; } }
    private void stopTimer() { if (timeout != null) { main.removeCallbacks(timeout); timeout = null; } }
    private void message(String value) { if (!destroyed && !activity.isFinishing() && !activity.isDestroyed()) Toast.makeText(activity, value, Toast.LENGTH_LONG).show(); }
    private static String random() { byte[] value = new byte[32]; new SecureRandom().nextBytes(value); return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    private static String form(String key, String value) { try { return key + "=" + URLEncoder.encode(value, StandardCharsets.UTF_8.name()); } catch (Exception failure) { throw new IllegalArgumentException("Invalid form"); } }
    private static JSONObject post(String path, JSONObject payload) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BuildConfig.STIZ_ORIGIN + path).openConnection();
        try {
            connection.setRequestMethod("POST"); connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000); connection.setReadTimeout(12000); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Origin", BuildConfig.STIZ_ORIGIN);
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new java.io.IOException("Authentication unavailable");
            try (java.io.InputStream input = connection.getInputStream(); java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[2048]; int count;
                while ((count = input.read(buffer)) != -1) { if (output.size() + count > 8192) throw new java.io.IOException("Response too large"); output.write(buffer, 0, count); }
                return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { connection.disconnect(); }
    }
}
