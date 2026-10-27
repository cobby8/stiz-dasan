package kr.stiz.driver;

/** Executes the same pure policy used for every sandbox WebView/worker request. */
public final class SandboxNavigationPolicyTest {
    private static int checks;
    private static void check(boolean value) { if (!value) throw new AssertionError("check " + (checks + 1)); checks++; }
    public static void main(String[] args) {
        for (String host : new String[]{"localhost", "127.0.0.1", "10.0.0.4", "172.16.0.1", "172.31.255.254", "192.168.0.4"}) {
            String origin = "https://" + host + ":8453";
            check(AppNavigationPolicy.sandboxOrigin(origin));
            for (String path : new String[]{"/store-app", "/__entry/admin", "/__entry/parent", "/__entry/teacher", "/__entry/driver", "/staff/run", "/api/staff/classes"}) check(AppNavigationPolicy.sandboxRequestAllowed(origin, origin + path));
            check(!AppNavigationPolicy.sandboxRequestAllowed(origin, "https://www.stiz-dasan.kr/api/driver/mobile/session"));
            check(!AppNavigationPolicy.sandboxRequestAllowed(origin, origin + "/auth/oauth/google"));
            check(!AppNavigationPolicy.sandboxRequestAllowed(origin, origin + "/auth/native/start"));
        }
        for (String origin : new String[]{"http://localhost:8453", "https://localhost", "https://localhost:8443", "https://www.stiz-dasan.kr:8453", "https://evil.invalid:8453", "https://192.168.1.256:8453", "https://192.168.001.1:8453", "https://172.15.0.1:8453", "https://172.32.0.1:8453", "https://192.169.0.1:8453", "https://8.8.8.8:8453", "https://user@localhost:8453", "https://localhost:8453/x", "https://localhost:8453?x", "https://localhost:8453#x", "https://localhost.evil.invalid:8453", "https://localhost.:8453", "https://[::1]:8453"}) check(!AppNavigationPolicy.sandboxOrigin(origin));
        String local = "https://localhost:8453";
        for (String url : new String[]{"https://localhost:8443/api/test", "https://127.0.0.1:8453/api/test", "http://localhost:8453/api/test", "https://www.stiz-dasan.kr/", "https://accounts.google.com/", "https://api.tosspayments.com/", "https://localhost:8453.evil.invalid/", local + "/a/%2e%2e/api", local + "/%2fadmin", local + "/%5cadmin", local + "/%00", "tel:12345678", "tmap://route", "intent://x", "file:///secret", "javascript:alert(1)"}) check(!AppNavigationPolicy.sandboxRequestAllowed(local, url));
        check(AppNavigationPolicy.sandboxRequestAllowed(local, local + "/api/test?value=https%3A%2F%2Fwww.stiz-dasan.kr")); // Server independently allowlists endpoint/body contracts; no proxy exists.
        check(AppNavigationPolicy.externalActionAllowed("tel:12345678", true)); // Existing release phone policy unchanged.
        check(AppNavigationPolicy.isDriverPage("https://www.stiz-dasan.kr", "https://www.stiz-dasan.kr/driver/test"));
        System.out.println("PASS " + checks + " sandbox origin/request boundary assertions; no network or location calls");
    }
}
