import Foundation

// 개발용 주소가 잘못되면 운영 사이트로 돌아가지 않고 연결을 멈춘다.
enum SandboxConfiguration: Equatable {
    case disabled, active(URL), invalid

    static func resolve(_ value: Any?, debugBuild: Bool) -> SandboxConfiguration {
        guard debugBuild else { return .disabled }
        guard let value = value else { return .disabled }
        guard let text = value as? String else { return .invalid }
        if text.isEmpty { return .disabled }
        guard !text.contains("%"), !text.contains("\\"),
              let parts = URLComponents(string: text), parts.scheme == "https",
              let host = parts.host, parts.port == 8453,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              text == "https://\(host):8453" || text == "https://\(host):8453/",
              isPrivateHost(host), let origin = URL(string: "https://\(host):8453/") else { return .invalid }
        return .active(origin)
    }

    private static func isPrivateHost(_ host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" { return true }
        let items = host.split(separator: ".", omittingEmptySubsequences: false)
        guard items.count == 4 else { return false }
        let numbers = items.compactMap { Int($0) }
        guard numbers.count == 4,
              zip(items, numbers).allSatisfy({ String($0.1) == String($0.0) && (0...255).contains($0.1) }) else { return false }
        return numbers[0] == 10 || (numbers[0] == 192 && numbers[1] == 168) ||
            (numbers[0] == 172 && (16...31).contains(numbers[1]))
    }

    var isRequested: Bool { self != .disabled }
    var origin: URL? { if case .active(let value) = self { return value }; return nil }

    // 주 화면뿐 아니라 사진·스크립트·fetch 등의 외부 통신도 같은 시험 서버로만 제한한다.
    var contentRules: String? {
        guard let origin = origin else { return nil }
        let prefix = "^" + origin.absoluteString.replacingOccurrences(of: ".", with: "\\.")
        var rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
            ["trigger": ["url-filter": prefix], "action": ["type": "ignore-previous-rules"]]
        ]
        for path in ["auth/", "api/auth/", "api/payments/", "payments/", "checkout/", "driver/", "staff/run", "staff/shuttle"] {
            rules.append(["trigger": ["url-filter": prefix + path], "action": ["type": "block"]])
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: rules) else { return nil }
        return String(data: bytes, encoding: .utf8)
    }
}

// 웹의 역할·권한 판단을 그대로 사용한다. 앱은 이동할 수 있는 주소만 제한한다.
enum NavigationPolicy {
    static let sandbox: SandboxConfiguration = {
        #if DEBUG
        return SandboxConfiguration.resolve(Bundle.main.object(forInfoDictionaryKey: "STIZSandboxOrigin"), debugBuild: true)
        #else
        return .disabled
        #endif
    }()
    static var entry: URL {
        if let origin = sandbox.origin { return origin.appendingPathComponent("store-app") }
        if sandbox.isRequested { return URL(string: "about:blank")! }
        return URL(string: "https://www.stiz-dasan.kr/store-app")!
    }
    enum Decision: Equatable { case website, external, blockedAuthentication, blocked }

    static func decide(_ url: URL, userInitiated: Bool, configuration: SandboxConfiguration = sandbox) -> Decision {
        guard url.user == nil, url.password == nil else { return .blocked }
        let scheme = url.scheme?.lowercased() ?? ""
        if configuration.isRequested {
            guard matchesWebsiteOrigin(url, configuration: configuration), let path = canonicalPath(url) else { return .blocked }
            if path == "/auth" || path.hasPrefix("/auth/") || path == "/api/auth" || path.hasPrefix("/api/auth/") { return .blockedAuthentication }
            if path == "/driver" || path.hasPrefix("/driver/") ||
                path == "/staff/run" || path.hasPrefix("/staff/run/") ||
                path == "/staff/shuttle" || path.hasPrefix("/staff/shuttle/") ||
                path == "/api/payments" || path.hasPrefix("/api/payments/") ||
                path == "/payments" || path.hasPrefix("/payments/") ||
                path == "/checkout" || path.hasPrefix("/checkout/") { return .blocked }
            return .website
        }
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
    static func allowsSubframe(_ url: URL, configuration: SandboxConfiguration = sandbox) -> Bool {
        if configuration.isRequested { return decide(url, userInitiated: false, configuration: configuration) == .website }
        return url.scheme?.lowercased() == "https" && url.host != nil &&
            url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
    }

    static func matchesWebsiteOrigin(_ url: URL, configuration: SandboxConfiguration = sandbox) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else { return false }
        if configuration.isRequested {
            guard let origin = configuration.origin else { return false }
            return url.host?.lowercased() == origin.host && url.port == origin.port
        }
        return url.host?.lowercased() == "www.stiz-dasan.kr" && (url.port == nil || url.port == 443)
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
