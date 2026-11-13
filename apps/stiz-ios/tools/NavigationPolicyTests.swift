import Foundation

@main
struct NavigationPolicyTests {
    static func main() {
        let cases: [(String, Bool, NavigationPolicy.Decision)] = [
            ("https://www.stiz-dasan.kr/store-app", false, .website),
            ("https://www.stiz-dasan.kr/auth/continue", false, .website),
            ("https://www.stiz-dasan.kr:443/admin", false, .website),
            ("https://www.stiz-dasan.kr/mypage", true, .website),
            ("https://www.stiz-dasan.kr/staff", true, .website),
            ("https://www.stiz-dasan.kr/account/withdraw", true, .website),
            ("https://www.stiz-dasan.kr/login?redirect=%2Fmypage", false, .website),
            ("https://www.stiz-dasan.kr/auth/oauth/google", true, .blockedAuthentication),
            ("https://www.stiz-dasan.kr/auth/oauth/apple", true, .blockedAuthentication),
            ("https://www.stiz-dasan.kr/api/auth/parent-link/start", false, .blockedAuthentication),
            ("https://www.stiz-dasan.kr/driver", true, .blockedDriver),
            ("https://www.stiz-dasan.kr/driver/example", true, .blockedDriver),
            ("https://www.stiz-dasan.kr/staff/run", true, .blockedDriver),
            // 셔틀 조회·승하차 체크는 아이폰에서도 연다. 위치 전송(/staff/run·/driver)만 Android 전용.
            ("https://www.stiz-dasan.kr/staff/shuttle", true, .website),
            ("https://www.stiz-dasan.kr/staff/shuttle/today", false, .website),
            ("https://www.stiz-dasan.kr/staff//run", true, .blockedDriver),
            ("https://www.stiz-dasan.kr/staff%2Frun", true, .blockedDriver),
            ("https://www.stiz-dasan.kr/driver%252Fexample", true, .blocked),
            ("https://www.stiz-dasan.kr/one/../driver/example", true, .blocked),
            ("https://www.stiz-dasan.kr:444/admin", false, .blocked),
            ("http://www.stiz-dasan.kr/admin", true, .blocked),
            ("https://fake.example/admin", false, .blocked),
            ("https://www.stiz-dasan.kr.fake.example/admin", false, .blocked),
            ("https://www.stiz-dasan.kr@fake.example/admin", true, .blocked),
            ("https://user:password@www.stiz-dasan.kr/admin", true, .blocked),
            ("file:///private/example", true, .blocked),
            ("javascript:alert(1)", true, .blocked),
            ("data:text/html,hello", true, .blocked),
            ("intent://example", true, .blocked),
            ("tel:000", false, .blocked),
            ("tel:000", true, .external),
            ("mailto:test@example.invalid", true, .external),
            ("maps://?q=academy", true, .external),
            ("https://maps.google.com/", true, .external),
            // 사용자가 누른 바깥 링크는 막지 않고 Safari 로 넘긴다. 자동 이동은 여전히 막는다.
            ("https://example.invalid/", true, .external),
            ("https://example.invalid/", false, .blocked),
            ("http://example.invalid/", true, .blocked),
            ("https://pf.kakao.com/_HhaQG", true, .external),
            ("https://map.kakao.com/link/map/STIZ,37.6,127.1", true, .external),
            ("sms:01000000000", true, .external),
            ("sms:01000000000?body=hello", true, .external),
            ("sms:01000000000", false, .blocked),
            ("nmap://route/car?dlat=37.6&dlng=127.1", true, .external),
            ("kakaomap://route?ep=37.6,127.1", true, .external),
            ("intent://example#Intent;scheme=https;end", true, .blocked),
            ("https://example.supabase.co/storage/v1/object/public/notices/a.pdf", true, .external),
            ("https://example.supabase.co/storage/v1/object/public/notices/a.pdf", false, .blocked),
            ("https://example.supabase.co/storage/v1/object/sign/private/a.pdf", true, .blockedAuthentication),
            ("https://example.supabase.co/storage/v1/object/public/../../auth/v1/authorize", true, .blockedAuthentication),
            ("https://maps.google.com:444/", true, .blocked),
            ("https://accounts.google.com/", true, .blockedAuthentication),
            ("https://appleid.apple.com/", true, .blockedAuthentication),
            ("https://example.supabase.co/auth/v1/authorize", true, .blockedAuthentication)
        ]
        for (address, initiated, expected) in cases {
            guard let url = URL(string: address) else { fatalError("Invalid fixture") }
            precondition(NavigationPolicy.decide(url, userInitiated: initiated) == expected, "Navigation case failed: \(address)")
        }
        // 앱 시작 주소는 우리 사이트이며 지원 기능(바깥 링크·문자)만 알린다.
        precondition(NavigationPolicy.entry.absoluteString == "https://www.stiz-dasan.kr/store-app?caps=links,sms")
        precondition(NavigationPolicy.decide(NavigationPolicy.entry, userInitiated: false) == .website)
        // 결제(원장 결정 2026-11-09): 토스 결제창은 탭 없이도 열고, 결제 중에만 카드사 화면·앱을 허용한다.
        let payments: [(String, Bool, NavigationPolicy.Decision)] = [
            ("https://api.tosspayments.com/v1/payments", false, .paymentStart),
            ("https://pay.toss.im/checkout", false, .paymentStart),
            ("https://tosspayments.com/", false, .paymentStart),
            ("https://tosspayments.com.evil.example/", false, .blocked),
            ("https://eviltosspayments.com/", false, .blocked),
            // 가짜 토스 주소는 결제로 인정하지 않는다. 사용자가 직접 누른 경우엔 일반 바깥 링크처럼 Safari 로 넘길 뿐이다.
            ("https://tosspayments.com.evil.example/", true, .external),
            ("http://api.tosspayments.com/", false, .blocked),
            ("https://api.tosspayments.com:444/", false, .blocked),
            ("https://user:pass@api.tosspayments.com/", false, .blocked),
            ("https://card-auth.example.invalid/", false, .blocked),
            ("ispmobile://TID=example", false, .blocked),
            ("kakaotalk://kakaopay/pg?url=example", false, .blocked),
            // 포트원·KG이니시스 본인인증도 결제처럼 «진행 중» 상태를 시작한다.
            ("https://checkout-service.prod.iamport.co/identity", false, .paymentStart),
            ("https://service.iamport.kr/certifications", false, .paymentStart),
            ("https://portone.io/", false, .paymentStart),
            ("https://sa.inicis.com/auth", false, .paymentStart),
            ("https://portone.io.evil.example/", false, .blocked),
            ("https://evilinicis.com/", false, .blocked),
            ("http://sa.inicis.com/auth", false, .blocked),
            ("https://sa.inicis.com:444/auth", false, .blocked)
        ]
        for (address, initiated, expected) in payments {
            precondition(NavigationPolicy.decide(URL(string: address)!, userInitiated: initiated) == expected, "Payment case failed: \(address)")
        }
        let paying: [(String, NavigationPolicy.Decision)] = [
            ("https://card-auth.example.invalid/acs", .paymentPage),
            ("https://tosspayments.com.evil.example/", .paymentPage),
            ("https://www.stiz-dasan.kr/mypage/payments/done?paymentKey=x", .website),
            ("https://www.stiz-dasan.kr/driver", .blockedDriver),
            ("https://accounts.google.com/", .blockedAuthentication),
            ("ispmobile://TID=example", .paymentApp),
            ("kakaotalk://kakaopay/pg?url=example", .paymentApp),
            ("supertoss://pay?x=1", .paymentApp),
            ("https://apps.apple.com/kr/app/id369125087", .paymentApp),
            ("itms-apps://apps.apple.com/app/id369125087", .paymentApp),
            ("kb-acp://pay", .paymentApp),
            ("shinhan-sr-ansimclick://pay", .paymentApp),
            ("hdcardappcardansimclick://pay", .paymentApp),
            ("intent://pay#Intent;scheme=ispmobile;end", .paymentApp),
            ("javascript:alert(1)", .blocked),
            ("data:text/html,hello", .blocked),
            ("file:///private/example", .blocked),
            ("http://card-auth.example.invalid/", .blocked),
            ("stiz-academy-dev://auth/return", .blocked)
        ]
        for (address, expected) in paying {
            precondition(NavigationPolicy.decide(URL(string: address)!, userInitiated: false, paymentActive: true) == expected, "Paying case failed: \(address)")
        }
        // 시험 앱은 결제 중이라도 결제창을 열지 않는다.
        let paymentSandbox = SandboxConfiguration.resolve("https://192.168.0.2:8453", debugBuild: true)
        for address in ["https://api.tosspayments.com/", "ispmobile://TID=example"] {
            precondition(NavigationPolicy.decide(URL(string: address)!, userInitiated: true, paymentActive: true, configuration: paymentSandbox) == .blocked)
        }
        for address in ["http://example.invalid", "tel:000", "javascript:alert(1)", "https://user:pass@map.naver.com", "https://map.naver.com:444/"] {
            precondition(!NavigationPolicy.allowsSubframe(URL(string: address)!))
        }
        precondition(NavigationPolicy.allowsSubframe(URL(string: "https://map.naver.com/")!))
        precondition(NativeAuthPolicy.provider(from: URL(string: "https://www.stiz-dasan.kr/auth/oauth/apple?intent=login")!) == "apple")
        for address in [
            "https://www.stiz-dasan.kr/auth/oauth/apple?intent=link",
            "https://www.stiz-dasan.kr/auth/oauth/apple?intent=parent-signup",
            "https://www.stiz-dasan.kr/auth/oauth/apple?intent=login&intent=link",
            "https://www.stiz-dasan.kr/auth/oauth/apple?intent=login&handoff=example",
            "https://www.stiz-dasan.kr/auth//oauth/apple?intent=login",
            "https://fake.example/auth/oauth/apple?intent=login"
        ] { precondition(NativeAuthPolicy.provider(from: URL(string: address)!) == nil) }
        let state = String(repeating: "s", count: 43)
        let code = String(repeating: "c", count: 43)
        let flow = String(repeating: "f", count: 43)
        // 출시(스토어 앱 ID)·개발 복귀 주소 모두 같은 규칙. 각 빌드는 자기 주소만 받는다(a1, 2026-11-13).
        precondition(NativeAuthPolicy.callbackScheme(debug: false) == "kr.co.upturnlabs.stizdasan")
        precondition(NativeAuthPolicy.callbackScheme(debug: true) == "stiz-academy-dev")
        for debug in [false, true] {
            let scheme = NativeAuthPolicy.callbackScheme(debug: debug)
            let other = NativeAuthPolicy.callbackScheme(debug: !debug)
            let callback = "\(scheme)://auth/return?flow=\(flow)&state=\(state)&code=\(code)"
            precondition(NativeAuthPolicy.callbackCode(URL(string: callback)!, flow: flow, state: state, scheme: scheme) == code)
            precondition(NativeAuthPolicy.callbackCode(URL(string: callback + "&code=bad")!, flow: flow, state: state, scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackCode(URL(string: callback)!, flow: flow, state: "wrong", scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackCode(URL(string: callback)!, flow: "wrong", state: state, scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackCode(URL(string: callback.replacingOccurrences(of: scheme + "://", with: other + "://"))!, flow: flow, state: state, scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackCode(URL(string: callback.replacingOccurrences(of: scheme + "://", with: "stiz-academy-android-dev://"))!, flow: flow, state: state, scheme: scheme) == nil)
            // 실패 이유만 실린 복귀: code 가 없으니 로그인은 안 되고 이유만 읽는다
            let failed = "\(scheme)://auth/return?flow=\(flow)&state=\(state)&error=no_account"
            precondition(NativeAuthPolicy.callbackCode(URL(string: failed)!, flow: flow, state: state, scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackFailure(URL(string: failed)!, flow: flow, state: state, scheme: scheme) == "no_account")
            precondition(NativeAuthPolicy.callbackFailure(URL(string: failed.replacingOccurrences(of: "no_account", with: "evil"))!, flow: flow, state: state, scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackFailure(URL(string: failed)!, flow: flow, state: "wrong", scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackFailure(URL(string: failed + "&code=\(code)")!, flow: flow, state: state, scheme: scheme) == nil)
            precondition(NativeAuthPolicy.callbackFailure(URL(string: callback)!, flow: flow, state: state, scheme: scheme) == nil)
        }
        precondition(NativeAuthPolicy.isBrowserURL(URL(string: "https://www.stiz-dasan.kr/auth/native/browser?flow=\(flow)")!, flow: flow))
        precondition(!NativeAuthPolicy.isBrowserURL(URL(string: "https://www.stiz-dasan.kr/auth/native/browser?flow=\(flow)&next=https://fake.example")!, flow: flow))
        // 같은 코드가 Release에서는 시험 주소를 무시하고 기존 운영 정책을 사용해야 한다.
        precondition(SandboxConfiguration.resolve("https://192.168.0.2:8453", debugBuild: false) == .disabled)
        precondition(SandboxConfiguration.resolve("", debugBuild: true) == .disabled)
        precondition(SandboxConfiguration.resolve(nil, debugBuild: true) == .disabled)
        for host in ["localhost", "127.0.0.1", "10.0.0.2", "172.16.0.2", "172.31.255.2", "192.168.0.2"] {
            let sandbox = SandboxConfiguration.resolve("https://\(host):8453", debugBuild: true)
            precondition(sandbox.origin?.host == host)
            precondition(NavigationPolicy.decide(URL(string: "https://\(host):8453/store-app")!, userInitiated: false, configuration: sandbox) == .website)
            precondition(NavigationPolicy.decide(URL(string: "https://\(host):8453/__entry/teacher")!, userInitiated: true, configuration: sandbox) == .website)
            precondition(NavigationPolicy.allowsSubframe(URL(string: "https://\(host):8453/mypage")!, configuration: sandbox))
        }
        for origin in [
            "http://localhost:8453", "https://localhost:8444", "https://localhost", "https://localhost:8453/path",
            "https://localhost:8453?next=x", "https://localhost:8453#fragment", "https://user:pass@localhost:8453",
            "https://www.stiz-dasan.kr:8453", "https://fake.example:8453", "https://8.8.8.8:8453",
            "https://172.15.0.2:8453", "https://172.32.0.2:8453", "https://192.169.0.2:8453",
            "https://192.168.00.2:8453", "https://192.168.256.2:8453", "https://[::1]:8453",
            "https://localhost.fake.example:8453", "https://local%68ost:8453", " https://localhost:8453"
        ] {
            let invalid = SandboxConfiguration.resolve(origin, debugBuild: true)
            precondition(invalid == .invalid)
            precondition(NavigationPolicy.decide(URL(string: "https://www.stiz-dasan.kr/store-app")!, userInitiated: true, configuration: invalid) == .blocked)
        }
        let sandbox = SandboxConfiguration.resolve("https://192.168.0.2:8453", debugBuild: true)
        for address in [
            "https://www.stiz-dasan.kr/admin", "https://accounts.google.com/", "https://map.kakao.com/", "tel:000", "mailto:test@example.invalid",
            "http://192.168.0.2:8453/admin", "https://192.168.0.2:8454/admin", "https://192.168.0.3:8453/admin",
            "https://192.168.0.2.fake.example:8453/admin", "https://user:pass@192.168.0.2:8453/admin",
            "https://192.168.0.2:8453/driver/example", "https://192.168.0.2:8453/staff/run",
            "https://192.168.0.2:8453/staff/shuttle", "https://192.168.0.2:8453/payments/checkout",
            "https://192.168.0.2:8453/api/payments/confirm", "https://192.168.0.2:8453/checkout"
        ] {
            precondition(NavigationPolicy.decide(URL(string: address)!, userInitiated: true, configuration: sandbox) == .blocked)
            precondition(!NavigationPolicy.allowsSubframe(URL(string: address)!, configuration: sandbox))
        }
        precondition(NavigationPolicy.decide(URL(string: "https://192.168.0.2:8453/auth/native/start")!, userInitiated: true, configuration: sandbox) == .blockedAuthentication)
        let rules = try! JSONSerialization.jsonObject(with: Data(sandbox.contentRules!.utf8)) as! [[String: Any]]
        precondition((rules[0]["action"] as! [String: String])["type"] == "block")
        let allowed = (rules[1]["trigger"] as! [String: String])["url-filter"]!
        let expression = try! NSRegularExpression(pattern: allowed)
        for address in ["https://www.stiz-dasan.kr/", "https://192.168.0.2.fake.example:8453/", "http://192.168.0.2:8453/", "https://192.168.0.2:8454/"] {
            precondition(expression.firstMatch(in: address, range: NSRange(address.startIndex..., in: address)) == nil)
        }
        let address = "https://192.168.0.2:8453/_next/static/app.js"
        precondition(expression.firstMatch(in: address, range: NSRange(address.startIndex..., in: address)) != nil)
        let sample = URL(string: "https://192.168.0.2:8453/__sandbox/sample.png")!
        let page = URL(string: "https://192.168.0.2:8453/__sandbox/media")!
        precondition(DownloadPolicy.allowsURL(sample, from: page, configuration: sandbox))
        for address in ["http://192.168.0.2:8453/a.png", "https://192.168.0.3:8453/a.png", "https://192.168.0.2:8454/a.png",
                        "https://user:pass@192.168.0.2:8453/a.png", "https://192.168.0.2:8453/driver/a.png", "https://192.168.0.2:8453/a.png#x",
                        "https://www.stiz-dasan.kr/a.png", "blob:https://192.168.0.2:8453/synthetic", "data:image/png;base64,AAAA"] {
            precondition(!DownloadPolicy.allowsURL(URL(string: address)!, from: page, configuration: sandbox))
        }
        precondition(DownloadPolicy.accepts(filename: "시험.png", mime: "image/png", length: 100))
        precondition(DownloadPolicy.accepts(filename: "sample.pdf", mime: "application/pdf", length: DownloadPolicy.maximumBytes))
        for length in [Int64(-1), 0, DownloadPolicy.maximumBytes + 1] {
            precondition(!DownloadPolicy.accepts(filename: "sample.png", mime: "image/png", length: length))
        }
        for filename in ["", ".png", "../sample.png", "nested/sample.png", "nested\\sample.png", "sample.png.exe", "sample.html.png",
                         "sample%2epng", "sample:png", "sample.png ", "sample\n.png", "sample\u{202E}.png", String(repeating: "a", count: 121) + ".png"] {
            precondition(!DownloadPolicy.accepts(filename: filename, mime: "image/png", length: 100))
        }
        for pair in [("sample.html", "text/html"), ("sample.js", "application/javascript"), ("sample.exe", "application/octet-stream"),
                     ("sample.zip", "application/zip"), ("sample.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                     ("sample.jpg", "image/png")] {
            precondition(!DownloadPolicy.accepts(filename: pair.0, mime: pair.1, length: 100))
        }
        precondition(DownloadPolicy.contentMatches(Data([137,80,78,71,13,10,26,10]), mime: "image/png"))
        precondition(DownloadPolicy.contentMatches(Data("%PDF-1.7".utf8), mime: "application/pdf"))
        precondition(DownloadPolicy.contentMatches(Data("name,value\nsynthetic,1".utf8), mime: "text/csv"))
        precondition(!DownloadPolicy.contentMatches(Data("<html>unsafe</html>".utf8), mime: "text/plain"))
        precondition(!DownloadPolicy.contentMatches(Data("\u{FEFF}<html>unsafe</html>".utf8), mime: "text/plain"))
        precondition(!DownloadPolicy.contentMatches(Data([0,1,2]), mime: "image/png"))
        precondition(!DownloadPolicy.contentMatches(Data("#!/bin/sh".utf8), mime: "text/plain"))
        print("STIZ iOS download policy: synthetic same-origin, filenames, types, size and content assertions passed")
        print("STIZ iOS navigation policy: \(cases.count) cases passed")
        print("STIZ iOS payment policy: \(payments.count + paying.count) cases passed")
        print("STIZ iOS native handoff policy: 13 assertions passed")
        print("STIZ iOS sandbox policy: valid/invalid origins, release isolation, navigation and resource rules passed")
    }
}
