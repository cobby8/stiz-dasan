import Foundation

// 인증 결과는 임의 링크가 아니라 이 앱이 시작한 요청과 정확히 일치해야 한다.
// 복귀 주소(2026-11-13 운영 전환, a1): 출시 = 스토어 앱 ID, 개발 = 기존 개발 주소. 서버(src/lib/native-auth/policy.ts)와 같은 이름.
// ASWebAuthenticationSession 이 이 주소를 직접 받아 인증창을 닫으므로 다른 앱이 가로챌 수 없고 Info.plist 등록도 필요 없다.
enum NativeAuthPolicy {
    static let developmentCallbackScheme = "stiz-academy-dev"
    static let releaseCallbackScheme = "kr.co.upturnlabs.stizdasan"
    /// 서버가 브라우저 로그인 실패 때 돌려주는 이유(src/lib/native-auth/service.ts 와 같게)
    static let failures: Set<String> = ["no_account", "cancelled", "failed"]
    static func callbackScheme(debug: Bool) -> String { debug ? developmentCallbackScheme : releaseCallbackScheme }
    static var callbackScheme: String {
        #if DEBUG
        return callbackScheme(debug: true)
        #else
        return callbackScheme(debug: false)
        #endif
    }
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

    static func callbackCode(_ url: URL, flow: String, state: String, scheme: String = NativeAuthPolicy.callbackScheme) -> String? {
        guard url.scheme == scheme, url.host == "auth", url.path == "/return",
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

    /// 서버가 «실패 이유»만 실어 돌려보낸 복귀(flow·state·error)면 그 이유. code 가 없으므로 로그인되지 않는다.
    static func callbackFailure(_ url: URL, flow: String, state: String, scheme: String = NativeAuthPolicy.callbackScheme) -> String? {
        guard url.scheme == scheme, url.host == "auth", url.path == "/return",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let query = parts.queryItems, query.count == 3,
              Set(query.map(\.name)) == Set(["flow", "state", "error"]),
              query.first(where: { $0.name == "flow" })?.value == flow,
              query.first(where: { $0.name == "state" })?.value == state,
              let reason = query.first(where: { $0.name == "error" })?.value,
              failures.contains(reason) else { return nil }
        return reason
    }

    /// 실패 이유별 안내(모르면 일반 안내)
    static func failureMessage(_ reason: String?) -> String {
        switch reason {
        case "no_account": return "이 간편로그인으로 가입된 학원 계정이 없습니다. 아이디·비밀번호로 로그인하거나 회원가입을 해 주세요."
        case "cancelled": return "간편로그인을 취소했습니다."
        default: return "로그인이 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요."
        }
    }
}
