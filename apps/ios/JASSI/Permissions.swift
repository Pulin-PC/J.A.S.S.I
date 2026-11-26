import AVFAudio
import Speech
import UIKit
import UserNotifications
import JassiCore

/// Reads and asks for the permissions the web app's setup screen shows (contract §2 and §5).
@MainActor
enum Permissions {
    static func snapshot() async -> PermissionSnapshot {
        PermissionSnapshot(
            screen: .unsupported, // iPhone never lets one app read or control another
            mic: mic,
            speech: speech,
            notifications: await notifications())
    }

    /// Shows the system question the first time. After that only the Settings page can change the answer.
    static func open(_ kind: PermissionKind) async {
        switch kind {
        case .screen:
            return
        case .mic:
            if mic == .ask {
                _ = await AVAudioApplication.requestRecordPermission()
            } else {
                await openSettings(UIApplication.openSettingsURLString)
            }
        case .speech:
            if speech == .ask {
                await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                    SFSpeechRecognizer.requestAuthorization { _ in done.resume() }
                }
            } else {
                await openSettings(UIApplication.openSettingsURLString)
            }
        case .notifications:
            if await notifications() == .ask {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            } else {
                await openSettings(UIApplication.openNotificationSettingsURLString)
            }
        }
    }

    static var mic: PermissionState {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .ask
        }
    }

    static var speech: PermissionState {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .notDetermined: return .ask
        default: return .denied
        }
    }

    static func notifications() async -> PermissionState {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional: return .granted
        case .notDetermined: return .ask
        default: return .denied
        }
    }

    private static func openSettings(_ link: String) async {
        guard let url = URL(string: link) else { return }
        await UIApplication.shared.open(url)
    }
}
