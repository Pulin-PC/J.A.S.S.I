import ActivityKit
import UIKit
import JassiCore

/// `bubble`: the Live Activity. `BubblePlanner` (JassiCore) decides what goes out and when; this does it.
@MainActor
final class Bubble {
    /// How long the bubble may go without news before it draws itself asleep (iOS may have paused the app).
    private static let freshFor: TimeInterval = 30

    private let emit: (NativeEvent) -> Void
    private var planner = BubblePlanner()
    private var activity: Activity<JassiBubbleAttributes>?
    private var watcher: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    /// ActivityKit calls run one after another, so an old update never lands on top of a newer one.
    private var queue: Task<Void, Never>?

    init(emit: @escaping (NativeEvent) -> Void) {
        self.emit = emit
        // A bubble left over from an earlier run: take it down. The page asks for a new one.
        for old in Activity<JassiBubbleAttributes>.activities {
            enqueue { await old.end(nil, dismissalPolicy: .immediate) }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification,
                                               object: nil, queue: .main) { _ in
            // The app is being closed: end the bubble before the process goes.
            let done = DispatchSemaphore(value: 0)
            Task.detached {
                for each in Activity<JassiBubbleAttributes>.activities {
                    await each.end(nil, dismissalPolicy: .immediate)
                }
                done.signal()
            }
            _ = done.wait(timeout: .now() + 1)
        }
    }

    func apply(_ update: BubbleUpdate) -> [String: Any] {
        noticeDismissal()
        let step = planner.apply(update, now: Date())
        guard perform(step) else {
            return BridgeReply.fail(ActivityAuthorizationInfo().areActivitiesEnabled ? "failed" : "no_permission")
        }
        return BridgeReply.ok
    }

    /// The app came to the front: the only time iOS lets a Live Activity start, so start one that is owed.
    func appBecameActive() {
        noticeDismissal()
        guard planner.shown, activity == nil else { return }
        _ = perform(.show(planner.content))
    }

    /// The app is leaving the screen, which is when the bubble is seen: send anything still waiting.
    func appWillLeave() {
        _ = perform(planner.flush(now: Date()))
    }

    /// False only when the bubble should be up and iOS would not start it.
    private func perform(_ step: BubblePlanner.Step) -> Bool {
        switch step {
        case .show(let content):
            let fresh = ActivityContent(state: content,
                                        staleDate: content.state == .sleep && content.caption.isEmpty
                                            ? nil : Date().addingTimeInterval(Self.freshFor))
            if let activity {
                enqueue { await activity.update(fresh) }
            } else if !start(fresh) {
                return false
            }
            schedule(planner.next(now: Date())) // a caption still has to fade
        case .wait:
            schedule(step)
        case .end:
            end()
        case .none:
            break
        }
        return true
    }

    private func start(_ content: ActivityContent<BubbleContent>) -> Bool {
        guard let started = try? Activity.request(attributes: JassiBubbleAttributes(), content: content) else {
            return false
        }
        activity = started
        watcher?.cancel()
        watcher = Task { [weak self] in
            for await state in started.activityStateUpdates {
                guard !Task.isCancelled else { return }
                if state == .dismissed { self?.dismissed(started.id) }
                // Ended by iOS (it allows 8 hours): forget it, so the next "show" starts a new one.
                if state == .ended { self?.forget(started.id) }
            }
        }
        return true
    }

    private func schedule(_ step: BubblePlanner.Step) {
        guard case .wait(let seconds) = step else { return }
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let self else { return }
            _ = self.perform(self.planner.next(now: Date()))
        }
    }

    /// The user may have swiped it away while the app was paused.
    private func noticeDismissal() {
        if let activity, activity.activityState == .dismissed { dismissed(activity.id) }
    }

    private func dismissed(_ id: String) {
        guard activity?.id == id || activity == nil && planner.shown else { return }
        activity = nil
        timer?.cancel()
        planner.hide()
        emit(.bubble(.dismissed))
    }

    private func forget(_ id: String) {
        guard activity?.id == id else { return }
        activity = nil
    }

    private func end() {
        watcher?.cancel() // our own ending is not the user's dismissal
        watcher = nil
        timer?.cancel()
        guard let old = activity else { return }
        activity = nil
        enqueue { await old.end(nil, dismissalPolicy: .immediate) }
    }

    private func enqueue(_ work: @escaping @Sendable () async -> Void) {
        let before = queue
        queue = Task {
            await before?.value
            await work()
        }
    }
}
