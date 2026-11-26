//! J.A.S.S.I for macOS and Windows: a thin shell around the web app. See docs/native-contract.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod banner;
mod bridge;
mod channel;
mod config;
mod http;
mod ops;
mod platform;
mod policy;
mod shell;
mod store;

use tauri::{Manager, WindowEvent};

fn main() {
    let app = tauri::Builder::default()
        // A second launch (for example Windows opening a jassi:// link) hands over to the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| shell::bring_to_front(app)))
        .plugin(tauri_plugin_deep_link::init())
        .manage(shell::Shell::new(config::jassi_url()))
        .invoke_handler(tauri::generate_handler![
            bridge::shell_connect,
            bridge::banner_stop,
            bridge::jn_page,
            bridge::jn_dev_log,
            bridge::jn_list_apps,
            bridge::jn_permissions,
            bridge::jn_open_permission,
            bridge::jn_pair,
            bridge::jn_unpair,
            bridge::jn_set_policy,
            bridge::jn_open_external,
            bridge::jn_biometric,
            bridge::jn_listen_start,
            bridge::jn_listen_stop,
            bridge::jn_speak,
            bridge::jn_speak_stop,
            bridge::jn_notify,
            bridge::jn_stop,
        ])
        .setup(|app| shell::setup(app))
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // macOS: closing the window keeps the app (and screen control) running; the Dock icon brings it back.
                // Windows: closing the window quits.
                if cfg!(target_os = "macos") {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("J.A.S.S.I could not start");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            shell::bring_to_front(_app);
        }
    });
}
