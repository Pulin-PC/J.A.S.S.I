//! The native half of `window.jassiNative` (docs/native-contract.md §2).
//! Every command answers with JSON and never throws: not possible here → `{ ok: false, error: "unsupported" }`.

use crate::policy::Policy;
use crate::shell::{self, Shell};
use crate::store::{self, Pairing};
use crate::{config, ops, platform, policy};
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
fn result(r: Result<(), &'static str>) -> Value {
    match r {
        Ok(()) => ok(),
        Err(why) => fail(why),
    }
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
pub fn banner_stop(app: AppHandle, webview: Webview) -> Value {
    if webview.label() != "banner" {
        return fail("not_allowed");
    }
    ops::user_stop(&app, true);
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

#[tauri::command(async)]
pub fn jn_list_apps(webview: Webview, shell: State<Shell>) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    json!({ "ok": true, "apps": platform::list_apps(), "partial": false })
}

#[tauri::command(async)]
pub fn jn_permissions(webview: Webview, shell: State<Shell>) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    json!(platform::permissions())
}

#[derive(Deserialize)]
pub struct KindArgs {
    kind: String,
}

#[tauri::command(async)]
pub fn jn_open_permission(webview: Webview, shell: State<Shell>, args: KindArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    if platform::open_permission(&args.kind) {
        ok()
    } else {
        unsupported()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairArgs {
    server: String,
    device_id: String,
    token: String,
}

/// Saves the token in OS secure storage and starts the device channel.
#[tauri::command(async)]
pub fn jn_pair(app: AppHandle, webview: Webview, shell: State<Shell>, args: PairArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    let server = match policy::check_server(&args.server, config::DEV) {
        Ok(server) => server,
        Err(why) => return fail(why),
    };
    if !policy::token_ok(&args.device_id) || !policy::token_ok(&args.token) {
        return fail("bad_args");
    }
    let pairing = Pairing { server, device_id: args.device_id, token: args.token };
    if !store::save_pairing(&pairing) {
        return fail("storage");
    }
    shell::resume(&app, pairing);
    ok()
}

/// Forgets the token and stops the channel.
#[tauri::command(async)]
pub fn jn_unpair(app: AppHandle, webview: Webview, shell: State<Shell>) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    shell::forget(&app);
    ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyArgs {
    blocked_apps: Vec<String>,
}

#[tauri::command(async)]
pub fn jn_set_policy(app: AppHandle, webview: Webview, shell: State<Shell>, args: PolicyArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    if args.blocked_apps.len() > 5000 || args.blocked_apps.iter().any(|id| id.len() > 300) {
        return fail("bad_args");
    }
    let policy = Policy::new(args.blocked_apps);
    let saved = store::save_blocked(&app, &policy.ids());
    *shell.policy.write().unwrap() = policy; // in force at once, even if the file could not be written
    if saved {
        ok()
    } else {
        fail("storage")
    }
}

#[derive(Deserialize)]
pub struct NotifyArgs {
    title: String,
    body: String,
}

#[tauri::command(async)]
pub fn jn_notify(app: AppHandle, webview: Webview, shell: State<Shell>, args: NotifyArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    result(platform::notify(&app, &policy::cut(&args.title, 120), &policy::cut(&args.body, 500)))
}

/// Abort any running screen action now.
#[tauri::command]
pub fn jn_stop(app: AppHandle, webview: Webview, shell: State<Shell>) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    ops::user_stop(&app, false); // the web app asked, so it needs no `stopped` event back
    ok()
}

#[derive(Deserialize)]
pub struct ReasonArgs {
    reason: String,
}

/// Real fingerprint (Touch ID) or Windows Hello. Answers only after the person has used it or given up.
#[tauri::command(async)]
pub fn jn_biometric(app: AppHandle, webview: Webview, shell: State<Shell>, args: ReasonArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    result(platform::biometric(&app, &policy::cut(&args.reason, 200)))
}

#[derive(Deserialize)]
pub struct LangArgs {
    lang: String,
}

#[tauri::command(async)]
pub fn jn_listen_start(app: AppHandle, webview: Webview, shell: State<Shell>, args: LangArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    result(platform::listen_start(&app, policy::cut(&args.lang, 20)))
}

#[tauri::command(async)]
pub fn jn_listen_stop(app: AppHandle, webview: Webview, shell: State<Shell>) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    result(platform::listen_stop(&app))
}

#[derive(Deserialize)]
pub struct SpeakArgs {
    text: String,
    lang: String,
}

#[tauri::command(async)]
pub fn jn_speak(app: AppHandle, webview: Webview, shell: State<Shell>, args: SpeakArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    if args.text.trim().is_empty() {
        return fail("bad_args");
    }
    result(platform::speak(&app, policy::cut(&args.text, 4000), policy::cut(&args.lang, 20)))
}

#[tauri::command(async)]
pub fn jn_speak_stop(app: AppHandle, webview: Webview, shell: State<Shell>) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    result(platform::speak_stop(&app))
}
