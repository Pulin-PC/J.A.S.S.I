import Foundation
import SwiftUI
import JassiCore

enum AppConfig {
    static let liveURL = URL(string: "https://jassi.pulin-chaudhari.workers.dev")!

    /// The one address the app loads. Set by the `JASSI_URL` build setting (Info.plist key `JassiURL`).
    static let baseURL: URL = {
        #if DEBUG
        // Debug builds only: `simctl launch <device> <bundle id> -JASSI_URL http://localhost:3000`.
        if let url = usable(UserDefaults.standard.string(forKey: "JASSI_URL")) { return url }
        #endif
        return usable(Bundle.main.object(forInfoDictionaryKey: "JassiURL") as? String) ?? liveURL
    }()

    static let origin: Origin = Origin(url: baseURL) ?? Origin(url: liveURL)!

    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"

    private static func usable(_ text: String?) -> URL? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: text), Origin(url: url) != nil else { return nil }
        return url
    }
}

enum Theme {
    /// The web app's own background (#01060c), so the edges of the screen match the page.
    static let background = Color(red: 1 / 255, green: 6 / 255, blue: 12 / 255)
    static let accent = Color(red: 60 / 255, green: 232 / 255, blue: 255 / 255)
}
