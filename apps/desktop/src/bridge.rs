//! The native half of `window.jassiNative` (docs/native-contract.md §2).
//! Every command answers with JSON and never throws: not possible here → `{ ok: false, error: "unsupported" }`.

use crate::shell::{self, Shell};
use crate::{config, policy};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State, Webview};

fn ok() -> Value {
    json!({ "ok": true })
}
fn fail(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}
fn unsupported() -> Value {
    fail("unsupported")
}

// ---------------------------------------------------------------- the two bundled screens

/// Start screen: try to reach J.A.S.S.I and go there.
#[tauri::command(async)]
pub fn shell_connect(app: AppHandle, webview: Webview) -> Value {
    if webview.label() != "main" {
        return fail("not_allowed");
    }
    json!({ "ok": shell::connect(&app) })
}

/// The Stop button on the "J.A.S.S.I is working" banner.
#[tauri::command]
pub fn banner_stop(_app: AppHandle) -> Value {
    ok()
}

// ---------------------------------------------------------------- bridge

#[derive(Deserialize)]
pub struct PageArgs {
    state: String,
}

#[tauri::command]
pub fn jn_page(app: AppHandle, webview: Webview, shell: State<Shell>, args: PageArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    shell::page_state(&app, &args.state);
    ok()
}

#[derive(Deserialize)]
pub struct DevLogArgs {
    text: String,
}

/// Dev builds only (see `shell::dev_script`). In a release build the page may not call it, and it does nothing.
#[tauri::command]
pub fn jn_dev_log(webview: Webview, shell: State<Shell>, args: DevLogArgs) -> Value {
    if !config::DEV || !shell.allows(&webview) {
        return fail("not_allowed");
    }
    println!("[dev] {}", args.text);
    ok()
}

#[derive(Deserialize)]
pub struct UrlArgs {
    url: String,
}

#[tauri::command]
pub fn jn_open_external(webview: Webview, shell: State<Shell>, args: UrlArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    if !policy::external_ok(&args.url) {
        return fail("bad_link");
    }
    match open::that_detached(&args.url) {
        Ok(_) => ok(),
        Err(_) => fail("failed"),
    }
}

// The rest arrive in the next steps. Until then they exist and answer "unsupported", as the contract asks.

#[tauri::command]
pub fn jn_list_apps() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_permissions() -> Value {
    json!({ "screen": "unsupported", "mic": "unsupported", "speech": "unsupported", "notifications": "unsupported" })
}
#[tauri::command]
pub fn jn_open_permission() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_pair() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_unpair() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_set_policy() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_biometric() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_listen_start() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_listen_stop() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_speak() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_speak_stop() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_notify() -> Value {
    unsupported()
}
#[tauri::command]
pub fn jn_stop() -> Value {
    ok()
}
