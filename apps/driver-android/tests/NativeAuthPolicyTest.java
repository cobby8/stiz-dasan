package kr.stiz.driver;

/** Exact callback/PKCE envelope tests, independent of Android, credentials and providers. */
public final class NativeAuthPolicyTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Native auth check " + checks); }
    public static void main(String[] args) {
        String origin = "https://www.stiz-dasan.kr";
        String flow = "F".repeat(43);
        String state = "S".repeat(43);
        String code = "C".repeat(43);
        for (String provider : new String[]{"google", "kakao", "naver", "apple"}) {
            check(provider.equals(NativeAuthPolicy.provider(origin, origin + "/auth/oauth/" + provider + "?intent=login", true)));
        }
        check(NativeAuthPolicy.provider(origin, origin + "/auth/oauth/google?intent=login", false) == null);
        for (String suffix : new String[]{"?intent=link", "?intent=parent-signup", "?intent=login&next=/admin", "?intent=login&enrollmentHandoff=secret", "?intent=login&intent=login", "?intent=login#fragment", ""}) {
            check(NativeAuthPolicy.provider(origin, origin + "/auth/oauth/google" + suffix, true) == null);
        }
        check(NativeAuthPolicy.provider(origin, "https://evil.invalid/auth/oauth/google?intent=login", true) == null);
        check(NativeAuthPolicy.provider(origin, origin + "/auth/oauth/unsupported?intent=login", true) == null);
        check(NativeAuthPolicy.provider(origin, origin + "/auth/oauth/%67oogle?intent=login", true) == null);
        check(NativeAuthPolicy.browserUrl(origin, origin + "/auth/native/browser?flow=" + flow, flow));
        check(!NativeAuthPolicy.browserUrl(origin, origin + "/auth/native/browser?flow=" + flow + "&x=1", flow));
        check(!NativeAuthPolicy.browserUrl(origin, origin + "/auth/native/browser?flow=wrong", flow));
        check(!NativeAuthPolicy.browserUrl(origin, "https://evil.invalid/auth/native/browser?flow=" + flow, flow));
        check(!NativeAuthPolicy.browserUrl(origin, origin + "/auth/native/browser?flow=" + flow + "#fragment", flow));
        // 출시(스토어 앱 ID)·개발 복귀 주소 모두 같은 규칙으로 검사한다. 각 빌드는 자기 주소만 받는다.
        check(NativeAuthPolicy.callbackScheme(false).equals("kr.co.upturnlabs.stizdasan"));
        check(NativeAuthPolicy.callbackScheme(true).equals("stiz-academy-android-dev"));
        for (boolean debug : new boolean[]{false, true}) {
            String scheme = NativeAuthPolicy.callbackScheme(debug);
            String other = NativeAuthPolicy.callbackScheme(!debug);
            String callback = scheme + "://auth/return?flow=" + flow + "&state=" + state + "&code=" + code;
            check(code.equals(NativeAuthPolicy.returnCode(callback, scheme, flow, state, 0)));
            check(code.equals(NativeAuthPolicy.returnCode(callback, scheme, flow, state, NativeAuthPolicy.LIFETIME_MS)));
            // 만료(5분 초과)·시계 이상
            check(NativeAuthPolicy.returnCode(callback, scheme, flow, state, -1) == null);
            check(NativeAuthPolicy.returnCode(callback, scheme, flow, state, NativeAuthPolicy.LIFETIME_MS + 1) == null);
            // 다른 요청·state 불일치
            check(NativeAuthPolicy.returnCode(callback, scheme, "different", state, 100) == null);
            check(NativeAuthPolicy.returnCode(callback, scheme, flow, "different", 100) == null);
            // 다른 빌드의 복귀 주소는 받지 않는다(출시 빌드는 개발 주소 거부)
            check(NativeAuthPolicy.returnCode(callback.replace(scheme + "://", other + "://"), scheme, flow, state, 100) == null);
            check(!NativeAuthPolicy.isCallback(callback.replace(scheme + "://", other + "://"), scheme));
            for (String forged : new String[]{callback + "&state=" + state, callback + "&error=cancelled", callback + "#fragment",
                callback.replace("://auth/", "://evil/"), callback.replace("/return?", "/return/extra?"), callback.replace("://auth/", "://user@auth/"),
                callback.replace("://auth/", "://auth:44/"), callback.replace(scheme + "://", "stiz-academy-ios-dev://"),
                callback.replace(code, "short"), callback.replace(code, "secret%0Avalue"), callback.replace("/return?", "/%72eturn?"),
                "https://www.stiz-dasan.kr/auth/native/return?flow=" + flow + "&state=" + state + "&code=" + code}) {
                check(NativeAuthPolicy.returnCode(forged, scheme, flow, state, 100) == null);
            }
            check(NativeAuthPolicy.isCallback(callback, scheme));
            check(!NativeAuthPolicy.isCallback(origin, scheme));
            // 서버가 «실패 이유»만 실어 보낸 복귀: code 가 없으니 로그인은 안 되고 이유만 읽는다
            String failed = scheme + "://auth/return?flow=" + flow + "&state=" + state + "&error=no_account";
            check(NativeAuthPolicy.returnCode(failed, scheme, flow, state, 100) == null);
            check("no_account".equals(NativeAuthPolicy.returnFailure(failed, scheme, flow, state, 100)));
            check("cancelled".equals(NativeAuthPolicy.returnFailure(failed.replace("no_account", "cancelled"), scheme, flow, state, 100)));
            check(NativeAuthPolicy.returnFailure(failed.replace("no_account", "evil"), scheme, flow, state, 100) == null);
            check(NativeAuthPolicy.returnFailure(failed, scheme, flow, "different", 100) == null);
            check(NativeAuthPolicy.returnFailure(failed, scheme, flow, state, NativeAuthPolicy.LIFETIME_MS + 1) == null);
            check(NativeAuthPolicy.returnFailure(failed + "&code=" + code, scheme, flow, state, 100) == null);
            check(NativeAuthPolicy.returnFailure(callback, scheme, flow, state, 100) == null);
        }
        check(NativeAuthPolicy.token(code));
        check(!NativeAuthPolicy.token("C".repeat(42)));
        check(!NativeAuthPolicy.token("C".repeat(44)));
        System.out.println("Native auth policy: " + checks + " checks passed");
    }
}
