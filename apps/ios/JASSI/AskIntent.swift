import AppIntents

/// "Ask J.A.S.S.I" for Siri and the Shortcuts app: takes the words, opens the app,
/// and hands them to the page as the `ask` event (contract §2).
struct AskJassiIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask J.A.S.S.I"
    static let description = IntentDescription("Say or type what you want. J.A.S.S.I opens and gets to work.")
    static let openAppWhenRun = true

    @Parameter(title: "What you want", requestValueDialog: "What should J.A.S.S.I do?")
    var text: String

    @MainActor
    func perform() async throws -> some IntentResult {
        WebShell.shared.deliverAsk(text)
        return .result()
    }
}

struct JassiShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskJassiIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) something",
                "Tell \(.applicationName) to do something",
            ],
            shortTitle: "Ask J.A.S.S.I",
            systemImageName: "mic.fill")
    }
}
