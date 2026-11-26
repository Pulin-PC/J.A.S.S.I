import SwiftUI
import WebKit

/// The whole app: one WebView. The only native screen is the "can't reach" one (contract §1.2).
struct RootView: View {
    @ObservedObject var shell: WebShell

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            WebViewHost(webView: shell.webView)
            if shell.offline {
                OfflineView(retry: shell.retry)
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

struct OfflineView: View {
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 44))
                .foregroundStyle(Theme.accent)
            Text("Can't reach J.A.S.S.I. Check your internet.")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .foregroundStyle(.black)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
    }
}
