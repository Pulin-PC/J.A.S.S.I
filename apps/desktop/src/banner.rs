//! The always-on-top "J.A.S.S.I is working · Stop" banner (docs/native-contract.md §4, rule 4).
//! It never takes the keyboard away from the app J.A.S.S.I is working in.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 40.0;

static SHOWN: AtomicU64 = AtomicU64::new(0);

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let x = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64 / m.scale_factor() - WIDTH) / 2.0)
        .unwrap_or(400.0);
    WebviewWindowBuilder::new(app, "banner", WebviewUrl::App("banner.html".into()))
        .title("J.A.S.S.I is working")
        .inner_size(WIDTH, HEIGHT)
        .position(x, 44.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;
    Ok(())
}

pub fn show(app: &AppHandle) {
    SHOWN.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("banner") {
        let _ = w.show();
    }
}

pub fn hide(app: &AppHandle) {
    SHOWN.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("banner") {
        let _ = w.hide();
    }
}

/// Hide a moment after the op ends, so a run of ops shows one steady banner instead of a flicker.
pub fn hide_soon(app: &AppHandle) {
    let mark = SHOWN.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        if SHOWN.load(Ordering::SeqCst) == mark {
            if let Some(w) = app.get_webview_window("banner") {
                let _ = w.hide();
            }
        }
    });
}
