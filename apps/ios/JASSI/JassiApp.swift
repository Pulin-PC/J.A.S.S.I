import SwiftUI

@main
struct JassiApp: App {
    @StateObject private var shell = WebShell.shared

    var body: some Scene {
        WindowGroup {
            RootView(shell: shell)
        }
    }
}
