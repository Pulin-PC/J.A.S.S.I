//! macOS: the list of apps, permissions and alerts.

use super::Permissions;
use crate::policy::AppInfo;
use accessibility_sys::{kAXTrustedCheckOptionPrompt, AXIsProcessTrusted, AXIsProcessTrustedWithOptions};
use block2::RcBlock;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::rc::autoreleasepool;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSettings,
    UNUserNotificationCenter,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------- apps

fn scan(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "app") {
            out.push(path);
        } else if depth > 0 && path.is_dir() {
            scan(&path, depth - 1, out);
        }
    }
}

/// Apps in /Applications and ~/Applications (and one folder down, for example Utilities).
pub fn list_apps() -> Vec<AppInfo> {
    let mut bundles = Vec::new();
    scan(Path::new("/Applications"), 1, &mut bundles);
    if let Some(home) = std::env::var_os("HOME") {
        scan(&Path::new(&home).join("Applications"), 1, &mut bundles);
    }
    let mut apps: Vec<AppInfo> = Vec::new();
    for bundle in bundles {
        let Ok(info) = plist::Value::from_file(bundle.join("Contents/Info.plist")) else { continue };
        let Some(id) = info.as_dictionary().and_then(|d| d.get("CFBundleIdentifier")).and_then(|v| v.as_string()) else { continue };
        let id = id.to_lowercase();
        let Some(name) = bundle.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        if !apps.iter().any(|a| a.id == id) {
            apps.push(AppInfo { id, name });
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}

// ---------------------------------------------------------------- permissions

fn open_settings(pane: &str) {
    let _ = Command::new("/usr/bin/open").arg(pane).status();
}

/// "Let J.A.S.S.I see and tap your screen" = the Accessibility permission.
/// macOS does not say whether the user refused or was never asked, so anything but granted is "ask".
pub fn screen_state() -> &'static str {
    if unsafe { AXIsProcessTrusted() } {
        "granted"
    } else {
        "ask"
    }
}

/// The system's own prompt (first time only), plus Privacy & Security → Accessibility on the right page.
fn open_screen_permission() {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
    open_settings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
}

/// Alerts need a real app bundle: macOS has no alert settings for a bare dev binary.
fn bundled() -> bool {
    std::env::current_exe().map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/")).unwrap_or(false)
}

fn notifications_state() -> &'static str {
    if !bundled() {
        return "unsupported";
    }
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
    });
    UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(s) if s == UNAuthorizationStatus::Authorized || s == UNAuthorizationStatus::Provisional => "granted",
        Ok(s) if s == UNAuthorizationStatus::Denied => "denied",
        Ok(s) if s == UNAuthorizationStatus::NotDetermined => "ask",
        _ => "unsupported",
    }
}

fn open_notifications_permission() {
    match notifications_state() {
        "ask" => {
            let block = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        }
        "denied" => open_settings("x-apple.systempreferences:com.apple.Notifications-Settings.extension"),
        _ => {}
    }
}

pub fn permissions() -> Permissions {
    Permissions { screen: screen_state(), mic: "unsupported", speech: "unsupported", notifications: notifications_state() }
}

/// Shows the system prompt, or opens the exact settings page. `false` = this device has no such permission.
pub fn open_permission(kind: &str) -> bool {
    match kind {
        "screen" => open_screen_permission(),
        "notifications" if bundled() => open_notifications_permission(),
        _ => return false,
    }
    true
}

// ---------------------------------------------------------------- alerts

pub fn notify(title: &str, body: &str) -> Result<(), &'static str> {
    match notifications_state() {
        "granted" => {}
        "unsupported" => return Err("unsupported"),
        _ => return Err("no_permission"),
    }
    autoreleasepool(|_| {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let id = NSString::from_str(&format!("jassi-{stamp}"));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
    });
    Ok(())
}
