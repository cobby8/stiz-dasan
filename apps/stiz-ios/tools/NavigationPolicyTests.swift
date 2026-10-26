import Foundation

@main
struct NavigationPolicyTests {
    static func main() {
        let cases: [(String, Bool, NavigationPolicy.Decision)] = [
            ("https://www.stiz-dasan.kr/store-app", false, .website),
            ("https://www.stiz-dasan.kr/auth/continue", false, .website),
            ("https://www.stiz-dasan.kr:443/admin", false, .website),
            ("https://www.stiz-dasan.kr/mypage", true, .website),
            ("https://www.stiz-dasan.kr/staff", true, .website),
            ("https://www.stiz-dasan.kr/account/withdraw", true, .website),
            ("https://www.stiz-dasan.kr/login?redirect=%2Fmypage", false, .website),
            ("https://www.stiz-dasan.kr/auth/oauth/google", true, .blockedAuthentication),
            ("https://www.stiz-dasan.kr/auth/oauth/apple", true, .blockedAuthentication),
            ("https://www.stiz-dasan.kr/api/auth/parent-link/start", false, .blockedAuthentication),
            ("https://www.stiz-dasan.kr/driver", true, .blocked),
            ("https://www.stiz-dasan.kr/driver/example", true, .blocked),
            ("https://www.stiz-dasan.kr/staff/run", true, .blocked),
            ("https://www.stiz-dasan.kr/staff/shuttle", true, .blocked),
            ("https://www.stiz-dasan.kr/staff//run", true, .blocked),
            ("https://www.stiz-dasan.kr/staff%2Frun", true, .blocked),
            ("https://www.stiz-dasan.kr/driver%252Fexample", true, .blocked),
            ("https://www.stiz-dasan.kr/one/../driver/example", true, .blocked),
            ("https://www.stiz-dasan.kr:444/admin", false, .blocked),
            ("http://www.stiz-dasan.kr/admin", true, .blocked),
            ("https://fake.example/admin", false, .blocked),
            ("https://www.stiz-dasan.kr.fake.example/admin", false, .blocked),
            ("https://www.stiz-dasan.kr@fake.example/admin", true, .blocked),
            ("https://user:password@www.stiz-dasan.kr/admin", true, .blocked),
            ("file:///private/example", true, .blocked),
            ("javascript:alert(1)", true, .blocked),
            ("data:text/html,hello", true, .blocked),
            ("intent://example", true, .blocked),
            ("tel:000", false, .blocked),
            ("tel:000", true, .external),
            ("mailto:test@example.invalid", true, .external),
            ("maps://?q=academy", true, .external),
            ("https://maps.google.com/", true, .external),
            ("https://example.invalid/", true, .blocked),
            ("https://maps.google.com:444/", true, .blocked),
            ("https://accounts.google.com/", true, .blockedAuthentication),
            ("https://appleid.apple.com/", true, .blockedAuthentication),
            ("https://example.supabase.co/auth/v1/authorize", true, .blockedAuthentication)
        ]
        for (address, initiated, expected) in cases {
            guard let url = URL(string: address) else { fatalError("Invalid fixture") }
            precondition(NavigationPolicy.decide(url, userInitiated: initiated) == expected, "Navigation case failed: \(address)")
        }
        for address in ["http://example.invalid", "tel:000", "javascript:alert(1)", "https://user:pass@map.naver.com", "https://map.naver.com:444/"] {
            precondition(!NavigationPolicy.allowsSubframe(URL(string: address)!))
        }
        precondition(NavigationPolicy.allowsSubframe(URL(string: "https://map.naver.com/")!))
        print("STIZ iOS navigation policy: \(cases.count) cases passed")
    }
}
