//! The shell itself: one window that shows the web app, the rule for which links stay inside,
//! events to the web app, and `jassi://` links (docs/native-contract.md §1-§3).

use crate::policy::Policy;
use crate::{banner, channel, config, ops, platform, policy, store};
use serde_json::{json, Value};
use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// What the bridge may call. Granted to the JASSI_URL origin only.
const BRIDGE_COMMANDS: &[&str] = &[
    "allow-jn-page",
    "allow-jn-list-apps",
    "allow-jn-permissions",
    "allow-jn-open-permission",
    "allow-jn-pair",
    "allow-jn-unpair",
    "allow-jn-set-policy",
    "allow-jn-open-external",
    "allow-jn-biometric",
    "allow-jn-listen-start",
    "allow-jn-listen-stop",
    "allow-jn-speak",
    "allow-jn-speak-stop",
    "allow-jn-notify",
    "allow-jn-stop",
    "allow-jn-bubble",
];

#[derive(Default)]
struct Page {
    /// Counts our own "go to J.A.S.S.I" attempts; `alive` catches up when the page says hello.
    nav: u64,
    alive: u64,
    /// The web app has finished loading, so it is listening for events.
    loaded: bool,
    /// `auth` and `ask` events wait here until then.
    queued: Vec<Value>,
}

pub struct Shell {
    pub jassi: Url,
    start_url: Mutex<Option<Url>>,
    page: Mutex<Page>,
    last_link: Mutex<Option<(String, Instant)>>,
    /// Apps that are never read or acted in (`setPolicy`). Also saved in the app's data folder.
    pub policy: RwLock<Policy>,
    /// Paired with a server (the token itself stays in the Keychain / Credential Manager).
    pub paired: Mutex<bool>,
    /// Bumped to stop the running device-channel loop.
    pub channel: AtomicU64,
    /// Stop / cancel state of the screen action that is running.
    pub control: ops::Control,
}

impl Shell {
    pub fn new(jassi: Url) -> Self {
        Shell {
            jassi,
            start_url: Mutex::new(None),
            page: Mutex::new(Page::default()),
            last_link: Mutex::new(None),
            policy: RwLock::new(Policy::default()),
            paired: Mutex::new(false),
            channel: AtomicU64::new(0),
            control: ops::Control::default(),
        }
    }

    /// Contract §1.3: the bridge answers only the main window while it shows a J.A.S.S.I page.
    /// (Tauri's access rules already enforce this; this is the second lock on the same door.)
    pub fn allows(&self, webview: &tauri::Webview) -> bool {
        webview.label() == "main" && webview.url().map(|u| policy::same_origin(&u, &self.jassi)).unwrap_or(false)
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let jassi = app.state::<Shell>().jassi.clone();
    let origin = jassi.origin().ascii_serialization();

    let mut bridge = CapabilityBuilder::new("bridge").local(false).remote(format!("{origin}/*")).window("main");
    for p in BRIDGE_COMMANDS {
        bridge = bridge.permission(*p);
    }
    if config::DEV {
        bridge = bridge.permission("allow-jn-dev-log");
    }
    app.add_capability(bridge)?;

    let script = include_str!("bridge.js")
        .replace("__JASSI_ORIGIN__", &origin)
        .replace("__PLATFORM__", config::PLATFORM)
        .replace("__VERSION__", config::VERSION);
    let nav = handle.clone();
    let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("J.A.S.S.I")
        .inner_size(1180.0, 800.0)
        .min_inner_size(380.0, 560.0)
        .initialization_script(&script)
        .on_navigation(move |url| stays_inside(&nav, url))
        .build()?;
    *app.state::<Shell>().start_url.lock().unwrap() = main.url().ok();
    banner::create(app)?;
    crate::bubble::create(app)?;

    // The stop shortcut works from any app: Control + Option + Esc (Ctrl + Alt + Esc on Windows).
    let stop = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Escape);
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &stop && event.state() == ShortcutState::Pressed {
                    ops::user_stop(app, true);
                }
            })
            .build(),
    )?;
    let _ = app.global_shortcut().register(stop); // if another app owns the shortcut, the banner's Stop still works

    // jassi:// links (contract §3). On Windows a link that starts the app arrives as `get_current`.
    let links = handle.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            on_link(&links, url.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            on_link(&handle, url.as_str());
        }
    }
    #[cfg(all(windows, debug_assertions))]
    let _ = app.deep_link().register_all(); // dev builds have no installer to register jassi://

    *app.state::<Shell>().policy.write().unwrap() = Policy::new(store::load_blocked(&handle));
    // The Keychain may ask the user before it hands the token over, so never wait for it on the main thread.
    let restore = handle.clone();
    std::thread::spawn(move || {
        if let Some(pairing) = store::load_pairing() {
            resume(&restore, pairing);
        }
    });
    watch_permissions(handle);

    Ok(())
}

/// Paired (now, or at an earlier launch): start the device channel.
pub fn resume(app: &AppHandle, pairing: store::Pairing) {
    *app.state::<Shell>().paired.lock().unwrap() = true;
    channel::start(app, pairing);
}

/// Unpair: stop the channel and forget the token.
pub fn forget(app: &AppHandle) {
    channel::stop(app);
    store::forget_pairing();
    *app.state::<Shell>().paired.lock().unwrap() = false;
}

/// Contract §2: tell the web app when a permission changes, so setup moves on by itself.
/// Checked once a second while a J.A.S.S.I page is listening.
fn watch_permissions(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if !app.state::<Shell>().page.lock().unwrap().loaded {
                continue;
            }
            let now = platform::permissions();
            if last.as_ref() != Some(&now) {
                if last.is_some() {
                    emit(&app, json!({ "type": "permission", "permissions": now }));
                }
                last = Some(now);
            }
        }
    });
}

fn is_start_page(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

/// Contract §1.3: only J.A.S.S.I pages load in the window. Every other link goes to the default browser.
fn stays_inside(app: &AppHandle, url: &Url) -> bool {
    let shell = app.state::<Shell>();
    if policy::same_origin(url, &shell.jassi) || is_start_page(url) || url.scheme() == "about" {
        return true;
    }
    if policy::external_ok(url.as_str()) {
        let _ = open::that_detached(url.as_str());
    }
    false
}

pub fn bring_to_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn reachable(url: &Url) -> bool {
    match crate::http::agent(8).get(url.as_str()).call() {
        Ok(_) | Err(ureq::Error::Status(..)) => true,
        Err(_) => false,
    }
}

/// The start screen asks for this. `false` → it shows "Can't reach J.A.S.S.I. Check your internet."
pub fn connect(app: &AppHandle) -> bool {
    let shell = app.state::<Shell>();
    let Some(main) = app.get_webview_window("main") else { return false };
    if !reachable(&shell.jassi) {
        return false;
    }
    let attempt = {
        let mut p = shell.page.lock().unwrap();
        p.nav += 1;
        p.nav
    };
    if main.navigate(shell.jassi.clone()).is_err() {
        return false;
    }
    // If the page never says hello, go back to the "Can't reach" screen.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        let shell = app.state::<Shell>();
        let stuck = {
            let p = shell.page.lock().unwrap();
            p.nav == attempt && p.alive < attempt
        };
        let start = shell.start_url.lock().unwrap().clone();
        if let (true, Some(mut start), Some(main)) = (stuck, start, app.get_webview_window("main")) {
            start.set_fragment(Some("offline"));
            let _ = main.navigate(start);
        }
    });
    true
}

/// The bridge script reports "start" as soon as a J.A.S.S.I page begins and "loaded" when it is ready.
pub fn page_state(app: &AppHandle, state: &str) {
    let shell = app.state::<Shell>();
    let ready: Vec<Value> = {
        let mut p = shell.page.lock().unwrap();
        match state {
            "start" => {
                p.alive = p.nav;
                p.loaded = false;
                Vec::new()
            }
            "loaded" => {
                p.loaded = true;
                std::mem::take(&mut p.queued)
            }
            _ => Vec::new(),
        }
    };
    if state == "loaded" {
        dev_script(app);
    }
    for detail in ready {
        emit(app, detail);
    }
}

/// Shell → web: `window.dispatchEvent(new CustomEvent("jassi-native", { detail }))`.
/// Dropped unless the window is showing a J.A.S.S.I page.
pub fn emit(app: &AppHandle, detail: Value) {
    let shell = app.state::<Shell>();
    let Some(main) = app.get_webview_window("main") else { return };
    if !main.url().map(|u| policy::same_origin(&u, &shell.jassi)).unwrap_or(false) {
        return;
    }
    let _ = main.eval(format!("window.dispatchEvent(new CustomEvent(\"jassi-native\",{{detail:{detail}}}))"));
}

/// For `auth` and `ask`: queue until the page has loaded.
pub fn emit_when_loaded(app: &AppHandle, detail: Value) {
    let shell = app.state::<Shell>();
    {
        let mut p = shell.page.lock().unwrap();
        if !p.loaded {
            if p.queued.len() < 8 {
                p.queued.push(detail);
            }
            return;
        }
    }
    emit(app, detail);
}

/// A `jassi://auth…` link opened the app: come to the front and hand the link to the web app.
/// The shell does nothing else with it.
pub fn on_link(app: &AppHandle, link: &str) {
    let Some(link) = policy::auth_link(link) else { return };
    {
        // Some systems deliver the same link twice (once as "current", once as an event).
        let shell = app.state::<Shell>();
        let mut last = shell.last_link.lock().unwrap();
        if matches!(&*last, Some((l, at)) if *l == link && at.elapsed() < Duration::from_secs(5)) {
            return;
        }
        *last = Some((link.clone(), Instant::now()));
    }
    bring_to_front(app);
    emit_when_loaded(app, json!({ "type": "auth", "url": link }));
}

/// Dev builds only: `JASSI_DEV_SCRIPT=/path/to/test.js` runs that file in the page once it has loaded
/// (apps/desktop/dev/). It reports through `jn_dev_log`. Release builds have neither.
fn dev_script(app: &AppHandle) {
    if !config::DEV {
        return;
    }
    let Ok(path) = std::env::var("JASSI_DEV_SCRIPT") else { return };
    let (Ok(js), Some(main)) = (std::fs::read_to_string(path), app.get_webview_window("main")) else { return };
    let _ = main.eval(js);
}
