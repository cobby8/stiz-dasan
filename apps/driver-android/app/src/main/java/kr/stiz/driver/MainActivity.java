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
    private WebFileChooser fileChooser;
    private NativeAuthController nativeAuth;
    private boolean visible;
    private final PendingRunStart pendingStart = new PendingRunStart();
    private boolean consentDialogOpen;
    private boolean navigationDialogOpen, browserAuthDialogOpen, accountRunDialogOpen;
    private String pendingNavigation;
    private volatile boolean unfinishedRun;
    private volatile String activeRunToken = "";
    private boolean backRegistered;
    private Object backCallback;
    private String lastErrorDetail, lastErrorToken;
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String detail = intent.getStringExtra("detail");
            try {
                JSONObject value = new JSONObject(detail);
                String transmission = value.optString("transmission");
                if (value.optBoolean("running") || "stopping".equals(transmission) || "stop-unknown".equals(transmission)) {
                    unfinishedRun = true; activeRunToken = value.optString("token");
                }
                if ("stopped".equals(transmission) && !value.optBoolean("running") && value.optString("token").equals(activeRunToken)) {
                    unfinishedRun = false;
                    if (pendingNavigation != null) {
                        String target = pendingNavigation; pendingNavigation = null;
                        loadPageUnchecked(Uri.parse(target));
                    }
                }
                if (value.optString("token").equals(pendingStart.token()) && ("stopping".equals(transmission) || "stopped".equals(transmission) || "stop-unknown".equals(transmission))) pendingStart.cancel();
                if (value.optString("token").equals(pageToken())) {
                    String state = value.optString("state");
                    if ("error".equals(state) || "denied".equals(state)) { lastErrorDetail = detail; lastErrorToken = pageToken(); }
                    else if ("active".equals(state) || "requesting".equals(state) || "stopped".equals(transmission) || "stop-unknown".equals(transmission)) clearError();
                }
            } catch (Exception ignored) { }
            publish(detail);
        }
    };
    // GPS capability remains restricted to the exact driver page, even in the unified shell.
    static boolean trusted(Uri uri) {
        return uri != null && AppNavigationPolicy.isDriverPage(BuildConfig.STIZ_ORIGIN, uri.toString());
    }
    static boolean trustedAppPage(Uri uri) {
        return uri != null && AppNavigationPolicy.isAppPage(BuildConfig.STIZ_ORIGIN, uri.toString(), BuildConfig.STIZ_UNIFIED_APP);
    }
    private static boolean needsAccountRunHandoff(String url) {
        return !BuildConfig.STIZ_SANDBOX && AppNavigationPolicy.needsAccountRunHandoff(BuildConfig.STIZ_ORIGIN, url);
    }
    private static WebResourceResponse sandboxDenied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (BuildConfig.STIZ_SANDBOX && (!BuildConfig.DEBUG || !AppNavigationPolicy.sandboxOrigin(BuildConfig.STIZ_ORIGIN)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST))) {
            TextView message = new TextView(this); message.setText("격리시험 주소 또는 Android System WebView의 안전한 연결 기능을 확인해 주세요."); setContentView(message); return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView message = new TextView(this); message.setText("Android System WebView를 업데이트한 뒤 다시 열어 주세요."); setContentView(message); return;
        }
        if (BuildConfig.STIZ_UNIFIED_APP && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            TextView message = new TextView(this); message.setText("안전한 앱 화면 전환을 위해 Android System WebView를 업데이트한 뒤 다시 열어 주세요."); setContentView(message); return;
        }
        web = new WebView(this); web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        if (BuildConfig.STIZ_SANDBOX) {
            web.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
                androidx.webkit.ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new androidx.webkit.ServiceWorkerClientCompat() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        return AppNavigationPolicy.sandboxRequestAllowed(BuildConfig.STIZ_ORIGIN, request.getUrl().toString()) ? null : sandboxDenied();
                    }
                });
            }
        }
        fileChooser = new WebFileChooser(this, web);
        nativeAuth = new NativeAuthController(this, web);
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setGeolocationEnabled(false); // Only native service may obtain and send locations.
        web.getSettings().setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebViewCompat.addWebMessageListener(web, "StizDriverGpsTransport", Collections.singleton(BuildConfig.STIZ_ORIGIN),
            (view, message, origin, mainFrame, reply) -> {
                if (!AppNavigationPolicy.isTrustedBridge(BuildConfig.STIZ_ORIGIN, origin.toString(), view.getUrl() == null ? "" : view.getUrl(), mainFrame)) return;
                try { handle(new JSONObject(message.getData())); } catch (Exception failure) { error("기사님 앱 요청 형식을 확인해 주세요."); }
            });
        if (BuildConfig.STIZ_UNIFIED_APP && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // This separate observer can only report navigation. It cannot read location state or start/stop GPS.
            WebViewCompat.addWebMessageListener(web, "StizAppNavigationTransport", Collections.singleton(BuildConfig.STIZ_ORIGIN),
                (view, message, origin, mainFrame, reply) -> {
                    if (!mainFrame || !AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, origin.toString())) return;
                    if (message.getType() != androidx.webkit.WebMessageCompat.TYPE_STRING) return;
                    String path = message.getData();
                    if (path == null || path.length() > 2048 || !path.startsWith("/") || path.indexOf('?') >= 0 || path.indexOf('#') >= 0) return;
                    String target = BuildConfig.STIZ_ORIGIN + path;
                    if (trustedAppPage(Uri.parse(target))) runOnUiThread(() -> checkObservedNavigation(target));
                });
            WebViewCompat.addDocumentStartJavaScript(web,
                "(()=>{if(window.top!==window)return;const notify=()=>{try{window.StizAppNavigationTransport.postMessage(location.pathname)}catch(e){}};"
                + "for(const key of ['pushState','replaceState']){const original=history[key];history[key]=function(...args){const value=original.apply(this,args);notify();return value}}"
                + "addEventListener('popstate',notify);notify()})();", Collections.singleton(BuildConfig.STIZ_ORIGIN));
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!request.isForMainFrame()) return !AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, uri.toString());
                if (!unfinishedRun && nativeAuth.begin(uri, request.hasGesture())) return true;
                if (trustedAppPage(uri)) { navigateSafely(uri); return true; }
                // External navigation only follows an explicit phone/map action. Arbitrary intents are never parsed.
                if (!BuildConfig.STIZ_SANDBOX && AppNavigationPolicy.externalActionAllowed(uri.toString(), request.hasGesture())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (ActivityNotFoundException failure) { showAppMessage("연결할 전화·지도 앱을 설치해 주세요."); }
                } else showAppMessage("이 주소는 앱에서 열 수 없습니다. 본인인증·외부 로그인은 앱 연결 준비 후 사용할 수 있습니다.");
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (BuildConfig.STIZ_SANDBOX && !AppNavigationPolicy.sandboxRequestAllowed(BuildConfig.STIZ_ORIGIN, request.getUrl().toString())) return sandboxDenied();
                boolean nativeConsume = request.isForMainFrame() && nativeAuth.takeConsumePermission(request.getUrl(), request.getMethod());
                if (request.isForMainFrame() && (!trustedAppPage(request.getUrl())
                    || (!nativeConsume && AppNavigationPolicy.needsNativeAuthHandoff(BuildConfig.STIZ_ORIGIN, request.getUrl().toString()))
                    || needsAccountRunHandoff(request.getUrl().toString())
                    || !AppNavigationPolicy.mayNavigate(BuildConfig.STIZ_ORIGIN, request.getUrl().toString(), unfinishedRun, activeRunToken))) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                runOnUiThread(() -> checkObservedNavigation(url));
                super.doUpdateVisitedHistory(view, url, isReload);
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                fileChooser.documentStarted();
                nativeAuth.documentStarted(url);
                if (!trusted(Uri.parse(url)) || !pageToken().equals(pendingStart.token())) pendingStart.cancel();
            }
            @Override public void onPageFinished(WebView view, String url) { nativeAuth.documentFinished(url); checkObservedNavigation(url); if (trusted(Uri.parse(url))) snapshot(); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) nativeAuth.consumeFailed(request.getUrl());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) nativeAuth.consumeFailed(request.getUrl());
            }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); nativeAuth.consumeFailed(error.getUrl() == null ? null : Uri.parse(error.getUrl())); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return fileChooser.open(callback, params);
            }
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                showBrowserAuthPending(); return false;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        setContentView(web);
        if (Build.VERSION.SDK_INT >= 33) {
            android.window.OnBackInvokedCallback callback = this::handleBack;
            backCallback = callback;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            backRegistered = true;
        }
        web.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        androidx.core.content.ContextCompat.registerReceiver(this, receiver, new IntentFilter(DriverLocationService.EVENT), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
        Uri incoming = getIntent().getData();
        worker.execute(() -> {
            try {
                JSONObject savedRun = new SessionStore(this).read();
                activeRunToken = savedRun.optString("token");
                unfinishedRun = AppNavigationPolicy.unfinishedRun(savedRun.has("sessionId"), savedRun.optBoolean("stopped", true), savedRun.optBoolean("stopPending"));
                runOnUiThread(() -> {
                    if (trustedAppPage(incoming)) navigateSafely(incoming);
                    else if (!activeRunToken.isEmpty() && (unfinishedRun || !BuildConfig.STIZ_UNIFIED_APP)) loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + "/driver/" + activeRunToken));
                    else if (BuildConfig.STIZ_UNIFIED_APP) loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + "/store-app"));
                    else showEntry();
                });
            } catch (Exception failure) {
                runOnUiThread(() -> showAppMessage("운행 저장소를 확인하지 못했습니다. 앱을 다시 열어 주세요."));
            }
        });
    }
    private void loadPageUnchecked(Uri uri) {
        if (web == null || isFinishing() || isDestroyed()) return;
        if (!trustedAppPage(uri) || AppNavigationPolicy.needsNativeAuthHandoff(BuildConfig.STIZ_ORIGIN, uri.toString())) return;
        if (needsAccountRunHandoff(uri.toString())) { showAccountRunPending(); return; }
        pendingStart.cancel();
        setContentView(web);
        web.loadUrl(uri.toString());
    }
    private void navigateSafely(Uri uri) { navigateSafely(uri, false); }
    private void navigateSafely(Uri uri, boolean back) {
        if (web == null || isFinishing() || isDestroyed() || worker.isShutdown()) return;
        if (!trustedAppPage(uri)) return;
        if (needsAccountRunHandoff(uri.toString())) { showAccountRunPending(); return; }
        if (AppNavigationPolicy.needsNativeAuthHandoff(BuildConfig.STIZ_ORIGIN, uri.toString())) { showBrowserAuthPending(); return; }
        worker.execute(() -> {
            try {
                JSONObject savedRun = new SessionStore(this).read();
                boolean savedUnfinished = AppNavigationPolicy.unfinishedRun(savedRun.has("sessionId"), savedRun.optBoolean("stopped", true), savedRun.optBoolean("stopPending"));
                if (savedUnfinished) activeRunToken = savedRun.optString("token");
                unfinishedRun = savedUnfinished || DriverLocationService.instance != null;
                runOnUiThread(() -> {
                    if (AppNavigationPolicy.mayNavigate(BuildConfig.STIZ_ORIGIN, uri.toString(), unfinishedRun, activeRunToken)) {
                        if (back && web.canGoBack()) web.goBack(); else loadPageUnchecked(uri);
                    }
                    else confirmNavigation(uri);
                });
            } catch (Exception failure) { showAppMessage("운행 상태를 확인하지 못했습니다. 기존 화면에서 다시 확인해 주세요."); }
        });
    }
    private void checkObservedNavigation(String url) {
        if (fileChooser != null) fileChooser.navigation(url);
        if (nativeAuth != null) nativeAuth.navigation(url);
        if (web == null || isFinishing() || isDestroyed() || !trustedAppPage(Uri.parse(url))) return;
        if (needsAccountRunHandoff(url)) {
            web.stopLoading();
            if (unfinishedRun && !activeRunToken.isEmpty()) loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + "/driver/" + activeRunToken));
            else loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + "/staff/shuttle"));
            showAccountRunPending();
            return;
        }
        if (!AppNavigationPolicy.mayNavigate(BuildConfig.STIZ_ORIGIN, url, unfinishedRun, activeRunToken)) {
            web.stopLoading();
            if (!activeRunToken.isEmpty()) loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + "/driver/" + activeRunToken));
            confirmNavigation(Uri.parse(url));
        }
    }
    private void showAccountRunPending() {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || accountRunDialogOpen) return;
            accountRunDialogOpen = true;
            AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle("통합 앱 운행 연결 준비 중")
                .setMessage("로그인으로 여는 운행표에서는 아직 앱 위치 공유를 시작할 수 없습니다. 셔틀 조회는 이용할 수 있습니다. 기사님 전용 운행 링크 시험과는 별도 기능입니다.")
                .setPositiveButton("확인", null).setOnDismissListener(value -> accountRunDialogOpen = false);
            if (!unfinishedRun) dialog.setNeutralButton("기존 운행 링크 입력", (value, which) -> showEntry());
            dialog.show();
        });
    }
    private void confirmNavigation(Uri uri) {
        if (isFinishing() || isDestroyed() || !trustedAppPage(uri) || navigationDialogOpen) return;
        navigationDialogOpen = true;
        new AlertDialog.Builder(this).setTitle("운행 종료 후 화면 이동")
            .setMessage("운행이 진행 중이거나 서버 종료 확인이 남아 있습니다. 종료가 확인되면 선택한 화면으로 이동합니다.")
            .setPositiveButton("운행 종료 후 이동", (dialog, which) -> {
                pendingNavigation = uri.toString(); pendingStart.cancel();
                try { startService(new Intent(this, DriverLocationService.class).setAction(DriverLocationService.STOP)); }
                catch (RuntimeException failure) { pendingNavigation = null; showAppMessage("운행을 종료하지 못했습니다. 운행 화면에서 다시 확인해 주세요."); }
            }).setNegativeButton("운행 화면 유지", (dialog, which) -> { })
            .setOnDismissListener(dialog -> navigationDialogOpen = false).show();
    }
    private void showAppMessage(String message) {
        runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) new AlertDialog.Builder(this).setTitle("스티즈 농구교실").setMessage(message).setPositiveButton("확인", null).show(); });
    }
    private void showBrowserAuthPending() {
        if (BuildConfig.STIZ_SANDBOX) { showAppMessage("격리시험에서는 실제 로그인·본인인증을 연결하지 않습니다. 시험 역할 선택 화면을 이용해 주세요."); return; }
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || browserAuthDialogOpen) return;
            browserAuthDialogOpen = true;
            new AlertDialog.Builder(this).setTitle("앱 로그인 연결 준비 중")
                .setMessage("현재 앱에서는 이메일·비밀번호로 로그인할 수 있습니다. 간편로그인·외부 본인인증은 브라우저에서 사이트를 이용해 주세요. 브라우저의 로그인 상태가 이 앱으로 전달되지는 않습니다.")
                .setPositiveButton("확인", null)
                .setNeutralButton("브라우저에서 사이트 이용", (dialog, which) -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.STIZ_ORIGIN + "/login"))); }
                    catch (ActivityNotFoundException failure) { showAppMessage("사이트를 열 브라우저를 설치해 주세요."); }
                }).setOnDismissListener(dialog -> browserAuthDialogOpen = false).show();
        });
    }
    private void handleBack() {
        if (web == null || !web.canGoBack()) { moveTaskToBack(true); return; }
        WebBackForwardList history = web.copyBackForwardList();
        int previous = history.getCurrentIndex() - 1;
        if (previous >= 0) navigateSafely(Uri.parse(history.getItemAtIndex(previous).getUrl()), true);
    }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); }
    private void showEntry() {
        if (isFinishing() || isDestroyed()) return;
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 64, 32, 32);
        ImageView logo = new ImageView(this); logo.setImageResource(kr.stiz.driver.R.drawable.stiz_logo); logo.setAdjustViewBounds(true); layout.addView(logo, new LinearLayout.LayoutParams(240, 100));
        TextView title = new TextView(this); title.setText("STIZ 기사님\n관리자에게 받은 운행 링크를 입력해 주세요."); title.setTextSize(20); layout.addView(title);
        EditText input = new EditText(this); input.setHint("https://www.stiz-dasan.kr/driver/…"); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); layout.addView(input);
        Button button = new Button(this); button.setText("운행 화면 열기"); layout.addView(button);
        button.setOnClickListener(view -> { Uri uri = Uri.parse(input.getText().toString().trim()); if (trusted(uri)) { navigateSafely(uri); } else input.setError("공식 STIZ 운행 링크를 입력해 주세요."); });
        setContentView(layout);
    }
    private String pageToken() {
        Uri uri = Uri.parse(web == null || web.getUrl() == null ? "" : web.getUrl());
        return trusted(uri) ? AppNavigationPolicy.driverToken(BuildConfig.STIZ_ORIGIN, uri.toString()) : "";
    }
    private void handle(JSONObject request) throws Exception {
        if (BuildConfig.STIZ_SANDBOX) { error("격리시험에서는 실제 위치를 수집하거나 운행을 전송하지 않습니다."); return; }
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
            pendingStart.cancel();
            startService(new Intent(this, DriverLocationService.class).setAction(DriverLocationService.STOP)); return;
        }
        if (!"start".equals(action)) return;
        if (consentDialogOpen || pendingStart.token() != null) return;
        clearError();
        final String consentToken = pageToken();
        consentDialogOpen = true;
        new AlertDialog.Builder(this).setTitle("운행 중 위치 공유")
            .setMessage("운행을 시작하면 화면 잠금·지도 앱 사용 중에도 위치가 관리자에게 공유됩니다. 알림의 운행 종료로 중단할 수 있습니다. 강제 종료·권한 해제·배터리 제한·통신 장애 시 중단될 수 있습니다.")
            .setPositiveButton("동의하고 시작", (dialog, which) -> {
                if (pendingStart.consent(consentToken, SystemClock.elapsedRealtime())) requestPermissionsAndStart();
            }).setNegativeButton("취소", (dialog, which) -> { pendingStart.cancel(); error("위치 공유 시작을 취소했습니다."); })
            .setOnCancelListener(dialog -> { pendingStart.cancel(); error("위치 공유 시작을 취소했습니다."); })
            .setOnDismissListener(dialog -> consentDialogOpen = false).show();
    }
    private void requestPermissionsAndStart() {
        String token = pendingStart.token();
        PendingRunStart.Step step = pendingStart.next(pageToken(), visible, SystemClock.elapsedRealtime(),
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED,
            Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
        if (token != null && step == PendingRunStart.Step.NONE && pendingStart.token() == null) error("시작 동의가 만료되었거나 운행 화면이 바뀌었습니다. 운행 시작을 다시 눌러 주세요.");
        try {
            if (step == PendingRunStart.Step.LOCATION_PERMISSION) requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 10);
            else if (step == PendingRunStart.Step.NOTIFICATION_PERMISSION && Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 11);
            else if (step == PendingRunStart.Step.START) launchRun(token);
        } catch (RuntimeException failure) {
            pendingStart.cancel(); error("권한 요청을 시작하지 못했습니다. 운행 화면에서 다시 시도해 주세요.");
        }
    }
    private void launchRun(String token) {
        if (BuildConfig.STIZ_SANDBOX) { error("격리시험에서는 실제 위치 공유를 시작하지 않습니다."); return; }
        if (!visible || token == null || !token.equals(pageToken())) { error("운행 화면에서 시작해 주세요."); return; }
        unfinishedRun = true; activeRunToken = token;
        try { startForegroundService(new Intent(this, DriverLocationService.class).setAction(DriverLocationService.START).putExtra("token", token)); }
        catch (RuntimeException failure) { error("휴대폰 위치 권한과 위치 설정을 확인해 주세요."); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 10) {
            boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            pendingStart.permissionResult(granted);
            if (granted) requestPermissionsAndStart();
            else error("정확한 위치 권한이 필요합니다. 휴대폰 설정에서 허용해 주세요.");
        } else if (request == 11) {
            boolean granted = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            pendingStart.permissionResult(granted);
            if (granted) requestPermissionsAndStart();
            else error("화면 밖에서도 운행 종료를 할 수 있도록 알림 권한을 허용해 주세요.");
        }
    }
    private void snapshot() {
        if (BuildConfig.STIZ_SANDBOX) return;
        if (DriverLocationService.instance != null) { DriverLocationService.instance.snapshot(); return; }
        final String token = pageToken();
        if (lastErrorDetail != null && token.equals(lastErrorToken)) { publish(lastErrorDetail); return; }
        if (lastErrorDetail != null) clearError();
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
                publishSnapshot(detail.toString());
            } catch (Exception failure) { error("안전한 운행 저장소를 읽을 수 없습니다. 관리자에게 문의해 주세요."); }
        });
    }
    private void error(String message) {
        runOnUiThread(() -> { try {
            lastErrorToken = pageToken();
            lastErrorDetail = new JSONObject().put("token", lastErrorToken).put("state", "error").put("transmission", "error").put("running", DriverLocationService.instance != null && DriverLocationService.instance.isRunning()).put("error", message).toString();
            publish(lastErrorDetail);
        } catch (Exception ignored) { } });
    }
    private void clearError() { lastErrorDetail = null; lastErrorToken = null; }
    private void publishSnapshot(String detail) {
        runOnUiThread(() -> {
            if (DriverLocationService.instance != null) { DriverLocationService.instance.snapshot(); return; }
            if (lastErrorDetail != null && pageToken().equals(lastErrorToken)) publish(lastErrorDetail);
            else publish(detail);
        });
    }
    private void publish(String detail) {
        if (detail == null) return;
        runOnUiThread(() -> { if (web != null && trusted(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('stiz-driver-gps',{detail:" + detail + "}));", null); });
    }
    @Override protected void onResume() { super.onResume(); visible = true; if (web != null) { web.onResume(); snapshot(); requestPermissionsAndStart(); } }
    @Override protected void onPause() { visible = false; if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (fileChooser != null && fileChooser.result(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); if (fileChooser != null) fileChooser.cancel(); if (nativeAuth != null && nativeAuth.callback(intent.getData())) return; setIntent(intent); pendingStart.cancel(); clearError(); if (web != null && trustedAppPage(intent.getData())) navigateSafely(intent.getData());
        else if (web != null && unfinishedRun && !activeRunToken.isEmpty()) loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + "/driver/" + activeRunToken)); }
    @Override protected void onDestroy() { pendingStart.cancel(); if (fileChooser != null) fileChooser.destroy(); if (nativeAuth != null) nativeAuth.destroy(); if (Build.VERSION.SDK_INT >= 33 && backRegistered) getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback); if (web != null) { unregisterReceiver(receiver); web.destroy(); web = null; } worker.shutdownNow(); super.onDestroy(); }
}
