import Foundation
import JavaScriptCore
import Testing
@testable import JassiCore

private func parse(_ method: String, _ args: Any? = nil) -> Result<BridgeCall, BridgeFailure> {
    BridgeRouter.parse(["method": method, "args": args ?? NSNull()] as [String: Any])
}

@Suite("Reading bridge calls")
struct BridgeRouterTests {
    /// The method names in contract §2, in the contract's order.
    private let contractMethods = [
        "listApps", "permissions", "openPermission", "pair", "unpair", "setPolicy", "openExternal",
        "biometric", "listenStart", "listenStop", "bubble", "speak", "speakStop", "notify", "stop",
    ]

    @Test func everyContractMethodExists() {
        #expect(BridgeMethod.allCases.map(\.rawValue) == contractMethods)
    }

    @Test func callsWithoutArgumentsAreRead() {
        #expect(parse("listApps") == .success(.listApps))
        #expect(parse("permissions") == .success(.permissions))
        #expect(parse("unpair") == .success(.unpair))
        #expect(parse("listenStop") == .success(.listenStop))
        #expect(parse("speakStop") == .success(.speakStop))
        #expect(parse("stop") == .success(.stop))
    }

    @Test func openPermissionTakesTheKindAsPlainText() {
        #expect(parse("openPermission", "mic") == .success(.openPermission(.mic)))
        #expect(parse("openPermission", "speech") == .success(.openPermission(.speech)))
        #expect(parse("openPermission", "notifications") == .success(.openPermission(.notifications)))
        #expect(parse("openPermission", "screen") == .success(.openPermission(.screen)))
        #expect(parse("openPermission", ["kind": "mic"]) == .success(.openPermission(.mic)))
        #expect(parse("openPermission", "camera") == .failure(.badArgs))
        #expect(parse("openPermission") == .failure(.badArgs))
    }

    @Test func openExternalTakesAWebLinkOnly() {
        let link = "https://jassi.pulin-chaudhari.workers.dev/auth/google/start?app=abc"
        #expect(parse("openExternal", link) == .success(.openExternal(URL(string: link)!)))
        #expect(parse("openExternal", ["url": link]) == .success(.openExternal(URL(string: link)!)))
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "jassi://auth?code=1", "tel:123", "", "not a link"] {
            #expect(parse("openExternal", bad) == .failure(.badArgs), "\(bad)")
        }
        #expect(parse("openExternal", 42) == .failure(.badArgs))
    }

    @Test func pairNeedsAllThreeFields() {
        let full = ["server": "https://jassi.example", "deviceId": "d1", "token": "t1"]
        #expect(parse("pair", full) == .success(.pair(server: "https://jassi.example", deviceId: "d1", token: "t1")))
        for missing in full.keys {
            var args = full
            args[missing] = nil
            #expect(parse("pair", args) == .failure(.badArgs), "without \(missing)")
        }
        #expect(parse("pair", ["server": "s", "deviceId": "d", "token": "  "]) == .failure(.badArgs))
    }

    @Test func setPolicyLowercasesAppIds() {
        #expect(parse("setPolicy", ["blockedApps": ["com.Bank.App", "net.one97.paytm"]])
            == .success(.setPolicy(blockedApps: ["com.bank.app", "net.one97.paytm"])))
        #expect(parse("setPolicy", ["blockedApps": [String]()]) == .success(.setPolicy(blockedApps: [])))
        #expect(parse("setPolicy", [String: Any]()) == .failure(.badArgs))
        #expect(parse("setPolicy", ["blockedApps": "com.bank.app"]) == .failure(.badArgs))
    }

    @Test func voiceCallsDefaultToIndianEnglish() {
        #expect(parse("listenStart") == .success(.listenStart(lang: "en-IN", onDevice: false)))
        #expect(parse("listenStart", ["lang": "hi-IN"]) == .success(.listenStart(lang: "hi-IN", onDevice: false)))
        #expect(parse("listenStart", ["lang": "en IN; rm"]) == .success(.listenStart(lang: "en-IN", onDevice: false)))
        #expect(parse("speak", ["text": "Hello"]) == .success(.speak(text: "Hello", lang: "en-IN")))
        #expect(parse("speak", ["text": "नमस्ते", "lang": "hi-IN"]) == .success(.speak(text: "नमस्ते", lang: "hi-IN")))
        #expect(parse("speak", ["text": "   "]) == .failure(.badArgs))
        #expect(parse("speak") == .failure(.badArgs))
    }

    @Test func listeningStaysOnTheDeviceOnlyWhenAskedWithARealTrue() {
        #expect(parse("listenStart", ["lang": "en-IN", "onDevice": true]) == .success(.listenStart(lang: "en-IN", onDevice: true)))
        #expect(parse("listenStart", ["onDevice": false]) == .success(.listenStart(lang: "en-IN", onDevice: false)))
        #expect(parse("listenStart", ["onDevice": "true"]) == .success(.listenStart(lang: "en-IN", onDevice: false)))
        #expect(parse("listenStart", ["onDevice": 1]) == .success(.listenStart(lang: "en-IN", onDevice: false)))
    }

    @Test func biometricAndNotifyFillInWhatIsMissing() {
        #expect(parse("biometric", ["reason": "Pay ₹500 to Asha"]) == .success(.biometric(reason: "Pay ₹500 to Asha")))
        #expect(parse("biometric") == .success(.biometric(reason: BridgeDefaults.biometricReason)))
        #expect(parse("notify", ["title": "Done", "body": "Sent"]) == .success(.notify(title: "Done", body: "Sent")))
        #expect(parse("notify", ["title": "Done"]) == .success(.notify(title: "Done", body: "")))
        #expect(parse("notify", ["body": "no title"]) == .failure(.badArgs))
    }

    @Test func anythingElseIsRefused() {
        #expect(parse("screenRead") == .failure(.unknownMethod))
        #expect(parse("") == .failure(.unknownMethod))
        #expect(BridgeRouter.parse(nil) == .failure(.unknownMethod))
        #expect(BridgeRouter.parse("listApps") == .failure(.unknownMethod))
        #expect(BridgeRouter.parse(["args": "mic"]) == .failure(.unknownMethod))
    }
}

@Suite("The script injected into the page")
struct BridgeScriptTests {
    private let origin = Origin(url: URL(string: "https://jassi.pulin-chaudhari.workers.dev")!)!

    /// Runs the injected script in a bare JavaScript engine that stands in for the page.
    private func page(origin pageOrigin: String, handler: Bool = true, frame: Bool = false) -> JSContext {
        let js = JSContext()!
        js.evaluateScript("var window = this; var sent = []; var location = { origin: '\(pageOrigin)' };")
        js.evaluateScript(frame ? "window.top = {};" : "window.top = window;")
        if handler {
            js.evaluateScript("""
            window.webkit = { messageHandlers: { jassi: { postMessage: function (m) {
              sent.push(m);
              return m.method === 'stop' ? Promise.reject(new Error('forbidden')) : Promise.resolve({ ok: true });
            } } } };
            """)
        }
        js.evaluateScript(BridgeScript.source(origin: origin, version: "1.2.3"))
        return js
    }

    /// Calls a bridge method and returns what its Promise resolved to, as JSON.
    private func call(_ js: JSContext, _ expression: String) -> String? {
        js.evaluateScript("var out; var threw = false; try { \(expression).then(function (r) { out = JSON.stringify(r); }); } catch (e) { threw = true; }")
        #expect(js.evaluateScript("threw").toBool() == false)
        return js.evaluateScript("out").toString()
    }

    @Test func hasTheContractFieldsAndEveryMethod() {
        let js = page(origin: origin.serialized)
        #expect(js.exception == nil)
        #expect(js.evaluateScript("jassiNative.platform").toString() == "ios")
        #expect(js.evaluateScript("jassiNative.version").toString() == "1.2.3")
        #expect(js.evaluateScript("jassiNative.contract").toInt32() == 1)
        for method in BridgeMethod.allCases {
            #expect(js.evaluateScript("typeof jassiNative.\(method.rawValue)").toString() == "function", "\(method.rawValue)")
        }
    }

    @Test func passesTheMethodAndItsFirstArgumentToTheShell() {
        let js = page(origin: origin.serialized)
        #expect(call(js, "jassiNative.speak({ text: 'Hi', lang: 'en-IN' })") == #"{"ok":true}"#)
        #expect(call(js, "jassiNative.openPermission('mic')") == #"{"ok":true}"#)
        #expect(call(js, "jassiNative.listApps()") == #"{"ok":true}"#)
        #expect(js.evaluateScript("JSON.stringify(sent)").toString()
            == #"[{"method":"speak","args":{"text":"Hi","lang":"en-IN"}},{"method":"openPermission","args":"mic"},{"method":"listApps","args":null}]"#)
    }

    @Test func bubblePassesTextAndWhoThrough() {
        let js = page(origin: origin.serialized)
        #expect(call(js, "jassiNative.bubble({ visible: true, state: 'listening', text: 'pay Asha', who: 'you' })") == #"{"ok":true}"#)
        #expect(js.evaluateScript("JSON.stringify(sent)").toString()
            == #"[{"method":"bubble","args":{"visible":true,"state":"listening","text":"pay Asha","who":"you"}}]"#)
    }

    @Test func neverThrowsOrRejects() {
        let js = page(origin: origin.serialized)
        // The shell refusing a call still resolves, with ok: false.
        #expect(call(js, "jassiNative.stop()") == #"{"ok":false,"error":"forbidden"}"#)
        // No shell behind the page at all.
        let alone = page(origin: origin.serialized, handler: false)
        #expect(call(alone, "jassiNative.listApps()") == #"{"ok":false,"error":"unsupported"}"#)
    }

    @Test func cannotBeReplacedByThePage() {
        let js = page(origin: origin.serialized)
        js.evaluateScript("try { window.jassiNative = { fake: true }; } catch (e) {} try { jassiNative.speak = 1; } catch (e) {}")
        #expect(js.evaluateScript("jassiNative.platform").toString() == "ios")
        #expect(js.evaluateScript("typeof jassiNative.speak").toString() == "function")
    }

    @Test func isAbsentOnOtherSitesAndInsideFrames() {
        #expect(page(origin: "https://evil.com").evaluateScript("typeof jassiNative").toString() == "undefined")
        #expect(page(origin: "http://jassi.pulin-chaudhari.workers.dev").evaluateScript("typeof jassiNative").toString() == "undefined")
        #expect(page(origin: origin.serialized, frame: true).evaluateScript("typeof jassiNative").toString() == "undefined")
    }
}

@Suite("Events for the page")
struct EventTests {
    private let allAsk = PermissionSnapshot(screen: .unsupported, mic: .ask, speech: .ask, notifications: .ask)

    @Test func signInAndAskWaitForThePage() {
        var queue = EventQueue()
        #expect(queue.submit(.auth(url: "jassi://auth?code=test")) == nil)
        #expect(queue.submit(.ask(text: "Pay the rent")) == nil)
        #expect(queue.pageDidLoad() == [.auth(url: "jassi://auth?code=test"), .ask(text: "Pay the rent")])
        #expect(queue.pageDidLoad().isEmpty) // delivered once only
    }

    @Test func liveEventsAreNotKeptForLater() {
        var queue = EventQueue()
        #expect(queue.submit(.speech(text: "hel", final: false)) == nil)
        #expect(queue.submit(.permission(allAsk)) == nil)
        #expect(queue.pageDidLoad().isEmpty)
    }

    @Test func onceThePageIsUpEventsGoStraightThrough() {
        var queue = EventQueue()
        _ = queue.pageDidLoad()
        #expect(queue.submit(.ask(text: "hi")) == .ask(text: "hi"))
        #expect(queue.submit(.speechEnd(error: nil)) == .speechEnd(error: nil))
        queue.pageWillLoad() // a reload: wait again
        #expect(queue.submit(.auth(url: "jassi://auth?code=2")) == nil)
        #expect(queue.pageDidLoad() == [.auth(url: "jassi://auth?code=2")])
    }

    @Test func aTapOnTheBubbleWaitsForThePage() {
        var queue = EventQueue()
        #expect(queue.submit(.bubble(.tap)) == nil)
        #expect(queue.pageDidLoad() == [.bubble(.tap)])
    }

    @Test func eventsHaveTheContractShape() throws {
        func json(_ event: NativeEvent) throws -> String {
            String(data: try JSONSerialization.data(withJSONObject: event.detail, options: .sortedKeys), encoding: .utf8)!
        }
        #expect(try json(.auth(url: "jassi://auth?code=test")) == #"{"type":"auth","url":"jassi:\/\/auth?code=test"}"#)
        #expect(try json(.bubble(.tap)) == #"{"action":"tap","type":"bubble"}"#)
        #expect(try json(.bubble(.dismissed)) == #"{"action":"dismissed","type":"bubble"}"#)
        #expect(try json(.ask(text: "Pay the rent")) == #"{"text":"Pay the rent","type":"ask"}"#)
        #expect(try json(.speech(text: "hello", final: true)) == #"{"final":true,"text":"hello","type":"speech"}"#)
        #expect(try json(.speechEnd(error: nil)) == #"{"type":"speech-end"}"#)
        #expect(try json(.speechEnd(error: "failed")) == #"{"error":"failed","type":"speech-end"}"#)
        #expect(try json(.permission(allAsk))
            == #"{"permissions":{"mic":"ask","notifications":"ask","screen":"unsupported","speech":"ask"},"type":"permission"}"#)
    }
}
