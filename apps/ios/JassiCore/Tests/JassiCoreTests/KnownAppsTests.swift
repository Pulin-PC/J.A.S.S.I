import Foundation
import Testing
@testable import JassiCore

@Suite("The list of apps we look for")
struct KnownAppsTests {
    @Test func staysWithinWhatiPhoneAllows() {
        #expect(!KnownApps.all.isEmpty)
        #expect(KnownApps.all.count <= KnownApps.limit)
        #expect(KnownApps.limit == 50)
    }

    @Test func noAppOrSchemeIsListedTwice() {
        #expect(Set(KnownApps.all.map(\.id)).count == KnownApps.all.count)
        #expect(Set(KnownApps.schemes).count == KnownApps.all.count)
        #expect(Set(KnownApps.all.map(\.name)).count == KnownApps.all.count)
    }

    @Test func idsAreLowerCaseBundleIdsAndSchemesAreValid() {
        let idShape = try! NSRegularExpression(pattern: "^[a-z0-9]+([.-][a-z0-9]+)*$")
        let schemeShape = try! NSRegularExpression(pattern: "^[a-z][a-z0-9+.-]*$")
        func fits(_ text: String, _ shape: NSRegularExpression) -> Bool {
            shape.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
        }
        for app in KnownApps.all {
            #expect(fits(app.id, idShape), "id \(app.id)")
            #expect(fits(app.scheme, schemeShape), "scheme \(app.scheme)")
            #expect(!app.name.isEmpty)
            #expect(URL(string: "\(app.scheme)://") != nil, "\(app.scheme)")
            // Never our own links, and never the web: those say nothing about which app is installed.
            #expect(!["jassi", "http", "https"].contains(app.scheme))
        }
    }

    @Test func returnsOnlyTheAppsThePhoneSaysItHas() {
        let onPhone: Set<String> = ["whatsapp", "maps", "tez"]
        let found = KnownApps.installed { onPhone.contains($0) }
        #expect(found.map(\.name) == ["Maps", "WhatsApp", "Google Pay"])
        #expect(found.map(\.id) == ["com.apple.maps", "net.whatsapp.whatsapp", "com.google.paisa"])
        #expect(KnownApps.installed { _ in false }.isEmpty)
        #expect(KnownApps.installed { _ in true }.count == KnownApps.all.count)
    }

    /// iPhone answers "is this app here?" only for schemes named in Info.plist, so the two lists must match.
    @Test func infoPlistDeclaresExactlyTheseSchemes() throws {
        let plistURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // JassiCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // JassiCore
            .deletingLastPathComponent() // apps/ios
            .appendingPathComponent("Info.plist")
        let plist = try #require(try PropertyListSerialization.propertyList(from: Data(contentsOf: plistURL), format: nil) as? [String: Any])
        let declared = try #require(plist["LSApplicationQueriesSchemes"] as? [String])
        #expect(declared == KnownApps.schemes)

        // The app answers jassi:// links itself (contract §3).
        let types = try #require(plist["CFBundleURLTypes"] as? [[String: Any]])
        #expect(types.compactMap { $0["CFBundleURLSchemes"] as? [String] }.flatMap { $0 } == [DeepLink.scheme])
    }
}
