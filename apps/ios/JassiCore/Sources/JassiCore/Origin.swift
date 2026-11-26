import Foundation

/// A web origin: scheme + host + port. Two pages share an origin only when all three match.
public struct Origin: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    /// `port` nil or 0 means "the usual port for this scheme" (that is how WebKit reports it).
    public init?(scheme: String?, host: String?, port: Int?) {
        guard let scheme = scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = host?.lowercased(), !host.isEmpty else { return nil }
        self.scheme = scheme
        self.host = host
        let given = port ?? 0
        self.port = given > 0 ? given : (scheme == "https" ? 443 : 80)
    }

    public init?(url: URL) {
        self.init(scheme: url.scheme, host: url.host, port: url.port)
    }

    /// The same text a page sees in `location.origin`.
    public var serialized: String {
        let usual = scheme == "https" ? 443 : 80
        return port == usual ? "\(scheme)://\(host)" : "\(scheme)://\(host):\(port)"
    }
}

public enum OriginCheck {
    /// Contract §1.3: the bridge answers only the main frame of a page on the J.A.S.S.I origin.
    public static func bridgeAllowed(isMainFrame: Bool, scheme: String?, host: String?, port: Int?, base: Origin) -> Bool {
        guard isMainFrame, let origin = Origin(scheme: scheme, host: host, port: port) else { return false }
        return origin == base
    }
}
