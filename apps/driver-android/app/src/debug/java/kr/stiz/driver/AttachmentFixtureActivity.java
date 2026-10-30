package kr.stiz.driver;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;

/** Non-exported debug-only fixture. No network, GPS, real photo, account or external chooser is used. */
public final class AttachmentFixtureActivity extends Activity {
    public WebView web;
    public WebFileChooser chooser;
    public volatile CountDownLatch ready = new CountDownLatch(1);
    public volatile CountDownLatch selected = new CountDownLatch(1);
    public volatile CountDownLatch delivered = new CountDownLatch(1);
    public volatile int requestCode;
    public volatile Intent pickerIntent;
    public volatile int callbacks;
    public volatile int resultCount;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!BuildConfig.DEBUG) { finish(); return; }
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setBlockNetworkLoads(true);
        chooser = new WebFileChooser(this, web);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // The base origin is only an origin label for loadDataWithBaseURL. Every network request is blocked.
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Fixture only", Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { chooser.documentStarted(); }
            @Override public void onPageFinished(WebView view, String url) { ready.countDown(); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return chooser.open(value -> { callbacks++; resultCount = value == null ? -1 : value.length; callback.onReceiveValue(value); delivered.countDown(); }, params);
            }
            @Override public void onPermissionRequest(android.webkit.PermissionRequest request) { request.deny(); }
        });
        setContentView(web);
        web.loadDataWithBaseURL(BuildConfig.STIZ_ORIGIN + "/staff/attachment-fixture", "<!doctype html><meta charset=utf-8>"
            + "<input id='single' type='file' accept='image/png,image/jpeg'><input id='multi' type='file' accept='image/png' multiple>"
            + "<input id='json' type='file' accept='.json'><input id='camera' type='file' accept='image/jpeg' capture='environment'>"
            + "<script>window.fixtureResult='';for(const i of document.querySelectorAll('input'))i.onchange=async()=>{"
            + "const values=[];for(const f of i.files){const bytes=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(Array.from(new Uint8Array(r.result)));r.onerror=no;r.readAsArrayBuffer(f)});"
            + "values.push({name:f.name,type:f.type,size:f.size,bytes})}window.fixtureResult=JSON.stringify(values)};</script>",
            "text/html", "UTF-8", null);
    }
    @Override public void startActivityForResult(Intent intent, int code) {
        // Keep the real chooser callback, but substitute only the external picker result in this fixture.
        pickerIntent = intent; requestCode = code; selected.countDown();
    }
    public void choose(String id) {
        selected = new CountDownLatch(1); delivered = new CountDownLatch(1);
        web.evaluateJavascript("window.fixtureResult='';document.getElementById('" + id + "').click()", null);
    }
    public void result(int code, int status, Intent data) { chooser.result(code, status, data); }
    @Override protected void onDestroy() { if (chooser != null) chooser.destroy(); if (web != null) web.destroy(); super.onDestroy(); }
}
