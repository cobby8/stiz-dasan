package kr.stiz.driver;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * 간편로그인 화면을 시스템 브라우저의 «맞춤 탭(Custom Tabs)»으로 연다(a1, 2026-11-13).
 *
 * 왜 맞춤 탭인가: 웹뷰 안 로그인은 구글이 막고(disallowed_useragent), 일반 브라우저로 보내면 앱과 따로 놀아
 * 돌아오는 길이 길다. 맞춤 탭은 앱 위에 크롬 화면을 띄우고, 로그인이 끝나 복귀 주소로 넘어가면
 * NativeAuthReturnActivity 가 그 탭을 닫고 앱 화면으로 돌아온다.
 *
 * androidx.browser 라이브러리 없이 맞춤 탭 규약(인텐트 extra 2개)만 쓴다 — 의존성을 늘리지 않으려고.
 * 맞춤 탭을 모르는 브라우저는 extra 를 무시하고 일반 브라우저로 연다(로그인은 그대로 된다).
 */
final class NativeAuthBrowser {
    // 맞춤 탭 규약 이름(androidx.browser.customtabs.CustomTabsIntent 와 같은 값)
    private static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    private static final String EXTRA_TITLE_VISIBILITY = "android.support.customtabs.extra.TITLE_VISIBILITY";
    private static final int SHOW_PAGE_TITLE = 1;

    private NativeAuthBrowser() { }

    /** https 주소만 연다. 열지 못하면 false. */
    static boolean open(Activity activity, Uri uri) {
        if (uri == null || !"https".equals(uri.getScheme())) return false;
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
        // 세션 extra 가 «있기만» 하면 맞춤 탭으로 연다(값 null = 연결 세션 없이 사용)
        Bundle extras = new Bundle();
        extras.putBinder(EXTRA_SESSION, null);
        intent.putExtras(extras);
        intent.putExtra(EXTRA_TITLE_VISIBILITY, SHOW_PAGE_TITLE);
        try {
            activity.startActivity(intent);
            return true;
        } catch (RuntimeException failure) {
            return false;
        }
    }
}
