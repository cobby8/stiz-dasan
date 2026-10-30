import Foundation

// 인증 결과는 임의 링크가 아니라 이 앱이 시작한 요청과 정확히 일치해야 한다.
enum NativeAuthPolicy {
    static let callbackScheme = "stiz-academy-dev"
    static let providers: Set<String> = ["google", "kakao", "naver", "apple"]

    static func provider(from url: URL) -> String? {
        guard url.scheme == "https", url.host == "www.stiz-dasan.kr",
              url.port == nil || url.port == 443, url.user == nil, url.password == nil,
              url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let parts = url.path.split(separator: "/")
        guard parts.count == 3, parts[0] == "auth", parts[1] == "oauth",
              url.path == "/auth/oauth/\(parts[2])", providers.contains(String(parts[2])) else { return nil }
        let items = components.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count,
              items.allSatisfy({ $0.name == "intent" }),
              items.first(where: { $0.name == "intent" })?.value == "login" else { return nil }
        // 가입·기존 계정 연결·수강신청 인계는 별도 승인 흐름이므로 여기서 로그인으로 바꾸지 않는다.
        return String(parts[2])
    }

    static func isToken(_ value: String, min: Int = 32, max: Int = 128) -> Bool {
        value.count >= min && value.count <= max &&
            value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) ||
                (48...57).contains($0) || $0 == 45 || $0 == 95 }
    }

    static func isBrowserURL(_ url: URL, flow: String) -> Bool {
        guard url.scheme == "https", url.host == "www.stiz-dasan.kr",
              url.user == nil, url.password == nil, url.port == nil || url.port == 443,
              url.path == "/auth/native/browser", url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let query = parts.queryItems, query.count == 1 else { return false }
        return query[0].name == "flow" && query[0].value == flow
    }

    static func callbackCode(_ url: URL, flow: String, state: String) -> String? {
        guard url.scheme == callbackScheme, url.host == "auth", url.path == "/return",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let query = parts.queryItems, query.count == 3,
              Set(query.map(\.name)) == Set(["flow", "state", "code"]),
              query.first(where: { $0.name == "flow" })?.value == flow,
              query.first(where: { $0.name == "state" })?.value == state,
              let code = query.first(where: { $0.name == "code" })?.value,
              isToken(code, min: 43, max: 43) else { return nil }
        return code
    }
}
