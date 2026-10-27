package kr.stiz.driver;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Development-only PKCE return policy; no login token or cookie is carried in the URL. */
final class NativeAuthPolicy {
    static final String CALLBACK_SCHEME = "stiz-academy-android-dev";
    static final long LIFETIME_MS = 5 * 60 * 1000;
    private NativeAuthPolicy() { }
    static String provider(String origin, String value, boolean userGesture) {
        if (!userGesture || !AppNavigationPolicy.sameOrigin(origin, value)) return null;
        try {
            URI uri = new URI(value);
            if (uri.getFragment() != null) return null;
            Map<String, String> query = query(uri.getRawQuery());
            if (!"login".equals(query.get("intent"))) return null;
            // Account linking and enrollment handoff need a distinct, reviewed flow.
            if (query.size() != 1) return null;
            for (String provider : new String[]{"google", "kakao", "naver", "apple"}) {
                if (("/auth/oauth/" + provider).equals(uri.getRawPath())) return provider;
            }
        } catch (Exception failure) { return null; }
        return null;
    }
    static boolean browserUrl(String origin, String value, String flow) {
        if (!AppNavigationPolicy.sameOrigin(origin, value)) return false;
        try {
            URI uri = new URI(value);
            Map<String, String> query = query(uri.getRawQuery());
            return "/auth/native/browser".equals(uri.getRawPath()) && uri.getFragment() == null
                && query.size() == 1 && flow.equals(query.get("flow"));
        } catch (Exception failure) { return false; }
    }
    static boolean isCallback(String value) {
        try { return CALLBACK_SCHEME.equals(new URI(value).getScheme()); }
        catch (Exception failure) { return false; }
    }
    static String returnCode(String value, String flow, String state, long elapsedMs) {
        if (elapsedMs < 0 || elapsedMs > LIFETIME_MS) return null;
        try {
            URI uri = new URI(value);
            if (!CALLBACK_SCHEME.equals(uri.getScheme()) || !"auth".equals(uri.getRawAuthority())
                || !"/return".equals(uri.getRawPath()) || uri.getFragment() != null) return null;
            Map<String, String> query = query(uri.getRawQuery());
            if (query.size() != 3 || !flow.equals(query.get("flow")) || !state.equals(query.get("state"))) return null;
            String code = query.get("code");
            return token(code) ? code : null;
        } catch (Exception failure) { return null; }
    }
    static boolean token(String value) { return value != null && value.matches("[A-Za-z0-9_-]{43}"); }
    private static Map<String, String> query(String raw) throws Exception {
        if (raw == null || raw.length() > 2048) throw new IllegalArgumentException("Invalid query");
        Map<String, String> result = new LinkedHashMap<>();
        for (String part : raw.split("&", -1)) {
            String[] pair = part.split("=", 2);
            if (pair.length != 2) throw new IllegalArgumentException("Invalid query");
            String key = URLDecoder.decode(pair[0], StandardCharsets.UTF_8.name());
            String value = URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name());
            if (result.put(key, value) != null) throw new IllegalArgumentException("Duplicate query");
        }
        return result;
    }
}
