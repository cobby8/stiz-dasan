package kr.stiz.driver;

public final class AppNavigationPolicyTest {
    private static int checks;
    private static void check(boolean value) { if (!value) throw new AssertionError("check " + (checks + 1)); checks++; }
    public static void main(String[] args) {
        String origin = "https://www.stiz-dasan.kr";
        for (String path : new String[]{"/store-app", "/auth/continue", "/login", "/signup/parent", "/admin", "/staff", "/mypage", "/account/children", "/account/withdraw", "/driver/test_token-1"}) {
            check(AppNavigationPolicy.isAppPage(origin, origin + path, true));
        }
        for (String url : new String[]{"http://www.stiz-dasan.kr/mypage", "https://evil.invalid/mypage", "https://www.stiz-dasan.kr.evil.invalid/mypage", "https://user@www.stiz-dasan.kr/mypage", "https://www.stiz-dasan.kr:444/mypage", "file:///mypage", "javascript:alert(1)", "intent://mypage", "https://www.stiz-dasan.kr//evil", "https://www.stiz-dasan.kr/%2fdriver/x", "https://www.stiz-dasan.kr/%5cdriver/x", "https://www.stiz-dasan.kr/a/../driver/x", "https://www.stiz-dasan.kr/a/%2e%2e/driver/x", "https://www.stiz-dasan.kr/%00"}) {
            check(!AppNavigationPolicy.isAppPage(origin, url, true));
        }
        check(AppNavigationPolicy.isDriverPage(origin, origin + "/driver/test_token-1"));
        for (String path : new String[]{"/store-app", "/admin", "/staff", "/mypage", "/driver/test/nested", "/driver/%61", "/api/driver/location"}) {
            check(!AppNavigationPolicy.isDriverPage(origin, origin + path));
            check(!AppNavigationPolicy.isAppPage(origin, origin + path, false));
        }
        check(AppNavigationPolicy.needsNativeAuthHandoff(origin, origin + "/auth/oauth/google?intent=link"));
        check(AppNavigationPolicy.needsNativeAuthHandoff(origin, origin + "/auth/oauth/apple"));
        check(AppNavigationPolicy.needsNativeAuthHandoff(origin, origin + "/auth/native/complete"));
        check(!AppNavigationPolicy.needsNativeAuthHandoff(origin, origin + "/login"));
        check(!AppNavigationPolicy.needsNativeAuthHandoff(origin, origin + "/api/auth/providers"));
        check(!AppNavigationPolicy.needsNativeAuthHandoff(origin, "https://evil.invalid/auth/oauth/google"));
        check(AppNavigationPolicy.mayNavigate(origin, origin + "/mypage", false, ""));
        check(AppNavigationPolicy.mayNavigate(origin, origin + "/driver/current", true, "current"));
        check(!AppNavigationPolicy.mayNavigate(origin, origin + "/mypage", true, "current"));
        check(!AppNavigationPolicy.mayNavigate(origin, origin + "/login", true, "current"));
        check(!AppNavigationPolicy.mayNavigate(origin, origin + "/driver/other", true, "current"));
        check(!AppNavigationPolicy.mayNavigate(origin, origin + "/driver/current", true, ""));
        check(!AppNavigationPolicy.unfinishedRun(false, false, false));
        check(AppNavigationPolicy.unfinishedRun(true, false, false));
        check(AppNavigationPolicy.unfinishedRun(true, true, true));
        check(!AppNavigationPolicy.unfinishedRun(true, true, false));
        check(AppNavigationPolicy.externalActionAllowed("tel:07088245712", true));
        check(AppNavigationPolicy.externalActionAllowed("tmap://route?goalname=test", true));
        check(AppNavigationPolicy.externalActionAllowed("https://map.naver.com/v5", true));
        check(!AppNavigationPolicy.externalActionAllowed("tel:07088245712", false));
        check(!AppNavigationPolicy.externalActionAllowed("tel:123%0a456", true));
        check(!AppNavigationPolicy.externalActionAllowed("intent://route", true));
        check(!AppNavigationPolicy.externalActionAllowed("https://evil.invalid", true));
        check(!AppNavigationPolicy.externalActionAllowed("https://map.naver.com:444/", true));
        check(AppNavigationPolicy.isAppPage("https://localhost:8443", "https://localhost:8443/driver/test", false));
        check(!AppNavigationPolicy.isAppPage("https://localhost:8443", "https://localhost/driver/test", false));
        check(AppNavigationPolicy.isTrustedBridge(origin, origin, origin + "/driver/current", true));
        check(!AppNavigationPolicy.isTrustedBridge(origin, origin, origin + "/driver/current", false));
        check(!AppNavigationPolicy.isTrustedBridge(origin, origin, origin + "/mypage", true));
        check(!AppNavigationPolicy.isTrustedBridge(origin, "https://evil.invalid", origin + "/driver/current", true));
        check(!AppNavigationPolicy.isTrustedBridge(origin, origin + ":444", origin + "/driver/current", true));
        check(AppNavigationPolicy.needsAccountRunHandoff(origin, origin + "/staff/run"));
        check(AppNavigationPolicy.needsAccountRunHandoff(origin, origin + "/staff/run/?date=2026-10-27"));
        check(!AppNavigationPolicy.needsAccountRunHandoff(origin, origin + "/staff/shuttle"));
        check(!AppNavigationPolicy.needsAccountRunHandoff(origin, origin + "/driver/current"));
        check(!AppNavigationPolicy.needsAccountRunHandoff(origin, "https://evil.invalid/staff/run"));
        System.out.println("PASS " + checks + " unified navigation/run-state policy checks; no network/location calls");
    }
}
