package kr.stiz.driver;

/**
 * 앱 알림(FCM) 순수 규칙 — 오프라인 테스트(tests/NativePushPolicyTest.java)가 그대로 실행한다(2026-11-14, e2).
 * 안드로이드 화면·Firebase 를 모른다.
 */
final class NativePushPolicy {
    private NativePushPolicy() { }

    /**
     * 알림을 눌렀을 때 열 주소. 서버는 우리 사이트 «경로»(예: /mypage/attendance)만 보낸다.
     * 경로가 아니거나(바깥 주소·"//evil"·역슬래시) 앱이 열 수 없는 주소면 시작 화면으로 바꾼다.
     * 최종 판정은 기존 주소 정책(AppNavigationPolicy.sameOrigin)을 그대로 쓴다 — 규칙을 새로 만들지 않는다.
     */
    static String target(String origin, String rawPath) {
        String fallback = origin + AppNavigationPolicy.ENTRY_PATH;
        if (rawPath == null) return fallback;
        String path = rawPath.trim();
        if (path.isEmpty() || path.length() > 1024 || !path.startsWith("/") || path.startsWith("//")) return fallback;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c < 33 || c == 127 || c == '\\') return fallback;
        }
        String url = origin + path;
        if (!AppNavigationPolicy.sameOrigin(origin, url) || AppNavigationPolicy.needsNativeAuthHandoff(origin, url)) return fallback;
        return url;
    }

    /**
     * 웹 요청 «명령#번호»(예: "state#7")에서 명령을 꺼낸다. "state"·"request" 가 아니면 null.
     * 웹은 답이 한 곳(onmessage)으로 모이므로 번호로 요청·답을 짝짓는다.
     */
    static String command(String message) {
        if (message == null) return null;
        int hash = message.indexOf('#');
        String command = hash < 0 ? message : message.substring(0, hash);
        return "state".equals(command) || "request".equals(command) ? command : null;
    }

    /** 요청 번호(1~999999999). 없거나 형식이 틀리면 0(답에 번호를 붙이지 않는다) */
    static int requestId(String message) {
        if (message == null) return 0;
        int hash = message.indexOf('#');
        if (hash < 0) return 0;
        String digits = message.substring(hash + 1);
        if (!digits.matches("[1-9][0-9]{0,8}")) return 0;
        return Integer.parseInt(digits);
    }

    static String stateJson(boolean supported, String permission, String token) { return stateJson(supported, permission, token, 0); }

    /**
     * 웹에 돌려줄 알림 상태 JSON 한 줄(웹의 parseNativePushReply 와 같은 모양). id 가 0 보다 크면 "id" 를 붙인다.
     * permission: "granted" | "denied" | "default"
     */
    static String stateJson(boolean supported, String permission, String token, int id) {
        String safePermission = "granted".equals(permission) || "denied".equals(permission) ? permission : "default";
        StringBuilder out = new StringBuilder("{\"v\":1,");
        if (id > 0) out.append("\"id\":").append(id).append(',');
        out.append("\"platform\":\"android\",\"supported\":").append(supported)
            .append(",\"permission\":\"").append(safePermission).append("\",\"token\":");
        // FCM 토큰은 영문·숫자·:_-. 만 쓴다 — 그 밖의 글자가 있으면 보내지 않는다(따옴표로 JSON 이 깨지는 일 방지)
        if (supported && token != null && token.matches("[A-Za-z0-9:_\\-.]{20,4096}")) out.append('"').append(token).append('"');
        else out.append("null");
        return out.append('}').toString();
    }

    /**
     * 휴대폰 알림 권한 상태.
     * @param sdk           안드로이드 버전(Build.VERSION.SDK_INT)
     * @param granted       POST_NOTIFICATIONS 허용 여부(33 미만은 늘 true 로 넘긴다)
     * @param enabled       앱 알림이 휴대폰 설정에서 켜져 있나(areNotificationsEnabled)
     * @param asked         이 앱이 알림 권한을 한 번이라도 물어봤나
     * @param canAskAgain   다시 물어볼 수 있나(shouldShowRequestPermissionRationale)
     */
    static String permission(int sdk, boolean granted, boolean enabled, boolean asked, boolean canAskAgain) {
        if (sdk >= 33 && !granted) return !asked || canAskAgain ? "default" : "denied";
        return enabled ? "granted" : "denied";
    }
}
