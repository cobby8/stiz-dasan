package kr.stiz.driver;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * 간편로그인 복귀 주소(kr.co.upturnlabs.stizdasan://auth/return, 개발판은 개발 주소)를 받는 투명 화면(a1, 2026-11-13).
 *
 * 왜 MainActivity 가 직접 받지 않나: 맞춤 탭(크롬 화면)은 앱 화면 «위»에 쌓인다. MainActivity(singleTop)가
 * 맨 위가 아니므로 복귀 주소를 직접 받으면 새 MainActivity 가 하나 더 생겨 진행 중인 로그인을 잃는다.
 * 이 화면이 받아 MainActivity 를 CLEAR_TOP 으로 다시 앞으로 부르면 맞춤 탭이 닫히고
 * 기존 MainActivity.onNewIntent 로 복귀 주소가 전달된다(그 뒤 검증은 NativeAuthController 가 한다).
 *
 * 누구나 이 주소를 보낼 수 있으므로 여기서는 이 빌드의 복귀 주소 모양인지만 보고 넘긴다.
 * 진짜 판정(진행 중인 요청·flow·state·5분)은 NativeAuthController 가 하며, code 교환에는 앱 메모리의 PKCE 비밀값이 필요하다.
 */
public final class NativeAuthReturnActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri data = getIntent() == null ? null : getIntent().getData();
        if (data != null && NativeAuthPolicy.isCallback(data.toString(), NativeAuthPolicy.callbackScheme(BuildConfig.DEBUG))) {
            Intent forward = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(forward);
        }
        finish();
    }
}
