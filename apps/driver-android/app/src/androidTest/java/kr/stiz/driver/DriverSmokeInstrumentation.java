package kr.stiz.driver;

import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import org.json.JSONObject;

/** Offline Android-runtime checks. Never calls the tracking API or obtains coordinates. */
public final class DriverSmokeInstrumentation extends Instrumentation {
    private int checks;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
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
            String origin = BuildConfig.STIZ_ORIGIN;
            verify(MainActivity.trusted(Uri.parse(origin + "/driver/test_token-123")));
            verify(MainActivity.trusted(Uri.parse(origin + "/driver/test/")));
            verify(!MainActivity.trusted(Uri.parse(origin.replace("https:", "http:") + "/driver/test")));
            verify(!MainActivity.trusted(Uri.parse("https://evil.invalid/driver/test")));
            verify(!MainActivity.trusted(Uri.parse(origin + ".evil.invalid/driver/test")));
            verify(!MainActivity.trusted(Uri.parse(origin + "/admin")));
            verify(!MainActivity.trusted(Uri.parse(origin + "/driver/test/nested")));
            verify(!MainActivity.trusted(Uri.parse(origin + ":444/driver/test")));
            verify(!MainActivity.trusted(Uri.parse("file:///driver/test")));
            verify(!MainActivity.trusted(Uri.parse(origin.replace("https://", "https://user@") + "/driver/test")));
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
}
