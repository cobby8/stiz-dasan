import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    // 유니버설 링크: 문자·카카오톡의 www.stiz-dasan.kr 링크(청구서·마이페이지 등)를 누르면 Safari 대신 이 앱이 열리고,
    // iOS 가 그 주소를 여기로 넘겨준다. 앱이 꺼져 있다가 열릴 때도 실행 직후 여기로 들어온다.
    // 어떤 주소를 앱이 받을지는 사이트의 /.well-known/apple-app-site-association(src/lib/app-site-association.ts)이 정한다.
    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL,
              let controller = window?.rootViewController as? WebViewController else { return false }
        return controller.openUniversalLink(url)
    }
}
