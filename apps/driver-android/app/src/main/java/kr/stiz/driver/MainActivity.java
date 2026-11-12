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
    // 토스 결제창에 들어간 뒤 우리 사이트(결제 완료·실패 화면)로 돌아올 때까지만 켜진다.
    private volatile boolean paymentActive;
    private boolean backRegistered;
    private Object backCallback;
    private String lastErrorDetail, lastErrorToken;
    // 웹뷰를 감싸는 화면 틀: 바깥 틀(안전 영역·키보드 여백) → 당겨서 새로고침 → 웹뷰.
    private FrameLayout webRoot;
    private androidx.swiperefreshlayout.widget.SwipeRefreshLayout refresher;
    // 마지막으로 정상 표시된 우리 사이트 주소. 오류 화면의 «다시 시도»가 여기로 돌아온다.
    private String lastAppUrl;
    // 웹 화면 «문서 전체»가 맨 위에서 더 당겨진(넘침) 마지막 시각. 이때만 당겨서 새로고침을 허용한다.
    private volatile long topOverscrollAt;
    private boolean touchStarting;
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
        web = new WebView(this) {
            // 문서 전체가 맨 위에서 더 당겨질 때만 기록한다. 모달 안 목록·지도처럼 안쪽에서 스크롤·끌기가 처리되면
            // 여기로 오지 않으므로, 그런 화면에서 아래로 끌어도 새로고침이 끼어들지 않는다(크롬의 당겨서 새로고침과 같은 기준).
            @Override protected void onOverScrolled(int scrollX, int scrollY, boolean clampedX, boolean clampedY) {
                if (clampedY && scrollY <= 0) topOverscrollAt = SystemClock.uptimeMillis();
                super.onOverScrolled(scrollX, scrollY, clampedX, clampedY);
            }
        };
        // 자동완성 허용(2026-11-13 원장 승인): 로그인 아이디·비밀번호를 휴대폰(구글 비밀번호 관리자 등)에 저장·채울 수 있게 한다.
        // 예전에는 꺼 두어(NO_EXCLUDE_DESCENDANTS) 매번 비밀번호를 직접 입력해야 했다.
        web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_AUTO);
        // 화면 틀 만들기. 웹뷰는 한 부모에만 붙을 수 있으므로 이후 화면 전환은 web 이 아니라 webRoot 로 한다.
        refresher = new androidx.swiperefreshlayout.widget.SwipeRefreshLayout(this) {
            // 손가락을 처음 댈 때(DOWN)는 «문서가 맨 위인지»만 보고 시작점을 기록하게 한다(여기서 거절하면 그 손동작 내내 새로고침이 안 된다).
            @Override public boolean onInterceptTouchEvent(android.view.MotionEvent event) {
                if (event.getActionMasked() != android.view.MotionEvent.ACTION_DOWN) return super.onInterceptTouchEvent(event);
                touchStarting = true;
                try { return super.onInterceptTouchEvent(event); } finally { touchStarting = false; }
            }
        };
        refresher.addView(web, new android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        refresher.setOnRefreshListener(this::pullToRefresh);
        // «아직 위로 스크롤할 수 있다»고 답하면 새로고침이 시작되지 않는다. 문서가 맨 위이고 방금 위로 넘쳐 당겨졌을 때만 false.
        refresher.setOnChildScrollUpCallback((parent, child) -> web.getScrollY() > 0
            || (!touchStarting && SystemClock.uptimeMillis() - topOverscrollAt > 300));
        webRoot = new FrameLayout(this);
        webRoot.addView(refresher, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
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
        // 앱 버전 표시: 기존 브라우저 식별 문자열 끝에 « STIZApp/버전 (android)» 를 덧붙인다(기존 문자열은 그대로 둔다).
        web.getSettings().setUserAgentString(web.getSettings().getUserAgentString() + " STIZApp/" + BuildConfig.VERSION_NAME + " (android)");
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
                String url = uri.toString();
                // 결제 중 카드사·간편결제 앱 호출은 본문·iframe 어디서 와도 바깥 앱으로 넘긴다.
                if (paymentActive && paymentAllowed() && AppNavigationPolicy.isPaymentAppScheme(url)) { openPaymentApp(uri); return true; }
                if (!request.isForMainFrame()) {
                    boolean paymentFrame = paymentAllowed() && (AppNavigationPolicy.isExternalFlowStart(url)
                        || (paymentActive && AppNavigationPolicy.paymentPageAllowed(url)));
                    return !(AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, url) || paymentFrame);
                }
                if (!unfinishedRun && nativeAuth.begin(uri, request.hasGesture())) return true;
                if (trustedAppPage(uri)) { paymentActive = false; navigateSafely(uri); return true; }
                // 토스 결제창·본인인증 화면은 웹이 스스로 화면을 넘기므로(사용자 탭이 아님) 탭 여부와 관계없이 연다.
                if (paymentAllowed() && AppNavigationPolicy.isExternalFlowStart(url)) { paymentActive = true; return false; }
                if (paymentActive && paymentAllowed() && AppNavigationPolicy.paymentPageAllowed(url)) return false;
                // 그 밖의 바깥 이동은 사용자가 직접 누른 것만 앱 밖으로 넘긴다(자동 이동은 막는다).
                if (!BuildConfig.STIZ_SANDBOX && AppNavigationPolicy.externalActionAllowed(url, request.hasGesture())) {
                    // 전화·문자·지도 앱. 지도 앱 호출은 크롬처럼 BROWSABLE 로 표시해, 웹 링크로 열려도 되는 화면만 열리게 한다.
                    Intent action = new Intent(Intent.ACTION_VIEW, uri);
                    if (!"tel".equals(uri.getScheme()) && !"sms".equals(uri.getScheme())) action.addCategory(Intent.CATEGORY_BROWSABLE);
                    try { startActivity(action); }
                    catch (ActivityNotFoundException failure) { showAppMessage("연결할 전화·문자·지도 앱을 설치해 주세요."); }
                } else if (unfinishedRun && AppNavigationPolicy.isExternalFlowStart(url)) {
                    showAppMessage("운행 중에는 결제·본인인증 화면을 열 수 없습니다. 운행을 마친 뒤 다시 시도해 주세요.");
                } else if (!BuildConfig.STIZ_SANDBOX && AppNavigationPolicy.openInBrowserAllowed(BuildConfig.STIZ_ORIGIN, url, request.hasGesture())) {
                    // 바깥 사이트·Supabase 공개 파일은 휴대폰 브라우저로 연다(예전엔 «열 수 없습니다»로 막혔다).
                    openInBrowser(uri);
                } else showAppMessage("이 주소는 앱에서 열 수 없습니다.");
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (BuildConfig.STIZ_SANDBOX && !AppNavigationPolicy.sandboxRequestAllowed(BuildConfig.STIZ_ORIGIN, request.getUrl().toString())) return sandboxDenied();
                if (request.isForMainFrame()) {
                    String target = request.getUrl().toString();
                    // 우리 사이트로 돌아오면 결제 중 상태를 끝낸다. 결제창·카드사 화면은 결제 중에만 통과시킨다.
                    if (trustedAppPage(request.getUrl())) paymentActive = false;
                    else if (paymentAllowed() && AppNavigationPolicy.isExternalFlowStart(target)) { paymentActive = true; return super.shouldInterceptRequest(view, request); }
                    else if (paymentActive && paymentAllowed() && AppNavigationPolicy.paymentPageAllowed(target)) return super.shouldInterceptRequest(view, request);
                }
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
            @Override public void onPageFinished(WebView view, String url) {
                nativeAuth.documentFinished(url); checkObservedNavigation(url); if (trusted(Uri.parse(url))) snapshot();
                if (refresher != null) refresher.setRefreshing(false);
                if (url != null && trustedAppPage(Uri.parse(url))) lastAppUrl = url;
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) nativeAuth.consumeFailed(request.getUrl());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) nativeAuth.consumeFailed(request.getUrl());
                // 토스·본인인증 화면을 불러오지 못하면 «진행 중» 상태를 풀어 우리 사이트를 다시 잠근다.
                if (request.isForMainFrame() && AppNavigationPolicy.isExternalFlowStart(request.getUrl().toString())) paymentActive = false;
                // 본문 화면이 인터넷 문제로 안 열리면, 주소가 드러나는 크롬 기본 오류 화면 대신 앱 안내 화면을 보인다.
                if (request.isForMainFrame() && isConnectionError(error.getErrorCode())) showLoadError(request.getUrl().toString());
            }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); nativeAuth.consumeFailed(error.getUrl() == null ? null : Uri.parse(error.getUrl())); }
        });
        // 파일 받기: 우리 사이트(로그인 필요한 엑셀·PDF 등)와 Supabase 공개 파일만 휴대폰 «다운로드» 기능으로 받는다.
        // 예전엔 받기 처리기가 없어 파일 링크를 눌러도 아무 반응이 없었다. 저장 권한은 새로 요청하지 않는다.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> startDownload(url, userAgent, contentDisposition, mimeType));
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return fileChooser.open(callback, params);
            }
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                showBrowserAuthPending(); return false;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        setContentView(webRoot);
        if (Build.VERSION.SDK_INT >= 33) {
            android.window.OnBackInvokedCallback callback = this::handleBack;
            backCallback = callback;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            backRegistered = true;
        }
        // 안전 영역 여백: 상태표시줄·내비게이션바·노치 + 키보드(IME). targetSdk 36 은 화면 끝까지 그려지므로(edge-to-edge)
        // 키보드 높이를 직접 빼 주지 않으면 아래쪽 입력칸·버튼이 키보드에 가려진다. 여백은 바깥 틀에 주고 안쪽으로는 넘기지 않는다.
        webRoot.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return android.view.WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
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
                    else if (BuildConfig.STIZ_UNIFIED_APP) loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + AppNavigationPolicy.ENTRY_PATH));
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
        setContentView(webRoot);
        web.loadUrl(uri.toString());
    }
    // 결제는 통합 앱의 운영 화면에서, 운행 중이 아닐 때만 연다(시험 앱·기사님 전용 앱 제외).
    private boolean paymentAllowed() { return !BuildConfig.STIZ_SANDBOX && BuildConfig.STIZ_UNIFIED_APP && !unfinishedRun; }
    // 카드사·간편결제 앱 열기. intent:// 는 크롬과 같은 방식으로 정리해 바깥 앱 화면만 연다.
    private void openPaymentApp(Uri uri) {
        Intent intent;
        try {
            if ("intent".equalsIgnoreCase(uri.getScheme())) {
                intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                intent.setComponent(null);
                intent.setSelector(null);
                // 안쪽 대상이 우리 앱 자신이거나 웹·파일 주소면 열지 않는다(결제 앱만 연다).
                String inner = intent.getScheme() == null ? "" : intent.getScheme().toLowerCase(java.util.Locale.ROOT);
                if (getPackageName().equals(intent.getPackage()) || !AppNavigationPolicy.isPaymentAppScheme(inner + ":")
                    && !inner.isEmpty()) { showAppMessage("이 결제 앱 주소는 열 수 없습니다. 다른 결제수단을 골라 주세요."); return; }
                intent.setFlags(intent.getFlags() & ~(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION));
            } else intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
        } catch (Exception failure) { showAppMessage("결제 앱 주소를 열지 못했습니다. 다른 결제수단을 골라 주세요."); return; }
        try { startActivity(intent); }
        catch (ActivityNotFoundException missing) {
            String pkg = intent.getPackage();
            if (pkg != null && pkg.matches("[A-Za-z0-9_.]+")) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg))); return; }
                catch (ActivityNotFoundException storeMissing) { /* 아래 안내로 넘어간다 */ }
            }
            showAppMessage("결제 앱이 설치되어 있지 않습니다. 설치한 뒤 다시 시도하거나 다른 결제수단을 골라 주세요.");
        } catch (Exception failure) { showAppMessage("결제 앱을 열지 못했습니다. 다른 결제수단을 골라 주세요."); }
    }
    private void navigateSafely(Uri uri) { navigateSafely(uri, 0); }
    private void navigateSafely(Uri uri, boolean back) { navigateSafely(uri, back ? -1 : 0); }
    // historySteps < 0 이면 새로 열지 않고 방문 기록 안에서 그만큼 뒤로 이동한다(운행 중 확인 mayNavigate 는 똑같이 거친다).
    private void navigateSafely(Uri uri, int historySteps) {
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
                        if (historySteps < 0 && web.canGoBackOrForward(historySteps)) web.goBackOrForward(historySteps); else loadPageUnchecked(uri);
                    }
                    else confirmNavigation(uri);
                });
            } catch (Exception failure) { showAppMessage("운행 상태를 확인하지 못했습니다. 기존 화면에서 다시 확인해 주세요."); }
        });
    }
    private void checkObservedNavigation(String url) {
        if (fileChooser != null) fileChooser.navigation(url);
        if (nativeAuth != null) nativeAuth.navigation(url);
        // 실제로 보이는 주소가 우리 사이트면(토스 이동 실패·취소 포함) 결제 중 상태를 끝낸다.
        if (url != null && trustedAppPage(Uri.parse(url))) paymentActive = false;
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
        runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) new AlertDialog.Builder(this).setTitle("STIZ 농구교실").setMessage(message).setPositiveButton("확인", null).show(); });
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
        if (web == null) { moveTaskToBack(true); return; }
        // 오류 안내 화면(웹뷰 틀이 화면에서 빠진 상태)에서 뒤로 → 마지막 우리 사이트 화면을 다시 연다.
        if (webRoot.getParent() == null && lastAppUrl != null) { retryAfterError(); return; }
        WebBackForwardList history = web.copyBackForwardList();
        int current = history.getCurrentIndex();
        String[] urls = new String[history.getSize()];
        for (int index = 0; index < urls.length; index++) urls[index] = history.getItemAtIndex(index).getUrl();
        // 가장 가까운 앞쪽 우리 사이트 화면까지 몇 칸인지. 결제·본인인증의 바깥 화면은 건너뛴다.
        // 새로 열지(loadUrl) 않고 기록 안에서 이동해야 «완료 → 뒤로 → 결제 화면 → 뒤로 → 완료…» 왕복 고리가 생기지 않는다.
        int steps = AppNavigationPolicy.backSteps(BuildConfig.STIZ_ORIGIN, urls, current, BuildConfig.STIZ_UNIFIED_APP);
        if (steps < 0) {
            if (steps < -1) paymentActive = false;
            navigateSafely(Uri.parse(urls[current + steps]), steps);
            return;
        }
        // 앞쪽에 우리 화면이 없는데 지금이 바깥 화면이면 앱 첫 화면으로.
        String now = web.getUrl();
        if (now != null && !trustedAppPage(Uri.parse(now))) { paymentActive = false; navigateSafely(Uri.parse(BuildConfig.STIZ_ORIGIN + AppNavigationPolicy.ENTRY_PATH)); return; }
        moveTaskToBack(true);
    }
    // 당겨서 새로고침: 우리 사이트 화면만 다시 불러온다. 결제·본인인증 중(카드사 화면 등)에는 다시 보내지 않는다.
    private void pullToRefresh() {
        String now = web == null ? null : web.getUrl();
        if (web == null || paymentActive || now == null || !trustedAppPage(Uri.parse(now))) { refresher.setRefreshing(false); return; }
        web.reload();
    }
    // 인터넷 연결 문제로 보이는 오류만 안내 화면으로 바꾼다(주소 해석·연결·시간 초과·입출력·보안 연결 실패).
    private static boolean isConnectionError(int code) {
        return code == WebViewClient.ERROR_HOST_LOOKUP || code == WebViewClient.ERROR_CONNECT || code == WebViewClient.ERROR_TIMEOUT
            || code == WebViewClient.ERROR_IO || code == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE || code == WebViewClient.ERROR_PROXY_AUTHENTICATION;
    }
    // «연결할 수 없어요» 안내 화면(아이폰 앱과 같은 수준). 실패한 주소는 화면에 보이지 않는다.
    private void showLoadError(String failedUrl) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || web == null) return;
            if (refresher != null) refresher.setRefreshing(false);
            if (failedUrl != null && trustedAppPage(Uri.parse(failedUrl))) lastAppUrl = failedUrl;
            float density = getResources().getDisplayMetrics().density;
            LinearLayout layout = new LinearLayout(this);
            layout.setOrientation(LinearLayout.VERTICAL);
            layout.setGravity(android.view.Gravity.CENTER);
            int pad = (int) (24 * density);
            layout.setPadding(pad, pad, pad, pad);
            TextView title = new TextView(this);
            title.setText("연결할 수 없어요");
            title.setTextSize(20);
            title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            title.setGravity(android.view.Gravity.CENTER);
            layout.addView(title);
            TextView body = new TextView(this);
            body.setText("인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
            body.setTextSize(15);
            body.setGravity(android.view.Gravity.CENTER);
            body.setPadding(0, (int) (8 * density), 0, (int) (20 * density));
            layout.addView(body);
            Button retry = new Button(this);
            retry.setText("다시 시도");
            retry.setMinHeight((int) (48 * density));
            retry.setOnClickListener(view -> retryAfterError());
            layout.addView(retry);
            setContentView(layout);
        });
    }
    private void retryAfterError() {
        paymentActive = false;
        Uri target = Uri.parse(lastAppUrl != null ? lastAppUrl : BuildConfig.STIZ_ORIGIN + AppNavigationPolicy.ENTRY_PATH);
        if (trustedAppPage(target)) navigateSafely(target);
        else loadPageUnchecked(Uri.parse(BuildConfig.STIZ_ORIGIN + AppNavigationPolicy.ENTRY_PATH));
    }
    // 바깥 사이트를 휴대폰 기본 브라우저로 연다.
    private void openInBrowser(Uri uri) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException failure) { showAppMessage("링크를 열 브라우저를 설치해 주세요."); }
    }
    // 파일 받기. 우리 사이트 파일은 로그인 쿠키를 붙여 휴대폰 다운로드 관리자로 받고, Supabase 공개 파일은 쿠키 없이 받는다.
    // Android 10 이상은 «다운로드» 폴더(권한 불필요), 그 아래 버전은 앱 전용 폴더에 저장하고 알림을 눌러 열 수 있다.
    private void startDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (BuildConfig.STIZ_SANDBOX) { showAppMessage("격리시험에서는 파일을 내려받지 않습니다."); return; }
        if (url == null || !AppNavigationPolicy.downloadAllowed(BuildConfig.STIZ_ORIGIN, url)) {
            // 화면에서 만든 파일(blob:)·바깥 주소는 다운로드 관리자가 받을 수 없다.
            showAppMessage("이 파일은 앱에서 바로 받을 수 없습니다. 브라우저에서 사이트를 이용해 주세요.");
            return;
        }
        try {
            // 한글 파일명은 filename*=UTF-8''... 로 오므로 그것을 먼저 읽는다(기본 추측은 한글이 깨진다).
            String encoded = AppNavigationPolicy.encodedFileName(contentDisposition);
            String fileName = encoded != null ? encoded : URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle(fileName)
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            // 로그인 쿠키는 우리 사이트 주소에만 붙인다(바깥 서버로 새지 않게).
            // ⚠️ 그래서 우리 사이트의 파일 받기 주소는 바깥 주소로 리다이렉트하면 안 된다 — 다운로드 관리자는 리다이렉트를
            //    따라가며 이 Cookie 헤더를 그대로 다시 보낸다(로그인 쿠키 유출). 바깥 파일은 바깥 주소를 직접 링크할 것.
            if (AppNavigationPolicy.sameOrigin(BuildConfig.STIZ_ORIGIN, url)) {
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) request.addRequestHeader("Cookie", cookies);
            }
            if (Build.VERSION.SDK_INT >= 29) request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            else request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("download manager");
            manager.enqueue(request);
            Toast.makeText(this, "파일을 받는 중입니다. 완료되면 알림에서 열 수 있어요.", Toast.LENGTH_SHORT).show();
        } catch (Exception failure) { showAppMessage("파일을 받지 못했습니다. 잠시 후 다시 시도해 주세요."); }
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
