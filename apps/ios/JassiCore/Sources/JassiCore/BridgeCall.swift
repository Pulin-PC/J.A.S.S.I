import Foundation

/// Every method of `window.jassiNative` (contract §2). The names are the ones the web app calls.
public enum BridgeMethod: String, CaseIterable, Sendable {
    case listApps, permissions, openPermission, pair, unpair, setPolicy, openExternal
    case biometric, listenStart, listenStop, bubble, speak, speakStop, notify, stop
}

public enum PermissionKind: String, CaseIterable, Sendable {
    case screen, mic, speech, notifications
}

public enum BridgeDefaults {
    public static let lang = "en-IN"
    public static let biometricReason = "Confirm it's you"
}

/// A bridge call after its arguments have been checked.
public enum BridgeCall: Equatable {
    case listApps
    case permissions
    case openPermission(PermissionKind)
    case pair(server: String, deviceId: String, token: String)
    case unpair
    case setPolicy(blockedApps: [String])
    case openExternal(URL)
    case biometric(reason: String)
    case listenStart(lang: String, onDevice: Bool)
    case listenStop
    case bubble(BubbleUpdate)
    case speak(text: String, lang: String)
    case speakStop
    case notify(title: String, body: String)
    case stop
}

public enum BridgeFailure: String, Error, Equatable {
    case unknownMethod = "unknown_method"
    case badArgs = "bad_args"
}

/// The answers the bridge sends back to the page.
public enum BridgeReply {
    public static var ok: [String: Any] { ["ok": true] }
    public static func fail(_ error: String) -> [String: Any] { ["ok": false, "error": error] }
    /// Contract §2: "Not possible on this device".
    public static var unsupported: [String: Any] { fail("unsupported") }
}

public enum BridgeRouter {
    /// Reads one message from the page: `{ method: "speak", args: { text: "Hi" } }`.
    public static func parse(_ body: Any?) -> Result<BridgeCall, BridgeFailure> {
        guard let message = body as? [String: Any],
              let name = message["method"] as? String,
              let method = BridgeMethod(rawValue: name) else { return .failure(.unknownMethod) }
        let args = message["args"]
        let fields = args as? [String: Any] ?? [:]

        switch method {
        case .listApps: return .success(.listApps)
        case .permissions: return .success(.permissions)
        case .unpair: return .success(.unpair)
        case .listenStop: return .success(.listenStop)
        case .speakStop: return .success(.speakStop)
        case .stop: return .success(.stop)

        case .openPermission:
            // Called as openPermission("mic").
            guard let raw = args as? String ?? fields["kind"] as? String,
                  let kind = PermissionKind(rawValue: raw) else { return .failure(.badArgs) }
            return .success(.openPermission(kind))

        case .openExternal:
            // Called as openExternal("https://…").
            guard let raw = args as? String ?? fields["url"] as? String,
                  let url = URL(string: raw), Origin(url: url) != nil else { return .failure(.badArgs) }
            return .success(.openExternal(url))

        case .pair:
            guard let server = text(fields["server"]), let deviceId = text(fields["deviceId"]),
                  let token = text(fields["token"]) else { return .failure(.badArgs) }
            return .success(.pair(server: server, deviceId: deviceId, token: token))

        case .setPolicy:
            guard let apps = fields["blockedApps"] as? [String] else { return .failure(.badArgs) }
            return .success(.setPolicy(blockedApps: apps.map { $0.lowercased() }))

        case .biometric:
            return .success(.biometric(reason: text(fields["reason"]) ?? BridgeDefaults.biometricReason))

        case .listenStart:
            return .success(.listenStart(lang: lang(fields["lang"]), onDevice: flag(fields["onDevice"]) ?? false))

        case .bubble:
            guard let update = bubbleUpdate(fields) else { return .failure(.badArgs) }
            return .success(.bubble(update))

        case .speak:
            guard let words = text(fields["text"]) else { return .failure(.badArgs) }
            return .success(.speak(text: words, lang: lang(fields["lang"])))

        case .notify:
            guard let title = text(fields["title"]) else { return .failure(.badArgs) }
            return .success(.notify(title: title, body: text(fields["body"]) ?? ""))
        }
    }

    /// A string with something in it, or nil.
    private static func text(_ value: Any?) -> String? {
        guard let string = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !string.isEmpty else { return nil }
        return string
    }

    /// `{ visible?, state?, text?, who? }`. Left out (or null) is fine; a wrong value, or nothing at all, is not.
    private static func bubbleUpdate(_ fields: [String: Any]) -> BubbleUpdate? {
        func given(_ key: String) -> Any? {
            let value = fields[key]
            return value is NSNull ? nil : value
        }
        var update = BubbleUpdate()
        if let value = given("visible") {
            guard let visible = flag(value) else { return nil }
            update.visible = visible
        }
        if let value = given("state") {
            guard let state = (value as? String).flatMap(BubbleState.init(rawValue:)) else { return nil }
            update.state = state
        }
        if let value = given("text") {
            guard let words = value as? String else { return nil }
            update.text = words
        }
        if let value = given("who") {
            guard let who = (value as? String).flatMap(BubbleSpeaker.init(rawValue:)) else { return nil }
            update.who = who
        }
        return update == BubbleUpdate() ? nil : update
    }

    /// A real `true` or `false`: a number such as 1 does not count.
    private static func flag(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// A language tag such as "en-IN" or "hi-IN". Anything odd falls back to the default.
    private static func lang(_ value: Any?) -> String {
        guard let tag = text(value), tag.count <= 35,
              tag.unicodeScalars.allSatisfy({ ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" })
        else { return BridgeDefaults.lang }
        return tag
    }
}
