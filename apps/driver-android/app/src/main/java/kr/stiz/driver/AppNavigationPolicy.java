package kr.stiz.driver;

import java.net.URI;

/** Pure URL/run-state policy, shared by navigation and the offline test suite. */
final class AppNavigationPolicy {
    private AppNavigationPolicy() { }
    static boolean sandboxOrigin(String origin) {
        try {
            URI uri = new URI(origin);
            if (!"https".equals(uri.getScheme()) || uri.getPort() != 8453 || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) return false;
            String host = uri.getHost();
            if ("localhost".equals(host)) return true;
            if (host == null || !host.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")) return false;
            String[] parts = host.split("\\."); int[] n = new int[4];
            for (int i = 0; i < 4; i++) { n[i] = Integer.parseInt(parts[i]); if (n[i] > 255) return false; }
            return n[0] == 127 || n[0] == 10 || (n[0] == 172 && n[1] >= 16 && n[1] <= 31) || (n[0] == 192 && n[1] == 168);
        } catch (Exception failure) { return false; }
    }
    // No external navigation or provider login is part of the synthetic-data sandbox.
    static boolean sandboxRequestAllowed(String origin, String url) {
        return sandboxOrigin(origin) && sameOrigin(origin, url) && !needsNativeAuthHandoff(origin, url);
    }
    static boolean sameOrigin(String origin, String url) {
        try {
            URI expected = new URI(origin), target = new URI(url);
            return "https".equals(target.getScheme()) && expected.getHost() != null
                && expected.getHost().equals(target.getHost()) && target.getRawUserInfo() == null
                && port(expected) == port(target) && canonicalPath(target);
        } catch (Exception failure) { return false; }
    }
    private static int port(URI uri) { return uri.getPort() < 0 ? 443 : uri.getPort(); }
    private static boolean canonicalPath(URI uri) {
        String raw = uri.getRawPath() == null ? "" : uri.getRawPath();
        String path = uri.getPath() == null ? "" : uri.getPath();
        String lower = raw.toLowerCase(java.util.Locale.ROOT);
        return (path.isEmpty() || path.startsWith("/")) && !path.startsWith("//")
            && !lower.contains("%2f") && !lower.contains("%5c") && !lower.contains("%00")
            && path.indexOf('\\') < 0 && path.chars().noneMatch(c -> c < 32 || c == 127)
            && !java.util.Arrays.asList(path.split("/", -1)).contains("..")
            && !java.util.Arrays.asList(path.split("/", -1)).contains(".");
    }
    static boolean isDriverPage(String origin, String url) {
        if (!sameOrigin(origin, url)) return false;
        try { return new URI(url).getRawPath().matches("/driver/[A-Za-z0-9_-]+/?"); }
        catch (Exception failure) { return false; }
    }
    static String driverToken(String origin, String url) {
        if (!isDriverPage(origin, url)) return "";
        try { return new URI(url).getRawPath().split("/")[2]; }
        catch (Exception failure) { return ""; }
    }
    static boolean isAppPage(String origin, String url, boolean unified) {
        return unified ? sameOrigin(origin, url) : isDriverPage(origin, url);
    }
    static boolean isTrustedBridge(String origin, String frameOrigin, String topLevelUrl, boolean mainFrame) {
        return mainFrame && sameOrigin(origin, frameOrigin) && isDriverPage(origin, topLevelUrl);
    }
    static boolean needsNativeAuthHandoff(String origin, String url) {
        if (!sameOrigin(origin, url)) return false;
        try {
            String path = new URI(url).getPath();
            return path != null && (path.startsWith("/auth/oauth/") || path.startsWith("/auth/native/"));
        } catch (Exception failure) { return false; }
    }
    static boolean needsAccountRunHandoff(String origin, String url) {
        if (!sameOrigin(origin, url)) return false;
        try {
            String path = new URI(url).getPath();
            return "/staff/run".equals(path) || "/staff/run/".equals(path);
        } catch (Exception failure) { return false; }
    }
    static boolean mayNavigate(String origin, String target, boolean unfinishedRun, String runToken) {
        return !unfinishedRun || (!runToken.isEmpty() && runToken.equals(driverToken(origin, target)));
    }
    static boolean unfinishedRun(boolean hasSession, boolean stopped, boolean stopPending) {
        return hasSession && (!stopped || stopPending);
    }
    // 토스 결제창 주소. 「tosspayments.com.evil.example」처럼 뒤에 붙인 가짜 주소는 끝부분 비교로 걸러진다.
    static boolean isTossPayment(String url) {
        if (!paymentPageAllowed(url)) return false;
        try {
            String host = new URI(url).getHost().toLowerCase(java.util.Locale.ROOT);
            return host.equals("tosspayments.com") || host.endsWith(".tosspayments.com")
                || host.equals("toss.im") || host.endsWith(".toss.im");
        } catch (Exception failure) { return false; }
    }
    // 원장 결정(2026-11-09): 결제 중엔 카드사 인증 화면 등 https 이동을 모두 허용한다.
    static boolean paymentPageAllowed(String url) {
        try {
            URI uri = new URI(url);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                || !(uri.getPort() == -1 || uri.getPort() == 443)) return false;
            // 결제 중에도 외부 로그인 화면은 열지 않는다(아이폰과 같은 규칙).
            String host = uri.getHost().toLowerCase(java.util.Locale.ROOT);
            return !host.equals("accounts.google.com") && !host.equals("appleid.apple.com") && !host.endsWith(".supabase.co");
        } catch (Exception failure) { return false; }
    }
    // 결제 중 바깥 앱으로 넘길 카드사·간편결제 앱 주소. 웹 실행·파일·앱 내부 주소는 넘기지 않는다.
    static boolean isPaymentAppScheme(String url) {
        int colon = url == null ? -1 : url.indexOf(':');
        if (colon <= 0) return false;
        String scheme = url.substring(0, colon).toLowerCase(java.util.Locale.ROOT);
        if (!scheme.matches("[a-z][a-z0-9+.-]*")) return false;
        return !java.util.Arrays.asList("http", "https", "about", "data", "javascript", "file", "blob", "ftp", "content",
            "stiz-academy-dev", "stiz-academy-android-dev").contains(scheme);
    }
    static boolean externalActionAllowed(String url, boolean userGesture) {
        if (!userGesture) return false;
        try {
            URI uri = new URI(url);
            if (uri.getRawUserInfo() != null) return false;
            if ("tel".equals(uri.getScheme())) return uri.getRawSchemeSpecificPart().matches("[+0-9*#(). -]{3,32}");
            if ("tmap".equals(uri.getScheme())) return true;
            return "https".equals(uri.getScheme()) && (uri.getPort() == -1 || uri.getPort() == 443)
                && ("apis.openapi.sk.com".equals(uri.getHost()) || "map.naver.com".equals(uri.getHost()));
        } catch (Exception failure) { return false; }
    }
}
