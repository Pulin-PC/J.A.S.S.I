import Foundation

public enum PermissionState: String, Sendable {
    case granted, denied, ask, unsupported
}

/// The answer to `permissions()` (contract §2).
public struct PermissionSnapshot: Equatable, Sendable {
    public var screen: PermissionState
    public var mic: PermissionState
    public var speech: PermissionState
    public var notifications: PermissionState

    public init(screen: PermissionState, mic: PermissionState, speech: PermissionState, notifications: PermissionState) {
        self.screen = screen
        self.mic = mic
        self.speech = speech
        self.notifications = notifications
    }

    public var dictionary: [String: String] {
        ["screen": screen.rawValue, "mic": mic.rawValue, "speech": speech.rawValue, "notifications": notifications.rawValue]
    }
}

/// What the shell tells the page: `new CustomEvent("jassi-native", { detail })`.
public enum NativeEvent: Equatable {
    case permission(PermissionSnapshot)
    case speech(text: String, final: Bool)
    case speechEnd(error: String?)
    case auth(url: String)
    case ask(text: String)

    public var detail: [String: Any] {
        switch self {
        case .permission(let snapshot): return ["type": "permission", "permissions": snapshot.dictionary]
        case .speech(let text, let final): return ["type": "speech", "text": text, "final": final]
        case .speechEnd(let error):
            var detail: [String: Any] = ["type": "speech-end"]
            if let error { detail["error"] = error }
            return detail
        case .auth(let url): return ["type": "auth", "url": url]
        case .ask(let text): return ["type": "ask", "text": text]
        }
    }

    /// Sign-in links and words handed in from outside must not be lost while the page is still loading.
    var waitsForPage: Bool {
        switch self {
        case .auth, .ask: return true
        default: return false
        }
    }
}

/// Holds `auth` and `ask` events until the page has loaded (contract §2). Other events only matter live.
public struct EventQueue {
    public private(set) var pageReady = false
    private var waiting: [NativeEvent] = []
    private let limit = 20

    public init() {}

    public mutating func pageWillLoad() { pageReady = false }

    /// The page finished loading: returns everything that was waiting, oldest first.
    public mutating func pageDidLoad() -> [NativeEvent] {
        pageReady = true
        defer { waiting = [] }
        return waiting
    }

    /// Returns the event if it should go to the page now. Otherwise it is kept (auth, ask) or dropped.
    public mutating func submit(_ event: NativeEvent) -> NativeEvent? {
        if pageReady { return event }
        if event.waitsForPage {
            waiting.append(event)
            if waiting.count > limit { waiting.removeFirst(waiting.count - limit) }
        }
        return nil
    }
}
