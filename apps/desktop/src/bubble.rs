//! The small floating J.A.S.S.I bubble (docs/native-contract.md, `bubble`). It floats above every app on every
//! desktop, never takes the keyboard, can be dragged anywhere, and a bin appears at the bottom of the screen while
//! it is dragged: drop it there to put it away. The web app shows it again on the next "Jassi".
//!
//! The bubble page (ui/bubble.js) owns the drag and its animation; this side only places windows and passes
//! taps and "put away" to the web app.

use crate::bridge::{fail, ok};
use crate::shell::{self, Shell};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder};

/// The bubble window: a 52 pt orb plus room for its glow.
pub const SIZE: f64 = 84.0;
/// The bin window at the bottom centre of the screen.
const BIN: f64 = 140.0;
/// The caption beside the bubble: live words, then the reply. Clicks pass through it.
const CAP_W: f64 = 300.0;
const CAP_H: f64 = 72.0;
const STATES: &[&str] = &["sleep", "listening", "thinking", "speaking"];

/// Where the bubble last rested (top-left, logical points). Kept for this run of the app.
static AT: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// How near (centre to centre) counts as "on the bin"; the bubble then snaps into it.
const MAGNET: f64 = 86.0;
const EDGE: f64 = 2.0;

// ---- the real mouse, read straight from the system (a window that never takes focus can't rely on
// the page's own drag events)
#[cfg(target_os = "macos")]
fn mouse(app: &AppHandle) -> Option<(f64, f64, bool)> {
    use objc2_app_kit::NSEvent;
    let full_h = app.primary_monitor().ok().flatten().map(|m| m.size().height as f64 / m.scale_factor())?;
    let p = NSEvent::mouseLocation(); // points, origin bottom-left of the main screen
    Some((p.x, full_h - p.y, NSEvent::pressedMouseButtons() & 1 == 1))
}
#[cfg(windows)]
fn mouse(app: &AppHandle) -> Option<(f64, f64, bool)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let s = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
    Some((p.x as f64 / s, p.y as f64 / s, down))
}
#[cfg(not(any(target_os = "macos", windows)))]
fn mouse(_app: &AppHandle) -> Option<(f64, f64, bool)> {
    None
}

/// The usable part of the screen (right edge, bottom edge) in points: above the Dock, below the menu bar.
fn screen(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            let a = m.work_area();
            ((a.position.x as f64 + a.size.width as f64) / s, (a.position.y as f64 + a.size.height as f64) / s)
        })
        .unwrap_or((1440.0, 860.0))
}
/// Gap between the bin and the bottom of the usable screen (ui/bubble.js uses the same).
const BIN_GAP: f64 = 14.0;

fn home(app: &AppHandle) -> (f64, f64) {
    let (w, h) = screen(app);
    (w - SIZE - 18.0, (h * 0.34).round())
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let (x, y) = home(handle);
    let (w, h) = screen(handle);
    for (label, page, size, pos) in [
        ("bubble", "bubble.html", SIZE, (x, y)),
        ("bin", "bin.html", BIN, ((w - BIN) / 2.0, h - BIN - BIN_GAP)),
        ("caption", "caption.html", CAP_W, (x - CAP_W, y)),
    ] {
        let tall = if label == "caption" { CAP_H } else { size };
        let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
            .title("J.A.S.S.I")
            .inner_size(size, tall)
            .position(pos.0, pos.1)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .build()?;
        if label == "caption" {
            let _ = win.set_ignore_cursor_events(true);
        }
    }
    Ok(())
}

/// The caption sits beside the bubble, on the side with more room, centred on it.
fn place_caption(app: &AppHandle, x: f64, y: f64) {
    let Some(c) = app.get_webview_window("caption") else { return };
    let (sw, _) = screen(app);
    let left = x + SIZE / 2.0 > sw / 2.0;
    let cx = if left { x - CAP_W + 10.0 } else { x + SIZE - 10.0 };
    let _ = c.set_position(LogicalPosition::new(cx, y + SIZE / 2.0 - CAP_H / 2.0));
    tell(app, "caption", format!("window.cap&&cap.side({})", if left { "'left'" } else { "'right'" }));
}

/// Runs a call on one of the two bundled pages (fixed function names, checked values only).
fn tell(app: &AppHandle, label: &str, js: String) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.eval(js);
    }
}

fn show(app: &AppHandle) {
    let Some(w) = app.get_webview_window("bubble") else { return };
    if w.is_visible().unwrap_or(false) {
        return;
    }
    let (x, y) = AT.lock().unwrap().unwrap_or_else(|| home(app));
    let (sw, sh) = screen(app);
    let _ = w.set_position(LogicalPosition::new(x, y));
    let _ = w.show();
    tell(app, "bubble", format!("window.jb&&jb.shown({x},{y},{sw},{sh})"));
}

fn hide(app: &AppHandle) {
    for label in ["bubble", "bin", "caption"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
}

#[derive(Deserialize)]
pub struct BubbleArgs {
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    state: Option<String>,
    /// Words for the caption: what the user is saying (`who: "you"`) or the reply (`"jassi"`).
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    who: Option<String>,
}

/// `bubble({ visible?, state? })` from the web app.
#[tauri::command]
pub fn jn_bubble(app: AppHandle, webview: Webview, shell: State<Shell>, args: BubbleArgs) -> Value {
    if !shell.allows(&webview) {
        return fail("not_allowed");
    }
    if let Some(s) = args.state.as_deref() {
        if !STATES.contains(&s) {
            return fail("bad_args");
        }
        tell(&app, "bubble", format!("window.jb&&jb.state({})", json!(s)));
    }
    match args.visible {
        Some(true) => show(&app),
        Some(false) => hide(&app),
        None => {}
    }
    if let Some(text) = args.text.as_deref() {
        let bubble_up = app.get_webview_window("bubble").and_then(|w| w.is_visible().ok()).unwrap_or(false);
        if bubble_up {
            let who = if args.who.as_deref() == Some("jassi") { "jassi" } else { "you" };
            let text: String = text.chars().take(400).collect();
            let (x, y) = AT.lock().unwrap().unwrap_or_else(|| home(&app));
            place_caption(&app, x, y);
            if let Some(c) = app.get_webview_window("caption") {
                let _ = c.show();
            }
            tell(&app, "caption", format!("window.cap&&cap.say({},{})", json!(text), json!(who)));
        }
    }
    ok()
}

fn from_bubble(webview: &Webview) -> bool {
    webview.label() == "bubble"
}

/// A tap on the bubble: talk now, or stop.
#[tauri::command]
pub fn bubble_tap(app: AppHandle, webview: Webview) -> Value {
    if !from_bubble(&webview) {
        return fail("not_allowed");
    }
    shell::emit(&app, json!({ "type": "bubble", "action": "tap" }));
    ok()
}

#[derive(Deserialize)]
pub struct MoveArgs {
    x: f64,
    y: f64,
    /// The bin: "show", "hot" (the bubble is over it), "cold", or "hide".
    #[serde(default)]
    bin: Option<String>,
}

/// The mouse went down on the bubble. Follow the real mouse until it is let go: a tap if it barely moved,
/// otherwise a drag (bin at the bottom; drop on it to put the bubble away, anywhere else it settles on a side).
#[tauri::command]
pub fn bubble_grab(app: AppHandle, webview: Webview) -> Value {
    if !from_bubble(&webview) {
        return fail("not_allowed");
    }
    let Some(start) = mouse(&app) else { return fail("unsupported") };
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return ok();
    }
    std::thread::spawn(move || {
        let (sw, sh) = screen(&app);
        let (x0, y0) = AT.lock().unwrap().unwrap_or_else(|| home(&app));
        let bin = (sw / 2.0, sh - BIN_GAP - BIN / 2.0);
        let (mut moved, mut hot, mut last) = (false, false, (x0, y0));
        let mut trail: Vec<(Instant, f64, f64)> = Vec::new();
        let began = Instant::now();
        while let Some((mx, my, down)) = mouse(&app) {
            if !down || began.elapsed() > Duration::from_secs(60) {
                break;
            }
            let (dx, dy) = (mx - start.0, my - start.1);
            if !moved && dx.hypot(dy) >= 4.0 {
                moved = true;
                tell(&app, "bubble", "window.jb&&jb.drag(true)".into());
                tell(&app, "caption", "window.cap&&cap.clear()".into());
                if let Some(b) = app.get_webview_window("bin") {
                    let _ = b.set_position(LogicalPosition::new((sw - BIN) / 2.0, sh - BIN - BIN_GAP));
                    let _ = b.show();
                }
                tell(&app, "bin", "window.bin&&bin.show()".into());
            }
            if moved {
                let (mut nx, mut ny) = (x0 + dx, y0 + dy);
                let over = (nx + SIZE / 2.0 - bin.0).hypot(ny + SIZE / 2.0 - bin.1) < MAGNET;
                if over != hot {
                    hot = over;
                    tell(&app, "bin", format!("window.bin&&bin.hot({hot})"));
                    tell(&app, "bubble", format!("window.jb&&jb.hot({hot})"));
                }
                if hot {
                    nx = bin.0 - SIZE / 2.0;
                    ny = bin.1 - SIZE / 2.0;
                }
                ny = ny.clamp(0.0, sh - SIZE / 2.0);
                if (nx - last.0).abs() + (ny - last.1).abs() > 0.4 {
                    if let Some(w) = app.get_webview_window("bubble") {
                        let _ = w.set_position(LogicalPosition::new(nx, ny));
                    }
                    last = (nx, ny);
                }
                trail.push((Instant::now(), nx, ny));
                trail.retain(|t| t.0.elapsed() < Duration::from_millis(90));
            }
            std::thread::sleep(Duration::from_millis(7));
        }
        DRAGGING.store(false, Ordering::SeqCst);
        if !moved {
            shell::emit(&app, json!({ "type": "bubble", "action": "tap" }));
            return;
        }
        tell(&app, "bubble", "window.jb&&jb.drag(false)".into());
        tell(&app, "bin", "window.bin&&bin.hide()".into());
        if hot {
            tell(&app, "bubble", "window.jb&&jb.bye()".into());
            std::thread::sleep(Duration::from_millis(250));
            hide(&app);
            *AT.lock().unwrap() = None; // comes back at its usual place, not on top of the bin
            shell::emit(&app, json!({ "type": "bubble", "action": "dismissed" }));
            return;
        }
        let later = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(220));
            if let Some(b) = later.get_webview_window("bin") {
                let _ = b.hide();
            }
        });
        // A fling carries it on; it comes to rest against the nearer side.
        let (vx, vy) = match (trail.first(), trail.last()) {
            (Some(a), Some(b)) if b.0 > a.0 => {
                let dt = (b.0 - a.0).as_secs_f64().max(0.016);
                ((b.1 - a.1) / dt, (b.2 - a.2) / dt)
            }
            _ => (0.0, 0.0),
        };
        let (px, py) = (last.0 + vx * 0.12, last.1 + vy * 0.12);
        let tx = if px + SIZE / 2.0 < sw / 2.0 { EDGE } else { sw - SIZE - EDGE };
        let ty = py.clamp(30.0, sh - SIZE - 30.0);
        // Spring-like glide there (ease-out-back), about 60 moves a second.
        let ease = |t: f64| {
            let c = 1.3;
            1.0 + (c + 1.0) * (t - 1.0).powi(3) + c * (t - 1.0).powi(2)
        };
        let (t0, dur) = (Instant::now(), 0.42);
        loop {
            let t = (t0.elapsed().as_secs_f64() / dur).min(1.0);
            let k = ease(t);
            let (nx, ny) = (last.0 + (tx - last.0) * k, last.1 + (ty - last.1) * k);
            if let Some(w) = app.get_webview_window("bubble") {
                let _ = w.set_position(LogicalPosition::new(nx, ny));
            }
            if t >= 1.0 || DRAGGING.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        *AT.lock().unwrap() = Some((tx, ty));
    });
    ok()
}

/// Moves the bubble while it settles (the page animates it), and drives the bin.
#[tauri::command]
pub fn bubble_move(app: AppHandle, webview: Webview, args: MoveArgs) -> Value {
    if !from_bubble(&webview) || !args.x.is_finite() || !args.y.is_finite() {
        return fail("bad_args");
    }
    let (sw, sh) = screen(&app);
    let x = args.x.clamp(-SIZE / 2.0, sw - SIZE / 2.0);
    let y = args.y.clamp(0.0, sh - SIZE / 2.0);
    if let Some(w) = app.get_webview_window("bubble") {
        let _ = w.set_position(LogicalPosition::new(x, y));
    }
    *AT.lock().unwrap() = Some((x, y));
    match args.bin.as_deref() {
        Some("show") => {
            tell(&app, "caption", "window.cap&&cap.clear()".into());
            if let Some(b) = app.get_webview_window("bin") {
                let _ = b.set_position(LogicalPosition::new((sw - BIN) / 2.0, sh - BIN - BIN_GAP));
                let _ = b.show();
            }
            tell(&app, "bin", "window.bin&&bin.show()".into());
        }
        Some("hot") => tell(&app, "bin", "window.bin&&bin.hot(true)".into()),
        Some("cold") => tell(&app, "bin", "window.bin&&bin.hot(false)".into()),
        Some("hide") => {
            tell(&app, "bin", "window.bin&&bin.hide()".into());
            let later = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(220));
                if let Some(b) = later.get_webview_window("bin") {
                    let _ = b.hide();
                }
            });
        }
        _ => {}
    }
    ok()
}

/// Dropped on the bin: put away until the web app shows it again (the next "Jassi").
#[tauri::command]
pub fn bubble_dismiss(app: AppHandle, webview: Webview) -> Value {
    if !from_bubble(&webview) {
        return fail("not_allowed");
    }
    hide(&app);
    *AT.lock().unwrap() = None; // comes back at its usual place, not on top of the bin
    shell::emit(&app, json!({ "type": "bubble", "action": "dismissed" }));
    ok()
}
