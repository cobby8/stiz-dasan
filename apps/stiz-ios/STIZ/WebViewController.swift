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
    private var fileDownloads: NativeFileDownloads!
    private var downloadLink: (page: URL, target: URL)?
    private var downloadConverted = false

    override func viewDidLoad() {
        super.viewDidLoad()
        nativeAuth = NativeAuthCoordinator(owner: self)
        fileDownloads = NativeFileDownloads(owner: self)
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
        #if DEBUG
        // 유효한 시험 앱에서는 실제 표시되는 재시도 버튼과 같은 색으로 안내를 읽을 수 있게 한다.
        if NavigationPolicy.sandbox.origin != nil { message.textColor = retry.tintColor }
        #endif
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

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || isMovingFromParent { fileDownloads?.cancelForPageExit() }
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
        if navigationAction.sourceFrame.isMainFrame,
           navigationAction.targetFrame?.isMainFrame != false,
           navigationAction.navigationType == .linkActivated,
           let page = webView.url, let target = navigationAction.request.url,
           DownloadPolicy.allowsURL(target, from: page) {
            downloadLink = (page, target)
            if navigationAction.shouldPerformDownload {
                let accepted = fileDownloads.begin(page: page, target: target)
                if accepted { downloadConverted = true }
                decisionHandler(accepted ? .download : .cancel)
                return
            }
        } else {
            downloadLink = nil
        }
        downloadConverted = false
        // iframe은 새 창이나 외부 앱을 열 권한을 얻지 않는다.
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(navigationAction.request.url.map { NavigationPolicy.allowsSubframe($0) } == true ? .allow : .cancel)
            return
        }
        let allowed = approve(navigationAction)
        if allowed { fileDownloads.cancelForPageExit() }
        decisionHandler(allowed ? .allow : .cancel)
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
              NavigationPolicy.decide(url, userInitiated: false) == .website else { decisionHandler(.cancel); return }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            guard let link = downloadLink, link.target == url,
                  fileDownloads.begin(page: link.page, target: url) else { decisionHandler(.cancel); return }
            downloadConverted = true
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        fileDownloads.attach(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        fileDownloads.attach(download)
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        downloadLink = nil
        if fileDownloads.isBusy {
            webView.stopLoading()
            fileDownloads.cancelForPageExit()
        }
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
        downloadLink = nil
        fileDownloads.pageDidChange(to: webView.url)
        progress.stopAnimating()
        if let url = webView.url, NavigationPolicy.decide(url, userInitiated: false) == .website { lastPage = url }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { recover(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { recover(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { recover(nil) }
    deinit {
        nativeConsumeTimeout?.invalidate(); pageObservation?.invalidate(); nativeAuth?.shutdown()
        let downloads = fileDownloads
        Task { @MainActor in downloads?.shutdown() }
    }
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
        // 파일로 전환되며 중단된 웹 탐색은 기존 페이지를 오류 화면으로 바꾸지 않는다.
        if error != nil, downloadConverted || fileDownloads?.isBusy == true { progress.stopAnimating(); return }
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

// WKDownload를 그대로 사용하므로 웹 쿠키·인증 정보를 다른 요청에 복사하지 않는다.
@MainActor
private final class NativeFileDownloads: NSObject, WKDownloadDelegate {
    private weak var owner: UIViewController?
    private var active: WKDownload?
    private var sourcePage: URL?
    private var target: URL?
    private var folder: URL?
    private var file: URL?
    private var mime = ""
    private var generation = UUID()
    private var stopping = false
    private var stopMessage: String?
    private var sharing = false
    private var declaredLength: Int64 = 0
    private var received: NSKeyValueObservation?
    private var monitor: Timer?
    private var timeout: Timer?
    private var backgroundObserver: NSObjectProtocol?
    private var terminationObserver: NSObjectProtocol?
    private var progressDialog: UIAlertController?
    private weak var shareDialog: UIActivityViewController?
    var isBusy: Bool { target != nil || active != nil || sharing }

    init(owner: UIViewController) {
        self.owner = owner
        super.init()
        // 강제 종료에는 콜백이 보장되지 않으므로 다음 실행 때도 전용 잔여 파일을 정리한다.
        purgeOldFiles()
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in if self?.sharing == false { self?.cancel(nil) } }
        }
        terminationObserver = NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.cancel(nil) }
        }
    }

    func begin(page: URL, target: URL) -> Bool {
        guard !isBusy, owner?.presentedViewController == nil,
              DownloadPolicy.allowsURL(target, from: page) else { return false }
        self.sourcePage = page
        self.target = target
        generation = UUID()
        stopping = false
        let token = generation
        timeout = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            Task { @MainActor in if self?.generation == token { self?.cancel("파일을 받는 시간이 지연되었습니다. 다시 시도해 주세요.") } }
        }
        return true
    }

    func attach(_ download: WKDownload) {
        guard active == nil, let page = sourcePage, let target = target,
              download.originalRequest?.url == target, DownloadPolicy.allowsURL(target, from: page) else {
            let token = generation
            download.cancel { [weak self] _ in
                Task { @MainActor in
                    guard let self = self, self.generation == token, self.active == nil else { return }
                    self.finishCleanup(message: "파일의 요청 주소를 확인하지 못했습니다.")
                }
            }
            return
        }
        active = download
        download.delegate = self
        let token = generation
        received = download.progress.observe(\.completedUnitCount, options: [.new]) { [weak self, weak download] _, _ in
            Task { @MainActor in
                guard let self = self, let download = download, self.generation == token, self.active === download else { return }
                self.checkSize()
            }
        }
        monitor = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in if self?.generation == token { self?.checkSize() } }
        }
        let dialog = UIAlertController(title: "파일 받는 중", message: "완료되면 저장·공유 방법을 선택할 수 있습니다.", preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "취소", style: .cancel) { [weak self] _ in self?.cancel(nil) })
        progressDialog = dialog
        owner?.present(dialog, animated: true)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard active === download, !stopping, let target = target, let page = sourcePage,
              response.url == target, DownloadPolicy.allowsURL(target, from: page),
              (response as? HTTPURLResponse)?.statusCode == 200, let type = response.mimeType,
              ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Encoding") ?? "identity").lowercased() == "identity",
              DownloadPolicy.accepts(filename: suggestedFilename, mime: type, length: response.expectedContentLength) else {
            completionHandler(nil)
            cancel("지원하지 않는 파일이거나 크기를 확인할 수 없습니다. 10MB 이하의 지원 파일을 선택해 주세요.")
            return
        }
        do {
            let base = try temporaryRoot()
            let directory = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            folder = directory
            let destination = directory.appendingPathComponent(suggestedFilename, isDirectory: false)
            guard destination.deletingLastPathComponent() == directory,
                  !FileManager.default.fileExists(atPath: destination.path) else { throw CocoaError(.fileWriteInvalidFileName) }
            file = destination
            mime = type.lowercased()
            declaredLength = response.expectedContentLength
            completionHandler(destination)
        } catch {
            completionHandler(nil)
            cancel("파일을 준비하지 못했습니다. 다시 시도해 주세요.")
        }
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(.cancel)
        if active === download { cancel("주소가 변경되는 파일은 앱에서 받을 수 없습니다.") }
    }

    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // OS 기본 신뢰 검증을 유지하고 새 인증 정보나 우회 자격 증명을 만들지 않는다.
        completionHandler(.performDefaultHandling, nil)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard active === download else { return }
        finishCleanup(message: stopping ? stopMessage : "파일을 받지 못했습니다. 기존 화면에서 다시 시도해 주세요.")
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard active === download, !stopping, let file = file else { return }
        do {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink == false,
                  let size = values.fileSize, size > 0, Int64(size) <= DownloadPolicy.maximumBytes, Int64(size) == declaredLength,
                  file.resolvingSymlinksInPath() == file.standardizedFileURL else { throw CocoaError(.fileReadUnknown) }
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            let bytes = try handle.readToEnd() ?? Data()
            guard Int64(bytes.count) == Int64(size), DownloadPolicy.contentMatches(bytes, mime: mime) else { throw CocoaError(.fileReadCorruptFile) }
            stopMonitoring()
            active = nil
            sharing = true
            let token = generation
            dismissProgress { [weak self] in
                guard let self = self, self.generation == token else { return }
                guard self.sharing, let owner = self.owner, owner.view.window != nil,
                      owner.presentedViewController == nil else { self.finishCleanup(message: nil); return }
                let dialog = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                dialog.popoverPresentationController?.sourceView = owner.view
                dialog.popoverPresentationController?.sourceRect = CGRect(x: owner.view.bounds.midX, y: owner.view.bounds.midY, width: 1, height: 1)
                dialog.completionWithItemsHandler = { [weak self] _, _, _, _ in
                    guard self?.generation == token else { return }
                    self?.finishCleanup(message: nil)
                }
                self.shareDialog = dialog
                owner.present(dialog, animated: true)
            }
        } catch {
            finishCleanup(message: "파일의 형식이나 크기를 확인하지 못했습니다. 저장하지 않았습니다.")
        }
    }

    private func checkSize() {
        guard let download = active, !stopping else { return }
        let actual = file.flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize } ?? 0
        if download.progress.completedUnitCount > DownloadPolicy.maximumBytes || Int64(actual) > DownloadPolicy.maximumBytes {
            cancel("파일이 10MB를 초과해 받기를 중단했습니다.")
        }
    }

    func pageDidChange(to page: URL?) {
        if let original = sourcePage, page != original { cancelForPageExit() }
    }

    func cancelForPageExit() {
        if sharing {
            let token = generation
            if let dialog = shareDialog {
                dialog.dismiss(animated: false) { [weak self] in
                    guard self?.generation == token else { return }
                    self?.finishCleanup(message: nil)
                }
            }
            else { finishCleanup(message: nil) }
        } else { cancel(nil) }
    }

    private func cancel(_ message: String?) {
        guard isBusy, !stopping else { return }
        stopping = true
        stopMessage = message
        stopMonitoring()
        let token = generation
        guard let download = active else { finishCleanup(message: message); return }
        download.cancel { [self] _ in
            Task { @MainActor in
                guard self.generation == token else { return }
                self.finishCleanup(message: message)
            }
        }
    }

    private func stopMonitoring() {
        received?.invalidate(); received = nil
        monitor?.invalidate(); monitor = nil
        timeout?.invalidate(); timeout = nil
    }

    private func dismissProgress(_ completion: @escaping () -> Void) {
        if let dialog = progressDialog, dialog.presentingViewController != nil {
            progressDialog = nil
            dialog.dismiss(animated: true, completion: completion)
        } else { progressDialog = nil; completion() }
    }

    private func finishCleanup(message: String?) {
        stopMonitoring()
        active = nil
        sharing = false
        target = nil
        sourcePage = nil
        stopping = false
        stopMessage = nil
        declaredLength = 0
        generation = UUID()
        let finishedToken = generation
        if let folder = folder { removeOwnedFolder(folder) }
        folder = nil; file = nil; mime = ""
        dismissProgress { [weak self] in
            guard self?.generation == finishedToken, let message = message, let owner = self?.owner,
                  owner.view.window != nil, owner.presentedViewController == nil else { return }
            let dialog = UIAlertController(title: "파일 안내", message: message, preferredStyle: .alert)
            dialog.addAction(UIAlertAction(title: "확인", style: .default))
            owner.present(dialog, animated: true)
        }
    }

    private func temporaryRoot() throws -> URL {
        let base = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("stiz-native-downloads", isDirectory: true)
        if !FileManager.default.fileExists(atPath: base.path) { try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        let values = try base.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink == false, base.resolvingSymlinksInPath() == base.standardizedFileURL else { throw CocoaError(.fileWriteNoPermission) }
        return base
    }

    private func removeOwnedFolder(_ directory: URL) {
        guard let base = try? temporaryRoot(), directory.deletingLastPathComponent() == base,
              UUID(uuidString: directory.lastPathComponent) != nil,
              let values = try? directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
              values.isDirectory == true, values.isSymbolicLink == false,
              let children = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return }
        for child in children {
            guard child.deletingLastPathComponent() == directory,
                  let value = try? child.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  value.isRegularFile == true, value.isSymbolicLink == false else { return }
        }
        for child in children { try? FileManager.default.removeItem(at: child) }
        // 소유한 UUID 폴더만 정리하고 링크나 하위 디렉터리를 재귀 탐색하지 않는다.
        if (try? FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty) == true { try? FileManager.default.removeItem(at: directory) }
    }

    private func purgeOldFiles() {
        guard let base = try? temporaryRoot(), let directories = try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil) else { return }
        for directory in directories { removeOwnedFolder(directory) }
    }

    func shutdown() {
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = terminationObserver { NotificationCenter.default.removeObserver(observer) }
        cancelForPageExit()
    }
}
