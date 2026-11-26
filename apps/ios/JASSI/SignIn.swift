import AuthenticationServices
import UIKit
import JassiCore

/// Sign-in runs in the system sign-in sheet, because Google refuses to sign in inside a WebView (contract §3).
@MainActor
final class SignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// Opens the sheet. `onReturn` gets the `jassi://auth…` link the server sends the browser back to.
    func start(url: URL, onReturn: @escaping (URL) -> Void) -> Bool {
        session?.cancel()
        let finished: (URL?, Error?) -> Void = { [weak self] link, _ in
            Task { @MainActor in
                self?.session = nil
                if let link { onReturn(link) }
            }
        }
        let session: ASWebAuthenticationSession
        if #available(iOS 17.4, *) {
            session = ASWebAuthenticationSession(url: url, callback: .customScheme(DeepLink.scheme), completionHandler: finished)
        } else {
            session = ASWebAuthenticationSession(url: url, callbackURLScheme: DeepLink.scheme, completionHandler: finished)
        }
        session.presentationContextProvider = self
        // Share Safari's cookies, so someone already signed in to Google is not asked again.
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        return session.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}
