import Foundation

/// The JavaScript that puts `window.jassiNative` on the page before the page's own scripts run.
public enum BridgeScript {
    /// The page talks to the shell through `webkit.messageHandlers.<handlerName>`.
    public static let handlerName = "jassi"
    public static let contract = 1

    public static func source(origin: Origin, version: String) -> String {
        let methods = BridgeMethod.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
        return """
        (function () {
          if (window.top !== window || location.origin !== \(quoted(origin.serialized)) || window.jassiNative) return;
          var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
          function call(method, args) {
            try {
              if (!handler) return Promise.resolve({ ok: false, error: "unsupported" });
              return handler.postMessage({ method: method, args: args === undefined ? null : args })
                .catch(function (e) { return { ok: false, error: String((e && e.message) || e || "failed") }; });
            } catch (e) {
              return Promise.resolve({ ok: false, error: "bad_args" });
            }
          }
          var api = { platform: "ios", version: \(quoted(version)), contract: \(contract) };
          [\(methods)].forEach(function (name) {
            api[name] = function (args) { return call(name, args); };
          });
          Object.defineProperty(window, "jassiNative", { value: Object.freeze(api), writable: false, configurable: false });
        })();
        """
    }

    /// A JavaScript string literal.
    private static func quoted(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let json = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(json.dropFirst().dropLast())
    }
}
