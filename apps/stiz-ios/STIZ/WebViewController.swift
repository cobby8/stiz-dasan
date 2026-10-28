import UIKit
import WebKit

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private let progress = UIActivityIndicatorView(style: .medium)
    private let message = UILabel()
    private let retry = UIButton(type: .system)
    private var lastPage = NavigationPolicy.entry
    private var nativeAuth: NativeAuthCoordinator!
    private var nativeConsumePending = false
    private var nativeAwaitingResponse = false
    private var nativeConsumeTimeout: Timer?
    private var pageObservation: NSKeyValueObservation?
    private var sandboxProtectionReady = !NavigationPolicy.sandbox.isRequested

    override func viewDidLoad() {
        super.viewDidLoad()
        nativeAuth = NativeAuthCoordinator(owner: self)
        view.backgroundColor = UIColor(named: "Canvas")
        let configuration = WKWebViewConfiguration()
        // 시험 앱은 운영 로그인 쿠키·저장소를 공유하지 않는다.
        configuration.websiteDataStore = NavigationPolicy.sandbox.isRequested ? .nonPersistent() : .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        if #available(iOS 16.4, *) {
            // 운영 화면은 검사 연결을 열지 않고, 유효한 격리 시험 주소에서만 허용한다.
            webView.isInspectable = false
            #if DEBUG
            webView.isInspectable = NavigationPolicy.sandbox.origin != nil
            #endif
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        pageObservation = webView.observe(\.url, options: [.new]) { [weak self] _, _ in
            guard let self = self else { return }
            self.nativeAuth.cancelIfPageChanged(self.webView.url)
        }
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        let topInset: CGFloat = NavigationPolicy.sandbox.isRequested ? 28 : 0
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: topInset),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        if NavigationPolicy.sandbox.isRequested {
            let badge = UILabel()
            badge.text = "시험 환경 · 합성 자료"
            badge.textAlignment = .center
            badge.textColor = UIColor(named: "AccentColor")
            badge.backgroundColor = UIColor(named: "Canvas")
            badge.font = .preferredFont(forTextStyle: .caption1)
            badge.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(badge)
            NSLayoutConstraint.activate([
                badge.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
                badge.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
                badge.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                badge.heightAnchor.constraint(equalToConstant: topInset)
            ])
        }
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.hidesWhenStopped = true
        view.addSubview(progress)
        NSLayoutConstraint.activate([
            progress.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8)
        ])
        message.text = "화면을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."
        message.numberOfLines = 0
        message.textAlignment = .center
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        retry.setTitle("다시 불러오기", for: .normal)
        retry.tintColor = UIColor(named: "AccentColor")
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.titleLabel?.adjustsFontForContentSizeCategory = true
        retry.addTarget(self, action: #selector(reloadPage), for: .touchUpInside)
        let recovery = UIStackView(arrangedSubviews: [message, retry])
        recovery.axis = .vertical
        recovery.spacing = 16
        recovery.translatesAutoresizingMaskIntoConstraints = false
        recovery.tag = 101
        recovery.isHidden = true
        view.addSubview(recovery)
        NSLayoutConstraint.activate([
            recovery.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            recovery.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            recovery.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        prepareSandboxProtection()
    }

    private func prepareSandboxProtection() {
        guard NavigationPolicy.sandbox.isRequested else { reloadPage(); return }
        guard let rules = NavigationPolicy.sandbox.contentRules else {
            showSandboxFailure("시험 서버 주소가 올바르지 않습니다. 개발용 HTTPS 시험 주소 설정을 확인해 주세요.")
            return
        }
        // 차단 규칙이 준비되기 전에는 첫 페이지도 읽지 않는다. 실패 시 운영 주소로 우회하지 않는다.
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "STIZ-Isolated-Sandbox", encodedContentRuleList: rules) { [weak self] list, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard error == nil, let list = list else {
                    self.showSandboxFailure("시험 통신 차단 설정을 준비하지 못했습니다. 앱을 다시 열어 주세요.")
                    return
                }
                self.webView.configuration.userContentController.add(list)
                self.sandboxProtectionReady = true
                self.reloadPage()
            }
        }
    }

    private func showSandboxFailure(_ text: String) {
        sandboxProtectionReady = false
        message.text = text
        webView.isHidden = true
        retry.isEnabled = false
        view.viewWithTag(101)?.isHidden = false
    }

    @objc private func reloadPage() {
        guard sandboxProtectionReady else { return }
        view.viewWithTag(101)?.isHidden = true
        webView.isHidden = false
        webView.load(URLRequest(url: lastPage))
    }

    private func alert(_ text: String) {
        guard presentedViewController == nil else { return }
        let dialog = UIAlertController(title: "안내", message: text, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "확인", style: .default))
        present(dialog, animated: true)
    }

    private func approve(_ action: WKNavigationAction) -> Bool {
        guard let url = action.request.url else { return false }
        switch NavigationPolicy.decide(url, userInitiated: action.navigationType == .linkActivated) {
        case .website:
            nativeAuth.cancelIfPageChanged(nil)
            return true
        case .external:
            if action.sourceFrame.isMainFrame { UIApplication.shared.open(url) }
        case .blockedAuthentication:
            if NavigationPolicy.sandbox.isRequested {
                alert("시험 환경에서는 실제 로그인·발송·결제를 사용할 수 없습니다.")
                return false
            }
            if NativeAuthCoordinator.enabled, action.sourceFrame.isMainFrame,
               action.navigationType == .linkActivated, let page = webView.url,
               let provider = NativeAuthPolicy.provider(from: url) {
                if !nativeAuth.isActive && !nativeAwaitingResponse {
                    nativeAuth.start(provider: provider, page: page, currentPage: { [weak self] in self?.webView.url }) { [weak self] request in
                        guard let self = self else { return }
                        guard let request = request else {
                            self.alert("로그인이 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요.")
                            return
                        }
                        self.nativeConsumePending = true
                        self.nativeAwaitingResponse = true
                        self.webView.load(request)
                        self.nativeConsumeTimeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                            guard let self = self, self.nativeAwaitingResponse else { return }
                            self.nativeConsumePending = false
                            self.nativeAwaitingResponse = false
                            self.webView.stopLoading()
                            self.alert("로그인 응답이 지연되고 있습니다. 기존 화면에서 다시 시도해 주세요.")
                            self.reloadPage()
                        }
                    }
                }
                return false
            }
            alert("앱의 간편로그인은 준비 중입니다. 이메일·비밀번호로 로그인해 주세요. 웹사이트에서는 기존 간편로그인을 사용할 수 있습니다.")
        case .blocked:
            alert(NavigationPolicy.sandbox.isRequested ? "시험 앱에서는 시험 서버 안의 화면만 열 수 있습니다." : "이 주소는 앱에서 열 수 없습니다. 기사님 운행은 Android 기사님 앱을 이용해 주세요.")
        }
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 앱이 만든 POST에만 단 한 번 허용한다. 웹 링크가 같은 주소를 열어도 통과하지 않는다.
        if nativeConsumePending && !NavigationPolicy.sandbox.isRequested {
            nativeConsumePending = false
            if navigationAction.request.httpMethod == "POST",
               navigationAction.request.url?.absoluteString == "https://www.stiz-dasan.kr/auth/native/consume" {
                decisionHandler(.allow)
                return
            }
        }
        // iframe은 새 창이나 외부 앱을 열 권한을 얻지 않는다.
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(navigationAction.request.url.map { NavigationPolicy.allowsSubframe($0) } == true ? .allow : .cancel)
            return
        }
        decisionHandler(approve(navigationAction) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else { decisionHandler(.allow); return }
        if nativeAwaitingResponse {
            nativeAwaitingResponse = false
            nativeConsumeTimeout?.invalidate()
            nativeConsumeTimeout = nil
            if navigationResponse.response.url?.absoluteString == "https://www.stiz-dasan.kr/auth/native/consume" {
                // 만료·서버 장애 JSON을 빈 화면으로 남기지 않고 기존 로그인 화면으로 돌아간다.
                decisionHandler(.cancel)
                alert("로그인을 완료하지 못했습니다. 기존 화면에서 다시 시도해 주세요.")
                DispatchQueue.main.async { [weak self] in self?.reloadPage() }
                return
            }
        }
        guard let url = navigationResponse.response.url,
              NavigationPolicy.decide(url, userInitiated: false) == .website,
              navigationResponse.canShowMIMEType else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, navigationAction.sourceFrame.isMainFrame,
           approve(navigationAction) {
            webView.load(navigationAction.request)
        }
        return nil
    }

    // 웹의 확인창을 생략하면 탈퇴·변경 확인이 작동하지 않는다. 공식 본문에서만 표시한다.
    private func trustedFrame(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        var address = URLComponents()
        address.scheme = origin.protocol
        address.host = origin.host
        if origin.port != 0 { address.port = origin.port }
        guard let url = address.url else { return false }
        return frame.isMainFrame && NavigationPolicy.matchesWebsiteOrigin(url)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard trustedFrame(frame), presentedViewController == nil else { completionHandler(); return }
        let dialog = UIAlertController(title: "STIZ", message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler() })
        present(dialog, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard trustedFrame(frame), presentedViewController == nil else { completionHandler(false); return }
        let dialog = UIAlertController(title: "확인", message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(false) })
        dialog.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler(true) })
        present(dialog, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard trustedFrame(frame), presentedViewController == nil else { completionHandler(nil); return }
        let dialog = UIAlertController(title: "STIZ", message: prompt, preferredStyle: .alert)
        dialog.addTextField { $0.text = defaultText }
        dialog.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(nil) })
        dialog.addAction(UIAlertAction(title: "확인", style: .default) { [weak dialog] _ in
            completionHandler(dialog?.textFields?.first?.text)
        })
        present(dialog, animated: true)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        nativeAuth.cancelIfPageChanged(webView.url)
        progress.startAnimating()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.stopAnimating()
        if let url = webView.url, NavigationPolicy.decide(url, userInitiated: false) == .website { lastPage = url }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { recover(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { recover(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { recover(nil) }
    deinit { nativeConsumeTimeout?.invalidate(); pageObservation?.invalidate(); nativeAuth?.shutdown() }
    #if DEBUG
    private func sandboxRecoveryMessage(_ error: Error?) -> String? {
        guard NavigationPolicy.sandbox.origin != nil else { return nil }
        guard let failure = error as NSError? else {
            return "시험 화면이 중단되었습니다. 다시 불러와 주세요."
        }
        // 주소나 원문 오류에는 개인정보가 담길 수 있어 허용된 분류와 숫자만 표시한다.
        guard failure.domain == NSURLErrorDomain || failure.domain == WKErrorDomain,
              (-9999...9999).contains(failure.code) else {
            return "시험 화면을 불러오지 못했습니다. 다시 시도해 주세요."
        }
        let guidance: String
        if failure.domain == NSURLErrorDomain {
            switch failure.code {
            case -1022:
                guidance = "시험 서버 연결이 보안 설정으로 차단되었습니다. 시험 앱의 주소 허용 설정을 확인해 주세요."
            case -1200, -1202:
                guidance = "시험 서버의 보안 연결을 확인하지 못했습니다. 시험 인증서의 유효기간과 신뢰 설정을 확인해 주세요."
            case -1009, -1004, -1001:
                guidance = "시험 서버에 연결하지 못했습니다. 같은 Wi-Fi 연결과 시험 서버 실행 상태를 확인해 주세요."
            default:
                guidance = "시험 화면을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요."
            }
        } else {
            guidance = "시험 웹 화면을 표시하지 못했습니다. 다시 불러와 주세요."
        }
        let category = failure.domain == NSURLErrorDomain ? "NSURLErrorDomain" : "WKErrorDomain"
        return "\(guidance)\n\n\(category) · \(failure.code)"
    }
    #endif
    private func recover(_ error: Error?) {
        // 주소 전환에 따른 취소는 완료 응답 대기를 해제하지 않는다.
        if (error as NSError?)?.code == NSURLErrorCancelled { progress.stopAnimating(); return }
        nativeConsumePending = false
        nativeAwaitingResponse = false
        nativeConsumeTimeout?.invalidate()
        nativeConsumeTimeout = nil
        progress.stopAnimating()
        #if DEBUG
        if let guidance = sandboxRecoveryMessage(error) { message.text = guidance }
        #endif
        webView.isHidden = true
        view.viewWithTag(101)?.isHidden = false
    }
}
