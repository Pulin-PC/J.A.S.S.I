//! Windows: the list of apps (Start menu), permissions and alerts.
//! NOT run on a real PC yet: it compiles against the Windows API, nothing more. See the README.

use super::Permissions;
use crate::policy::AppInfo;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use windows::core::{w, PWSTR};
use windows::Devices::Enumeration::{DeviceAccessInformation, DeviceAccessStatus, DeviceClass};
use windows::Win32::Storage::EnhancedStorage::PKEY_Link_TargetParsingPath;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
use windows::Win32::UI::Shell::{BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, SHCreateItemFromParsingName, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING};

/// Every thread that talks to Windows components needs this once. Calling it again is harmless.
pub(super) fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn take(text: windows::core::Result<PWSTR>) -> Option<String> {
    let p = text.ok()?;
    if p.is_null() {
        return None;
    }
    let s = unsafe { p.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(p.as_ptr() as _)) };
    s
}

// ---------------------------------------------------------------- apps

/// One Start menu entry. `aumid` keeps its original spelling for opening; ids sent out are lower case.
#[derive(Clone)]
pub(super) struct StartApp {
    pub aumid: String,
    pub name: String,
    /// The program behind it (lower case), when it is an ordinary desktop program.
    pub exe: String,
}

static START_APPS: Mutex<Vec<StartApp>> = Mutex::new(Vec::new());

fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    take(unsafe { item.GetDisplayName(kind) })
}

/// Everything in the Start menu's "All apps" (the shell's AppsFolder), with its AppUserModelID.
fn scan_start_menu() -> Vec<StartApp> {
    com();
    let mut apps = Vec::new();
    unsafe {
        let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(w!("shell:AppsFolder"), None) else { return apps };
        let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return apps };
        loop {
            let mut one: [Option<IShellItem>; 1] = [None];
            let mut got = 0u32;
            if items.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                break;
            }
            let Some(item) = one[0].take() else { break };
            let (Some(aumid), Some(name)) = (display_name(&item, SIGDN_PARENTRELATIVEPARSING), display_name(&item, SIGDN_NORMALDISPLAY)) else { continue };
            let exe = windows::core::Interface::cast::<IShellItem2>(&item)
                .ok()
                .and_then(|i| take(i.GetString(&PKEY_Link_TargetParsingPath)))
                .unwrap_or_default()
                .to_lowercase();
            apps.push(StartApp { aumid, name, exe });
        }
    }
    apps
}

pub(super) fn start_apps() -> Vec<StartApp> {
    let mut cached = START_APPS.lock().unwrap();
    if cached.is_empty() {
        *cached = scan_start_menu();
    }
    cached.clone()
}

pub fn list_apps() -> Vec<AppInfo> {
    let fresh = scan_start_menu();
    let mut apps: Vec<AppInfo> = Vec::new();
    for a in &fresh {
        let id = a.aumid.to_lowercase();
        if !apps.iter().any(|x| x.id == id) {
            apps.push(AppInfo { id, name: a.name.clone() });
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    *START_APPS.lock().unwrap() = fresh;
    apps
}

// ---------------------------------------------------------------- permissions

/// Windows lets any desktop program use UI Automation: there is nothing to ask for.
pub fn screen_state() -> &'static str {
    "granted"
}

pub(super) fn mic_state() -> &'static str {
    match DeviceAccessInformation::CreateFromDeviceClass(DeviceClass::AudioCapture).and_then(|i| i.CurrentStatus()) {
        Ok(DeviceAccessStatus::Allowed) => "granted",
        Ok(DeviceAccessStatus::DeniedByUser) | Ok(DeviceAccessStatus::DeniedBySystem) => "denied",
        Ok(_) => "ask",
        Err(_) => "unsupported",
    }
}

pub fn permissions() -> Permissions {
    // Speech recognition on Windows has no switch of its own that a program can read: it follows the microphone.
    let mic = mic_state();
    Permissions { screen: "granted", mic, speech: mic, notifications: "granted" }
}

fn settings(page: &str) -> bool {
    open::that_detached(page).is_ok()
}

/// Opens the exact Settings page. `false` = no such permission here.
pub fn open_permission(kind: &str) -> bool {
    match kind {
        "screen" => true,
        "mic" => settings("ms-settings:privacy-microphone"),
        "speech" => settings("ms-settings:privacy-speech"),
        "notifications" => settings("ms-settings:notifications"),
        _ => false,
    }
}

// ---------------------------------------------------------------- alerts

pub fn notify(app: &AppHandle, title: &str, body: &str) -> Result<(), &'static str> {
    app.notification().builder().title(title).body(body).show().map_err(|_| "failed")
}
