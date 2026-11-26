// swift-tools-version: 5.9
import PackageDescription

// The rules of the shell that need no iPhone to run: who may use the bridge,
// where a link opens, how a bridge call is read, which apps we look for.
// Kept apart from the app so the tests run on a Mac in seconds (`swift test`).
let package = Package(
    name: "JassiCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "JassiCore", targets: ["JassiCore"]),
    ],
    targets: [
        .target(name: "JassiCore"),
        .testTarget(name: "JassiCoreTests", dependencies: ["JassiCore"]),
    ]
)
