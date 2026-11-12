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
        // 결제(원장 결정 2026-11-09): 토스 결제창 판별·결제 중 https 허용·카드사 앱 주소 판별
        for (String url : new String[]{"https://api.tosspayments.com/v1/payments", "https://pay.toss.im/checkout", "https://tosspayments.com/", "https://api.tosspayments.com:443/x"}) {
            check(AppNavigationPolicy.isTossPayment(url));
        }
        for (String url : new String[]{"https://tosspayments.com.evil.example/", "https://eviltosspayments.com/", "http://api.tosspayments.com/", "https://api.tosspayments.com:444/", "https://user:pass@api.tosspayments.com/", "ispmobile://TID=x", "javascript:alert(1)"}) {
            check(!AppNavigationPolicy.isTossPayment(url));
        }
        check(AppNavigationPolicy.paymentPageAllowed("https://card-auth.example.invalid/acs"));
        for (String url : new String[]{"http://card-auth.example.invalid/", "https://user@card-auth.example.invalid/", "https://card-auth.example.invalid:444/", "file:///x", "javascript:alert(1)", "https://accounts.google.com/", "https://appleid.apple.com/", "https://abc.supabase.co/auth/v1/authorize"}) {
            check(!AppNavigationPolicy.paymentPageAllowed(url));
        }
        for (String url : new String[]{"ispmobile://TID=x", "kakaotalk://kakaopay/pg?url=x", "supertoss://pay", "kb-acp://pay", "shinhan-sr-ansimclick://pay", "intent://pay#Intent;scheme=ispmobile;package=kvp.jjy.MispAndroid320;end", "market://details?id=x"}) {
            check(AppNavigationPolicy.isPaymentAppScheme(url));
        }
        for (String url : new String[]{"https://x.example/", "http://x.example/", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "file:///x", "blob:https://x", "content://x", "about:blank", "stiz-academy-android-dev://auth", "no-colon", ":x", "1abc://x", null}) {
            check(!AppNavigationPolicy.isPaymentAppScheme(url));
        }
        // 2026-11-13: 문자·지도 앱, 바깥 링크는 브라우저로, 본인인증 흐름, 파일 받기 허용 범위
        for (String url : new String[]{"sms:01000000000", "sms:010-0000-0000?body=%EC%95%88%EB%85%95", "sms:?body=x", "nmap://route/car?dlat=37.6", "kakaomap://route?ep=37.6,127.1", "https://map.kakao.com/link/map/STIZ,37.6,127.1"}) {
            check(AppNavigationPolicy.externalActionAllowed(url, true));
        }
        check(!AppNavigationPolicy.externalActionAllowed("sms:01000000000", false));
        check(!AppNavigationPolicy.externalActionAllowed("sms:javascript:alert(1)", true));
        for (String url : new String[]{"https://pf.kakao.com/_HhaQG", "https://blog.naver.com/x", "https://abc.supabase.co/storage/v1/object/public/notices/a.pdf"}) {
            check(AppNavigationPolicy.openInBrowserAllowed(origin, url, true));
            check(!AppNavigationPolicy.openInBrowserAllowed(origin, url, false));
        }
        for (String url : new String[]{origin + "/mypage", "http://example.invalid/", "https://user@example.invalid/", "https://example.invalid:444/", "https://accounts.google.com/", "https://appleid.apple.com/",
            "https://abc.supabase.co/auth/v1/authorize", "https://abc.supabase.co/storage/v1/object/sign/x.pdf", "https://abc.supabase.co/storage/v1/object/public/../../auth/v1/authorize", "intent://x#Intent;end", "javascript:alert(1)", "file:///x"}) {
            check(!AppNavigationPolicy.openInBrowserAllowed(origin, url, true));
        }
        for (String url : new String[]{"https://checkout-service.prod.iamport.co/identity", "https://service.iamport.kr/certifications", "https://portone.io/", "https://sa.inicis.com/auth"}) {
            check(AppNavigationPolicy.isIdentityVerification(url));
            check(AppNavigationPolicy.isExternalFlowStart(url));
        }
        for (String url : new String[]{"https://portone.io.evil.example/", "https://evilinicis.com/", "http://sa.inicis.com/", "https://sa.inicis.com:444/", "https://user@sa.inicis.com/"}) {
            check(!AppNavigationPolicy.isIdentityVerification(url));
        }
        check(AppNavigationPolicy.isExternalFlowStart("https://api.tosspayments.com/v1/payments"));
        check(AppNavigationPolicy.downloadAllowed(origin, origin + "/api/admin/export.csv"));
        check(AppNavigationPolicy.downloadAllowed(origin, "https://abc.supabase.co/storage/v1/object/public/a.pdf"));
        for (String url : new String[]{"blob:https://www.stiz-dasan.kr/x", "data:text/csv,a", "https://evil.invalid/a.pdf", "http://www.stiz-dasan.kr/a.pdf", "https://abc.supabase.co/storage/v1/object/sign/a.pdf"}) {
            check(!AppNavigationPolicy.downloadAllowed(origin, url));
        }
        System.out.println("PASS " + checks + " unified navigation/run-state policy checks; no network/location calls");
    }
}
