import Foundation

// 웹 인증 요청을 새로 만들지 않고, 현재 웹 화면에서 시작한 파일만 내려받는다.
enum DownloadPolicy {
    static let maximumBytes: Int64 = 10 * 1024 * 1024
    private static let extensions: [String: Set<String>] = [
        "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"],
        "application/pdf": ["pdf"], "text/plain": ["txt"], "text/csv": ["csv"]
    ]

    static func allowsURL(_ url: URL, from page: URL, configuration: SandboxConfiguration = NavigationPolicy.sandbox) -> Bool {
        guard NavigationPolicy.decide(page, userInitiated: false, configuration: configuration) == .website,
              NavigationPolicy.decide(url, userInitiated: false, configuration: configuration) == .website,
              url.fragment == nil, page.scheme == "https", url.scheme == "https",
              url.host?.lowercased() == page.host?.lowercased(),
              (url.port ?? 443) == (page.port ?? 443) else { return false }
        return true
    }

    static func accepts(filename: String, mime: String, length: Int64) -> Bool {
        guard length > 0, length <= maximumBytes, !filename.isEmpty, filename.utf8.count <= 120,
              filename == filename.precomposedStringWithCanonicalMapping,
              !filename.hasPrefix("."), !filename.contains(".."),
              !filename.contains("/"), !filename.contains("\\"), !filename.contains("%"),
              !filename.contains(":"), filename == filename.trimmingCharacters(in: .whitespacesAndNewlines),
              filename.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) &&
                  !CharacterSet(charactersIn: "\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}").contains($0) }),
              let allowed = extensions[mime.lowercased()] else { return false }
        let parts = filename.split(separator: ".", omittingEmptySubsequences: false)
        // 이중 확장자는 파일 종류를 오인하기 쉬워 허용하지 않는다.
        return parts.count == 2 && !parts[0].isEmpty && allowed.contains(String(parts[1]).lowercased())
    }

    static func contentMatches(_ header: Data, mime: String) -> Bool {
        switch mime.lowercased() {
        case "image/png": return header.starts(with: [137, 80, 78, 71, 13, 10, 26, 10])
        case "image/jpeg": return header.starts(with: [255, 216, 255])
        case "image/webp": return header.count >= 12 && header.prefix(4) == Data("RIFF".utf8) && header.dropFirst(8).prefix(4) == Data("WEBP".utf8)
        case "application/pdf": return header.starts(with: Data("%PDF-".utf8))
        case "text/plain", "text/csv":
            guard !header.contains(0), let text = String(data: header, encoding: .utf8) else { return false }
            let prefix = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))).lowercased()
            return !prefix.hasPrefix("<") && !prefix.hasPrefix("#!") && !prefix.hasPrefix("mz")
        default: return false
        }
    }
}

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
    // paymentStart: 토스 결제창·포트원 본인인증 시작(이때부터 «결제·인증 중») · paymentPage: 그 중의 카드사·통신사 인증 화면
    // paymentApp: 결제·인증 중 카드사·간편결제·인증 앱 호출 · blockedDriver: 기사님 운행 위치 화면(Android 전용)
    // external: 사용자가 누른 바깥 링크·전화·문자·지도 — 앱 안이 아니라 Safari·시스템 앱으로 연다
    enum Decision: Equatable { case website, external, paymentStart, paymentPage, paymentApp, blockedAuthentication, blockedDriver, blocked }

    // 토스 결제창 주소. 「tosspayments.com.evil.example」처럼 뒤에 붙인 가짜 주소는 끝부분 비교로 걸러진다.
    static func isTossPayment(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased() else { return false }
        return ["tosspayments.com", "toss.im"].contains { host == $0 || host.hasSuffix("." + $0) }
    }

    // 포트원(옛 아임포트)·KG이니시스 본인인증 화면. 자녀 연결·기존 계정 연결의 본인인증이 이 주소로 넘어간다.
    // 여기서 시작하면 결제와 같은 «진행 중» 상태가 되어 통신사·인증 앱 화면을 잠시 허용하고, 우리 사이트로 돌아오면 다시 잠근다.
    // ⚠️ 실제 경유 도메인은 실기기로 확인해야 한다(포트원 SDK 가 채널마다 다른 화면으로 보낸다).
    static let identityHosts = ["portone.io", "iamport.kr", "iamport.co", "inicis.com"]
    static func isIdentityVerification(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased() else { return false }
        return identityHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    // Supabase 저장소의 «공개 파일»(사진·첨부 PDF 등). 로그인 화면이 아니므로 사용자가 누르면 Safari 로 연다(Safari 가 보여 주거나 내려받는다).
    static func isSupabasePublicFile(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased(), host.hasSuffix(".supabase.co"),
              let path = canonicalPath(url) else { return false }
        return path.hasPrefix("/storage/v1/object/public/")
    }

    // 결제 중 바깥 앱으로 넘길 수 있는 주소. 웹 실행·파일 주소는 앱 이름처럼 보여도 넘기지 않는다.
    static func isPaymentAppScheme(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        guard !scheme.isEmpty, scheme.range(of: "^[a-z][a-z0-9+.-]*$", options: .regularExpression) != nil else { return false }
        return !["http", "https", "about", "data", "javascript", "file", "blob", "ftp", "stiz-academy-dev"].contains(scheme)
    }

    static func decide(_ url: URL, userInitiated: Bool, paymentActive: Bool = false, configuration: SandboxConfiguration = sandbox) -> Decision {
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
            // 운행 «위치 전송»(/driver·/staff/run)은 Android 앱에서만 한다. 아이폰은 백그라운드 위치 권한·심사 준비가 없어서다.
            // 셔틀 조회·승하차 체크(/staff/shuttle)는 위치를 쓰지 않으므로 아이폰에서도 연다(기사님이 로그인 후 멈추던 문제).
            if path == "/driver" || path.hasPrefix("/driver/") ||
                path == "/staff/run" || path.hasPrefix("/staff/run/") { return .blockedDriver }
            return .website
        }
        // 토스 결제창·본인인증 화면은 웹이 스스로 화면을 넘기므로(사용자 탭이 아님) 탭 여부와 관계없이 연다.
        if isTossPayment(url) || isIdentityVerification(url) { return .paymentStart }
        if paymentActive {
            if scheme == "https", let host = url.host?.lowercased() {
                // 결제 중에도 로그인 화면은 기존처럼 막는다.
                if host == "accounts.google.com" || host == "appleid.apple.com" || host.hasSuffix(".supabase.co") { return .blockedAuthentication }
                // 카드 앱이 없을 때 결제창이 보내는 앱스토어 주소는 웹뷰가 아니라 앱스토어 앱으로 연다.
                if host == "apps.apple.com" || host == "itunes.apple.com" { return .paymentApp }
                // 원장 결정(2026-11-09): 결제 중엔 카드사 인증 화면 등 https 이동을 모두 허용한다.
                return .paymentPage
            }
            if isPaymentAppScheme(url) { return .paymentApp }
        }
        // 여기부터는 사용자가 직접 누른 링크만 다룬다. iframe·스크립트의 자동 이동은 지금처럼 막는다.
        guard userInitiated else { return .blocked }
        // 전화·메일·문자·지도 앱. nmap(네이버지도)·kakaomap(카카오맵)·tmap(티맵)은 길찾기 버튼이 쓴다.
        if ["tel", "mailto", "sms", "maps", "nmap", "kakaomap", "tmap"].contains(scheme) { return .external }
        if scheme == "https", let host = url.host?.lowercased(), url.port == nil || url.port == 443 {
            // 로그인 화면은 Safari 로 넘겨도 앱 로그인이 되지 않으므로 기존처럼 안내한다.
            if host == "accounts.google.com" || host == "appleid.apple.com" { return .blockedAuthentication }
            if host.hasSuffix(".supabase.co") { return isSupabasePublicFile(url) ? .external : .blockedAuthentication }
            // 그 밖의 바깥 사이트(블로그·카카오채널·지도·공지 첨부 등)는 막지 않고 Safari 로 연다(원장 승인 2026-11-13).
            return .external
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
