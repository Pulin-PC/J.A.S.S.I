import Foundation

/// A link that opens the app from outside (contract §3).
public enum DeepLink: Equatable {
    /// `jassi://auth…`: the sign-in hand-off. The shell passes it on untouched.
    case auth(URL)

    public static let scheme = "jassi"

    public static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == "auth" else { return nil }
        return .auth(url)
    }
}

/// Where a page load inside the WebView should go.
public enum NavigationDecision: Equatable {
    /// Load it in the WebView.
    case allow
    /// Hand it to the system (Safari, Mail, Phone).
    case external(URL)
    /// A `jassi://` link.
    case deepLink(URL)
    case block
}

public enum NavigationPolicy {
    private static let systemSchemes: Set<String> = ["mailto", "tel", "sms"]

    /// Contract §1.3: only J.A.S.S.I pages load in the main frame. Every other link opens in the system browser.
    public static func decide(url: URL, base: Origin, isMainFrame: Bool) -> NavigationDecision {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == DeepLink.scheme { return .deepLink(url) }
        if scheme == "http" || scheme == "https" {
            guard let origin = Origin(url: url) else { return .block }
            if origin == base { return .allow }
            // Content a page embeds may load in its own frame; such a frame never gets the bridge.
            return isMainFrame ? .external(url) : .allow
        }
        if scheme == "about" { return .allow }
        if systemSchemes.contains(scheme) { return .external(url) }
        return .block
    }
}

/// Where `openExternal(url)` sends a link.
public enum ExternalRoute: Equatable {
    /// A sign-in page: runs in the system sign-in sheet and comes back through `jassi://`.
    case authSession(URL)
    /// Anything else on the web: Safari.
    case browser(URL)
    case reject

    public static func route(_ url: URL, base: Origin) -> ExternalRoute {
        guard let origin = Origin(url: url) else { return .reject }
        // J.A.S.S.I's own sign-in start pages ("Continue with Google", connect Gmail or Calendar).
        if origin == base, url.path.hasPrefix("/auth/") { return .authSession(url) }
        // Another company's sign-in page that hands back to J.A.S.S.I (connecting Notion, Linear and so on):
        // its `redirect_uri` is on our own address, and our server then sends the browser to `jassi://auth…`.
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let back = items.first(where: { $0.name == "redirect_uri" })?.value,
           let backURL = URL(string: back), Origin(url: backURL) == base {
            return .authSession(url)
        }
        return .browser(url)
    }
}
