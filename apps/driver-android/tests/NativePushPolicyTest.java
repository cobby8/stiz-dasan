package kr.stiz.driver;

/** 앱 알림(FCM) 순수 규칙 검사(e2). javac 로 NativePushPolicy·AppNavigationPolicy 와 함께 컴파일해 실행한다. */
public final class NativePushPolicyTest {
    private static int checks;
    private static void check(boolean value) { if (!value) throw new AssertionError("check " + (checks + 1)); checks++; }
    public static void main(String[] args) {
        String origin = "https://www.stiz-dasan.kr";
        String entry = origin + AppNavigationPolicy.ENTRY_PATH;
        // 우리 사이트 경로는 그대로 연다(쿼리 포함)
        check(NativePushPolicy.target(origin, "/mypage").equals(origin + "/mypage"));
        check(NativePushPolicy.target(origin, "/staff/shuttle?date=2026-11-14").equals(origin + "/staff/shuttle?date=2026-11-14"));
        check(NativePushPolicy.target(origin, " /admin ").equals(origin + "/admin"));
        // 바깥 주소·주소 속임수는 시작 화면으로
        for (String bad : new String[]{null, "", "https://evil.invalid/x", "//evil.invalid/x", "javascript:alert(1)", "mypage",
            "/\\evil", "/a b", "/a\nb", "/%2fdriver", "/a/../driver/x", "@evil.invalid", "/auth/oauth/google"}) {
            check(NativePushPolicy.target(origin, bad).equals(entry));
        }
        StringBuilder longPath = new StringBuilder("/");
        for (int i = 0; i < 1100; i++) longPath.append('a');
        check(NativePushPolicy.target(origin, longPath.toString()).equals(entry));
        // 웹에 돌려주는 JSON(웹 parseNativePushReply 와 같은 모양)
        String token = "abcDEF123:_-.abcdefghijk";
        check(NativePushPolicy.stateJson(true, "granted", token).equals("{\"v\":1,\"platform\":\"android\",\"supported\":true,\"permission\":\"granted\",\"token\":\"" + token + "\"}"));
        check(NativePushPolicy.stateJson(false, "granted", token).endsWith("\"token\":null}"));
        check(NativePushPolicy.stateJson(true, "granted", "bad\"token-with-quote-xxxxxxxx").endsWith("\"token\":null}"));
        check(NativePushPolicy.stateJson(true, "granted", "short").endsWith("\"token\":null}"));
        check(NativePushPolicy.stateJson(true, "weird", null).contains("\"permission\":\"default\""));
        // 권한 판정: 13 이상 미허용 — 안 물어봤거나 다시 물을 수 있으면 default, 아니면 denied
        check(NativePushPolicy.permission(33, false, false, false, false).equals("default"));
        check(NativePushPolicy.permission(34, false, false, true, true).equals("default"));
        check(NativePushPolicy.permission(34, false, false, true, false).equals("denied"));
        check(NativePushPolicy.permission(34, true, true, true, false).equals("granted"));
        // 허용됐어도 휴대폰 설정에서 앱 알림을 끄면 denied
        check(NativePushPolicy.permission(34, true, false, true, false).equals("denied"));
        // 12 이하는 권한 창이 없다 — 설정의 켜짐 여부만
        check(NativePushPolicy.permission(30, true, true, false, false).equals("granted"));
        check(NativePushPolicy.permission(30, true, false, false, false).equals("denied"));
        System.out.println("NativePushPolicyTest " + checks + " checks passed");
    }
}
