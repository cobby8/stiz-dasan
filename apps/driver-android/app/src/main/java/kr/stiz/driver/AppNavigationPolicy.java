package kr.stiz.driver;

import java.net.URI;

/** Pure URL/run-state policy, shared by navigation and the offline test suite. */
final class AppNavigationPolicy {
    private AppNavigationPolicy() { }
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
