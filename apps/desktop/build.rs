// Every command the two kinds of page may call. Listing them here puts them behind Tauri's
// access rules, so a page gets nothing unless a capability names it:
//   capabilities/shell.json    → the two bundled screens (start / can't reach, working banner)
//   src/shell.rs (at start-up)  → the bridge, for the JASSI_URL origin only
const COMMANDS: &[&str] = &[
    "shell_connect",
    "banner_stop",
    "jn_page",
    "jn_dev_log",
    "jn_list_apps",
    "jn_permissions",
    "jn_open_permission",
    "jn_pair",
    "jn_unpair",
    "jn_set_policy",
    "jn_open_external",
    "jn_biometric",
    "jn_listen_start",
    "jn_listen_stop",
    "jn_speak",
    "jn_speak_stop",
    "jn_notify",
    "jn_stop",
    "jn_bubble",
    "bubble_tap",
    "bubble_grab",
    "bubble_move",
    "bubble_dismiss",
];

fn main() {
    // JASSI_URL is a build setting. HTTPS only; plain HTTP only for localhost in dev builds.
    println!("cargo:rerun-if-env-changed=JASSI_URL");
    if let Ok(raw) = std::env::var("JASSI_URL") {
        if !raw.trim().is_empty() {
            let u = url::Url::parse(raw.trim()).expect("JASSI_URL must be a full address, for example https://example.com");
            let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
            let dev = std::env::var("PROFILE").map(|p| p == "debug").unwrap_or(false);
            let ok = u.scheme() == "https" || (u.scheme() == "http" && local && dev);
            assert!(ok, "JASSI_URL must be https (http is allowed only for localhost in dev builds)");
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build failed");
}
