package kr.stiz.driver;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Prepared real-WebView checks; run only in an explicitly owned isolated emulator. */
final class AttachmentWebViewChecks {
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void await(CountDownLatch latch) throws Exception { require(latch.await(8, TimeUnit.SECONDS), "Fixture callback timeout"); }
    private static Uri uri(String name) { return Uri.parse("content://kr.stiz.driver.test.synthetic/" + name); }
    private static String read(Instrumentation runner, AttachmentFixtureActivity activity) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        for (int retry = 0; retry < 60; retry++) {
            CountDownLatch done = new CountDownLatch(1);
            runner.runOnMainSync(() -> activity.web.evaluateJavascript("window.fixtureResult", result -> { value.set(result); done.countDown(); }));
            await(done);
            if (value.get() != null && !value.get().equals("\"\"")) return new JSONArray("[" + value.get() + "]").getString(0);
            Thread.sleep(100);
        }
        throw new AssertionError("FileReader did not read selected bytes");
    }
    private static void choose(Instrumentation runner, AttachmentFixtureActivity activity, String input) throws Exception {
        runner.runOnMainSync(() -> activity.choose(input)); await(activity.selected);
    }
    private static void deliver(Instrumentation runner, AttachmentFixtureActivity activity, Intent result) throws Exception {
        runner.runOnMainSync(() -> activity.result(activity.requestCode, Activity.RESULT_OK, result)); await(activity.delivered);
    }
    static int run(Instrumentation runner) throws Exception {
        require(BuildConfig.DEBUG && BuildConfig.STIZ_UNIFIED_APP && !BuildConfig.STIZ_NATIVE_AUTH, "Use the default unified, native-auth-disabled debug fixture APK");
        AttachmentFixtureActivity activity = (AttachmentFixtureActivity) runner.startActivitySync(new Intent(runner.getTargetContext(), AttachmentFixtureActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        int checks = 0;
        try {
            await(activity.ready);
            java.util.concurrent.atomic.AtomicBoolean restricted = new java.util.concurrent.atomic.AtomicBoolean();
            runner.runOnMainSync(() -> restricted.set(!activity.web.getSettings().getAllowFileAccess() && !activity.web.getSettings().getAllowContentAccess()));
            require(restricted.get(), "WebView local access changed"); checks++;
            choose(runner, activity, "single"); deliver(runner, activity, new Intent().setData(uri("one")));
            JSONArray first = new JSONArray(read(runner, activity));
            require(first.length() == 1 && first.getJSONObject(0).getString("type").equals("image/png") && first.getJSONObject(0).getJSONArray("bytes").getInt(0) == 137, "PNG FileList/FileReader failed"); checks++;
            choose(runner, activity, "multi");
            ClipData clip = ClipData.newRawUri("synthetic", uri("one")); clip.addItem(new ClipData.Item(uri("two")));
            Intent multiple = new Intent(); multiple.setClipData(clip);
            deliver(runner, activity, multiple);
            require(new JSONArray(read(runner, activity)).length() == 2, "Multiple FileList failed"); checks++;
            choose(runner, activity, "json"); deliver(runner, activity, new Intent().setData(uri("json")));
            JSONObject json = new JSONArray(read(runner, activity)).getJSONObject(0);
            require(json.getString("type").equals("application/json") && json.getJSONArray("bytes").getInt(0) == '{', "JSON FileReader failed"); checks++;
            choose(runner, activity, "single");
            int callbacks = activity.callbacks;
            runner.runOnMainSync(() -> activity.result(activity.requestCode, Activity.RESULT_CANCELED, null)); await(activity.delivered);
            require(activity.resultCount == -1 && activity.callbacks == callbacks + 1, "Cancel callback failed"); checks++;
            runner.runOnMainSync(() -> activity.result(activity.requestCode, Activity.RESULT_OK, new Intent().setData(uri("one"))));
            require(activity.callbacks == callbacks + 1, "Late duplicate result accepted"); checks++;
            choose(runner, activity, "single"); deliver(runner, activity, new Intent().setData(uri("badimage")));
            require(activity.resultCount == -1, "Invalid image accepted"); checks++;
            choose(runner, activity, "single"); deliver(runner, activity, new Intent().setData(uri("oversize")));
            require(activity.resultCount == -1, "Oversize metadata accepted"); checks++;
            choose(runner, activity, "single");
            runner.runOnMainSync(() -> activity.chooser.navigation(BuildConfig.STIZ_ORIGIN + "/login")); await(activity.delivered);
            require(activity.resultCount == -1, "Navigation did not cancel"); checks++;
            return checks;
        } finally { runner.runOnMainSync(activity::finish); }
    }
}
