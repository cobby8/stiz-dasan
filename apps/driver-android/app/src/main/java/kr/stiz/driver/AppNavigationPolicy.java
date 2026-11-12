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
    // 사용자가 누른 전화·문자·지도 앱 호출. 문자(sms)는 2026-11-13 원장 승인으로 추가(학부모·선생님 «문자 보내기» 버튼).
    static boolean externalActionAllowed(String url, boolean userGesture) {
        if (!userGesture) return false;
        try {
            URI uri = new URI(url);
            if (uri.getRawUserInfo() != null) return false;
            if ("tel".equals(uri.getScheme())) return uri.getRawSchemeSpecificPart().matches("[+0-9*#(). -]{3,32}");
            // sms:번호 또는 sms:번호?body=내용. 받는 번호 부분만 검사하고, 내용은 길이·제어문자만 막는다(문자 앱이 보여 주고 사용자가 보낸다).
            if ("sms".equals(uri.getScheme())) {
                String part = uri.getRawSchemeSpecificPart();
                String number = part.indexOf('?') < 0 ? part : part.substring(0, part.indexOf('?'));
                return part.length() <= 2000 && number.matches("[+0-9*#(). ,;-]{0,200}") && part.chars().noneMatch(c -> c < 32 || c == 127);
            }
            // 티맵·네이버지도·카카오맵 길찾기 앱
            if ("tmap".equals(uri.getScheme()) || "nmap".equals(uri.getScheme()) || "kakaomap".equals(uri.getScheme())) return true;
            return "https".equals(uri.getScheme()) && (uri.getPort() == -1 || uri.getPort() == 443)
                && ("apis.openapi.sk.com".equals(uri.getHost()) || "map.naver.com".equals(uri.getHost()) || "map.kakao.com".equals(uri.getHost()));
        } catch (Exception failure) { return false; }
    }
    // 포트원(옛 아임포트)·KG이니시스 본인인증 화면. 자녀 연결·기존 계정 연결의 본인인증이 이 주소로 넘어간다.
    // 결제처럼 «진행 중» 상태를 시작해 통신사·인증 앱 화면을 잠시 허용하고, 우리 사이트로 돌아오면 다시 잠근다.
    // ⚠️ 실제 경유 도메인은 실기기로 확인해야 한다(포트원 SDK 가 채널마다 다른 화면으로 보낸다).
    static boolean isIdentityVerification(String url) {
        if (!paymentPageAllowed(url)) return false;
        try {
            String host = new URI(url).getHost().toLowerCase(java.util.Locale.ROOT);
            for (String domain : new String[]{"portone.io", "iamport.kr", "iamport.co", "inicis.com"}) {
                if (host.equals(domain) || host.endsWith("." + domain)) return true;
            }
            return false;
        } catch (Exception failure) { return false; }
    }
    // 토스 결제창 또는 본인인증 화면 — 여기로 들어가면 «결제·인증 중» 상태가 된다.
    static boolean isExternalFlowStart(String url) { return isTossPayment(url) || isIdentityVerification(url); }
    // Supabase 저장소의 «공개 파일»(사진·첨부 PDF 등). 로그인 화면(*.supabase.co/auth)과 구분한다.
    static boolean isSupabasePublicFile(String url) {
        try {
            URI uri = new URI(url);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(java.util.Locale.ROOT);
            return "https".equals(uri.getScheme()) && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                && host.endsWith(".supabase.co") && canonicalPath(uri) && uri.getPath().startsWith("/storage/v1/object/public/");
        } catch (Exception failure) { return false; }
    }
    // 사용자가 누른 바깥 사이트 링크(블로그·카카오채널·공지 첨부 등)는 막지 않고 휴대폰 브라우저로 연다(원장 승인 2026-11-13).
    // 우리 사이트·외부 로그인 화면은 제외한다(브라우저로 넘겨도 앱 로그인이 되지 않는다).
    static boolean openInBrowserAllowed(String origin, String url, boolean userGesture) {
        if (!userGesture) return false;
        try {
            URI uri = new URI(url), own = new URI(origin);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                || !(uri.getPort() == -1 || uri.getPort() == 443)) return false;
            String host = uri.getHost().toLowerCase(java.util.Locale.ROOT);
            if (host.equals(own.getHost()) || host.equals("accounts.google.com") || host.equals("appleid.apple.com")) return false;
            if (host.endsWith(".supabase.co")) return isSupabasePublicFile(url);
            return true;
        } catch (Exception failure) { return false; }
    }
    // 앱 안에서 내려받기를 허용하는 파일 주소: 우리 사이트(로그인 쿠키 필요)와 Supabase 공개 파일만.
    static boolean downloadAllowed(String origin, String url) {
        return sameOrigin(origin, url) || isSupabasePublicFile(url);
    }
}
