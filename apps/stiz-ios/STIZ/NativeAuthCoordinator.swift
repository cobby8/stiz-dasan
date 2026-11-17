import UIKit
import AuthenticationServices
import CryptoKit
import Security

// 외부 브라우저 쿠키를 복사하지 않는다. 앱 메모리에만 둔 비밀값으로 단회 코드를 교환한다.
final class NativeAuthCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding, URLSessionTaskDelegate {
    private struct Pending {
        let id: UUID
        let verifier: String
        let state: String
        var flow: String?
        let page: URL
        let currentPage: () -> URL?
        // 성공이면 consume 요청, 실패면 nil + 안내 문구(없으면 기본 안내)
        let completion: (URLRequest?, String?) -> Void
    }
    private weak var owner: UIViewController?
    private var pending: Pending?
    private var authentication: ASWebAuthenticationSession?
    private var task: URLSessionDataTask?
    private var timeout: Timer?
    private lazy var transport: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()

    static var enabled: Bool {
        // 앱 간편로그인(a1, 2026-11-13 운영 전환).
        // 출시 빌드: 기능을 넣어 두고(복귀 주소 kr.co.upturnlabs.stizdasan) 실제 허용은 서버 스위치(NATIVE_AUTH_ENABLED)가 정한다.
        //           서버가 꺼져 있으면 시작 요청이 503 으로 막혀 안내만 뜬다. 웹도 그때는 버튼을 보이지 않는다.
        // 개발 빌드: 기존처럼 Info-Debug 의 STIZNativeAuthDevelopmentEnabled 를 직접 켤 때만(개발 복귀 주소).
        #if DEBUG
        guard !NavigationPolicy.sandbox.isRequested else { return false }
        return Bundle.main.object(forInfoDictionaryKey: "STIZNativeAuthDevelopmentEnabled") as? Bool == true
        #else
        return true
        #endif
    }

    /// 인증 창을 열어 두는 최대 시간(1.0.6: 15분 — 간편가입까지 마칠 수 있게)
    static let lifetime: TimeInterval = 15 * 60

    init(owner: UIViewController) { self.owner = owner }

    /// 우리 사이트 화면인가 — 1.0.6 부터 진행 중인 로그인은 사이트 «밖»으로 나갈 때만 취소한다.
    /// 안전 근거: 로그인 완료는 복귀 시점에 flow·state·앱 메모리의 PKCE 비밀값으로 검증하고, 교환은 항상 우리 사이트로만 보낸다.
    private static func isWebsite(_ page: URL?) -> Bool {
        guard let page = page else { return false }
        return NavigationPolicy.decide(page, userInitiated: false) == .website
    }

    var isActive: Bool { pending != nil }

    private func randomToken() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        return encode(Data(bytes))
    }

    private func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    func start(provider: String, page: URL, currentPage: @escaping () -> URL?, completion: @escaping (URLRequest?, String?) -> Void) {
        guard Self.enabled, pending == nil, NativeAuthPolicy.providers.contains(provider),
              NavigationPolicy.decide(page, userInitiated: false) == .website,
              let verifier = randomToken(), let state = randomToken() else { completion(nil, nil); return }
        let id = UUID()
        pending = Pending(id: id, verifier: verifier, state: state, flow: nil, page: page, currentPage: currentPage, completion: completion)
        // 1.0.6: 300초 → 15분. 학원 계정이 없으면 서버가 이 인증 창 안에서 간편가입 화면으로 보내므로(2026-11-17),
        // 가입을 마칠 시간을 준다. 로그인 완료 자체는 서버의 1회용 code 수명(5분)이 따로 지킨다.
        timeout = Timer.scheduledTimer(withTimeInterval: Self.lifetime, repeats: false) { [weak self] _ in
            self?.cancel(notice: "로그인 시간이 지났습니다. 가입을 마치셨다면 앱에서 다시 로그인해 주세요.", reason: "timeout")
        }
        let challenge = encode(Data(SHA256.hash(data: Data(verifier.utf8))))
        var request = URLRequest(url: URL(string: "https://www.stiz-dasan.kr/auth/native/start")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["platform": "ios", "provider": provider,
                                                                       "codeChallenge": challenge, "state": state])
        task = transport.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self, self.pending?.id == id else { return }
            guard error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let data = data, data.count < 16384,
                  let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let flow = body["flowId"] as? String, NativeAuthPolicy.isToken(flow, min: 43, max: 43),
                  let address = body["browserUrl"] as? String, let url = URL(string: address),
                  NativeAuthPolicy.isBrowserURL(url, flow: flow) else {
                // 서버 스위치가 꺼져 있으면(503) 준비 중 안내
                let unavailable = (response as? HTTPURLResponse)?.statusCode == 503
                self.cancel(notice: unavailable ? "앱 간편로그인을 준비 중입니다. 아이디·비밀번호로 로그인해 주세요." : nil, reason: "start_failed")
                return
            }
            self.pending?.flow = flow
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: NativeAuthPolicy.callbackScheme) { [weak self] callback, error in
                DispatchQueue.main.async { self?.returned(id: id, callback: error == nil ? callback : nil) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.authentication = session
            if !session.start() { self.cancel(reason: "browser_failed") }
        }
        task?.resume()
    }

    private func returned(id: UUID, callback: URL?) {
        guard let current = pending, current.id == id else { return }
        // 1.0.6: 로그인 버튼을 누른 «그 주소»가 아니어도 우리 사이트 화면이면 이어서 로그인한다.
        guard Self.isWebsite(current.currentPage()),
              let callback = callback, let flow = current.flow,
              let code = NativeAuthPolicy.callbackCode(callback, flow: flow, state: current.state) else {
            // 서버가 «실패 이유»만 실어 돌려보낸 경우(학원 계정 없음·취소 등) 그에 맞는 안내.
            // 복귀 주소 없이 창을 닫은 경우(간편가입하러 갔다 닫은 경우 포함)는 기본 안내(failureMessage(nil)).
            let reason = callback.flatMap { url in current.flow.flatMap { NativeAuthPolicy.callbackFailure(url, flow: $0, state: current.state) } }
            cancel(notice: NativeAuthPolicy.failureMessage(reason), reason: callback == nil ? "returned_empty" : "return_failed")
            return
        }
        var request = URLRequest(url: URL(string: "https://www.stiz-dasan.kr/auth/native/consume")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        // 값은 모두 제한된 문자만 허용한다. 로그인 토큰을 URL이나 JavaScript에 전달하지 않는다.
        request.httpBody = Data("flowId=\(flow)&code=\(code)&codeVerifier=\(current.verifier)&state=\(current.state)".utf8)
        finish(request)
    }

    /// 웹뷰 화면이 바뀌었을 때(1.0.6): 우리 사이트 안의 이동·다시 불러오기면 그대로 두고, 사이트 밖이면 취소한다.
    /// 주소가 아직 없는(nil) 순간은 판단하지 않는다 — 불러오는 중에 잠깐 비는 경우가 있다.
    func cancelIfLeftWebsite(_ page: URL?) {
        guard let current = pending, let page = page, page != current.page, !Self.isWebsite(page) else { return }
        cancel(reason: "page_left")
    }

    /// 결제창처럼 사이트 밖 흐름을 시작할 때 — 진행 중인 로그인을 그만둔다
    func cancelForExternalFlow() { cancel(reason: "page_left") }

    /// reason: 서버 기록용 한 단어(NativeAuthPolicy.cancelReasons 중 하나, 개인정보 없음)
    func cancel(notice: String? = nil, reason: String = "app_closed") {
        guard let current = pending else { return }
        let activeSession = authentication
        let activeTask = task
        // 먼저 대기를 해제해 늦게 도착한 브라우저 결과가 다시 처리되지 않게 한다.
        finish(nil, notice: notice)
        activeTask?.cancel()
        activeSession?.cancel()
        if let flow = current.flow {
            var request = URLRequest(url: URL(string: "https://www.stiz-dasan.kr/auth/native/cancel")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let known = NativeAuthPolicy.cancelReasons.contains(reason) ? reason : "app_closed"
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["flowId": flow,
                "codeVerifier": current.verifier, "state": current.state, "reason": known])
            transport.dataTask(with: request).resume()
        }
    }

    func shutdown() {
        cancel(reason: "app_closed")
        transport.invalidateAndCancel()
    }

    private func finish(_ request: URLRequest?, notice: String? = nil) {
        guard let current = pending else { return }
        pending = nil
        timeout?.invalidate()
        timeout = nil
        authentication = nil
        current.completion(request, notice)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        owner?.view.window ?? ASPresentationAnchor()
    }

    // 시작·취소 요청이 다른 사이트로 전송돼 비밀값이 새지 않도록 주소 전환을 거절한다.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
