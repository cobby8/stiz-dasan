package kr.stiz.driver;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 앱 간편로그인 복귀 정책(PKCE). 복귀 주소에는 로그인 토큰·쿠키가 없고 flow·state·1회용 code(또는 실패 이유)만 실린다.
 * 운영(release) = 스토어 앱 ID 주소, 개발(debug) = 기존 개발 주소. 서버(src/lib/native-auth/policy.ts)와 같은 이름이어야 한다.
 */
final class NativeAuthPolicy {
    static final String DEVELOPMENT_CALLBACK_SCHEME = "stiz-academy-android-dev";
    static final String RELEASE_CALLBACK_SCHEME = "kr.co.upturnlabs.stizdasan";
    static final long LIFETIME_MS = 5 * 60 * 1000;
    /** 서버가 브라우저 로그인 실패 때 돌려주는 이유(src/lib/native-auth/service.ts NATIVE_BROWSER_FAILURES 와 같게). */
    static final String[] FAILURES = {"no_account", "cancelled", "failed"};
    /** 빌드 종류별 복귀 주소 이름 — 출시 빌드는 개발 주소를 받지 않는다. */
    static String callbackScheme(boolean debug) { return debug ? DEVELOPMENT_CALLBACK_SCHEME : RELEASE_CALLBACK_SCHEME; }
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
    static boolean isCallback(String value, String scheme) {
        try { return scheme.equals(new URI(value).getScheme()); }
        catch (Exception failure) { return false; }
    }
    /** 이 앱이 시작한 요청(flow·state)과 정확히 맞는 복귀면 1회용 code, 아니면 null. 5분이 지나면 받지 않는다. */
    static String returnCode(String value, String scheme, String flow, String state, long elapsedMs) {
        Map<String, String> query = returnQuery(value, scheme, flow, state, elapsedMs);
        if (query == null || query.size() != 3) return null;
        String code = query.get("code");
        return token(code) ? code : null;
    }
    /** 서버가 «로그인 실패»로 돌려보낸 복귀(flow·state·error 만)면 그 이유, 아니면 null. code 는 없으므로 로그인되지 않는다. */
    static String returnFailure(String value, String scheme, String flow, String state, long elapsedMs) {
        Map<String, String> query = returnQuery(value, scheme, flow, state, elapsedMs);
        if (query == null || query.size() != 3 || query.containsKey("code")) return null;
        String reason = query.get("error");
        for (String known : FAILURES) if (known.equals(reason)) return reason;
        return null;
    }
    private static Map<String, String> returnQuery(String value, String scheme, String flow, String state, long elapsedMs) {
        if (elapsedMs < 0 || elapsedMs > LIFETIME_MS || flow == null || state == null) return null;
        try {
            URI uri = new URI(value);
            if (!scheme.equals(uri.getScheme()) || !"auth".equals(uri.getRawAuthority())
                || !"/return".equals(uri.getRawPath()) || uri.getFragment() != null) return null;
            Map<String, String> query = query(uri.getRawQuery());
            if (!flow.equals(query.get("flow")) || !state.equals(query.get("state"))) return null;
            return query;
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
