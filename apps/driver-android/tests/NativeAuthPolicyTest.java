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
        String callback = NativeAuthPolicy.CALLBACK_SCHEME + "://auth/return?flow=" + flow + "&state=" + state + "&code=" + code;
        check(code.equals(NativeAuthPolicy.returnCode(callback, flow, state, 0)));
        check(code.equals(NativeAuthPolicy.returnCode(callback, flow, state, NativeAuthPolicy.LIFETIME_MS)));
        check(NativeAuthPolicy.returnCode(callback, flow, state, -1) == null);
        check(NativeAuthPolicy.returnCode(callback, flow, state, NativeAuthPolicy.LIFETIME_MS + 1) == null);
        check(NativeAuthPolicy.returnCode(callback, "different", state, 100) == null);
        check(NativeAuthPolicy.returnCode(callback, flow, "different", 100) == null);
        for (String forged : new String[]{callback + "&state=" + state, callback + "&error=cancelled", callback + "#fragment",
            callback.replace("://auth/", "://evil/"), callback.replace("/return?", "/return/extra?"), callback.replace("://auth/", "://user@auth/"),
            callback.replace("://auth/", "://auth:44/"), callback.replace(NativeAuthPolicy.CALLBACK_SCHEME, "stiz-academy-ios-dev"),
            callback.replace(code, "short"), callback.replace(code, "secret%0Avalue"), callback.replace("/return?", "/%72eturn?")}) {
            check(NativeAuthPolicy.returnCode(forged, flow, state, 100) == null);
        }
        check(NativeAuthPolicy.isCallback(callback));
        check(!NativeAuthPolicy.isCallback(origin));
        check(NativeAuthPolicy.token(code));
        check(!NativeAuthPolicy.token("C".repeat(42)));
        check(!NativeAuthPolicy.token("C".repeat(44)));
        System.out.println("Native auth policy: " + checks + " checks passed");
    }
}
