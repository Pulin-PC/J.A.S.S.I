import Foundation
import Testing
@testable import JassiCore

private let live = Origin(url: URL(string: "https://jassi.pulin-chaudhari.workers.dev")!)!
private let host = "jassi.pulin-chaudhari.workers.dev"

@Suite("Who may use the bridge")
struct OriginTests {
    @Test func mainFrameOfJassiIsAllowed() {
        // WebKit reports the usual port as 0.
        #expect(OriginCheck.bridgeAllowed(isMainFrame: true, scheme: "https", host: host, port: 0, base: live))
        #expect(OriginCheck.bridgeAllowed(isMainFrame: true, scheme: "https", host: host, port: 443, base: live))
        #expect(OriginCheck.bridgeAllowed(isMainFrame: true, scheme: "HTTPS", host: host.uppercased(), port: nil, base: live))
    }

    @Test func aFrameInsideThePageIsRefused() {
        #expect(!OriginCheck.bridgeAllowed(isMainFrame: false, scheme: "https", host: host, port: 0, base: live))
    }

    @Test func otherSitesAreRefused() {
        let others: [(String?, String?, Int?)] = [
            ("http", host, 0),                               // same name, not secure
            ("https", host, 8443),                           // other port
            ("https", "pulin-chaudhari.workers.dev", 0),     // parent site
            ("https", "evil.\(host)", 0),                    // sub-site
            ("https", "\(host).evil.com", 0),                // look-alike
            ("https", "evil.com", 0),
            ("file", "", 0),
            ("about", nil, nil),
            (nil, nil, nil),
        ]
        for (scheme, name, port) in others {
            #expect(!OriginCheck.bridgeAllowed(isMainFrame: true, scheme: scheme, host: name, port: port, base: live),
                    "\(scheme ?? "nil")://\(name ?? "nil"):\(port ?? -1)")
        }
    }

    @Test func aNameBeforeAnAtSignDoesNotFoolTheCheck() {
        let trick = Origin(url: URL(string: "https://\(host)@evil.com/")!)
        #expect(trick?.host == "evil.com")
        #expect(trick != live)
    }

    @Test func aDevAddressKeepsItsPort() {
        let dev = Origin(url: URL(string: "http://localhost:3000/setup")!)!
        #expect(dev.serialized == "http://localhost:3000")
        #expect(OriginCheck.bridgeAllowed(isMainFrame: true, scheme: "http", host: "localhost", port: 3000, base: dev))
        #expect(!OriginCheck.bridgeAllowed(isMainFrame: true, scheme: "http", host: "localhost", port: 3001, base: dev))
        #expect(!OriginCheck.bridgeAllowed(isMainFrame: true, scheme: "https", host: host, port: 0, base: dev))
    }

    @Test func originTextMatchesWhatThePageSees() {
        #expect(live.serialized == "https://jassi.pulin-chaudhari.workers.dev")
        #expect(Origin(url: URL(string: "https://Example.com:443/a?b#c")!)?.serialized == "https://example.com")
        #expect(Origin(url: URL(string: "jassi://auth?code=1")!) == nil)
    }
}

@Suite("Where links go")
struct LinkTests {
    private func decide(_ link: String, mainFrame: Bool = true) -> NavigationDecision {
        NavigationPolicy.decide(url: URL(string: link)!, base: live, isMainFrame: mainFrame)
    }

    @Test func jassiPagesLoadInTheApp() {
        #expect(decide("https://\(host)/") == .allow)
        #expect(decide("https://\(host)/setup?step=2#apps") == .allow)
    }

    @Test func everyOtherSiteOpensInSafari() {
        for link in ["https://accounts.google.com/o/oauth2/v2/auth", "https://example.com/", "http://\(host)/", "https://\(host).evil.com/"] {
            #expect(decide(link) == .external(URL(string: link)!), "\(link)")
        }
    }

    @Test func embeddedContentLoadsInItsOwnFrame() {
        #expect(decide("https://example.com/widget", mainFrame: false) == .allow)
        #expect(decide("about:blank", mainFrame: false) == .allow)
    }

    @Test func mailAndPhoneLinksGoToTheSystem() {
        #expect(decide("mailto:someone@example.com") == .external(URL(string: "mailto:someone@example.com")!))
        #expect(decide("tel:+911234567890") == .external(URL(string: "tel:+911234567890")!))
    }

    @Test func oddSchemesAreBlocked() {
        for link in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "whatsapp://send?text=hi", "ftp://example.com/x"] {
            #expect(decide(link) == .block, "\(link)")
        }
    }

    @Test func signInLinkIsRecognised() {
        let link = URL(string: "jassi://auth?code=test")!
        #expect(DeepLink.parse(link) == .auth(link))
        #expect(DeepLink.parse(URL(string: "JASSI://AUTH?code=test")!) != nil)
        #expect(decide("jassi://auth?code=test") == .deepLink(link))
    }

    @Test func otherLinksIntoTheAppAreIgnored() {
        for link in ["jassi://open?x=1", "jassi://authx?code=1", "jassi:auth", "https://\(host)/auth?code=1", "other://auth?code=1"] {
            #expect(DeepLink.parse(URL(string: link)!) == nil, "\(link)")
        }
    }

    @Test func openExternalSendsSignInToTheSignInSheetAndTheRestToSafari() {
        let start = URL(string: "https://\(host)/auth/google/start?app=abc123")!
        #expect(ExternalRoute.route(start, base: live) == .authSession(start))

        let page = URL(string: "https://\(host)/help")!
        #expect(ExternalRoute.route(page, base: live) == .browser(page))

        let elsewhere = URL(string: "https://evil.com/auth/google/start")!
        #expect(ExternalRoute.route(elsewhere, base: live) == .browser(elsewhere))

        // Connecting another company's app: their sign-in page, handing back to J.A.S.S.I's own address.
        let connect = URL(string: "https://mcp.notion.com/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2F\(host)%2Fauth%2Fmcp%2Fcallback&state=xyz")!
        #expect(ExternalRoute.route(connect, base: live) == .authSession(connect))

        // The same kind of page handing back to someone else is just a web page.
        let foreign = URL(string: "https://mcp.notion.com/authorize?redirect_uri=https%3A%2F%2Fevil.com%2Fcallback")!
        #expect(ExternalRoute.route(foreign, base: live) == .browser(foreign))
        let lookalike = URL(string: "https://mcp.notion.com/authorize?redirect_uri=https%3A%2F%2F\(host).evil.com%2Fcb")!
        #expect(ExternalRoute.route(lookalike, base: live) == .browser(lookalike))

        #expect(ExternalRoute.route(URL(string: "file:///etc/passwd")!, base: live) == .reject)
        #expect(ExternalRoute.route(URL(string: "jassi://auth?code=1")!, base: live) == .reject)
    }
}
