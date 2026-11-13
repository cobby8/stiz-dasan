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

    init(owner: UIViewController) { self.owner = owner }

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
        timeout = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in self?.cancel() }
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
                self.cancel(notice: unavailable ? "앱 간편로그인을 준비 중입니다. 아이디·비밀번호로 로그인해 주세요." : nil)
                return
            }
            self.pending?.flow = flow
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: NativeAuthPolicy.callbackScheme) { [weak self] callback, error in
                DispatchQueue.main.async { self?.returned(id: id, callback: error == nil ? callback : nil) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.authentication = session
            if !session.start() { self.cancel() }
        }
        task?.resume()
    }

    private func returned(id: UUID, callback: URL?) {
        guard let current = pending, current.id == id else { return }
        guard current.currentPage() == current.page,
              let callback = callback, let flow = current.flow,
              let code = NativeAuthPolicy.callbackCode(callback, flow: flow, state: current.state) else {
            // 서버가 «실패 이유»만 실어 돌려보낸 경우(학원 계정 없음·취소 등) 그에 맞는 안내
            let reason = callback.flatMap { url in current.flow.flatMap { NativeAuthPolicy.callbackFailure(url, flow: $0, state: current.state) } }
            cancel(notice: reason.map { NativeAuthPolicy.failureMessage($0) })
            return
        }
        var request = URLRequest(url: URL(string: "https://www.stiz-dasan.kr/auth/native/consume")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        // 값은 모두 제한된 문자만 허용한다. 로그인 토큰을 URL이나 JavaScript에 전달하지 않는다.
        request.httpBody = Data("flowId=\(flow)&code=\(code)&codeVerifier=\(current.verifier)&state=\(current.state)".utf8)
        finish(request)
    }

    func cancelIfPageChanged(_ page: URL?) {
        if let current = pending, page != current.page { cancel() }
    }

    func cancel(notice: String? = nil) {
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
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["flowId": flow,
                "codeVerifier": current.verifier, "state": current.state])
            transport.dataTask(with: request).resume()
        }
    }

    func shutdown() {
        cancel()
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
