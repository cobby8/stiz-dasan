import UIKit
import WebKit

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private let progress = UIActivityIndicatorView(style: .medium)
    private let message = UILabel()
    private let retry = UIButton(type: .system)
    private var lastPage = NavigationPolicy.entry

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(named: "Canvas")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
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
        reloadPage()
    }

    @objc private func reloadPage() {
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
        case .website: return true
        case .external:
            if action.sourceFrame.isMainFrame { UIApplication.shared.open(url) }
        case .blockedAuthentication:
            alert("앱의 간편로그인은 준비 중입니다. 이메일·비밀번호로 로그인해 주세요. 웹사이트에서는 기존 간편로그인을 사용할 수 있습니다.")
        case .blocked:
            alert("이 주소는 앱에서 열 수 없습니다. 기사님 운행은 Android 기사님 앱을 이용해 주세요.")
        }
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // iframe은 새 창이나 외부 앱을 열 권한을 얻지 않는다.
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(navigationAction.request.url.map(NavigationPolicy.allowsSubframe) == true ? .allow : .cancel)
            return
        }
        decisionHandler(approve(navigationAction) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else { decisionHandler(.allow); return }
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
        return frame.isMainFrame && origin.protocol == "https" &&
            origin.host.lowercased() == "www.stiz-dasan.kr" && (origin.port == 0 || origin.port == 443)
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

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { progress.startAnimating() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.stopAnimating()
        if let url = webView.url, NavigationPolicy.decide(url, userInitiated: false) == .website { lastPage = url }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { recover(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { recover(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { recover(nil) }
    private func recover(_ error: Error?) {
        if (error as NSError?)?.code == NSURLErrorCancelled { progress.stopAnimating(); return }
        progress.stopAnimating()
        webView.isHidden = true
        view.viewWithTag(101)?.isHidden = false
    }
}
