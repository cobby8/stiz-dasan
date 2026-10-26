import Foundation

// 웹의 역할·권한 판단을 그대로 사용한다. 앱은 이동할 수 있는 주소만 제한한다.
enum NavigationPolicy {
    static let entry = URL(string: "https://www.stiz-dasan.kr/store-app")!
    enum Decision: Equatable { case website, external, blockedAuthentication, blocked }

    static func decide(_ url: URL, userInitiated: Bool) -> Decision {
        guard url.user == nil, url.password == nil else { return .blocked }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "https", url.host?.lowercased() == "www.stiz-dasan.kr",
           url.port == nil || url.port == 443 {
            guard let path = canonicalPath(url) else { return .blocked }
            // 브라우저와 앱의 안전한 로그인 인계가 완성되기 전에는 소셜 인증을 시작하지 않는다.
            if path.hasPrefix("/api/auth/") || (path.hasPrefix("/auth/") && path != "/auth/continue") {
                return .blockedAuthentication
            }
            // iOS는 학부모·선생님·관리자용이다. 운행 위치 공유는 Android 앱에서만 한다.
            if path == "/driver" || path.hasPrefix("/driver/") ||
                path == "/staff/run" || path.hasPrefix("/staff/run/") ||
                path == "/staff/shuttle" || path.hasPrefix("/staff/shuttle/") { return .blocked }
            return .website
        }
        guard userInitiated else { return .blocked }
        if ["tel", "mailto", "maps"].contains(scheme) { return .external }
        if scheme == "https", url.host != nil {
            let host = url.host!.lowercased()
            if host == "accounts.google.com" || host == "appleid.apple.com" ||
                host.hasSuffix(".supabase.co") { return .blockedAuthentication }
            if url.port == nil || url.port == 443,
               ["maps.google.com", "maps.apple.com", "map.naver.com", "map.kakao.com", "naver.me", "kko.to"].contains(host) {
                return .external
            }
        }
        return .blocked
    }

    // 지도·인증 등의 iframe은 HTTPS 콘텐츠만 표시하고, 앱 실행/새 창 권한은 주지 않는다.
    static func allowsSubframe(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host != nil &&
            url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
    }

    private static func canonicalPath(_ url: URL) -> String? {
        guard let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
              let decoded = encoded.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.contains("%") else { return nil }
        let parts = decoded.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.contains("."), !parts.contains("..") else { return nil }
        return "/" + parts.joined(separator: "/").lowercased()
    }
}
