import SwiftUI
import UIKit
import WebKit
import JassiCore

/// Owns the one WebView: loads J.A.S.S.I, keeps other sites out, answers the bridge, sends events to the page.
@MainActor
final class WebShell: NSObject, ObservableObject {
    static let shared = WebShell()

    /// True while the "Can't reach J.A.S.S.I" screen is up.
    @Published private(set) var offline = false

    let webView: WKWebView
    private let base = AppConfig.origin
    private var queue = EventQueue()
    private let signIn = SignIn()

    private override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the sign-in cookie between launches
        config.allowsInlineMediaPlayback = true
        config.userContentController.addUserScript(WKUserScript(
            source: BridgeScript.source(origin: AppConfig.origin, version: AppConfig.version),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        webView.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: BridgeScript.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Theme.background)
        webView.scrollView.backgroundColor = UIColor(Theme.background)
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: AppConfig.baseURL))
    }

    /// "Try again" on the offline screen.
    func retry() {
        offline = false
        if webView.url == nil {
            webView.load(URLRequest(url: AppConfig.baseURL))
        } else {
            webView.reload()
        }
    }

    // MARK: Events, shell → page

    func send(_ event: NativeEvent) {
        if let ready = queue.submit(event) { dispatch(ready) }
    }

    private func dispatch(_ event: NativeEvent) {
        // Never hand an event to a page that is not J.A.S.S.I.
        guard let url = webView.url, Origin(url: url) == base else { return }
        webView.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent('jassi-native', { detail: detail }))",
            arguments: ["detail": event.detail],
            in: nil,
            in: .page,
            completionHandler: nil)
    }

    // MARK: Bridge, page → shell

    private func run(_ call: BridgeCall) async -> [String: Any] {
        switch call {
        case .openExternal(let url):
            switch ExternalRoute.route(url, base: base) {
            case .authSession(let url):
                let started = signIn.start(url: url) { [weak self] link in self?.handleIncoming(link) }
                return started ? BridgeReply.ok : BridgeReply.fail("failed")
            case .browser(let url):
                return await UIApplication.shared.open(url) ? BridgeReply.ok : BridgeReply.fail("failed")
            case .reject:
                return BridgeReply.fail(BridgeFailure.badArgs.rawValue)
            }
        default:
            return BridgeReply.unsupported
        }
    }

    // MARK: Links

    /// A link that opened the app. Only `jassi://auth…` means anything; it goes to the page untouched (contract §3).
    func handleIncoming(_ url: URL) {
        guard case .auth(let link)? = DeepLink.parse(url) else { return }
        send(.auth(url: link.absoluteString))
    }

    private func open(_ decision: NavigationDecision) {
        switch decision {
        case .external(let url): UIApplication.shared.open(url)
        case .deepLink(let url): handleIncoming(url)
        case .allow, .block: break
        }
    }

    private func loadFailed(_ error: Error) {
        let error = error as NSError
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain", error.code == 102 { return } // we stopped the load ourselves
        offline = true
    }
}

extension WebShell: WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.webView === webView,
              OriginCheck.bridgeAllowed(isMainFrame: message.frameInfo.isMainFrame,
                                        scheme: origin.protocol, host: origin.host, port: origin.port,
                                        base: base) else {
            replyHandler(nil, "forbidden")
            return
        }
        switch BridgeRouter.parse(message.body) {
        case .failure(let failure):
            replyHandler(BridgeReply.fail(failure.rawValue), nil)
        case .success(let call):
            Task { @MainActor in
                replyHandler(await self.run(call), nil)
            }
        }
    }
}

extension WebShell: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        let decision = NavigationPolicy.decide(url: url, base: base,
                                               isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true)
        if decision == .allow { return .allow }
        open(decision)
        return .cancel
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        queue.pageWillLoad()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        offline = false
        queue.pageDidLoad().forEach(dispatch)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebShell: WKUIDelegate {
    /// Links that ask for a new window: J.A.S.S.I pages load here, everything else goes to Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            let decision = NavigationPolicy.decide(url: url, base: base, isMainFrame: true)
            if decision == .allow {
                webView.load(navigationAction.request)
            } else {
                open(decision)
            }
        }
        return nil
    }
}
