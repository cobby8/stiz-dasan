import UIKit
import WebKit
import UserNotifications
import FirebaseCore
import FirebaseMessaging

// 앱 알림(FCM → APNs, 2026-11-14 e2). AppDelegate·WebViewController 는 한 줄씩만 부른다(start / attach).
//
// 흐름: 웹 화면(우리 사이트 맨 위 화면)이 "stizPush" 창구로 "state"/"request" 를 보낸다 →
//       여기서 알림 권한·FCM 토큰을 JSON 한 줄로 답한다 → 웹이 로그인 쿠키로 /api/push/native 에 등록한다.
// 알림을 누르면 data.url(우리 사이트 경로)을 NavigationPolicy.pushTarget 으로 거른 뒤 유니버설 링크와 같은 길로 연다.
//
// Firebase 설정 파일은 저장소에 없다. 빌드 전에 STIZ/Firebase/GoogleService-Info.plist 로 넣으면(Codemagic 주입)
// 앱 안 Firebase/ 폴더로 복사되고, 없으면 FirebaseApp 을 켜지 않아 «supported:false»(알림 미지원)로만 답한다 — 빌드·실행은 그대로.
// 상태(configured·open)는 화면 스레드(MainActor)에서만 읽고 쓴다.
@MainActor
final class NativePush: NSObject, UNUserNotificationCenterDelegate, MessagingDelegate, WKScriptMessageHandlerWithReply {
    static let shared = NativePush()

    private var configured = false
    private var open: ((URL) -> Void)?
    // 앱이 꺼진 상태에서 알림을 눌러 열렸을 때, 화면이 준비되기 전에 온 주소를 잠시 보관한다
    private var pendingURL: URL?

    /// 실행 직후 AppDelegate 가 부른다. 시험 앱(격리 주소)·설정 파일 없는 빌드는 Firebase 를 켜지 않는다.
    func start(_ application: UIApplication, open: @escaping (URL) -> Void) {
        self.open = open
        UNUserNotificationCenter.current().delegate = self
        if let url = pendingURL { pendingURL = nil; open(url) }
        guard !NavigationPolicy.sandbox.isRequested,
              let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist", inDirectory: "Firebase"),
              let options = FirebaseOptions(contentsOfFile: path) else { return }
        if FirebaseApp.app() == nil { FirebaseApp.configure(options: options) }
        Messaging.messaging().delegate = self
        configured = true
        // 이미 허용된 기기는 실행할 때마다 APNs 토큰을 새로 받아 FCM 토큰이 최신이 되게 한다
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if Self.isGranted(settings.authorizationStatus) { application.registerForRemoteNotifications() }
        }
    }

    /// WebViewController 가 웹뷰를 만들기 전에 부른다. 시험 앱에는 창구를 열지 않는다(웹은 «옛 앱»으로 본다).
    func attach(to controller: WKUserContentController) {
        guard !NavigationPolicy.sandbox.isRequested else { return }
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "stizPush")
    }

    private static func isGranted(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    private static func permissionText(_ status: UNAuthorizationStatus) -> String {
        if isGranted(status) { return "granted" }
        return status == .denied ? "denied" : "default"
    }

    // MARK: 웹 창구

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // 우리 사이트의 맨 위 화면만 — 결제창·지도 같은 안쪽 화면(iframe)이나 다른 사이트에는 답하지 않는다
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https", origin.host.lowercased() == "www.stiz-dasan.kr",
              origin.port == 0 || origin.port == 443, let command = message.body as? String else {
            replyHandler(nil, "denied")
            return
        }
        let ask = command == "request"
        Task { @MainActor in
            replyHandler(await self.state(askPermission: ask), nil)
        }
    }

    /// 지금 상태(필요하면 먼저 권한을 묻는다). 이미 정해졌으면(허용·거절) 아이폰은 창을 다시 띄우지 않는다.
    private func state(askPermission: Bool) async -> String {
        let center = UNUserNotificationCenter.current()
        if askPermission && configured {
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
                // APNs 토큰이 FCM 에 전달될 시간을 잠깐 준다(늦으면 웹이 다음 화면에서 다시 받는다)
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
        let permission = Self.permissionText(await center.notificationSettings().authorizationStatus)
        var token: String?
        if configured && permission == "granted" { token = try? await Messaging.messaging().token() }
        return json(permission: permission, token: token)
    }

    /// 웹의 parseNativePushReply 와 같은 모양
    private func json(permission: String, token: String?) -> String {
        var value: [String: Any] = ["v": 1, "platform": "ios", "supported": configured, "permission": permission]
        if configured, let token = token, token.count >= 20, token.count <= 4096 { value["token"] = token } else { value["token"] = NSNull() }
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }

    // MARK: 알림

    // 앱을 보고 있을 때 온 알림도 위에 띄운다
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // 알림을 누르면 그 화면을 앱 안에서 연다(우리 사이트 경로만 — 아니면 지금 화면 유지)
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let url = NavigationPolicy.pushTarget(response.notification.request.content.userInfo["url"])
        completionHandler()
        guard let url = url else { return }
        Task { @MainActor in self.deliver(url) }
    }

    private func deliver(_ url: URL) {
        if let open = open { open(url) } else { pendingURL = url }
    }

    // 새 FCM 토큰은 다음에 웹 화면이 열릴 때 웹이 받아 서버에 등록한다(로그인 쿠키가 웹뷰에 있으므로)
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) { }
}
