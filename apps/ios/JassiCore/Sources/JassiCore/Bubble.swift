import Foundation

/// What J.A.S.S.I is doing, as the bubble shows it (contract §2, `bubble`).
public enum BubbleState: String, Codable, Hashable, Sendable, CaseIterable {
    case sleep, listening, thinking, speaking
}

/// Whose words the caption shows: live words, or J.A.S.S.I's reply.
public enum BubbleSpeaker: String, Codable, Hashable, Sendable {
    case you, jassi
}

/// What the user did to the bubble, as sent back to the page.
public enum BubbleAction: String, Sendable {
    case tap, dismissed
}

/// One `bubble({ visible?, state?, text?, who? })` call. A field that was left out changes nothing.
public struct BubbleUpdate: Equatable, Sendable {
    public var visible: Bool?
    public var state: BubbleState?
    public var text: String?
    public var who: BubbleSpeaker?

    public init(visible: Bool? = nil, state: BubbleState? = nil, text: String? = nil, who: BubbleSpeaker? = nil) {
        self.visible = visible
        self.state = state
        self.text = text
        self.who = who
    }
}

/// Everything the Live Activity draws.
public struct BubbleContent: Codable, Hashable, Sendable {
    public var state: BubbleState
    /// One line, already cut to length. Empty: no caption.
    public var caption: String
    public var who: BubbleSpeaker

    public init(state: BubbleState = .sleep, caption: String = "", who: BubbleSpeaker = .jassi) {
        self.state = state
        self.caption = caption
        self.who = who
    }

    public static let captionLimit = 90

    /// Folds words onto one line. Live words keep their end (the newest words), a reply keeps its start.
    public static func line(_ text: String, who: BubbleSpeaker, limit: Int = captionLimit) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        guard flat.count > limit else { return flat }
        let kept = limit - 1
        switch who {
        case .you: return "…" + String(flat.suffix(kept)).trimmingCharacters(in: .whitespaces)
        case .jassi: return String(flat.prefix(kept)).trimmingCharacters(in: .whitespaces) + "…"
        }
    }
}

/// Decides when the bubble starts, changes and ends. It holds the update rate down so live words do not
/// use up what ActivityKit allows, and takes a caption away a few seconds after the last words.
/// No timers and no ActivityKit here: the caller passes the time in and does what the step says.
public struct BubblePlanner {
    /// Shortest gap before a change of state goes out.
    public static let stateInterval: TimeInterval = 0.3
    /// Shortest gap between two caption-only changes.
    public static let captionInterval: TimeInterval = 1.0
    /// How long a caption stays after the last words.
    public static let captionLife: TimeInterval = 6

    public enum Step: Equatable {
        /// Show this now, starting the bubble if it is not up.
        case show(BubbleContent)
        /// Nothing to send yet: ask `next` again after this many seconds.
        case wait(TimeInterval)
        /// Take the bubble away.
        case end
        case none
    }

    public private(set) var shown = false
    public private(set) var content = BubbleContent()
    private var sent: BubbleContent?
    private var sentAt = Date.distantPast
    private var wordsAt = Date.distantPast

    public init() {}

    public mutating func apply(_ update: BubbleUpdate, now: Date) -> Step {
        if update.visible == false {
            hide()
            return .end
        }
        let appearing = update.visible == true && !shown
        if appearing { shown = true }
        if let state = update.state, state != content.state {
            // A reply that was just read out stays a little longer.
            if content.state == .speaking { wordsAt = now }
            content.state = state
        }
        // Contract §2: words only count while the bubble is shown.
        if shown, let text = update.text {
            let who = update.who ?? .jassi
            content.caption = BubbleContent.line(text, who: who)
            content.who = who
            wordsAt = now
        }
        // Asking for it by name always sends, so a bubble the system lost comes back.
        if update.visible == true { sent = nil }
        return next(now: now)
    }

    /// What is due now.
    public mutating func next(now: Date) -> Step {
        guard shown else { return .none }
        // While J.A.S.S.I is working or talking the caption stays; otherwise it fades.
        let canFade = !content.caption.isEmpty && (content.state == .sleep || content.state == .listening)
        let fadeIn = wordsAt.addingTimeInterval(Self.captionLife).timeIntervalSince(now)
        if canFade, fadeIn <= 0 { content.caption = "" }

        guard let last = sent else { return send(now: now) }
        if content == last {
            return canFade && fadeIn > 0 ? .wait(fadeIn) : .none
        }
        let gap = content.state == last.state ? Self.captionInterval : Self.stateInterval
        let left = gap - now.timeIntervalSince(sentAt)
        return left > 0.001 ? .wait(left) : send(now: now)
    }

    /// Whatever is still waiting, right now: used as the app leaves the screen.
    public mutating func flush(now: Date) -> Step {
        guard shown, content != sent else { return .none }
        return send(now: now)
    }

    /// The bubble is gone (asked to hide, binned by the user, or ended by the system).
    public mutating func hide() {
        shown = false
        content = BubbleContent()
        sent = nil
        sentAt = .distantPast
        wordsAt = .distantPast
    }

    private mutating func send(now: Date) -> Step {
        sent = content
        sentAt = now
        return .show(content)
    }
}
