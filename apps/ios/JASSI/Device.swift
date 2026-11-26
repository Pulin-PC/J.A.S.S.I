import LocalAuthentication
import Security
import UIKit
import UserNotifications
import JassiCore

/// `biometric`: Face ID or Touch ID. The real thing only, no passcode fallback.
enum Biometric {
    static func confirm(reason: String) async -> [String: Any] {
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else {
            return BridgeReply.unsupported // no Face ID / Touch ID here, or none set up
        }
        do {
            let passed = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            return passed ? BridgeReply.ok : BridgeReply.fail("failed")
        } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
            return BridgeReply.fail("cancelled")
        } catch {
            return BridgeReply.fail("failed")
        }
    }
}

/// `notify`: a system notification, shown as a banner even while the app is open.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    func send(title: String, body: String) async -> [String: Any] {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else { return BridgeReply.fail("permission") }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        do {
            try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            return BridgeReply.ok
        } catch {
            return BridgeReply.fail("failed")
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}

/// `listApps`: the well-known apps found on this phone (see `KnownApps`). Always `partial: true`.
@MainActor
enum AppLister {
    static func list() -> [String: Any] {
        let found = KnownApps.installed { scheme in
            guard let url = URL(string: "\(scheme)://") else { return false }
            return UIApplication.shared.canOpenURL(url)
        }
        return ["ok": true, "apps": found.map { ["id": $0.id, "name": $0.name] }, "partial": true]
    }
}

/// `pair` / `unpair`: the device token lives only in the Keychain and is never logged (contract §4.6).
/// iPhone has no screen control, so nothing here ever starts a device channel.
enum Pairing {
    private static let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "jassi.device",
        kSecAttrAccount as String: "pairing",
    ]

    static func save(server: String, deviceId: String, token: String) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: ["server": server, "deviceId": deviceId, "token": token]) else {
            return false
        }
        guard forget() else { return false }
        var entry = item
        entry[kSecValueData as String] = data
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(entry as CFDictionary, nil) == errSecSuccess
    }

    static func forget() -> Bool {
        let status = SecItemDelete(item as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// `setPolicy`: the locked-app list, kept on the device. Nothing on iPhone reads other apps, so it is only stored.
enum Policy {
    static func save(blockedApps: [String]) {
        UserDefaults.standard.set(blockedApps, forKey: "blockedApps")
    }
}
