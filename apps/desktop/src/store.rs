//! What the shell remembers between launches.
//! - The pairing (with its token): only in OS secure storage (Apple Keychain / Windows Credential Manager).
//! - The list of locked apps: a small file in the app's own data folder. It holds app ids, nothing secret.
//! Nothing read from the screen is ever kept.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// No `Debug` on purpose: the token must never reach a log.
#[derive(Clone, Serialize, Deserialize)]
pub struct Pairing {
    pub server: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub token: String,
}

const SERVICE: &str = "J.A.S.S.I";
const ACCOUNT: &str = "device";

fn entry() -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).ok()
}

pub fn save_pairing(p: &Pairing) -> bool {
    let Ok(secret) = serde_json::to_string(p) else { return false };
    entry().is_some_and(|e| e.set_password(&secret).is_ok())
}

pub fn load_pairing() -> Option<Pairing> {
    let secret = entry()?.get_password().ok()?;
    serde_json::from_str(&secret).ok()
}

pub fn forget_pairing() {
    if let Some(e) = entry() {
        let _ = e.delete_credential();
    }
}

#[derive(Default, Serialize, Deserialize)]
struct PolicyFile {
    #[serde(rename = "blockedApps", default)]
    blocked_apps: Vec<String>,
}

fn policy_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("policy.json"))
}

pub fn save_blocked(app: &AppHandle, ids: &[String]) -> bool {
    let Some(path) = policy_path(app) else { return false };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(text) = serde_json::to_string(&PolicyFile { blocked_apps: ids.to_vec() }) else { return false };
    std::fs::write(path, text).is_ok()
}

pub fn load_blocked(app: &AppHandle) -> Vec<String> {
    policy_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<PolicyFile>(&t).ok())
        .map(|f| f.blocked_apps)
        .unwrap_or_default()
}
