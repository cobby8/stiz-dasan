package kr.stiz.driver;

import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import org.json.JSONObject;

/** Offline Android-runtime checks. Never calls the tracking API or obtains coordinates. */
public final class DriverSmokeInstrumentation extends Instrumentation {
    private int checks;
    private boolean mediaFixture;
    private boolean insetsFixture;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        mediaFixture = arguments != null && "true".equals(arguments.getString("mediaFixture"));
        insetsFixture = arguments != null && "true".equals(arguments.getString("insetsFixture"));
        start();
    }
    private void verify(boolean condition) { if (!condition) throw new AssertionError("check " + (checks + 1)); checks++; }
    @Override public void onStart() {
        Bundle result = new Bundle();
        final String[] preference = {null};
        Context isolated = new ContextWrapper(getTargetContext()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                preference[0] = name + ".instrumentation";
                return super.getSharedPreferences(preference[0], mode);
            }
        };
        try {
            if (insetsFixture) {
                verifyAppInsets();
                result.putString("stream", "PASS " + checks + " app system inset checks; no network/location calls");
                finish(-1, result);
                return;
            }
            if (mediaFixture) {
                int mediaChecks = AttachmentWebViewChecks.run(this);
                result.putString("stream", "PASS " + mediaChecks + " synthetic real-WebView attachment checks; no network/location/camera UI");
                finish(-1, result);
                return;
            }
            String origin = BuildConfig.STIZ_ORIGIN;
            verify(MainActivity.trusted(Uri.parse(origin + "/driver/test_token-123")));
            verify(MainActivity.trusted(Uri.parse(origin + "/driver/test/")));
            verify(!MainActivity.trusted(Uri.parse(origin.replace("https:", "http:") + "/driver/test")));
            verify(!MainActivity.trusted(Uri.parse("https://evil.invalid/driver/test")));
            verify(!MainActivity.trusted(Uri.parse("https://" + Uri.parse(origin).getHost() + ".evil.invalid/driver/test")));
            verify(!MainActivity.trusted(Uri.parse(origin + "/admin")));
            verify(!MainActivity.trusted(Uri.parse(origin + "/driver/test/nested")));
            verify(!MainActivity.trusted(Uri.parse("https://" + Uri.parse(origin).getHost() + ":444/driver/test")));
            verify(!MainActivity.trusted(Uri.parse("file:///driver/test")));
            verify(!MainActivity.trusted(Uri.parse(origin.replace("https://", "https://user@") + "/driver/test")));
            verify(MainActivity.trustedAppPage(Uri.parse(origin + "/store-app")) == BuildConfig.STIZ_UNIFIED_APP);
            verify(MainActivity.trustedAppPage(Uri.parse(origin + "/mypage")) == BuildConfig.STIZ_UNIFIED_APP);
            verify(!AppNavigationPolicy.isTrustedBridge(origin, origin, origin + "/mypage", true));
            verify(!AppNavigationPolicy.isTrustedBridge(origin, origin, origin + "/driver/test", false));
            SessionStore store = new SessionStore(isolated);
            String secret = "synthetic-test-secret-not-an-operational-credential";
            store.write(new JSONObject().put("secret", secret).put("sequence", 8).put("stopPending", true));
            JSONObject restored = store.read();
            verify(secret.equals(restored.getString("secret")));
            verify(restored.getInt("sequence") == 8 && restored.getBoolean("stopPending"));
            String sealed = getTargetContext().getSharedPreferences(preference[0], 0).getString("sealed", "");
            verify(!sealed.isEmpty() && !sealed.contains(secret) && !sealed.contains("stopPending"));
            result.putString("stream", "PASS " + checks + " Android-runtime origin/vault checks; no network/location calls");
            finish(-1, result);
        } catch (Throwable failure) {
            result.putString("stream", "FAIL " + failure.getClass().getSimpleName() + ": " + failure.getMessage()); finish(0, result);
        } finally {
            if (preference[0] != null) getTargetContext().getSharedPreferences(preference[0], 0).edit().clear().commit();
        }
    }

    private void verifyAppInsets() throws Exception {
        // 링크 입력으로 시작하는 별도 시험 APK만 사용해 운영 URL을 열지 않는다.
        if (!BuildConfig.DEBUG || BuildConfig.STIZ_UNIFIED_APP || android.os.Build.VERSION.SDK_INT < 30)
            throw new IllegalStateException("Requires non-unified debug build on Android 11+");
        MainActivity activity = (MainActivity) startActivitySync(new Intent(getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            FrameLayout host = activity.findViewById(android.R.id.content);
            FrameLayout root = (FrameLayout) host.getChildAt(0);
            // 앱이 저장소를 읽고 기본 링크 입력 화면을 표시할 때까지 기다린다.
            for (int attempt = 0; attempt < 40 && !Boolean.TRUE.equals(onMain(() ->
                root.getChildAt(0) instanceof LinearLayout && root.getPaddingTop() > 0)); attempt++) {
                Thread.sleep(100);
            }
            java.lang.reflect.Field webField = MainActivity.class.getDeclaredField("web");
            webField.setAccessible(true);
            java.lang.reflect.Method showContent = MainActivity.class.getDeclaredMethod("showContent", View.class);
            showContent.setAccessible(true);
            onMain(() -> {
                View entry = root.getChildAt(0);
                verify(entry instanceof LinearLayout);
                verify(root.getPaddingTop() > 0 && entry.getTop() == root.getPaddingTop());
                verify(entry.getBottom() <= root.getHeight() - root.getPaddingBottom());
                WebView web = (WebView) webField.get(activity);
                showContent.invoke(activity, web);
                verify(host.getChildAt(0) == root && root.getChildAt(0) == web);
                int edges = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
                int ime = WindowInsetsCompat.Type.ime();
                WindowInsetsCompat rotated = new WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, 24, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.of(40, 0, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 16, 20))
                    .setInsets(ime, Insets.of(0, 0, 0, 220)).build();
                WindowInsetsCompat forwarded = ViewCompat.dispatchApplyWindowInsets(root, rotated);
                verify(root.getPaddingLeft() == 40 && root.getPaddingTop() == 24);
                verify(root.getPaddingRight() == 16 && root.getPaddingBottom() == 20);
                verify(forwarded.getInsets(edges).equals(Insets.NONE));
                verify(forwarded.getInsets(ime).bottom == 220);
                TextView error = new TextView(activity);
                showContent.invoke(activity, error);
                verify(host.getChildAt(0) == root && root.getChildAt(0) == error);
                verify(root.getPaddingTop() == 24 && root.getPaddingRight() == 16);
                showContent.invoke(activity, entry);
                verify(host.getChildAt(0) == root && root.getChildAt(0) == entry);
                verify(root.getPaddingLeft() == 40 && root.getPaddingBottom() == 20);
                return null;
            });
        } finally {
            runOnMainSync(activity::finish);
        }
    }

    private <T> T onMain(java.util.concurrent.Callable<T> action) throws Exception {
        java.util.concurrent.FutureTask<T> task = new java.util.concurrent.FutureTask<>(action);
        runOnMainSync(task);
        return task.get();
    }
}
